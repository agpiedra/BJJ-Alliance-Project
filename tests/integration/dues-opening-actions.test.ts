import "dotenv/config";
import { Pool } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "../../src/generated/prisma/client";
import { getTestPrismaClient } from "../helpers/test-db";
import { makeAccountingOrg } from "../helpers/accounting-org";
import { resolveGuardedTestDatabaseUrl } from "../../scripts/lib/test-database-guard";
import type { TenantContext } from "../../src/lib/tenant/types";
import type { ActionState } from "../../src/lib/action-state";

/**
 * Stage 8 PR 8c (docs/dues/STAGE-8C-IMPLEMENTATION-PLAN.md rev 2) against the REAL isolated test database, with private
 * temporary organizations (removed in afterAll). Amounts, notes and months are synthetic.
 *
 * `@/lib/prisma` is a pass-through proxy whose target can be swapped for a client over a deliberately CONSTRAINED pg pool
 * (`max: 1` or `max: 2`) — the connection-availability scenarios (C). Everything else uses the ordinary guarded client. Test
 * observers (lock-wait polling, fixtures, counts) use the separate test client, so observing never consumes the constrained pool.
 *
 * Three properties are tested SEPARATELY (plan §6): A — transaction ordering (student lock, sequence); B — snapshot consistency
 * of the single-statement content read; C — connection availability (no nested pool acquisition). C establishes exactly the
 * scenarios it runs (the pool sizes and request mixes below), not unlimited concurrency or production capacity.
 */
const pool = vi.hoisted(() => ({ client: null as unknown }));
vi.mock("@/lib/prisma", async () => {
  const actual = await vi.importActual<typeof import("../../src/lib/prisma")>("../../src/lib/prisma");
  const prisma = new Proxy(actual.prisma, {
    get(target, prop, receiver) {
      if (pool.client) {
        const value = (pool.client as Record<string | symbol, unknown>)[prop];
        return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(pool.client) : value;
      }
      return Reflect.get(target, prop, receiver);
    },
  });
  return { ...actual, prisma };
});

let currentSession: { user: { id: string; role: string } | null; activeOrganizationId?: string } | null = null;
vi.mock("@/auth", () => ({ auth: () => Promise.resolve(currentSession), signIn: vi.fn() }));
vi.mock("@/lib/email/send-transactional-email", () => ({ sendTransactionalEmail: vi.fn(async () => ({ success: true })) }));

const actions = await import("../../src/lib/dues/readiness/opening-actions");
const core = await import("../../src/lib/dues/readiness/opening-core");
const { getDuesReadinessForOwner } = await import("../../src/lib/dues/readiness");
const { loadReadinessSnapshot } = await import("../../src/lib/dues/readiness/snapshot");
const { branchFingerprint, openingReviewBinding, pricingAckBinding, studentFingerprint } = await import("../../src/lib/dues/readiness/fingerprint");
const { tenantGuardExtension } = await import("../../src/lib/tenant/tenant-guard");
const { recordPayment } = await import("../../src/lib/payments/payment-actions");
const { updatePlan } = await import("../../src/lib/payments/plan-actions");
const { correctPlanTerms } = await import("../../src/lib/dues/config-actions");
const { termsRevision } = await import("../../src/lib/dues/config-input");

const prisma = getTestPrismaClient();
type Db = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];
type Fixture = Awaited<ReturnType<typeof makeAccountingOrg>>;
type CoreTx = Parameters<NonNullable<import("../../src/lib/dues/readiness/opening-core").TestHooks["afterLocks"]>>[0];

const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
const S = { year: 2026, month: 12 };
const PRISTINE: ActionState = {};

let a: Fixture;
let b: Fixture;
let director: { id: string };
let usdPlan: { id: string };
let futureTerms: { id: string }; // A, USD plan, effective 2099-01 (correctable in place, D25)
let n = 0;

function actAs(userId: string | null, organizationId: string, role = "ADMIN") {
  currentSession = userId ? { user: { id: userId, role }, activeOrganizationId: organizationId } : null;
}
const asOwner = () => actAs(a.admin.id, a.org.id);
const ctx = (): TenantContext => ({
  kind: "tenant", actorUserId: a.admin.id, organizationId: a.org.id, organizationRole: "ADMIN", academyIds: "ALL", selfStudentId: null, linkedStudentId: null,
});
const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};

/** A different past month for every call (2005-01 onward, far below today), so drafts never collide and are never in the future. */
let monthCounter = 0;
function pastMonth() {
  const i = monthCounter++;
  return { year: 2005 + Math.floor(i / 12), month: (i % 12) + 1 };
}
const draftForm = (studentId: string | null, over: Record<string, string> = {}) => {
  const m = pastMonth();
  return form({
    ...(studentId ? { studentId } : {}),
    coverageYear: String(m.year), coverageMonth: String(m.month), amount: "100.00", currency: "USD", note: "Unpaid before the switch", ...over,
  });
};
const content = (over: Partial<import("../../src/lib/dues/readiness/opening-core").DraftContent> = {}) => {
  const m = pastMonth();
  return { coverageYear: m.year, coverageMonth: m.month, amount: "100.00", currency: "USD" as const, note: "Unpaid before the switch", legacyPaymentPeriodId: null, ...over };
};

async function newStudent(fx: Fixture, label: string) {
  n++;
  const student = await prisma.student.create({
    data: {
      organizationId: fx.org.id, homeAcademyId: fx.academy.id, firstName: "Opening", lastName: `${label}${n}`, phone: "00000000",
      email: `opening8c-${label}-${n}-${suffix}@example.com`, currentRankId: await fx.rankId("WHITE"), codeHash: `opening8c-${label}-${n}-${suffix}`, status: "ACTIVE",
    },
  });
  await prisma.studentStatusChange.create({
    data: { organizationId: fx.org.id, studentId: student.id, status: "ACTIVE", effectiveOn: new Date(Date.UTC(2022, 0, 1)), sequence: 1, source: "EVENT", actorId: fx.admin.id },
  });
  return student.id;
}

async function latestDraft(studentId: string) {
  return prisma.duesOpeningItem.findFirstOrThrow({ where: { organizationId: a.org.id, studentId }, orderBy: { createdAt: "desc" } });
}

/** What the owner's page showed: the report's fingerprints turned into the two bindings for S. */
async function shownBindings(studentId: string, candidate = S) {
  asOwner();
  const result = await getDuesReadinessForOwner(a.org.id, candidate);
  if (!result.ok) throw new Error("expected a report");
  const studentFp = result.report.fingerprints.students[studentId];
  const home = (await prisma.student.findUniqueOrThrow({ where: { id: studentId } })).homeAcademyId;
  return { opening: openingReviewBinding(candidate, studentFp), pricing: pricingAckBinding(candidate, studentFp, result.report.fingerprints.branches[home]) };
}
async function reportState(studentId: string) {
  asOwner();
  const result = await getDuesReadinessForOwner(a.org.id, S);
  if (!result.ok) throw new Error("expected a report");
  return { report: result.report, state: result.report.confirmations.find((c) => c.studentId === studentId)! };
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pidOf = async (tx: CoreTx) => (await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`)[0].pid;
/**
 * Polls until at least `count` backends are genuinely waiting behind `holderPid` (real lock waits), directly or through a chain:
 * a third request for one row queues behind the second request's tuple lock, so it is blocked by that waiter, not the holder.
 */
async function waitForWaiters(holderPid: number, count: number, timeoutMs = 10_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const rows = await prisma.$queryRaw<{ pid: number; blockers: number[] }[]>`
      SELECT pid, pg_blocking_pids(pid) AS blockers FROM pg_stat_activity WHERE cardinality(pg_blocking_pids(pid)) > 0`;
    const behind = new Set<number>([holderPid]);
    for (let grew = true; grew; ) {
      grew = false;
      for (const r of rows) {
        if (!behind.has(r.pid) && r.blockers.some((p) => behind.has(p))) {
          behind.add(r.pid);
          grew = true;
        }
      }
    }
    if (behind.size - 1 >= count) return;
    await sleep(25);
  }
  throw new Error(`fewer than ${count} backends were waiting behind ${holderPid}`);
}
/** Holds the first call's transaction right after its locks until `release` resolves. */
function holder() {
  const locked = deferred<number>();
  const release = deferred();
  return {
    locked: locked.promise,
    release: () => release.resolve(),
    hooks: {
      afterLocks: async (tx: CoreTx) => {
        locked.resolve(await pidOf(tx));
        await release.promise;
      },
    },
  };
}

async function ledgerCounts(organizationId: string) {
  return {
    obligations: await prisma.duesObligation.count({ where: { organizationId } }),
    coverage: await prisma.duesCoverage.count({ where: { organizationId } }),
    lateFees: await prisma.duesLateFee.count({ where: { organizationId } }),
    payments: await prisma.duesPayment.count({ where: { organizationId } }),
    settlements: await prisma.duesSettlement.count({ where: { organizationId } }),
    paymentPeriods: await prisma.paymentPeriod.count({ where: { organizationId } }),
  };
}

function constrainedClient(max: number) {
  const pg = new Pool({ connectionString: resolveGuardedTestDatabaseUrl(), max });
  const base = new PrismaClient({ adapter: new PrismaPg(pg, { disposeExternalPool: true }) });
  return { client: base.$extends(tenantGuardExtension()), pg, base };
}
async function withPool<T>(max: number, fn: (pg: Pool) => Promise<T>): Promise<T> {
  const c = constrainedClient(max);
  pool.client = c.client;
  try {
    return await fn(c.pg);
  } finally {
    pool.client = null;
    await c.base.$disconnect();
  }
}

beforeAll(async () => {
  a = await makeAccountingOrg("CUMULATIVE", "open8c-a");
  b = await makeAccountingOrg("CUMULATIVE", "open8c-b");
  usdPlan = await prisma.paymentPlan.create({ data: { organizationId: a.org.id, academyId: a.academy.id, name: `USD monthly ${suffix}` } });
  await prisma.paymentPlanTerms.create({
    data: { organizationId: a.org.id, planId: usdPlan.id, effectiveYear: 2022, effectiveMonth: 1, priceAmount: "100.00", currency: "USD", monthsCovered: 1, createdById: a.admin.id },
  });
  futureTerms = await prisma.paymentPlanTerms.create({
    data: { organizationId: a.org.id, planId: usdPlan.id, effectiveYear: 2099, effectiveMonth: 1, priceAmount: "120.00", currency: "USD", monthsCovered: 1, createdById: a.admin.id },
  });
  await prisma.duesPolicyVersion.create({
    data: { organizationId: a.org.id, academyId: a.academy.id, effectiveYear: 2022, effectiveMonth: 1, dueDay: 20, graceDay: 5, lateFeeAmount: "20.00", lateFeeCurrency: "USD", createdById: a.admin.id },
  });
  director = await prisma.user.create({ data: { email: `open8c-director-${suffix}@example.com`, passwordHash: "x", role: "DIRECTOR" } });
  await prisma.organizationMembership.create({ data: { userId: director.id, organizationId: a.org.id, role: "DIRECTOR" } });
  await prisma.staffAssignment.create({ data: { userId: director.id, academyId: a.academy.id, organizationId: a.org.id, role: "DIRECTOR" } });
}, 120_000);

afterAll(async () => {
  pool.client = null;
  const orgIds = [a?.org.id, b?.org.id].filter(Boolean) as string[];
  if (orgIds.length > 0) {
    // Test-only: drafts and confirmations reject DELETE (8b triggers), so committed fixture rows are removed with the triggers off
    // for this transaction alone. The migration's triggers are untouched.
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL session_replication_role = replica");
      for (const table of ["DuesReadinessConfirmation", "DuesOpeningItem"]) {
        await tx.$executeRawUnsafe(`DELETE FROM "${table}" WHERE "organizationId" = ANY($1::text[])`, orgIds);
      }
    });
  }
  for (const fx of [a, b]) {
    if (!fx) continue;
    await prisma.paymentPeriod.deleteMany({ where: { organizationId: fx.org.id } });
    await prisma.studentPlanAssignment.deleteMany({ where: { organizationId: fx.org.id } });
    await prisma.paymentPlanTerms.deleteMany({ where: { organizationId: fx.org.id } });
    await prisma.duesPolicyVersion.deleteMany({ where: { organizationId: fx.org.id } });
    await prisma.paymentPlan.deleteMany({ where: { organizationId: fx.org.id } });
    await prisma.staffAssignment.deleteMany({ where: { organizationId: fx.org.id } });
    await fx.drop();
  }
  if (director) await prisma.user.deleteMany({ where: { id: director.id } });
}, 120_000);

describe("authorization: owner only, server-derived actor, uniform notFound", () => {
  it("the owner creates a draft; the actor is the session user even when the form names another", async () => {
    const studentId = await newStudent(a, "auth");
    asOwner();
    const f = draftForm(studentId, { createdById: director.id, organizationId: b.org.id, withdrawnById: director.id });
    expect(await actions.createOpeningDraft(a.org.id, PRISTINE, f)).toEqual({ ok: true });
    const d = await latestDraft(studentId);
    expect(d).toMatchObject({ organizationId: a.org.id, createdById: a.admin.id, withdrawnAt: null, withdrawnById: null });
    expect(await prisma.auditLog.count({ where: { organizationId: a.org.id, action: "duesOpeningItem.create", entityId: d.id, actorId: a.admin.id } })).toBe(1);
  });

  it("a Director of the organization and an anonymous caller get notFound for every action, and nothing is written", async () => {
    const studentId = await newStudent(a, "dir");
    const before = await prisma.duesOpeningItem.count({ where: { organizationId: a.org.id } });
    for (const who of [() => actAs(director.id, a.org.id, "DIRECTOR"), () => actAs(null, a.org.id)]) {
      who();
      expect(await actions.createOpeningDraft(a.org.id, PRISTINE, draftForm(studentId))).toEqual({ error: "notFound" });
      expect(await actions.withdrawOpeningDraft(a.org.id, PRISTINE, form({ draftId: "x", reason: "r" }))).toEqual({ error: "notFound" });
      const review = form({ studentId, candidateYear: "2026", candidateMonth: "12", binding: "a".repeat(64), declaration: "noOpeningDebt" });
      expect(await actions.recordOpeningReview(a.org.id, PRISTINE, review)).toEqual({ error: "notFound" });
    }
    expect(await prisma.duesOpeningItem.count({ where: { organizationId: a.org.id } })).toBe(before);
  });

  it("another organization's owner gets notFound; the existing security audit records the refusal; nothing else is written", async () => {
    const studentId = await newStudent(a, "xorg");
    const refusals = () => prisma.auditLog.count({ where: { organizationId: a.org.id, action: "organization.accessRefused", actorId: b.admin.id } });
    const refusalsBefore = await refusals();
    actAs(b.admin.id, a.org.id);
    expect(await actions.createOpeningDraft(a.org.id, PRISTINE, draftForm(studentId))).toEqual({ error: "notFound" });
    expect(await refusals()).toBe(refusalsBefore + 1);
    expect(await prisma.duesOpeningItem.count({ where: { organizationId: a.org.id, studentId } })).toBe(0);
    expect(await prisma.auditLog.count({ where: { organizationId: a.org.id, actorId: b.admin.id, NOT: { action: "organization.accessRefused" } } })).toBe(0);
  });

  it("a student or draft of another organization is notFound to this organization's owner", async () => {
    const foreignStudent = await newStudent(b, "foreign");
    actAs(b.admin.id, b.org.id);
    expect(await actions.createOpeningDraft(b.org.id, PRISTINE, draftForm(foreignStudent))).toEqual({ ok: true });
    const foreignDraft = await prisma.duesOpeningItem.findFirstOrThrow({ where: { organizationId: b.org.id, studentId: foreignStudent } });
    asOwner();
    expect(await actions.createOpeningDraft(a.org.id, PRISTINE, draftForm(foreignStudent))).toEqual({ error: "notFound" });
    expect(await actions.replaceOpeningDraft(a.org.id, PRISTINE, draftForm(null, { draftId: foreignDraft.id }))).toEqual({ error: "notFound" });
    expect(await actions.withdrawOpeningDraft(a.org.id, PRISTINE, form({ draftId: foreignDraft.id, reason: "not mine" }))).toEqual({ error: "notFound" });
    const ack = form({ studentId: foreignStudent, candidateYear: "2026", candidateMonth: "12", binding: "a".repeat(64) });
    expect(await actions.acknowledgePricing(a.org.id, PRISTINE, ack)).toEqual({ error: "notFound" });
    expect(await prisma.duesOpeningItem.findUniqueOrThrow({ where: { id: foreignDraft.id } })).toMatchObject({ withdrawnAt: null });
  });
});

describe("validation", () => {
  it("amount, currency, note, month and future month are refused with field errors; boundaries accepted", async () => {
    const studentId = await newStudent(a, "valid");
    asOwner();
    const cases: [Record<string, string>, string][] = [
      [{ amount: "0" }, "amount"], [{ amount: "0.00" }, "amount"], [{ amount: "0.001" }, "amount"], [{ amount: "1,000" }, "amount"],
      [{ amount: "-5.00" }, "amount"], [{ amount: "+5.00" }, "amount"], [{ amount: "100000000" }, "amount"],
      [{ currency: "EUR" }, "currency"], [{ currency: "" }, "currency"],
      [{ note: "   " }, "note"], [{ note: "x".repeat(501) }, "note"],
      [{ coverageMonth: "0" }, "coverageMonth"], [{ coverageMonth: "13" }, "coverageMonth"], [{ coverageYear: "1999" }, "coverageMonth"],
    ];
    for (const [over, field] of cases) {
      const result = await actions.createOpeningDraft(a.org.id, PRISTINE, draftForm(studentId, over));
      expect(result, JSON.stringify(over)).toMatchObject({ error: "invalid" });
      expect(Object.keys(result.fieldErrors ?? {}), JSON.stringify(over)).toContain(field);
    }
    expect(await actions.createOpeningDraft(a.org.id, PRISTINE, draftForm(studentId, { coverageYear: "2100", coverageMonth: "12" }))).toEqual({
      error: "invalid", fieldErrors: { coverageMonth: ["future"] },
    });
    expect(await prisma.duesOpeningItem.count({ where: { organizationId: a.org.id, studentId } })).toBe(0);
    expect(await actions.createOpeningDraft(a.org.id, PRISTINE, draftForm(studentId, { amount: "99999999.99", note: `  ${"é".repeat(500)}  ` }))).toEqual({ ok: true });
    expect((await latestDraft(studentId)).note).toBe("é".repeat(500));
  });

  it("legacy link: another organization's or a nonexistent row is notFound; this organization's row for another student or month is invalid; the matching row is accepted", async () => {
    const studentId = await newStudent(a, "link");
    const other = await newStudent(a, "link-other");
    const foreign = await newStudent(b, "link-foreign");
    const period = (fx: Fixture, sid: string, month: number, planId: string) =>
      prisma.paymentPeriod.create({
        data: { organizationId: fx.org.id, studentId: sid, academyId: fx.academy.id, year: 2025, month, planId, status: "PENDING", amount: "50.00", currency: "USD", recordedById: fx.admin.id },
      });
    const foreignPlan = await prisma.paymentPlan.create({ data: { organizationId: b.org.id, academyId: b.academy.id, name: `B plan ${suffix}` } });
    const mine = await period(a, studentId, 6, usdPlan.id);
    const others = await period(a, other, 6, usdPlan.id);
    const foreignRow = await period(b, foreign, 6, foreignPlan.id);
    asOwner();
    const june = { coverageYear: "2025", coverageMonth: "6" };
    expect(await actions.createOpeningDraft(a.org.id, PRISTINE, draftForm(studentId, { ...june, legacyPaymentPeriodId: foreignRow.id }))).toEqual({ error: "notFound" });
    expect(await actions.createOpeningDraft(a.org.id, PRISTINE, draftForm(studentId, { ...june, legacyPaymentPeriodId: "does-not-exist" }))).toEqual({ error: "notFound" });
    const mismatch = { error: "invalid", fieldErrors: { legacyPaymentPeriodId: ["mismatch"] } };
    expect(await actions.createOpeningDraft(a.org.id, PRISTINE, draftForm(studentId, { ...june, legacyPaymentPeriodId: others.id }))).toEqual(mismatch);
    expect(await actions.createOpeningDraft(a.org.id, PRISTINE, draftForm(studentId, { coverageYear: "2025", coverageMonth: "7", legacyPaymentPeriodId: mine.id }))).toEqual(mismatch);
    expect(await prisma.duesOpeningItem.count({ where: { organizationId: a.org.id, studentId } })).toBe(0);
    expect(await actions.createOpeningDraft(a.org.id, PRISTINE, draftForm(studentId, { ...june, legacyPaymentPeriodId: mine.id }))).toEqual({ ok: true });
    expect((await latestDraft(studentId)).legacyPaymentPeriodId).toBe(mine.id);
  });

  it("confirmation inputs: a malformed binding, month or declaration is invalid; a declaration contradicting the drafts is invalid", async () => {
    const studentId = await newStudent(a, "confval");
    asOwner();
    const base = { studentId, candidateYear: "2026", candidateMonth: "12", declaration: "noOpeningDebt" };
    for (const over of [{ binding: "A".repeat(64) }, { binding: "ab" }, { binding: "a".repeat(64), candidateMonth: "13" }, { binding: "a".repeat(64), declaration: "maybe" }]) {
      expect(await actions.recordOpeningReview(a.org.id, PRISTINE, form({ ...base, ...over })), JSON.stringify(over)).toMatchObject({ error: "invalid" });
    }
    const shown = await shownBindings(studentId);
    asOwner();
    expect(await actions.recordOpeningReview(a.org.id, PRISTINE, form({ ...base, binding: shown.opening, declaration: "itemsAsShown" }))).toEqual({
      error: "invalid", fieldErrors: { declaration: ["mismatch"] },
    });
    expect(await prisma.duesReadinessConfirmation.count({ where: { organizationId: a.org.id, studentId } })).toBe(0);
  });
});

describe("draft operations", () => {
  it("same-month and changed-month replacement leave one active draft, mark the predecessor and keep its content", async () => {
    const studentId = await newStudent(a, "replace");
    asOwner();
    await actions.createOpeningDraft(a.org.id, PRISTINE, draftForm(studentId, { coverageYear: "2024", coverageMonth: "3", amount: "100.00" }));
    const first = await latestDraft(studentId);
    expect(await actions.replaceOpeningDraft(a.org.id, PRISTINE, draftForm(null, { draftId: first.id, coverageYear: "2024", coverageMonth: "3", amount: "80.00" }))).toEqual({ ok: true });
    const second = await latestDraft(studentId);
    expect(await actions.replaceOpeningDraft(a.org.id, PRISTINE, draftForm(null, { draftId: second.id, coverageYear: "2024", coverageMonth: "4", amount: "80.00" }))).toEqual({ ok: true });
    const rows = await prisma.duesOpeningItem.findMany({ where: { organizationId: a.org.id, studentId } });
    const active = rows.filter((r) => r.withdrawnAt === null);
    expect(active).toHaveLength(1);
    expect([active[0].coverageYear, active[0].coverageMonth, active[0].amount.toFixed(2)]).toEqual([2024, 4, "80.00"]);
    const firstNow = rows.find((r) => r.id === first.id)!;
    expect(firstNow).toMatchObject({ withdrawalKind: "EDITED", supersededById: second.id, withdrawnById: a.admin.id });
    expect(firstNow.amount.toFixed(2)).toBe("100.00");
    expect(await prisma.auditLog.count({ where: { organizationId: a.org.id, action: "duesOpeningItem.replace", entityId: { in: [first.id, second.id] } } })).toBe(2);
  });

  it("replacing into an occupied month rolls the whole edit back: monthHasDraft, the predecessor stays active, no successor, no audit row", async () => {
    const studentId = await newStudent(a, "collide");
    asOwner();
    await actions.createOpeningDraft(a.org.id, PRISTINE, draftForm(studentId, { coverageYear: "2024", coverageMonth: "5" }));
    await actions.createOpeningDraft(a.org.id, PRISTINE, draftForm(studentId, { coverageYear: "2024", coverageMonth: "6" }));
    const june = await latestDraft(studentId);
    expect(await actions.replaceOpeningDraft(a.org.id, PRISTINE, draftForm(null, { draftId: june.id, coverageYear: "2024", coverageMonth: "5" }))).toEqual({ error: "monthHasDraft" });
    expect(await prisma.duesOpeningItem.findUniqueOrThrow({ where: { id: june.id } })).toMatchObject({ withdrawnAt: null, supersededById: null });
    expect(await prisma.duesOpeningItem.count({ where: { organizationId: a.org.id, studentId } })).toBe(2);
    expect(await prisma.auditLog.count({ where: { organizationId: a.org.id, action: "duesOpeningItem.replace", entityId: june.id } })).toBe(0);
    expect(await actions.createOpeningDraft(a.org.id, PRISTINE, draftForm(studentId, { coverageYear: "2024", coverageMonth: "5" }))).toEqual({ error: "monthHasDraft" });
  });

  it("a withdrawn draft can be neither replaced nor withdrawn again (stale)", async () => {
    const studentId = await newStudent(a, "stale");
    asOwner();
    await actions.createOpeningDraft(a.org.id, PRISTINE, draftForm(studentId));
    const d = await latestDraft(studentId);
    expect(await actions.withdrawOpeningDraft(a.org.id, PRISTINE, form({ draftId: d.id, reason: "  Entered by mistake  " }))).toEqual({ ok: true });
    expect(await prisma.duesOpeningItem.findUniqueOrThrow({ where: { id: d.id } })).toMatchObject({ withdrawalKind: "WITHDRAWN", withdrawalReason: "Entered by mistake" });
    expect(await actions.withdrawOpeningDraft(a.org.id, PRISTINE, form({ draftId: d.id, reason: "again" }))).toEqual({ error: "stale" });
    expect(await actions.replaceOpeningDraft(a.org.id, PRISTINE, draftForm(null, { draftId: d.id }))).toEqual({ error: "stale" });
    expect(await actions.withdrawOpeningDraft(a.org.id, PRISTINE, form({ draftId: d.id, reason: " " }))).toEqual({ error: "invalid", fieldErrors: { reason: ["invalid"] } });
  });

  it("A: two edits of one draft at once — the second waits at the student lock, then finds it withdrawn (stale); one successor", async () => {
    const studentId = await newStudent(a, "concur");
    asOwner();
    await actions.createOpeningDraft(a.org.id, PRISTINE, draftForm(studentId));
    const d = await latestDraft(studentId);
    const h = holder();
    const first = core.replaceOpeningDraftCore(ctx(), d.id, content({ coverageYear: d.coverageYear, coverageMonth: d.coverageMonth, amount: "80.00" }), h.hooks);
    const holderPid = await h.locked;
    const second = core.withdrawOpeningDraftCore(ctx(), d.id, "racing withdrawal");
    try {
      await waitForWaiters(holderPid, 1);
    } finally {
      h.release();
    }
    expect(await first).toEqual({ ok: true });
    expect(await second).toEqual({ error: "stale" });
    expect(await prisma.duesOpeningItem.count({ where: { organizationId: a.org.id, studentId, withdrawnAt: null } })).toBe(1);
  }, 60_000);

  it("A: two creates for one month at once — one succeeds, the other is monthHasDraft", async () => {
    const studentId = await newStudent(a, "dupcreate");
    const h = holder();
    const m = content();
    const first = core.createOpeningDraftCore(ctx(), studentId, m, h.hooks);
    const holderPid = await h.locked;
    const second = core.createOpeningDraftCore(ctx(), studentId, { ...m, amount: "70.00" });
    try {
      await waitForWaiters(holderPid, 1);
    } finally {
      h.release();
    }
    expect(await first).toEqual({ ok: true });
    expect(await second).toEqual({ error: "monthHasDraft" });
  }, 60_000);
});

describe("confirmations: stale reviews and explicit no debt", () => {
  const review = (studentId: string, binding: string, declaration = "noOpeningDebt") =>
    form({ studentId, candidateYear: "2026", candidateMonth: "12", binding, declaration });

  it("explicit no debt is accepted only with zero active drafts; a later draft makes it stale; withdrawing that draft does not revive it", async () => {
    const studentId = await newStudent(a, "nodebt");
    const shown = await shownBindings(studentId);
    asOwner();
    expect(await actions.recordOpeningReview(a.org.id, PRISTINE, review(studentId, shown.opening))).toEqual({ ok: true });
    const stored = await prisma.duesReadinessConfirmation.findFirstOrThrow({ where: { organizationId: a.org.id, studentId } });
    expect(stored).toMatchObject({ kind: "OPENING_REVIEWED", sequence: 1, declaredNoOpeningDebt: true, binding: shown.opening, confirmedById: a.admin.id, fingerprintFormat: "r2" });
    const valid = await reportState(studentId);
    expect(valid.state.openingReview.state).toBe("valid");
    expect(valid.report.checks.find((c) => c.id === 9)!.items).not.toContain(`student:${studentId}`);

    asOwner();
    await actions.createOpeningDraft(a.org.id, PRISTINE, draftForm(studentId));
    expect((await reportState(studentId)).state.openingReview.state).toBe("stale");
    asOwner();
    await actions.withdrawOpeningDraft(a.org.id, PRISTINE, form({ draftId: (await latestDraft(studentId)).id, reason: "mistake" }));
    const after = await reportState(studentId);
    expect(after.state.openingReview.state).toBe("stale");
    expect(after.report.checks.find((c) => c.id === 9)!.items).toContain(`student:${studentId}`);
    asOwner();
    expect(await actions.recordOpeningReview(a.org.id, PRISTINE, review(studentId, shown.opening))).toEqual({ error: "stale" });
  });

  it("edit then revert through the actions never revives an earlier review", async () => {
    const studentId = await newStudent(a, "revert");
    asOwner();
    await actions.createOpeningDraft(a.org.id, PRISTINE, draftForm(studentId, { coverageYear: "2024", coverageMonth: "8", amount: "100.00" }));
    const shown = await shownBindings(studentId);
    asOwner();
    expect(await actions.recordOpeningReview(a.org.id, PRISTINE, review(studentId, shown.opening, "itemsAsShown"))).toEqual({ ok: true });
    await actions.replaceOpeningDraft(a.org.id, PRISTINE, draftForm(null, { draftId: (await latestDraft(studentId)).id, coverageYear: "2024", coverageMonth: "8", amount: "60.00" }));
    asOwner();
    await actions.replaceOpeningDraft(a.org.id, PRISTINE, draftForm(null, { draftId: (await latestDraft(studentId)).id, coverageYear: "2024", coverageMonth: "8", amount: "100.00" }));
    expect((await reportState(studentId)).state.openingReview.state).toBe("stale");
  });

  it("a legacy payment recorded through the real recordPayment after the page was read makes the submitted review stale", async () => {
    const studentId = await newStudent(a, "legacy");
    const shown = await shownBindings(studentId);
    asOwner();
    expect(await recordPayment(a.org.id, PRISTINE, form({ studentId, year: "2026", month: "1", planId: usdPlan.id, status: "PAID", amount: "100" }))).toMatchObject({ ok: true });
    expect(await actions.recordOpeningReview(a.org.id, PRISTINE, review(studentId, shown.opening))).toEqual({ error: "stale" });
  });

  it("a status change after the page was read makes the submitted review stale", async () => {
    const studentId = await newStudent(a, "status");
    const shown = await shownBindings(studentId);
    await prisma.studentStatusChange.create({
      data: { organizationId: a.org.id, studentId, status: "ACTIVE", effectiveOn: new Date(Date.UTC(2023, 0, 1)), sequence: 2, source: "EVENT", actorId: a.admin.id },
    });
    asOwner();
    expect(await actions.recordOpeningReview(a.org.id, PRISTINE, review(studentId, shown.opening))).toEqual({ error: "stale" });
  });

  it("pricing: a D25 terms correction (real config action) and a plan rename (real legacy action) each make an acknowledgement stale", async () => {
    const studentId = await newStudent(a, "pricing");
    const ack = (binding: string) => form({ studentId, candidateYear: "2026", candidateMonth: "12", binding });
    let shown = await shownBindings(studentId);
    asOwner();
    expect(await actions.acknowledgePricing(a.org.id, PRISTINE, ack(shown.pricing))).toEqual({ ok: true });
    expect((await reportState(studentId)).state.pricingAck.state).toBe("valid");

    const row = await prisma.paymentPlanTerms.findUniqueOrThrow({ where: { id: futureTerms.id } });
    asOwner();
    expect(await correctPlanTerms(a.org.id, PRISTINE, form({ termsId: row.id, expectedRevision: termsRevision(row), priceAmount: "125.00", currency: "USD", monthsCovered: "1" }))).toEqual({ ok: true });
    expect((await reportState(studentId)).state.pricingAck.state).toBe("stale");
    asOwner();
    expect(await actions.acknowledgePricing(a.org.id, PRISTINE, ack(shown.pricing))).toEqual({ error: "stale" });

    shown = await shownBindings(studentId);
    asOwner();
    expect(await actions.acknowledgePricing(a.org.id, PRISTINE, ack(shown.pricing))).toEqual({ ok: true });
    expect((await reportState(studentId)).state.pricingAck).toMatchObject({ state: "valid", sequence: 2 });
    asOwner();
    expect(await updatePlan(a.org.id, PRISTINE, form({ planId: usdPlan.id, name: `USD monthly renamed ${suffix}` }))).toMatchObject({ ok: true });
    expect((await reportState(studentId)).state.pricingAck.state).toBe("stale");
    asOwner();
    expect(await actions.acknowledgePricing(a.org.id, PRISTINE, ack(shown.pricing))).toEqual({ error: "stale" });
  });
});

describe("A: transaction ordering under the student lock", () => {
  it("A1: three concurrent reviews of one identity all commit, with sequences 1-3; the report's current one is 3", async () => {
    const studentId = await newStudent(a, "a1");
    const { opening } = await shownBindings(studentId);
    const input = { studentId, candidate: S, kind: "OPENING_REVIEWED" as const, binding: opening, declaration: "noOpeningDebt" as const };
    const h = holder();
    const first = core.recordConfirmationCore(ctx(), input, h.hooks);
    const holderPid = await h.locked;
    const others = [core.recordConfirmationCore(ctx(), input), core.recordConfirmationCore(ctx(), input)];
    try {
      await waitForWaiters(holderPid, 2);
    } finally {
      h.release();
    }
    expect(await Promise.all([first, ...others])).toEqual([{ ok: true }, { ok: true }, { ok: true }]);
    const rows = await prisma.duesReadinessConfirmation.findMany({ where: { organizationId: a.org.id, studentId }, orderBy: { sequence: "asc" } });
    expect(rows.map((r) => r.sequence)).toEqual([1, 2, 3]);
    expect((await reportState(studentId)).state.openingReview).toMatchObject({ state: "valid", sequence: 3 });
  }, 60_000);

  it("A2: a draft committed first makes a confirmation waiting on the lock stale; a confirmation committed first is stale after the draft", async () => {
    const studentId = await newStudent(a, "a2");
    const { opening } = await shownBindings(studentId);
    const input = { studentId, candidate: S, kind: "OPENING_REVIEWED" as const, binding: opening, declaration: "noOpeningDebt" as const };

    const h1 = holder();
    const draft = core.createOpeningDraftCore(ctx(), studentId, content(), h1.hooks);
    const p1 = await h1.locked;
    const confirmation = core.recordConfirmationCore(ctx(), input);
    try {
      await waitForWaiters(p1, 1);
    } finally {
      h1.release();
    }
    expect(await draft).toEqual({ ok: true });
    expect(await confirmation).toEqual({ error: "stale" });

    const fresh = (await shownBindings(studentId)).opening;
    const h2 = holder();
    const confirmFirst = core.recordConfirmationCore(ctx(), { ...input, binding: fresh, declaration: "itemsAsShown" }, h2.hooks);
    const p2 = await h2.locked;
    const draftAfter = core.createOpeningDraftCore(ctx(), studentId, content());
    try {
      await waitForWaiters(p2, 1);
    } finally {
      h2.release();
    }
    expect(await confirmFirst).toEqual({ ok: true });
    expect(await draftAfter).toEqual({ ok: true });
    expect((await reportState(studentId)).state.openingReview.state).toBe("stale");
  }, 60_000);

  it("A3: a replacement committed first makes a waiting confirmation stale", async () => {
    const studentId = await newStudent(a, "a3");
    asOwner();
    await actions.createOpeningDraft(a.org.id, PRISTINE, draftForm(studentId));
    const d = await latestDraft(studentId);
    const { opening } = await shownBindings(studentId);
    const h = holder();
    const replace = core.replaceOpeningDraftCore(ctx(), d.id, content({ coverageYear: d.coverageYear, coverageMonth: d.coverageMonth, amount: "55.00" }), h.hooks);
    const pid = await h.locked;
    const confirmation = core.recordConfirmationCore(ctx(), { studentId, candidate: S, kind: "OPENING_REVIEWED", binding: opening, declaration: "itemsAsShown" });
    try {
      await waitForWaiters(pid, 1);
    } finally {
      h.release();
    }
    expect(await replace).toEqual({ ok: true });
    expect(await confirmation).toEqual({ error: "stale" });
  }, 60_000);
});

describe("B: the single-statement content read", () => {
  it("B1: equals the report loader's student and branch fingerprints across nulls, currencies, ledger rows and draft states", async () => {
    class Rollback extends Error {}
    try {
      await prisma.$transaction(
        async (tx: Db) => {
          // A second branch in another timezone, with CRC configuration, an inactive plan and a policy with a prepayment limit.
          const a2 = await tx.academy.create({ data: { organizationId: a.org.id, name: "8c Second", slug: `open8c-a2-${suffix}`, kioskTokenHash: `open8c-a2-${suffix}`, timezone: "America/New_York" } });
          const crcPlan = await tx.paymentPlan.create({ data: { organizationId: a.org.id, academyId: a2.id, name: `CRC mensual ${suffix}` } });
          await tx.paymentPlan.create({ data: { organizationId: a.org.id, academyId: a2.id, name: `Retired ${suffix}`, active: false } });
          const crcTerms = { organizationId: a.org.id, planId: crcPlan.id, currency: "CRC" as const, createdById: a.admin.id };
          await tx.paymentPlanTerms.create({ data: { ...crcTerms, effectiveYear: 2022, effectiveMonth: 1, priceAmount: "25000.50", monthsCovered: 1 } });
          await tx.paymentPlanTerms.create({ data: { ...crcTerms, effectiveYear: 2024, effectiveMonth: 7, priceAmount: "70000.00", monthsCovered: 3 } });
          await tx.duesPolicyVersion.create({
            data: { organizationId: a.org.id, academyId: a2.id, effectiveYear: 2022, effectiveMonth: 1, dueDay: 31, graceDay: 1, lateFeeAmount: "0.00", lateFeeCurrency: "CRC", maxPrepaidMonths: 6, createdById: a.admin.id },
          });
          const student = (homeAcademyId: string, label: string, status: "ACTIVE" | "INACTIVE") =>
            a.rankId("WHITE").then((rank) =>
              tx.student.create({
                data: { organizationId: a.org.id, homeAcademyId, firstName: label, lastName: "Fixture", phone: "0", email: `open8c-${label}-${suffix}@example.com`, currentRankId: rank, codeHash: `open8c-${label}-${suffix}`, status },
              }),
            );
          const rich = await student(a.academy.id, "rich", "INACTIVE");
          const second = await student(a2.id, "second", "ACTIVE");
          for (const [sequence, status, source] of [[1, "ACTIVE", "BASELINE"], [2, "INACTIVE", "EVENT"]] as const) {
            await tx.studentStatusChange.create({ data: { organizationId: a.org.id, studentId: rich.id, status, effectiveOn: new Date(Date.UTC(2023, 1, 28)), sequence, source, actorId: a.admin.id } });
          }
          const assign = (studentId: string, planId: string | null, year: number, month: number) =>
            tx.studentPlanAssignment.create({ data: { organizationId: a.org.id, studentId, planId, effectiveYear: year, effectiveMonth: month, createdById: a.admin.id } });
          await assign(rich.id, usdPlan.id, 2023, 1);
          await assign(rich.id, null, 2024, 2);
          await assign(second.id, crcPlan.id, 2022, 1);
          const legacy = (studentId: string, academyId: string, planId: string, month: number, data: Record<string, unknown>) =>
            tx.paymentPeriod.create({ data: { organizationId: a.org.id, studentId, academyId, year: 2024, month, planId, recordedById: a.admin.id, currency: "USD", status: "PAID", ...data } as never });
          const paid = (await legacy(rich.id, a.academy.id, usdPlan.id, 1, { amount: "100.10" })) as { id: string };
          await legacy(rich.id, a.academy.id, usdPlan.id, 2, { status: "PENDING", amount: null });
          await legacy(rich.id, a.academy.id, usdPlan.id, 3, { status: "PROMO", amount: "0.00", promoName: "Familia 2×1", promoRecurring: true });
          await legacy(second.id, a2.id, crcPlan.id, 4, { status: "EXEMPT", amount: "25000.00", currency: "CRC" });
          const terms = await tx.paymentPlanTerms.findFirstOrThrow({ where: { organizationId: a.org.id, planId: usdPlan.id, effectiveYear: 2022 } });
          const policy = await tx.duesPolicyVersion.findFirstOrThrow({ where: { organizationId: a.org.id, academyId: a.academy.id } });
          const obligation = await tx.duesObligation.create({
            data: {
              organizationId: a.org.id, studentId: rich.id, academyId: a.academy.id, type: "MONTHLY", origin: "SCHEDULED_JOB", coverageYear: 2025, coverageMonth: 3, monthsCovered: 1,
              amount: "100.00", currency: "USD", lateFeeAmount: "20.00", dueOn: new Date(Date.UTC(2025, 2, 20)), graceDeadline: new Date(Date.UTC(2025, 3, 5)),
              planTermsId: terms.id, policyVersionId: policy.id, createdById: a.admin.id,
            },
          });
          await tx.duesCoverage.create({ data: { organizationId: a.org.id, studentId: rich.id, obligationId: obligation.id, year: 2025, month: 3 } });
          // Drafts: EDITED with its successor (non-ASCII note, another currency), active with a link, WITHDRAWN, and one in CRC for the other student.
          const draft = (studentId: string, coverageYear: number, coverageMonth: number, amount: string, currency: "USD" | "CRC", note: string, extra: Record<string, unknown> = {}) =>
            tx.duesOpeningItem.create({ data: { organizationId: a.org.id, studentId, coverageYear, coverageMonth, amount, currency, note, createdById: a.admin.id, ...extra } });
          const edited = await draft(rich.id, 2024, 5, "40.00", "USD", "first");
          const successorId = `succ-${suffix}`;
          await tx.duesOpeningItem.update({ where: { id: edited.id }, data: { withdrawnAt: new Date(), withdrawnById: a.admin.id, withdrawalKind: "EDITED", supersededById: successorId } });
          await draft(rich.id, 2024, 5, "45.55", "CRC", "segundo — año ñ «x»", { id: successorId });
          await draft(rich.id, 2024, 1, "0.01", "USD", "linked", { legacyPaymentPeriodId: paid.id });
          const gone = await draft(rich.id, 2023, 12, "999.99", "USD", "gone");
          await tx.duesOpeningItem.update({ where: { id: gone.id }, data: { withdrawnAt: new Date(), withdrawnById: a.admin.id, withdrawalKind: "WITHDRAWN", withdrawalReason: "no" } });
          await draft(second.id, 2024, 2, "12345.67", "CRC", "crc");

          const report = await loadReadinessSnapshot(tx as never, a.org.id);
          expect(report.withdrawnOpeningItems.length).toBeGreaterThanOrEqual(2); // not vacuous
          let compared = 0;
          for (const st of report.students) {
            const single = await core.loadReviewContentInTx(tx as never, a.org.id, st.id, st.homeAcademyId);
            expect(studentFingerprint(single, st.id), `student ${st.id}`).toBe(studentFingerprint(report, st.id));
            expect(branchFingerprint(single, st.homeAcademyId), `branch ${st.homeAcademyId}`).toBe(branchFingerprint(report, st.homeAcademyId));
            compared++;
          }
          expect(compared).toBeGreaterThanOrEqual(3);
          throw new Rollback();
        },
        { timeout: 60_000 },
      );
    } catch (error) {
      if (!(error instanceof Rollback)) throw error;
    }
  }, 120_000);

  it("B1: every read is tenant-scoped — asked for another organization, the content of this student and branch is empty", async () => {
    const studentId = await newStudent(a, "scope");
    const c = await prisma.$transaction((tx) => core.loadReviewContentInTx(tx as never, b.org.id, studentId, a.academy.id));
    expect([c.students, c.statusChanges, c.branches, c.plans, c.terms, c.policies]).toEqual([[], [], [], [], [], []]);
  });

  it("B2: a non-participating write committed after the lock grant but before the statement is seen", async () => {
    const studentId = await newStudent(a, "b2");
    const row = await prisma.paymentPeriod.create({
      data: { organizationId: a.org.id, studentId, academyId: a.academy.id, year: 2025, month: 9, planId: usdPlan.id, status: "PENDING", amount: "100.00", currency: "USD", recordedById: a.admin.id },
    });
    const before = (await shownBindings(studentId)).opening;
    await prisma.paymentPeriod.update({ where: { id: row.id }, data: { status: "PAID" } });
    const afterEdit = (await shownBindings(studentId)).opening;
    await prisma.paymentPeriod.update({ where: { id: row.id }, data: { status: "PENDING" } });
    expect(afterEdit).not.toBe(before);
    // The legacy row takes no student lock, so the hook's update (on the separate test client) commits while the locks are held.
    const legacyEdit = { afterLocks: async () => void (await prisma.paymentPeriod.update({ where: { id: row.id }, data: { status: "PAID" } })) };
    const input = { studentId, candidate: S, kind: "OPENING_REVIEWED" as const, declaration: "noOpeningDebt" as const };
    expect(await core.recordConfirmationCore(ctx(), { ...input, binding: before }, legacyEdit)).toEqual({ error: "stale" });
    await prisma.paymentPeriod.update({ where: { id: row.id }, data: { status: "PENDING" } });
    expect(await core.recordConfirmationCore(ctx(), { ...input, binding: afterEdit }, legacyEdit)).toEqual({ ok: true });
    expect((await prisma.duesReadinessConfirmation.findFirstOrThrow({ where: { organizationId: a.org.id, studentId } })).binding).toBe(afterEdit);
  }, 60_000);

  it("B3: a non-participating write committed after the statement is not in the stored binding; the next report shows the confirmation stale", async () => {
    const studentId = await newStudent(a, "b3");
    const row = await prisma.paymentPeriod.create({
      data: { organizationId: a.org.id, studentId, academyId: a.academy.id, year: 2025, month: 10, planId: usdPlan.id, status: "PENDING", amount: "100.00", currency: "USD", recordedById: a.admin.id },
    });
    const shown = (await shownBindings(studentId)).opening;
    const late = { afterContentRead: async () => void (await prisma.paymentPeriod.update({ where: { id: row.id }, data: { amount: "90.00" } })) };
    expect(await core.recordConfirmationCore(ctx(), { studentId, candidate: S, kind: "OPENING_REVIEWED", binding: shown, declaration: "noOpeningDebt" }, late)).toEqual({ ok: true });
    expect((await prisma.duesReadinessConfirmation.findFirstOrThrow({ where: { organizationId: a.org.id, studentId } })).binding).toBe(shown);
    expect((await reportState(studentId)).state.openingReview.state).toBe("stale");
  }, 60_000);
});

describe("C: connection availability with a constrained pool (the tested scenarios only)", () => {
  it("C1: with a pool of ONE connection, every action completes (no nested acquisition)", async () => {
    const studentId = await newStudent(a, "c1");
    const shown = await shownBindings(studentId);
    await withPool(1, async (pg) => {
      asOwner();
      const confirm = { studentId, candidateYear: "2026", candidateMonth: "12" };
      expect(await actions.recordOpeningReview(a.org.id, PRISTINE, form({ ...confirm, binding: shown.opening, declaration: "noOpeningDebt" }))).toEqual({ ok: true });
      expect(await actions.acknowledgePricing(a.org.id, PRISTINE, form({ ...confirm, binding: shown.pricing }))).toEqual({ ok: true });
      expect(await actions.createOpeningDraft(a.org.id, PRISTINE, draftForm(studentId))).toEqual({ ok: true });
      const d = await latestDraft(studentId);
      const same = { draftId: d.id, coverageYear: String(d.coverageYear), coverageMonth: String(d.coverageMonth), amount: "1.00" };
      expect(await actions.replaceOpeningDraft(a.org.id, PRISTINE, draftForm(null, same))).toEqual({ ok: true });
      expect(await actions.withdrawOpeningDraft(a.org.id, PRISTINE, form({ draftId: (await latestDraft(studentId)).id, reason: "done" }))).toEqual({ ok: true });
      expect(pg.totalCount).toBeLessThanOrEqual(1);
    });
  }, 60_000);

  it("C2: with a pool of TWO, six concurrent confirmations (three for one identity, three for other students) all complete with correct sequences", async () => {
    const same = await newStudent(a, "c2same");
    const others = [await newStudent(a, "c2o1"), await newStudent(a, "c2o2"), await newStudent(a, "c2o3")];
    const bindings = new Map<string, string>();
    for (const id of [same, ...others]) bindings.set(id, (await shownBindings(id)).opening);
    await withPool(2, async (pg) => {
      asOwner();
      const call = (studentId: string) =>
        actions.recordOpeningReview(a.org.id, PRISTINE, form({ studentId, candidateYear: "2026", candidateMonth: "12", binding: bindings.get(studentId)!, declaration: "noOpeningDebt" }));
      const results = await Promise.all([call(same), call(others[0]), call(same), call(others[1]), call(same), call(others[2])]);
      expect(results).toEqual(Array(6).fill({ ok: true }));
      expect(pg.totalCount).toBeLessThanOrEqual(2);
    });
    const sequences = await prisma.duesReadinessConfirmation.findMany({ where: { organizationId: a.org.id, studentId: same }, orderBy: { sequence: "asc" } });
    expect(sequences.map((r) => r.sequence)).toEqual([1, 2, 3]);
    for (const id of others) expect(await prisma.duesReadinessConfirmation.count({ where: { organizationId: a.org.id, studentId: id, sequence: 1 } })).toBe(1);
  }, 60_000);

  it("C3: with a pool of TWO, a confirmation and two draft writes for one student at once all complete; outcomes are only the A2 ones", async () => {
    const studentId = await newStudent(a, "c3");
    const shown = await shownBindings(studentId);
    await withPool(2, async () => {
      asOwner();
      const results = await Promise.all([
        actions.recordOpeningReview(a.org.id, PRISTINE, form({ studentId, candidateYear: "2026", candidateMonth: "12", binding: shown.opening, declaration: "noOpeningDebt" })),
        actions.createOpeningDraft(a.org.id, PRISTINE, draftForm(studentId)),
        actions.createOpeningDraft(a.org.id, PRISTINE, draftForm(studentId)),
      ]);
      expect(results[1]).toEqual({ ok: true });
      expect(results[2]).toEqual({ ok: true });
      expect([{ ok: true }, { error: "stale" }]).toContainEqual(results[0]);
    });
    expect(["stale", "missing"]).toContain((await reportState(studentId)).state.openingReview.state); // never valid over drafts not seen
  }, 60_000);
});

describe("atomicity: an operation and its audit row commit together or not at all", () => {
  const boom = {
    beforeAudit: async () => {
      throw new Error("injected failure before the audit write");
    },
  };

  it("a failure between the change and its audit row leaves nothing: create, replace (marker reverted), withdraw, confirmation", async () => {
    const studentId = await newStudent(a, "atomic");
    await expect(core.createOpeningDraftCore(ctx(), studentId, content(), boom)).rejects.toThrow("injected failure");
    expect(await prisma.duesOpeningItem.count({ where: { organizationId: a.org.id, studentId } })).toBe(0);
    asOwner();
    await actions.createOpeningDraft(a.org.id, PRISTINE, draftForm(studentId));
    const d = await latestDraft(studentId);
    await expect(core.replaceOpeningDraftCore(ctx(), d.id, content({ coverageYear: d.coverageYear, coverageMonth: d.coverageMonth }), boom)).rejects.toThrow("injected failure");
    await expect(core.withdrawOpeningDraftCore(ctx(), d.id, "x", boom)).rejects.toThrow("injected failure");
    expect(await prisma.duesOpeningItem.findUniqueOrThrow({ where: { id: d.id } })).toMatchObject({ withdrawnAt: null, supersededById: null });
    expect(await prisma.duesOpeningItem.count({ where: { organizationId: a.org.id, studentId } })).toBe(1);
    const { opening } = await shownBindings(studentId);
    await expect(core.recordConfirmationCore(ctx(), { studentId, candidate: S, kind: "OPENING_REVIEWED", binding: opening, declaration: "itemsAsShown" }, boom)).rejects.toThrow("injected failure");
    expect(await prisma.duesReadinessConfirmation.count({ where: { organizationId: a.org.id, studentId } })).toBe(0);
    expect(await prisma.auditLog.count({ where: { organizationId: a.org.id, entityId: d.id, action: { not: "duesOpeningItem.create" } } })).toBe(0);
  }, 60_000);

  it("a failure AFTER the audit row (still inside the transaction) leaves neither the change nor its audit row", async () => {
    const studentId = await newStudent(a, "afteraudit");
    const late = {
      afterAudit: async () => {
        throw new Error("injected failure after the audit write");
      },
    };
    await expect(core.createOpeningDraftCore(ctx(), studentId, content(), late)).rejects.toThrow("injected failure");
    const { opening } = await shownBindings(studentId);
    await expect(core.recordConfirmationCore(ctx(), { studentId, candidate: S, kind: "OPENING_REVIEWED", binding: opening, declaration: "noOpeningDebt" }, late)).rejects.toThrow("injected failure");
    expect(await prisma.duesOpeningItem.count({ where: { organizationId: a.org.id, studentId } })).toBe(0);
    expect(await prisma.duesReadinessConfirmation.count({ where: { organizationId: a.org.id, studentId } })).toBe(0);
    const audits = await prisma.auditLog.findMany({ where: { organizationId: a.org.id, action: { in: ["duesOpeningItem.create", "duesReadinessConfirmation.record"] } } });
    expect(audits.filter((r) => JSON.stringify(r.after).includes(studentId))).toEqual([]);
  }, 60_000);

  it("a REAL audit-insert failure (a test-only trigger scoped to this organization) rolls back the draft and the confirmation", async () => {
    const studentId = await newStudent(a, "auditfail");
    const { opening } = await shownBindings(studentId);
    expect(a.org.id).toMatch(/^[a-z0-9]+$/); // embedded in the test-only DDL below
    const fn = `test_8c_refuse_audit_${a.org.id}`;
    await prisma.$executeRawUnsafe(`CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW."organizationId" = '${a.org.id}' AND NEW."action" LIKE 'dues%' THEN RAISE EXCEPTION 'test: audit write refused'; END IF; RETURN NEW; END $$`);
    await prisma.$executeRawUnsafe(`CREATE TRIGGER ${fn} BEFORE INSERT ON "AuditLog" FOR EACH ROW EXECUTE FUNCTION ${fn}()`);
    try {
      await expect(core.createOpeningDraftCore(ctx(), studentId, content())).rejects.toThrow();
      await expect(core.recordConfirmationCore(ctx(), { studentId, candidate: S, kind: "OPENING_REVIEWED", binding: opening, declaration: "noOpeningDebt" })).rejects.toThrow();
    } finally {
      await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${fn} ON "AuditLog"`);
      await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${fn}()`);
    }
    expect(await prisma.duesOpeningItem.count({ where: { organizationId: a.org.id, studentId } })).toBe(0);
    expect(await prisma.duesReadinessConfirmation.count({ where: { organizationId: a.org.id, studentId } })).toBe(0);
  }, 60_000);
});

describe("no financial effect, and the report end to end", () => {
  it("every action leaves ledger and legacy-payment rows unchanged; a linked legacy row is byte-identical", async () => {
    const studentId = await newStudent(a, "nofin");
    const linked = await prisma.paymentPeriod.create({
      data: { organizationId: a.org.id, studentId, academyId: a.academy.id, year: 2025, month: 11, planId: usdPlan.id, status: "PAID", amount: "100.00", currency: "USD", recordedById: a.admin.id },
    });
    const before = await ledgerCounts(a.org.id);
    asOwner();
    const nov = { coverageYear: "2025", coverageMonth: "11", legacyPaymentPeriodId: linked.id };
    expect(await actions.createOpeningDraft(a.org.id, PRISTINE, draftForm(studentId, { ...nov, amount: "20.00" }))).toEqual({ ok: true });
    await actions.replaceOpeningDraft(a.org.id, PRISTINE, draftForm(null, { ...nov, draftId: (await latestDraft(studentId)).id, amount: "25.00" }));
    const shown = await shownBindings(studentId);
    asOwner();
    const confirm = { studentId, candidateYear: "2026", candidateMonth: "12" };
    expect(await actions.recordOpeningReview(a.org.id, PRISTINE, form({ ...confirm, binding: shown.opening, declaration: "itemsAsShown" }))).toEqual({ ok: true });
    expect(await actions.acknowledgePricing(a.org.id, PRISTINE, form({ ...confirm, binding: shown.pricing }))).toEqual({ ok: true });
    await actions.withdrawOpeningDraft(a.org.id, PRISTINE, form({ draftId: (await latestDraft(studentId)).id, reason: "settled" }));
    expect(await ledgerCounts(a.org.id)).toEqual(before);
    expect(await prisma.paymentPeriod.findUniqueOrThrow({ where: { id: linked.id } })).toEqual(linked);
  }, 60_000);

  it("the report: checks 10-12 notImplemented, 13 decisionPending, ready false; a draft linked to a PAID row warns; opening totals appear", async () => {
    const studentId = await newStudent(a, "report");
    const paid = await prisma.paymentPeriod.create({
      data: { organizationId: a.org.id, studentId, academyId: a.academy.id, year: 2025, month: 12, planId: usdPlan.id, status: "PAID", amount: "100.00", currency: "USD", recordedById: a.admin.id },
    });
    asOwner();
    await actions.createOpeningDraft(a.org.id, PRISTINE, draftForm(studentId, { coverageYear: "2025", coverageMonth: "12", legacyPaymentPeriodId: paid.id }));
    const { report } = await reportState(studentId);
    expect(report.checks.filter((c) => c.status === "notImplemented").map((c) => c.id)).toEqual([10, 11, 12]);
    expect(report.checks.find((c) => c.id === 13)!.status).toBe("decisionPending");
    expect(report.ready).toBe(false);
    const d = await latestDraft(studentId);
    expect(report.warnings.find((w) => w.key === "openingItemLinkedToPaidRow")!.items).toContain(`openingItem:${d.id}`);
    expect(report.openingDrafts.find((t) => t.academyId === a.academy.id && t.currency === "USD")!.count).toBeGreaterThanOrEqual(1);
  });
});
