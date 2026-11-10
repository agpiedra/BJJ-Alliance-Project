import "dotenv/config";
import { DateTime } from "luxon";
import { Pool, type PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { getTestPrismaClient } from "../helpers/test-db";
import { makeAccountingOrg } from "../helpers/accounting-org";
import { forceDeleteForTest } from "../helpers/force-delete";
import { resolveGuardedTestDatabaseUrl } from "../../scripts/lib/test-database-guard";
import type { TenantContext } from "../../src/lib/tenant/types";
import type { Tx } from "../../src/lib/students/lock";

/**
 * Stage 9 PR 9-3 (docs/dues/STAGE-9-IMPLEMENTATION-PLAN.md; A1–A8 approved 2026-11-10) against the REAL isolated test database,
 * with private temporary organizations (one per switch: activation is one-way) removed in afterAll. Every "waits" claim is
 * observed with pg_blocking_pids(), never inferred from timing. Synthetic students and amounts only.
 *
 * Clocks: approval runs on the real clock (S is next month in Costa Rica), shifted two minutes back so confirmations the database
 * timestamps a moment later are reliably "after approval" whatever the container's clock drift; the switch runs on a fixed clock
 * inside S. Check 10 (the platform job's trigger health, not organization data and never schedulable from a test) is injected
 * healthy through the core's test-only `triggerForTest`; everything else readiness reads is real.
 */
let currentSession: { user: { id: string; role: string } | null; activeOrganizationId?: string } | null = null;
vi.mock("@/auth", () => ({ auth: () => Promise.resolve(currentSession), signIn: vi.fn() }));
vi.mock("@/lib/email/send-transactional-email", () => ({ sendTransactionalEmail: vi.fn(async () => ({ success: true })) }));
// Longer than every internal wait (the switch's 5 s lock timeout, the 5 s blocked-poll), so a slow test fails on its own assertion.
vi.setConfig({ testTimeout: 40_000, hookTimeout: 120_000 });

const { approveActivationCore, withdrawApprovalCore, activateCore, SWITCH_BOUNDS } = await import("../../src/lib/dues/readiness/activation-core");
const { approveActivation, activateLedger } = await import("../../src/lib/dues/readiness/activation-actions");
const { recordConfirmationCore, recordNoMoneyAcknowledgementCore, createOpeningDraftCore } = await import("../../src/lib/dues/readiness/opening-core");
const { loadReadinessSnapshot } = await import("../../src/lib/dues/readiness/snapshot");
const { evaluateReadiness } = await import("../../src/lib/dues/readiness/evaluate");
const { openingReviewBinding, legacyNoMoneyBinding } = await import("../../src/lib/dues/readiness/fingerprint");
const { readLedgerActive } = await import("../../src/lib/dues/activation-gate");
const { recordPayment } = await import("../../src/lib/payments/payment-actions");
const { currentCrDateParts } = await import("../../src/lib/payments/get-current-period");
const { runMonthlyGeneration } = await import("../../src/lib/dues/monthly-generation-progress");
const { prisma: appPrisma } = await import("../../src/lib/prisma");

const prisma = getTestPrismaClient();
const pool = new Pool({ connectionString: resolveGuardedTestDatabaseUrl(), max: 4 });
type Fixture = Awaited<ReturnType<typeof makeAccountingOrg>>;
const CR = "America/Costa_Rica";
const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
const today = currentCrDateParts();
const S = today.month === 12 ? { year: today.year + 1, month: 1 } : { year: today.year, month: today.month + 1 };
const PREV = today.month === 1 ? { year: today.year - 1, month: 12 } : { year: today.year, month: today.month - 1 };
const inS = (day: number, hour = 12, minute = 0, second = 0, ms = 0) => DateTime.fromObject({ year: S.year, month: S.month, day, hour, minute, second, millisecond: ms }, { zone: CR }).toJSDate();
const HEALTHY = { scheduled: true, latestRun: { status: "SUCCEEDED", finalized: true, heartbeatStatus: "ok", alertPings: { urgent: "ok", data: "ok", workload: "ok" } }, stale: false, stuck: false };
const approvalClock = () => new Date(Date.now() - 120_000);
const switchAt = (at: Date) => ({ now: () => at, triggerForTest: HEALTHY });

type Org = { fx: Fixture; planId: string; s1: string; s2: string; inactive: string; ctx: TenantContext };
const orgs: Fixture[] = [];
let n = 0;

async function newStudent(fx: Fixture, status: "ACTIVE" | "INACTIVE", planId: string) {
  n++;
  const student = await prisma.student.create({
    data: {
      organizationId: fx.org.id, homeAcademyId: fx.academy.id, firstName: "Switch", lastName: `S${n}`, phone: "00000000",
      email: `s93-${n}-${suffix}@example.com`, currentRankId: await fx.rankId("WHITE"), codeHash: `s93-${n}-${suffix}`, status,
    },
  });
  await prisma.studentStatusChange.create({
    data: { organizationId: fx.org.id, studentId: student.id, status, effectiveOn: new Date(Date.UTC(2026, 0, 1)), sequence: 1, source: "EVENT", actorId: fx.admin.id },
  });
  await prisma.studentPlanAssignment.create({ data: { organizationId: fx.org.id, studentId: student.id, planId, effectiveYear: 2026, effectiveMonth: 1, createdById: fx.admin.id } });
  return student.id;
}

/** One branch in Costa Rica; one CRC monthly plan and policy; s1 active, s2 active with one opening item for last month, one inactive. */
async function build(label: string): Promise<Org> {
  const fx = await makeAccountingOrg("CUMULATIVE", `s93-${label}`);
  orgs.push(fx);
  await prisma.academy.update({ where: { id: fx.academy.id }, data: { timezone: CR } });
  const plan = await prisma.paymentPlan.create({ data: { organizationId: fx.org.id, academyId: fx.academy.id, name: `Mensualidad ${label}`, defaultAmount: 25000 } });
  await prisma.paymentPlanTerms.create({
    data: { organizationId: fx.org.id, planId: plan.id, effectiveYear: 2026, effectiveMonth: 1, priceAmount: "25000.00", currency: "CRC", monthsCovered: 1, createdById: fx.admin.id },
  });
  await prisma.duesPolicyVersion.create({
    data: { organizationId: fx.org.id, academyId: fx.academy.id, effectiveYear: 2026, effectiveMonth: 1, dueDay: 1, graceDay: 5, lateFeeAmount: "2000.00", lateFeeCurrency: "CRC", createdById: fx.admin.id },
  });
  const ctx: TenantContext = { kind: "tenant", actorUserId: fx.admin.id, organizationId: fx.org.id, organizationRole: "ADMIN", academyIds: "ALL", selfStudentId: null, linkedStudentId: null };
  const s1 = await newStudent(fx, "ACTIVE", plan.id);
  const s2 = await newStudent(fx, "ACTIVE", plan.id);
  const inactive = await newStudent(fx, "INACTIVE", plan.id);
  expect(await createOpeningDraftCore(ctx, s2, { coverageYear: PREV.year, coverageMonth: PREV.month, amount: "18000.00", currency: "CRC", note: "Unpaid last month", legacyPaymentPeriodId: null })).toEqual({ ok: true });
  return { fx, planId: plan.id, s1, s2, inactive, ctx };
}

const snap = (o: Org) => appPrisma.$transaction((tx) => loadReadinessSnapshot(tx, o.fx.org.id));
const report = async (o: Org) => evaluateReadiness({ ...(await snap(o)), trigger: HEALTHY }, S);

/** The owner reviews one student exactly as the screen shows it (binding from the current content). */
async function review(o: Org, studentId: string) {
  const s = await snap(o);
  const fp = evaluateReadiness(s, S).fingerprints.students[studentId]!;
  const declaration = s.openingItems.some((i) => i.studentId === studentId) ? "itemsAsShown" : "noOpeningDebt";
  expect(await recordConfirmationCore(o.ctx, { studentId, candidate: S, kind: "OPENING_REVIEWED", binding: openingReviewBinding(S, fp), declaration })).toEqual({ ok: true });
}
async function acknowledge(o: Org, legacyId: string) {
  const s = await snap(o);
  const row = s.legacyPayments.find((p) => p.id === legacyId)!;
  return recordNoMoneyAcknowledgementCore(o.ctx, { studentId: row.studentId, candidate: S, legacyPaymentPeriodId: legacyId, binding: legacyNoMoneyBinding(S, row) });
}
async function approve(o: Org) {
  const r = await report(o);
  return approveActivationCore(o.ctx, { candidate: S, organizationFingerprint: r.fingerprints.organization }, { now: approvalClock, triggerForTest: HEALTHY });
}
async function readyAndApproved(label: string) {
  const o = await build(label);
  await review(o, o.s1);
  await review(o, o.s2);
  expect(await approve(o)).toMatchObject({ ok: true });
  return o;
}

/** Everything the switch writes, for "nothing was written" assertions. */
async function switchWrites(o: Org) {
  const organizationId = o.fx.org.id;
  return {
    effective: await prisma.duesActivation.count({ where: { organizationId, effectiveAt: { not: null } } }),
    obligations: await prisma.duesObligation.count({ where: { organizationId } }),
    progress: await prisma.duesGenerationProgress.count({ where: { organizationId } }),
    materialized: await prisma.duesOpeningItem.count({ where: { organizationId, materializedObligationId: { not: null } } }),
    activateAudit: await prisma.auditLog.count({ where: { organizationId, action: "duesActivation.activate" } }),
  };
}
const NOTHING = { effective: 0, obligations: 0, progress: 0, materialized: 0, activateAudit: 0 };

/** A pause point inside a core's transaction (after the gate): reports the backend pid, holds until released. */
function pausePoint() {
  let release!: () => void;
  const released = new Promise<void>((r) => (release = r));
  let reached!: (pid: number) => void;
  const at = new Promise<number>((r) => (reached = r));
  const hook = async (tx: Tx) => {
    const [{ pid }] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid()::int AS pid`;
    reached(pid);
    await released;
  };
  return { hook, at, release };
}
async function waitUntilBlockedBy(holderPid: number, timeoutMs = 5_000): Promise<string[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rows = await prisma.$queryRaw<{ query: string }[]>`SELECT query FROM pg_stat_activity WHERE ${holderPid}::int = ANY(pg_blocking_pids(pid))`;
    if (rows.length > 0) return rows.map((r) => r.query);
    if (Date.now() > deadline) throw new Error(`nothing became blocked by pid ${holderPid}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}
const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};
const asOwner = (o: Org) => (currentSession = { user: { id: o.fx.admin.id, role: "ADMIN" }, activeOrganizationId: o.fx.org.id });
const legacyForm = (o: Org, studentId: string, notes: string) =>
  form({ studentId, year: String(today.year), month: String(today.month), planId: o.planId, status: "PAID", amount: "25000", method: "EFECTIVO", notes });

const openClients = new Set<PoolClient>();
afterEach(async () => {
  for (const client of [...openClients]) {
    openClients.delete(client);
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
  }
});

beforeAll(() => {
  expect(S.year * 12 + S.month).toBeGreaterThan(today.year * 12 + today.month); // approval on the real clock is before S
});

afterAll(async () => {
  const ids = orgs.map((fx) => fx.org.id);
  if (ids.length > 0) {
    const del = (table: string) => ({ sql: `DELETE FROM "${table}" WHERE "organizationId" = ANY($1::text[])`, params: [ids] });
    await forceDeleteForTest(
      prisma,
      ...["DuesSettlement", "DuesLateFee", "DuesCoverage", "DuesPayment", "DuesReadinessConfirmation", "DuesOpeningItem", "DuesObligation", "DuesGenerationProgress", "DuesActivation"].map(del),
    );
  }
  for (const fx of orgs) {
    await prisma.paymentPeriod.deleteMany({ where: { organizationId: fx.org.id } });
    await prisma.studentPlanAssignment.deleteMany({ where: { organizationId: fx.org.id } });
    await prisma.paymentPlanTerms.deleteMany({ where: { organizationId: fx.org.id } });
    await prisma.duesPolicyVersion.deleteMany({ where: { organizationId: fx.org.id } });
    await prisma.paymentPlan.deleteMany({ where: { organizationId: fx.org.id } });
    await prisma.organizationMembership.deleteMany({ where: { organizationId: fx.org.id, role: { not: "ADMIN" } } });
    await fx.drop();
  }
  await pool.end();
});

describe("advance approval (rules 2–3)", () => {
  it("refuses before readiness, refuses a stale report, refuses on or after the first branch's 1st; stores S, fingerprints and totals; switches nothing; one live approval; withdraw and approve again", async () => {
    const o = await build("approve");
    const notReady = await approve(o);
    expect(notReady).toMatchObject({ ok: false, error: "notReady" });
    expect(notReady.ok ? [] : notReady.failing!.map((f) => f.id)).toEqual([9]);
    await review(o, o.s1);
    await review(o, o.s2);

    const r = await report(o);
    expect(await approveActivationCore(o.ctx, { candidate: S, organizationFingerprint: "0".repeat(64) }, { now: approvalClock, triggerForTest: HEALTHY })).toEqual({ ok: false, error: "stale" });
    expect(await approveActivationCore(o.ctx, { candidate: S, organizationFingerprint: r.fingerprints.organization }, { now: () => inS(1, 0), triggerForTest: HEALTHY })).toEqual({ ok: false, error: "tooLate" });
    // Without the injected trigger, today's real check 10 (not scheduled) blocks approval: approval never ignores a blocker.
    const real = await approveActivationCore(o.ctx, { candidate: S, organizationFingerprint: r.fingerprints.organization }, { now: approvalClock });
    expect(real.ok ? [] : real.failing!.map((f) => f.id)).toEqual([10]);
    expect(await prisma.duesActivation.count({ where: { organizationId: o.fx.org.id } })).toBe(0);

    const ok = await approveActivationCore(o.ctx, { candidate: S, organizationFingerprint: r.fingerprints.organization }, { now: approvalClock, triggerForTest: HEALTHY });
    expect(ok).toMatchObject({ ok: true });
    const row = await prisma.duesActivation.findFirstOrThrow({ where: { organizationId: o.fx.org.id } });
    expect(row).toMatchObject({
      startYear: S.year, startMonth: S.month, fingerprintFormat: "r3", configFingerprint: r.fingerprints.configuration, approvedById: o.fx.admin.id,
      withdrawnAt: null, effectiveAt: null, approvedOpeningTotals: { [o.s2]: [{ currency: "CRC", total: "18000.00" }] },
    });
    expect(row.studentFingerprints).toEqual(r.fingerprints.students);
    expect(await prisma.auditLog.count({ where: { organizationId: o.fx.org.id, action: "duesActivation.approve", entityId: row.id } })).toBe(1);
    expect(await readLedgerActive(o.fx.org.id)).toBe(false);
    expect(await switchWrites(o)).toEqual(NOTHING);

    expect(await approve(o)).toEqual({ ok: false, error: "approvalExists" });
    expect(await withdrawApprovalCore(o.ctx)).toEqual({ ok: true });
    expect(await withdrawApprovalCore(o.ctx)).toEqual({ ok: false, error: "noApproval" });
    expect(await approve(o)).toMatchObject({ ok: true });
    expect(await prisma.duesActivation.count({ where: { organizationId: o.fx.org.id } })).toBe(2);
    expect(await prisma.auditLog.count({ where: { organizationId: o.fx.org.id, action: "duesActivation.withdraw" } })).toBe(1);
  });

  it("A7: only the owner — a Director gets notFound from every activation action, and nothing is written", async () => {
    const o = await build("director");
    const director = await prisma.user.create({ data: { email: `s93-director-${suffix}@example.com`, passwordHash: "x", role: "DIRECTOR" } });
    await prisma.organizationMembership.create({ data: { userId: director.id, organizationId: o.fx.org.id, role: "DIRECTOR" } });
    try {
      currentSession = { user: { id: director.id, role: "DIRECTOR" }, activeOrganizationId: o.fx.org.id };
      const r = await report(o);
      expect(await approveActivation(o.fx.org.id, form({ candidateYear: String(S.year), candidateMonth: String(S.month), organizationFingerprint: r.fingerprints.organization }))).toEqual({ ok: false, error: "notFound" });
      expect(await activateLedger(o.fx.org.id)).toEqual({ ok: false, error: "notFound" });
      expect(await prisma.duesActivation.count({ where: { organizationId: o.fx.org.id } })).toBe(0);
    } finally {
      currentSession = null;
      await prisma.organizationMembership.deleteMany({ where: { userId: director.id } });
      await prisma.user.delete({ where: { id: director.id } });
    }
  });
});

describe("the switch (rules 4–7)", () => {
  it("opens at the LAST branch's 00:00 on the 1st (inclusive); creates exactly the reviewed OPENING charges, the first progress row and the effective record; generation then bills S", async () => {
    const o = await readyAndApproved("switch");
    expect(await activateCore(o.ctx, switchAt(new Date(inS(1, 0).getTime() - 1)))).toEqual({ ok: false, error: "windowNotOpen" });
    expect(await activateCore(o.ctx, { triggerForTest: HEALTHY })).toEqual({ ok: false, error: "windowNotOpen" }); // the real clock: before S
    expect(await switchWrites(o)).toEqual(NOTHING);

    const at = inS(1, 0);
    const result = await activateCore(o.ctx, switchAt(at));
    expect(result).toMatchObject({ ok: true, startYear: S.year, startMonth: S.month, openingObligations: 1, refreshedStudents: [] });

    const organizationId = o.fx.org.id;
    const opening = await prisma.duesObligation.findMany({ where: { organizationId } });
    expect(opening).toHaveLength(1);
    expect(opening[0]).toMatchObject({
      type: "OPENING", origin: "STAFF", studentId: o.s2, academyId: o.fx.academy.id, coverageYear: PREV.year, coverageMonth: PREV.month, monthsCovered: 1,
      currency: "CRC", dueOn: null, graceDeadline: null, lateFeeAmount: null, policyVersionId: null, planTermsId: null, createdById: o.fx.admin.id, cancelledAt: null,
    });
    expect(opening[0]!.amount.toFixed(2)).toBe("18000.00");
    const item = await prisma.duesOpeningItem.findFirstOrThrow({ where: { organizationId } });
    expect(item.materializedObligationId).toBe(opening[0]!.id);
    expect(await prisma.duesCoverage.count({ where: { organizationId } })).toBe(0);
    const progress = await prisma.duesGenerationProgress.findMany({ where: { organizationId } });
    expect(progress).toHaveLength(1);
    expect(progress[0]).toMatchObject({ year: S.year, month: S.month, cursorStudentId: null, lastPassCompletedAt: null });
    expect(progress[0]!.lastVisitedAt.getTime()).toBe(0);
    const activation = await prisma.duesActivation.findFirstOrThrow({ where: { organizationId, withdrawnAt: null } });
    expect(activation.effectiveAt?.getTime()).toBe(at.getTime());
    expect(activation.effectiveById).toBe(o.fx.admin.id);
    expect(await prisma.auditLog.count({ where: { organizationId, action: "duesActivation.activate" } })).toBe(1);

    // From the commit: active, and every activation action refuses; the legacy writer refuses (9-1) with the input kept.
    expect(await readLedgerActive(organizationId)).toBe(true);
    expect(await activateCore(o.ctx, switchAt(inS(2)))).toEqual({ ok: false, error: "alreadyActive" });
    expect(await approve(o)).toEqual({ ok: false, error: "alreadyActive" });
    expect(await withdrawApprovalCore(o.ctx)).toEqual({ ok: false, error: "alreadyActive" });
    asOwner(o);
    const legacy = await recordPayment(organizationId, {}, legacyForm(o, o.s1, "after the switch"));
    currentSession = null;
    expect(legacy).toMatchObject({ error: "ledgerActive", submitted: { studentId: o.s1, notes: "after the switch" } });
    expect(await prisma.paymentPeriod.count({ where: { organizationId } })).toBe(0);

    // Generation now visits this organization and bills S for both active students (never the inactive one, never another month).
    await runMonthlyGeneration({ closurePolicy: "reopen", now: () => inS(5) });
    const monthly = await prisma.duesObligation.findMany({ where: { organizationId, type: "MONTHLY" }, select: { studentId: true, coverageYear: true, coverageMonth: true } });
    expect(monthly.map((m) => m.studentId).sort()).toEqual([o.s1, o.s2].sort());
    expect(monthly.every((m) => m.coverageYear === S.year && m.coverageMonth === S.month)).toBe(true);
  });

  it("generation never bills an organization that has not switched (no progress row, nothing visited)", async () => {
    const o = await readyAndApproved("noswitch");
    await runMonthlyGeneration({ closurePolicy: "reopen", now: () => inS(5) });
    expect(await switchWrites(o)).toEqual(NOTHING);
  });

  it("closes at the FIRST branch's 00:00 on day 11 (exclusive); a switch one millisecond before still succeeds", async () => {
    const o = await readyAndApproved("close");
    expect(await activateCore(o.ctx, switchAt(inS(11, 0)))).toEqual({ ok: false, error: "windowClosed" });
    expect(await switchWrites(o)).toEqual(NOTHING);
    expect(await activateCore(o.ctx, switchAt(inS(10, 23, 59, 59, 999)))).toMatchObject({ ok: true });
  });

  it("refuses with no live approval, and after a configuration change (a new price) — nothing written, nothing left blocked", async () => {
    const o = await build("config");
    expect(await activateCore(o.ctx, switchAt(inS(2)))).toEqual({ ok: false, error: "noApproval" });
    await review(o, o.s1);
    await review(o, o.s2);
    expect(await approve(o)).toMatchObject({ ok: true });
    await prisma.paymentPlanTerms.create({
      data: { organizationId: o.fx.org.id, planId: o.planId, effectiveYear: S.year, effectiveMonth: S.month, priceAmount: "27000.00", currency: "CRC", monthsCovered: 1, createdById: o.fx.admin.id },
    });
    expect(await activateCore(o.ctx, switchAt(inS(2)))).toEqual({ ok: false, error: "configurationChanged" });
    expect(await switchWrites(o)).toEqual(NOTHING);
    asOwner(o);
    expect(await recordPayment(o.fx.org.id, {}, legacyForm(o, o.s1, "still the old system"))).toEqual({ ok: true });
    currentSession = null;
  });

  it("regression (browser pass): a page load creating the system's custom-promotion plan after approval does not block the switch", async () => {
    const o = await readyAndApproved("custompromo");
    const { ensureCustomPromoPlan } = await import("../../src/lib/payments/ensure-custom-promo-plan");
    expect(await ensureCustomPromoPlan(o.fx.org.id, o.fx.academy.id)).toMatchObject({ name: expect.any(String) });
    expect(await activateCore(o.ctx, switchAt(inS(2)))).toMatchObject({ ok: true });
  });

  it("the exception is only for the UNPRICED system plan: once it gets prices, and when any owner plan is added, the switch refuses configurationChanged and writes nothing", async () => {
    const priced = await readyAndApproved("custompromo-priced");
    const { ensureCustomPromoPlan } = await import("../../src/lib/payments/ensure-custom-promo-plan");
    const plan = await ensureCustomPromoPlan(priced.fx.org.id, priced.fx.academy.id);
    await prisma.paymentPlanTerms.create({
      data: { organizationId: priced.fx.org.id, planId: plan!.id, effectiveYear: 2026, effectiveMonth: 1, priceAmount: "20000.00", currency: "CRC", monthsCovered: 1, createdById: priced.fx.admin.id },
    });
    expect(await activateCore(priced.ctx, switchAt(inS(2)))).toEqual({ ok: false, error: "configurationChanged" });
    expect(await switchWrites(priced)).toEqual(NOTHING);

    const ownerPlan = await readyAndApproved("ownerplan");
    await prisma.paymentPlan.create({ data: { organizationId: ownerPlan.fx.org.id, academyId: ownerPlan.fx.academy.id, name: "Weekend only" } });
    expect(await activateCore(ownerPlan.ctx, switchAt(inS(2)))).toEqual({ ok: false, error: "configurationChanged" });
    expect(await switchWrites(ownerPlan)).toEqual(NOTHING);
  });

  it("rule 6 on the DATABASE clock (no injected clock): a re-review after approval counts; the approval's own earlier review does not", async () => {
    const o = await build("dbclock");
    await review(o, o.s1);
    await review(o, o.s2);
    const r = await report(o);
    expect(await approveActivationCore(o.ctx, { candidate: S, organizationFingerprint: r.fingerprints.organization }, { triggerForTest: HEALTHY })).toMatchObject({ ok: true });
    await prisma.paymentPeriod.create({
      data: { organizationId: o.fx.org.id, studentId: o.s1, academyId: o.fx.academy.id, year: PREV.year, month: PREV.month, planId: o.planId, status: "PAID", amount: "25000.00", currency: "CRC", method: "EFECTIVO", recordedById: o.fx.admin.id },
    });
    expect(await activateCore(o.ctx, switchAt(inS(2)))).toEqual({ ok: false, error: "needsReconfirmation", students: [o.s1] });
    await review(o, o.s1);
    expect(await activateCore(o.ctx, switchAt(inS(2)))).toMatchObject({ ok: true, refreshedStudents: [o.s1] });
  });

  it("rule 6: a student changed after approval (an old-system payment for an earlier month) blocks until re-reviewed AFTER approval; then it switches and lists them", async () => {
    const o = await readyAndApproved("refresh");
    await prisma.paymentPeriod.create({
      data: { organizationId: o.fx.org.id, studentId: o.s1, academyId: o.fx.academy.id, year: PREV.year, month: PREV.month, planId: o.planId, status: "PAID", amount: "25000.00", currency: "CRC", method: "EFECTIVO", recordedById: o.fx.admin.id },
    });
    expect(await activateCore(o.ctx, switchAt(inS(3)))).toEqual({ ok: false, error: "needsReconfirmation", students: [o.s1] });
    expect(await switchWrites(o)).toEqual(NOTHING);
    await review(o, o.s1); // re-confirming after the 1st of S is allowed (it reviews pre-S facts)
    expect(await activateCore(o.ctx, switchAt(inS(3)))).toMatchObject({ ok: true, refreshedStudents: [o.s1] });
  });

  it("A8 at the switch: an ambiguous S row needs the owner's 'no money' acknowledgement bound to its exact content; any later write to the row invalidates it; placeholders never block and are never changed", async () => {
    const o = await build("a8");
    const row = (studentId: string, method: "EFECTIVO" | null, notes: string | null) =>
      prisma.paymentPeriod.create({
        data: { organizationId: o.fx.org.id, studentId, academyId: o.fx.academy.id, year: S.year, month: S.month, planId: o.planId, status: "PENDING", amount: "25000.00", currency: "CRC", method, notes, recordedById: o.fx.admin.id },
      });
    const ambiguous = await row(o.s1, "EFECTIVO", null);
    const placeholder = await row(o.s2, null, null);
    await review(o, o.s1);
    await review(o, o.s2);
    const blocked = await approve(o);
    expect(blocked.ok ? [] : blocked.failing).toEqual([{ id: 5, key: "noLegacyFromStart", items: [`legacy:${ambiguous.id}`] }]);
    expect(await acknowledge(o, placeholder.id)).toMatchObject({ error: "invalid", fieldErrors: { legacyPaymentPeriodId: ["notAcknowledgeable"] } });
    expect(await acknowledge(o, ambiguous.id)).toEqual({ ok: true });
    expect(await prisma.auditLog.count({ where: { organizationId: o.fx.org.id, action: "duesReadinessConfirmation.recordNoMoney" } })).toBe(1);
    expect(await approve(o)).toMatchObject({ ok: true });

    // The old system writes the row again after approval (same visible content: every write sets recordedAt).
    await prisma.paymentPeriod.update({ where: { id: ambiguous.id }, data: { recordedAt: new Date() } });
    expect(await activateCore(o.ctx, switchAt(inS(2)))).toMatchObject({ ok: false, error: "notReady", failing: [{ id: 5, items: [`legacy:${ambiguous.id}`] }] });
    expect(await switchWrites(o)).toEqual(NOTHING);
    expect(await acknowledge(o, ambiguous.id)).toEqual({ ok: true });

    const before = await prisma.paymentPeriod.findMany({ where: { organizationId: o.fx.org.id }, orderBy: { id: "asc" } });
    expect(await activateCore(o.ctx, switchAt(inS(2)))).toMatchObject({ ok: true });
    expect(await prisma.paymentPeriod.findMany({ where: { organizationId: o.fx.org.id }, orderBy: { id: "asc" } })).toEqual(before); // nothing edited or deleted
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { organizationId: o.fx.org.id, action: "duesActivation.activate" } });
    expect(audit.after).toMatchObject({ legacyPlaceholders: [placeholder.id], acknowledgedNoMoney: [ambiguous.id] });
  });

  it("A8 rule 10: a recorded old-system payment for S can never be acknowledged and blocks approval (resolution: move S)", async () => {
    const o = await build("a8paid");
    const paid = await prisma.paymentPeriod.create({
      data: { organizationId: o.fx.org.id, studentId: o.s1, academyId: o.fx.academy.id, year: S.year, month: S.month, planId: o.planId, status: "PAID", amount: "25000.00", currency: "CRC", method: "EFECTIVO", recordedById: o.fx.admin.id },
    });
    await review(o, o.s1);
    await review(o, o.s2);
    expect(await acknowledge(o, paid.id)).toMatchObject({ error: "invalid", fieldErrors: { legacyPaymentPeriodId: ["notAcknowledgeable"] } });
    expect(await approve(o)).toMatchObject({ ok: false, error: "notReady", failing: [{ id: 5, items: [`legacy:${paid.id}`] }] });
  });

  it("atomic: a failure after every write rolls ALL of it back, and nothing is left blocked (a retry succeeds)", async () => {
    const o = await readyAndApproved("atomic");
    await expect(
      activateCore(o.ctx, {
        ...switchAt(inS(2)),
        beforeCommitForTest: async () => {
          throw new Error("injected failure before commit");
        },
      }),
    ).rejects.toThrow("injected failure before commit");
    expect(await switchWrites(o)).toEqual(NOTHING);
    expect(await activateCore(o.ctx, switchAt(inS(2)))).toMatchObject({ ok: true, openingObligations: 1 });
  });
});

describe("real writer races (concurrency rules 5, 6, 8), proved with pg_blocking_pids", () => {
  it("a legacy payment waits on the switch; when the switch commits it is refused, writes nothing, and returns the input", async () => {
    const o = await readyAndApproved("race-commit");
    const p = pausePoint();
    const switching = activateCore(o.ctx, { ...switchAt(inS(2)), afterGateForTest: p.hook });
    const pid = await p.at;
    asOwner(o);
    const pending = recordPayment(o.fx.org.id, {}, legacyForm(o, o.s1, "receipt 2001, cash"));
    expect((await waitUntilBlockedBy(pid)).some((q) => /FROM "Organization" WHERE "id" = \$1 FOR SHARE/.test(q))).toBe(true);
    p.release();
    expect(await switching).toMatchObject({ ok: true });
    const result = await pending;
    currentSession = null;
    expect(result).toMatchObject({ error: "ledgerActive", submitted: { studentId: o.s1, notes: "receipt 2001, cash", amount: "25000" } });
    expect(await prisma.paymentPeriod.count({ where: { organizationId: o.fx.org.id } })).toBe(0);
  });

  it("a legacy payment waits on the switch; when the switch fails and rolls back, the payment proceeds normally", async () => {
    const o = await readyAndApproved("race-rollback");
    const p = pausePoint();
    const switching = activateCore(o.ctx, {
      ...switchAt(inS(2)),
      afterGateForTest: p.hook,
      beforeCommitForTest: async () => {
        throw new Error("injected failure before commit");
      },
    });
    const pid = await p.at;
    asOwner(o);
    const pending = recordPayment(o.fx.org.id, {}, legacyForm(o, o.s1, "receipt 2002"));
    await waitUntilBlockedBy(pid);
    p.release();
    await expect(switching).rejects.toThrow("injected failure before commit");
    expect(await pending).toEqual({ ok: true });
    currentSession = null;
    expect(await switchWrites(o)).toEqual(NOTHING);
    expect(await prisma.paymentPeriod.count({ where: { organizationId: o.fx.org.id } })).toBe(1);
  });

  it("the switch waits for an in-flight writer holding the gate, then sees its commit (a new opening item → that student must be re-reviewed)", async () => {
    const o = await readyAndApproved("race-inflight");
    const p = pausePoint();
    const writing = createOpeningDraftCore(
      o.ctx,
      o.s1,
      { coverageYear: PREV.year, coverageMonth: PREV.month, amount: "5000.00", currency: "CRC", note: "found late", legacyPaymentPeriodId: null },
      { afterLocks: p.hook },
    );
    const writerPid = await p.at;
    const switching = activateCore(o.ctx, switchAt(inS(2)));
    expect((await waitUntilBlockedBy(writerPid)).some((q) => /FOR NO KEY UPDATE/.test(q))).toBe(true);
    p.release();
    expect(await writing).toEqual({ ok: true });
    expect(await switching).toEqual({ ok: false, error: "needsReconfirmation", students: [o.s1] });
    expect(await switchWrites(o)).toEqual(NOTHING);
  });

  it("two switches: the second waits on the first, then refuses alreadyActive; exactly one set of writes", async () => {
    const o = await readyAndApproved("race-two");
    const p = pausePoint();
    const first = activateCore(o.ctx, { ...switchAt(inS(2)), afterGateForTest: p.hook });
    const pid = await p.at;
    const second = activateCore(o.ctx, switchAt(inS(2)));
    await waitUntilBlockedBy(pid);
    p.release();
    expect(await first).toMatchObject({ ok: true });
    expect(await second).toEqual({ ok: false, error: "alreadyActive" });
    expect(await switchWrites(o)).toEqual({ effective: 1, obligations: 1, progress: 1, materialized: 1, activateAudit: 1 });
  });

  it("withdrawal vs the switch: serialized on the gate; the switch commits first, so the withdrawal refuses alreadyActive", async () => {
    const o = await readyAndApproved("race-withdraw");
    const p = pausePoint();
    const switching = activateCore(o.ctx, { ...switchAt(inS(2)), afterGateForTest: p.hook });
    const pid = await p.at;
    const withdrawing = withdrawApprovalCore(o.ctx);
    await waitUntilBlockedBy(pid);
    p.release();
    expect(await switching).toMatchObject({ ok: true });
    expect(await withdrawing).toEqual({ ok: false, error: "alreadyActive" });
  });

  it("a gate held longer than the lock timeout: the switch answers busy after ~5 s, writes nothing, and works once released", async () => {
    const o = await readyAndApproved("race-timeout");
    const client = await pool.connect();
    openClients.add(client);
    await client.query("BEGIN");
    await client.query(`SELECT "id" FROM "Organization" WHERE "id" = $1 FOR SHARE`, [o.fx.org.id]);
    const started = Date.now();
    expect(await activateCore(o.ctx, switchAt(inS(2)))).toEqual({ ok: false, error: "busy" });
    expect(Date.now() - started).toBeGreaterThanOrEqual(SWITCH_BOUNDS.lockTimeoutMs - 200);
    await client.query("ROLLBACK");
    openClients.delete(client);
    client.release();
    expect(await switchWrites(o)).toEqual(NOTHING);
    expect(await activateCore(o.ctx, switchAt(inS(2)))).toMatchObject({ ok: true });
  });
});

describe("approval and acknowledgement under concurrency", () => {
  it("approval waits for an in-flight writer, then refuses stale (the owner must look at the new content); nothing written", async () => {
    const o = await build("approve-inflight");
    await review(o, o.s1);
    await review(o, o.s2);
    const shown = (await report(o)).fingerprints.organization;
    const p = pausePoint();
    const writing = createOpeningDraftCore(
      o.ctx,
      o.s1,
      { coverageYear: PREV.year, coverageMonth: PREV.month, amount: "5000.00", currency: "CRC", note: "found late", legacyPaymentPeriodId: null },
      { afterLocks: p.hook },
    );
    const writerPid = await p.at;
    const approving = approveActivationCore(o.ctx, { candidate: S, organizationFingerprint: shown }, { now: approvalClock, triggerForTest: HEALTHY });
    expect((await waitUntilBlockedBy(writerPid)).some((q) => /FOR NO KEY UPDATE/.test(q))).toBe(true);
    p.release();
    expect(await writing).toEqual({ ok: true });
    expect(await approving).toEqual({ ok: false, error: "stale" });
    expect(await prisma.duesActivation.count({ where: { organizationId: o.fx.org.id } })).toBe(0);
  });

  it("approval and withdrawal answer busy after the lock timeout and write nothing", async () => {
    const o = await build("approve-busy");
    await review(o, o.s1);
    await review(o, o.s2);
    const shown = (await report(o)).fingerprints.organization;
    const client = await pool.connect();
    openClients.add(client);
    await client.query("BEGIN");
    await client.query(`SELECT "id" FROM "Organization" WHERE "id" = $1 FOR SHARE`, [o.fx.org.id]);
    expect(await approveActivationCore(o.ctx, { candidate: S, organizationFingerprint: shown }, { now: approvalClock, triggerForTest: HEALTHY })).toEqual({ ok: false, error: "busy" });
    expect(await withdrawApprovalCore(o.ctx)).toEqual({ ok: false, error: "busy" });
    await client.query("ROLLBACK");
    openClients.delete(client);
    client.release();
    expect(await prisma.duesActivation.count({ where: { organizationId: o.fx.org.id } })).toBe(0);
    expect(await prisma.auditLog.count({ where: { organizationId: o.fx.org.id, action: { startsWith: "duesActivation." } } })).toBe(0);
  });

  it("an old-system write racing a 'no money' acknowledgement of the same row leaves that acknowledgement stale (it never vouches for content it did not see)", async () => {
    const o = await build("ack-race");
    const row = await prisma.paymentPeriod.create({
      data: { organizationId: o.fx.org.id, studentId: o.s1, academyId: o.fx.academy.id, year: S.year, month: S.month, planId: o.planId, status: "PENDING", amount: "25000.00", currency: "CRC", method: "EFECTIVO", notes: "cash?", recordedById: o.fx.admin.id },
    });
    const s = await snap(o);
    const shownRow = s.legacyPayments.find((x) => x.id === row.id)!;
    const p = pausePoint();
    const acking = recordNoMoneyAcknowledgementCore(o.ctx, { studentId: o.s1, candidate: S, legacyPaymentPeriodId: row.id, binding: legacyNoMoneyBinding(S, shownRow) }, { afterContentRead: p.hook });
    await p.at;
    asOwner(o);
    const writing = recordPayment(o.fx.org.id, {}, form({ studentId: o.s1, year: String(S.year), month: String(S.month), planId: o.planId, status: "PENDING", amount: "25000", method: "EFECTIVO", notes: "paid at the desk" }));
    await new Promise((r) => setTimeout(r, 300));
    p.release();
    expect(await acking).toEqual({ ok: true });
    expect(await writing).toEqual({ ok: true });
    currentSession = null;
    const r = await report(o);
    expect(r.legacyFromStart.find((x) => x.legacyId === row.id)?.acknowledgement?.state).toBe("stale");
    expect(r.checks.find((c) => c.id === 5)).toMatchObject({ status: "fail", items: [`legacy:${row.id}`] });
  });
});

describe("database invariants (migration 20261113120100)", () => {
  it("a materialized opening item never changes, is never withdrawn, and only links to an OPENING charge with its exact content", async () => {
    const o = await readyAndApproved("db-items");
    expect(await activateCore(o.ctx, switchAt(inS(2)))).toMatchObject({ ok: true });
    const item = await prisma.duesOpeningItem.findFirstOrThrow({ where: { organizationId: o.fx.org.id } });
    await expect(prisma.duesOpeningItem.update({ where: { id: item.id }, data: { materializedObligationId: null } })).rejects.toThrow(/materialized opening item never changes/);
    await expect(
      prisma.duesOpeningItem.update({ where: { id: item.id }, data: { withdrawnAt: new Date(), withdrawnById: o.fx.admin.id, withdrawalKind: "WITHDRAWN", withdrawalReason: "x" } }),
    ).rejects.toThrow(/materialized opening item never changes/);
    // A fresh active item cannot be linked to a charge with different content.
    const other = await prisma.duesOpeningItem.create({
      data: { organizationId: o.fx.org.id, studentId: o.s2, coverageYear: PREV.year, coverageMonth: PREV.month === 1 ? 2 : PREV.month - 1, amount: "1.00", currency: "CRC", note: "x", createdById: o.fx.admin.id },
    });
    await expect(prisma.duesOpeningItem.update({ where: { id: other.id }, data: { materializedObligationId: item.materializedObligationId } })).rejects.toThrow();
  });

  it("progress rows are never deleted; an effective activation without its progress row is refused at commit", async () => {
    const o = await readyAndApproved("db-progress");
    expect(await activateCore(o.ctx, switchAt(inS(2)))).toMatchObject({ ok: true });
    await expect(prisma.duesGenerationProgress.deleteMany({ where: { organizationId: o.fx.org.id } })).rejects.toThrow();
    expect(await prisma.duesGenerationProgress.count({ where: { organizationId: o.fx.org.id } })).toBe(1);
    const p = await build("db-noprogress");
    await review(p, p.s1);
    await review(p, p.s2);
    expect(await approve(p)).toMatchObject({ ok: true });
    await expect(
      prisma.duesActivation.updateMany({ where: { organizationId: p.fx.org.id }, data: { effectiveAt: new Date(), effectiveById: p.fx.admin.id } }),
    ).rejects.toThrow(/must have its start month's progress row/);
    expect(await readLedgerActive(p.fx.org.id)).toBe(false);
  });

  it("a LEGACY_NO_MONEY confirmation must name its legacy row and carry no declaration or branch fingerprint", async () => {
    const o = await build("db-ack");
    const base = { organizationId: o.fx.org.id, studentId: o.s1, candidateYear: S.year, candidateMonth: S.month, kind: "LEGACY_NO_MONEY" as const, sequence: 1, fingerprintFormat: "r3", binding: "a".repeat(64), studentFingerprint: "b".repeat(64), confirmedById: o.fx.admin.id };
    await expect(prisma.duesReadinessConfirmation.create({ data: base })).rejects.toThrow(/shape_by_kind/);
    const legacy = await prisma.paymentPeriod.create({
      data: { organizationId: o.fx.org.id, studentId: o.s1, academyId: o.fx.academy.id, year: S.year, month: S.month, planId: o.planId, status: "PENDING", currency: "CRC", notes: "?", recordedById: o.fx.admin.id },
    });
    await expect(prisma.duesReadinessConfirmation.create({ data: { ...base, legacyPaymentPeriodId: legacy.id, declaredNoOpeningDebt: true } })).rejects.toThrow(/shape_by_kind/);
    await expect(prisma.duesReadinessConfirmation.create({ data: { ...base, kind: "OPENING_REVIEWED", declaredNoOpeningDebt: true, legacyPaymentPeriodId: legacy.id } })).rejects.toThrow(/shape_by_kind/);
    await prisma.duesReadinessConfirmation.create({ data: { ...base, legacyPaymentPeriodId: legacy.id } });
  });
});
