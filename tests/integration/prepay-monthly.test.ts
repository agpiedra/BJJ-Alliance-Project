import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getTestPrismaClient } from "../helpers/test-db";
import { makeAccountingOrg } from "../helpers/accounting-org";
import type { TenantContext } from "../../src/lib/tenant/types";
import type { YearMonth } from "../../src/lib/dues/calendar";
import { createMonthlyObligation } from "../../src/lib/dues/ledger/create-monthly-obligation";
import { recordDuesPayment } from "../../src/lib/dues/ledger/record-payment";
import { reversePayment } from "../../src/lib/dues/ledger/reverse-payment";
import { prepayMonthlyObligations, type PrepayMonthlyObligationsResult } from "../../src/lib/dues/ledger/prepay-monthly";
import type { LedgerActivation } from "../../src/lib/dues/ledger/activation";
import { versionRevision } from "../../src/lib/dues/config-input";

// correctAssignment (a real server action) calls resolveActionContext -> auth(), which needs a Next.js request scope that
// doesn't exist here — mocked exactly as monthly-generation.test.ts already does for assignPlan, dynamically imported only
// after the mock is registered.
let currentSession: { user: { id: string; role: string } } | null = null;
vi.mock("@/auth", () => ({ auth: () => Promise.resolve(currentSession), signIn: vi.fn() }));
const { correctAssignment } = await import("../../src/lib/dues/assignment-actions");

/**
 * Monthly-prepayment brief, proved against the REAL test database, following this session's established fixture/concurrency
 * conventions (`waive-late-fee.test.ts`, `reverse-payment.test.ts`). Assignment rows are seeded directly (bypassing
 * `assignPlan`'s own action wrapper) since this suite is exercising `prepayMonthlyObligations`, not `assignPlan`.
 */
const prisma = getTestPrismaClient();
type Fixture = Awaited<ReturnType<typeof makeAccountingOrg>>;
const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
const ACTIVE: LedgerActivation = { isActive: async () => true };
const at = (isoLocal: string) => () => new Date(`${isoLocal}-06:00`); // Costa Rica, UTC-6 all year
const DEC_2030 = at("2030-12-01T12:00:00");
const deps = (extra: Record<string, unknown> = {}) => ({ activation: ACTIVE, now: DEC_2030, ...extra });

let a: Fixture;
let b: Fixture;
let planA: { id: string };
let termsA: { id: string };
let policyBase: { id: string; maxPrepaidMonths: number | null };

function context(over: Partial<TenantContext> = {}): TenantContext {
  return { kind: "tenant", actorUserId: a.admin.id, organizationId: a.org.id, organizationRole: "ADMIN", academyIds: "ALL", selfStudentId: null, linkedStudentId: null, ...over };
}

let studentCounter = 0;
async function newStudent(label: string, academyId = a.academy.id, org: Fixture = a) {
  const n = ++studentCounter;
  return prisma.student.create({
    data: {
      organizationId: org.org.id, homeAcademyId: academyId, firstName: "Prepay", lastName: `${label}${n}`, phone: "00000000",
      email: `prepay-${label}-${n}-${suffix}@example.com`, currentRankId: await org.rankId("WHITE"), codeHash: `prepay-${label}-${n}-${suffix}`, status: "ACTIVE",
    },
  });
}

async function assign(studentId: string, planId: string | null, effectiveYear = 2020, effectiveMonth = 1, organizationId = a.org.id) {
  return prisma.studentPlanAssignment.create({ data: { organizationId, studentId, planId, effectiveYear, effectiveMonth, createdById: a.admin.id } });
}

function assignmentRevision(row: { planId: string | null }): string {
  return versionRevision({ planId: row.planId });
}

/** N consecutive months starting at (year, month). */
function months(year: number, month: number, count: number): YearMonth[] {
  const out: YearMonth[] = [];
  let y = year, m = month;
  for (let i = 0; i < count; i++) {
    out.push({ year: y, month: m });
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return out;
}

const prepay = (over: Partial<Parameters<typeof prepayMonthlyObligations>[0]> = {}, extraDeps: Record<string, unknown> = {}) =>
  prepayMonthlyObligations(
    { context: context(), studentId: "", requestedMonths: [], receivedOn: { year: 2030, month: 12, day: 1 }, tender: { currency: "USD", amount: "" }, method: "EFECTIVO", maxBackdateDays: 90, ...over },
    deps(extraDeps),
  );

async function ledgerCounts(organizationId: string) {
  return {
    obligations: await prisma.duesObligation.count({ where: { organizationId } }),
    coverage: await prisma.duesCoverage.count({ where: { organizationId } }),
    payments: await prisma.duesPayment.count({ where: { organizationId } }),
    settlements: await prisma.duesSettlement.count({ where: { organizationId } }),
    audits: await prisma.auditLog.count({ where: { organizationId, action: { startsWith: "dues" } } }),
  };
}

/** Waits until Postgres reports a session genuinely blocked on a lock matching every string in `matches` — the established
 * pattern, reused verbatim from `dues-ledger-writers.test.ts`/`correct-late-fee.test.ts`. */
async function waitUntilBlockedOnLock(matches: string[], timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = await prisma.$queryRawUnsafe<{ query: string }[]>(`SELECT query FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query IS NOT NULL`);
    if (rows.some((row) => matches.every((m) => row.query.includes(m)))) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

/** A bystander transaction that holds a specific `StudentPlanAssignment` row `FOR UPDATE` — the identical lock and write shape
 * `correctAssignment` itself performs — until `release()`, optionally writing a new `planId` right before releasing (simulating
 * `correctAssignment`'s own committed effect for the "correction acquires the lock first" serialization order, since
 * `correctAssignment` has no injectable pause point of its own to hold it open mid-transaction). */
function holdAssignmentLock(assignmentId: string, writePlanId?: string | null) {
  let started!: () => void;
  const startedPromise = new Promise<void>((r) => (started = r));
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const held = prisma.$transaction(
    async (tx) => {
      await tx.$queryRawUnsafe(`SELECT "id" FROM "StudentPlanAssignment" WHERE "id" = '${assignmentId}' FOR UPDATE`);
      started();
      await gate;
      if (writePlanId !== undefined) await tx.studentPlanAssignment.update({ where: { id: assignmentId, organizationId: a.org.id }, data: { planId: writePlanId } });
    },
    { timeout: 60_000 },
  );
  return { startedPromise, release, held };
}

beforeAll(async () => {
  a = await makeAccountingOrg("CUMULATIVE", "prepay-a");
  b = await makeAccountingOrg("CUMULATIVE", "prepay-b");
  currentSession = { user: { id: a.admin.id, role: "ADMIN" } };
  const plan = await prisma.paymentPlan.create({ data: { organizationId: a.org.id, academyId: a.academy.id, name: `Prepay plan ${suffix}` } });
  planA = plan;
  termsA = await prisma.paymentPlanTerms.create({
    data: { organizationId: a.org.id, planId: plan.id, effectiveYear: 2027, effectiveMonth: 1, priceAmount: "100.00", currency: "USD", monthsCovered: 1, createdById: a.admin.id },
  });
  policyBase = await prisma.duesPolicyVersion.create({
    data: { organizationId: a.org.id, academyId: a.academy.id, effectiveYear: 2027, effectiveMonth: 1, dueDay: 20, graceDay: 5, lateFeeAmount: "20.00", lateFeeCurrency: "USD", maxPrepaidMonths: 3, createdById: a.admin.id },
  });
}, 60_000);

async function clearLedgerTables(organizationId: string) {
  await prisma.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL session_replication_role = replica");
      for (const table of ["DuesSettlement", "DuesPayment", "DuesLateFee", "DuesCoverage", "DuesObligation"]) {
        await tx.$executeRawUnsafe(`DELETE FROM "${table}" WHERE "organizationId" = $1`, organizationId);
      }
    },
    { timeout: 60_000 },
  );
  await prisma.studentPlanAssignment.deleteMany({ where: { organizationId } });
  await prisma.auditLog.deleteMany({ where: { organizationId } });
  await prisma.paymentPlanTerms.deleteMany({ where: { organizationId } });
  await prisma.duesPolicyVersion.deleteMany({ where: { organizationId } });
  await prisma.paymentPlan.deleteMany({ where: { organizationId } });
}

afterAll(async () => {
  if (a) await clearLedgerTables(a.org.id);
  if (b) await clearLedgerTables(b.org.id);
  await a?.drop();
  await b?.drop();
}, 120_000);

describe("prepayMonthlyObligations: the gate — activation, owner-only, tenant/branch scope, malformed input", () => {
  it("refuses notActive and writes nothing when no activation is injected", async () => {
    const s = await newStudent("gate");
    await assign(s.id, planA.id);
    const before = await ledgerCounts(a.org.id);
    const r = await prepayMonthlyObligations({
      context: context(), studentId: s.id, requestedMonths: months(2031, 1, 1), receivedOn: { year: 2030, month: 12, day: 1 },
      tender: { currency: "USD", amount: "100.00" }, method: "EFECTIVO", maxBackdateDays: 90,
    });
    expect(r).toEqual({ ok: false, error: "notActive" });
    expect(await ledgerCounts(a.org.id)).toEqual(before);
  });

  it("a DIRECTOR (non-owner) context is refused (notFound), zero writes", async () => {
    const s = await newStudent("director");
    await assign(s.id, planA.id);
    const before = await ledgerCounts(a.org.id);
    const r = await prepay({ context: context({ organizationRole: "DIRECTOR" }), studentId: s.id, requestedMonths: months(2031, 1, 1), tender: { currency: "USD", amount: "100.00" } });
    expect(r).toEqual({ ok: false, error: "notFound" });
    expect(await ledgerCounts(a.org.id)).toEqual(before);
  });

  it("a DIRECTOR scoped to a different branch is refused (notFound)", async () => {
    const other = await prisma.academy.create({ data: { organizationId: a.org.id, name: `Other ${suffix}`, slug: `other-prepay-${suffix}`, kioskTokenHash: `other-prepay-${suffix}` } });
    const s = await newStudent("outofbranch");
    await assign(s.id, planA.id);
    const r = await prepay({ context: context({ organizationRole: "DIRECTOR", academyIds: [other.id] }), studentId: s.id, requestedMonths: months(2031, 1, 1), tender: { currency: "USD", amount: "100.00" } });
    expect(r).toEqual({ ok: false, error: "notFound" });
    await prisma.academy.delete({ where: { id: other.id } });
  });

  it("a student of a different organization is refused (notFound), never leaked cross-tenant", async () => {
    const bStudent = await newStudent("cross", b.academy.id, b);
    const before = await ledgerCounts(a.org.id);
    const r = await prepay({ studentId: bStudent.id, requestedMonths: months(2031, 1, 1), tender: { currency: "USD", amount: "100.00" } });
    expect(r).toEqual({ ok: false, error: "notFound" });
    expect(await ledgerCounts(a.org.id)).toEqual(before);
  });

  it("empty/malformed requestedMonths and receivedOn are refused (invalid), before any DB read", async () => {
    const s = await newStudent("malformed");
    await assign(s.id, planA.id);
    for (const bad of [[], [{ year: 2030, month: 13 }], [{ year: 1999, month: 1 }]]) {
      expect(await prepay({ studentId: s.id, requestedMonths: bad as YearMonth[], tender: { currency: "USD", amount: "100.00" } })).toEqual({ ok: false, error: "invalid" });
    }
    expect(await prepay({ studentId: s.id, requestedMonths: months(2031, 1, 1), receivedOn: { year: 2030, month: 2, day: 30 }, tender: { currency: "USD", amount: "100.00" } })).toEqual({ ok: false, error: "invalid" });
  });

  it("a malformed studentId is refused (invalid), before any DB read, with an otherwise-fully-valid request", async () => {
    // A real, eligible student exists (assigned, would otherwise succeed) so nothing else about this request could be what
    // trips the refusal — only studentId itself varies across the invalid cases below.
    const real = await newStudent("studentidfixture");
    await assign(real.id, planA.id);
    const validArgs = { requestedMonths: months(2031, 1, 1), receivedOn: { year: 2030 as const, month: 12 as const, day: 1 as const }, tender: { currency: "USD" as const, amount: "100.00" } };

    const before = await ledgerCounts(a.org.id);
    const cases: unknown[] = [undefined, null, 12345, ""];
    for (const bad of cases) {
      const r = await prepay({ ...validArgs, studentId: bad as never });
      expect(r, `studentId=${JSON.stringify(bad)}`).toEqual({ ok: false, error: "invalid" });
      expect(await ledgerCounts(a.org.id), `studentId=${JSON.stringify(bad)}`).toEqual(before);
    }

    // Confirm the fixture really was otherwise-valid: the SAME args with the real student's id succeed.
    const ok = await prepay({ ...validArgs, studentId: real.id });
    expect(ok).toMatchObject({ ok: true });
  });
});

describe("prepayMonthlyObligations: explicit coverage-gap validation", () => {
  it("the exact dated example: Oct/Dec skipping Nov refuses; Oct/Nov/Dec succeeds; Nov/Dec while Oct is open refuses", async () => {
    const s = await newStudent("gap");
    await assign(s.id, planA.id);
    const before = await ledgerCounts(a.org.id);

    const skip = await prepay({ studentId: s.id, requestedMonths: [{ year: 2031, month: 1 }, { year: 2031, month: 3 }], tender: { currency: "USD", amount: "200.00" } });
    expect(skip).toEqual({ ok: false, error: "coverageGap" });
    expect(await ledgerCounts(a.org.id)).toEqual(before);

    const laterFirst = await prepay({ studentId: s.id, requestedMonths: [{ year: 2031, month: 2 }, { year: 2031, month: 3 }], tender: { currency: "USD", amount: "200.00" } });
    expect(laterFirst).toEqual({ ok: false, error: "coverageGap" });
    expect(await ledgerCounts(a.org.id)).toEqual(before);

    const ok = await prepay({ studentId: s.id, requestedMonths: months(2031, 1, 3), tender: { currency: "USD", amount: "300.00" } });
    expect(ok).toMatchObject({ ok: true, obligationIds: expect.arrayContaining([expect.any(String)]) });
    if (ok.ok) expect(ok.obligationIds).toHaveLength(3);
  });
});

describe("prepayMonthlyObligations: current-month gaps are explicitly out of scope", () => {
  it("succeeds regardless of the current month's own obligation state or a historical gap behind it", async () => {
    const s = await newStudent("currentgap");
    await assign(s.id, planA.id);
    // No September obligation exists at all, and no November obligation either (a historical gap): this writer must not
    // read, touch or react to either — it only cares that January 2031 onward is uncovered.
    const r = await prepay({ studentId: s.id, requestedMonths: months(2031, 1, 1), tender: { currency: "USD", amount: "100.00" } });
    expect(r).toMatchObject({ ok: true });
    // September/November remain exactly as absent as before — no enrollment/resume-charge obligation was invented.
    expect(await prisma.duesObligation.count({ where: { organizationId: a.org.id, studentId: s.id, coverageYear: 2030 } })).toBe(0);
  });
});

describe("prepayMonthlyObligations: existing outstanding debt plus future months in one receipt", () => {
  it("combines a named current-debt obligation with newly created future ones, oldest first, one exact total", async () => {
    const s = await newStudent("combined");
    await assign(s.id, planA.id);
    const sep = await createMonthlyObligation({ context: context(), studentId: s.id, coverage: { year: 2030, month: 9 }, planTermsId: termsA.id, policyVersionId: policyBase.id }, deps());
    if (!sep.ok) throw new Error(sep.error);

    // September's grace deadline is Oct 5, 2030 — settling it on Dec 1 (this receipt's date) is well past it, so it
    // correctly owes its own USD 20.00 late fee too: 100 (Sep + fee 20) + 100 (Jan) + 100 (Feb) = 320.00.
    const r = await prepay({ studentId: s.id, requestedMonths: months(2031, 1, 2), existingObligationIds: [sep.obligationId], tender: { currency: "USD", amount: "320.00" } });
    expect(r).toMatchObject({ ok: true, totalMinor: 32000 });
    if (!r.ok) return;
    expect(r.obligationIds).toHaveLength(2);
    expect(await prisma.duesSettlement.count({ where: { paymentId: r.paymentId, reversedAt: null } })).toBe(3);
  });
});

describe("prepayMonthlyObligations: retries are bound to explicit selections, never recomputed", () => {
  it("an identical retried request either succeeds once or cleanly refuses on retry — never silently extends further", async () => {
    const s = await newStudent("retry");
    await assign(s.id, planA.id);
    const first = await prepay({ studentId: s.id, requestedMonths: months(2031, 1, 2), tender: { currency: "USD", amount: "200.00" } });
    expect(first).toMatchObject({ ok: true });
    const after = await ledgerCounts(a.org.id);

    // The exact same request again: both requested months are now already covered, so this is refused as a duplicate — it
    // must NOT silently reinterpret itself as "the next 2 uncovered months" (which would be March/April) and purchase those.
    const retry = await prepay({ studentId: s.id, requestedMonths: months(2031, 1, 2), tender: { currency: "USD", amount: "200.00" } });
    expect(retry.ok).toBe(false);
    expect(await ledgerCounts(a.org.id)).toEqual(after);
    expect(await prisma.duesObligation.count({ where: { organizationId: a.org.id, studentId: s.id, coverageYear: 2031, coverageMonth: { in: [3, 4] } } })).toBe(0);
  });
});

describe("prepayMonthlyObligations: rollback proof", () => {
  it("a settlement refusal (unknown current-debt id) rolls back every provisionally created obligation, coverage and audit row", async () => {
    const s = await newStudent("rollbacksettle");
    await assign(s.id, planA.id);
    const before = await ledgerCounts(a.org.id);
    const r = await prepay({ studentId: s.id, requestedMonths: months(2031, 1, 2), existingObligationIds: ["no-such-obligation"], tender: { currency: "USD", amount: "200.00" } });
    expect(r).toMatchObject({ ok: false, error: "notFound" });
    expect(await ledgerCounts(a.org.id)).toEqual(before);
  });

  it("a forced failure right after every month is written still leaves nothing persisted", async () => {
    const s = await newStudent("rollbackhook");
    await assign(s.id, planA.id);
    const before = await ledgerCounts(a.org.id);
    await expect(
      prepay(
        { studentId: s.id, requestedMonths: months(2031, 1, 2), tender: { currency: "USD", amount: "200.00" } },
        { afterPrepaymentObligationsWrittenForTest: async () => { throw new Error("forced failure, proving rollback"); } },
      ),
    ).rejects.toThrow("forced failure");
    expect(await ledgerCounts(a.org.id)).toEqual(before);
  });
});

describe("prepayMonthlyObligations: one consistent purchase-time instant", () => {
  it("the instant is captured once, after the locks, and reused even if the injected clock later moves on", async () => {
    const s = await newStudent("instant");
    await assign(s.id, planA.id);
    let callCount = 0;
    const tickingNow = () => {
      callCount += 1;
      // The FIRST call is purchaseInstant's own capture (Dec 1, 2030 — receivedOn below is on time against it). Every call
      // AFTER that must still resolve to the SAME frozen instant if the fix holds; a bug that re-reads the clock later would
      // instead see this much later value, making the Dec 1 receivedOn a FUTURE date relative to it (settlement failure).
      return callCount === 1 ? new Date("2030-12-01T12:00:00-06:00") : new Date("2031-06-01T12:00:00-06:00");
    };
    const r = await prepay({ studentId: s.id, requestedMonths: months(2031, 1, 1), receivedOn: { year: 2030, month: 12, day: 1 }, tender: { currency: "USD", amount: "100.00" } }, { now: tickingNow });
    expect(r).toMatchObject({ ok: true });
    expect(callCount).toBeGreaterThanOrEqual(1);
  });
});

describe("prepayMonthlyObligations: the standing-horizon limit (§1, approved policies)", () => {
  let academy: { id: string };
  let plan: { id: string };
  const SEPT_2030 = at("2030-09-15T12:00:00");
  const NOV_2030 = at("2030-11-15T12:00:00");

  beforeAll(async () => {
    academy = await prisma.academy.create({ data: { organizationId: a.org.id, name: `Horizon ${suffix}`, slug: `horizon-${suffix}`, kioskTokenHash: `horizon-${suffix}` } });
    plan = await prisma.paymentPlan.create({ data: { organizationId: a.org.id, academyId: academy.id, name: `Horizon plan ${suffix}` } });
    await prisma.paymentPlanTerms.create({ data: { organizationId: a.org.id, planId: plan.id, effectiveYear: 2027, effectiveMonth: 1, priceAmount: "100.00", currency: "USD", monthsCovered: 1, createdById: a.admin.id } });
    await prisma.duesPolicyVersion.create({ data: { organizationId: a.org.id, academyId: academy.id, effectiveYear: 2027, effectiveMonth: 1, dueDay: 20, graceDay: 5, lateFeeAmount: "20.00", lateFeeCurrency: "USD", maxPrepaidMonths: 3, createdById: a.admin.id } });
  }, 30_000);

  it("September, limit 3: coverage stands through December; a fourth month is refused until one becomes current", async () => {
    const s = await newStudent("horizon", academy.id);
    await assign(s.id, plan.id);
    const three = await prepayMonthlyObligations(
      { context: context(), studentId: s.id, requestedMonths: months(2030, 10, 3), receivedOn: { year: 2030, month: 9, day: 15 }, tender: { currency: "USD", amount: "300.00" }, method: "EFECTIVO", maxBackdateDays: 90 },
      deps({ now: SEPT_2030 }),
    );
    expect(three).toMatchObject({ ok: true });

    const fourth = await prepayMonthlyObligations(
      { context: context(), studentId: s.id, requestedMonths: [{ year: 2031, month: 1 }], receivedOn: { year: 2030, month: 9, day: 16 }, tender: { currency: "USD", amount: "100.00" }, method: "EFECTIVO", maxBackdateDays: 90 },
      deps({ now: SEPT_2030 }),
    );
    expect(fourth).toEqual({ ok: false, error: "prepaymentLimitExceeded" });

    // Once October has become the current month (Nov 2030 "now"), only November and December stand ahead (2 months) — one
    // more (January) fits back under the limit of 3.
    const afterOctoberCurrent = await prepayMonthlyObligations(
      { context: context(), studentId: s.id, requestedMonths: [{ year: 2031, month: 1 }], receivedOn: { year: 2030, month: 11, day: 15 }, tender: { currency: "USD", amount: "100.00" }, method: "EFECTIVO", maxBackdateDays: 90 },
      deps({ now: NOV_2030 }),
    );
    expect(afterOctoberCurrent).toMatchObject({ ok: true });
  });

  it("unset maxPrepaidMonths refuses prepaymentUnavailable outright", async () => {
    const noLimitAcademy = await prisma.academy.create({ data: { organizationId: a.org.id, name: `NoLimit ${suffix}`, slug: `nolimit-${suffix}`, kioskTokenHash: `nolimit-${suffix}` } });
    const noLimitPlan = await prisma.paymentPlan.create({ data: { organizationId: a.org.id, academyId: noLimitAcademy.id, name: `NoLimit plan ${suffix}` } });
    await prisma.paymentPlanTerms.create({ data: { organizationId: a.org.id, planId: noLimitPlan.id, effectiveYear: 2027, effectiveMonth: 1, priceAmount: "100.00", currency: "USD", monthsCovered: 1, createdById: a.admin.id } });
    await prisma.duesPolicyVersion.create({ data: { organizationId: a.org.id, academyId: noLimitAcademy.id, effectiveYear: 2027, effectiveMonth: 1, dueDay: 20, graceDay: 5, lateFeeAmount: "20.00", lateFeeCurrency: "USD", maxPrepaidMonths: null, createdById: a.admin.id } });
    const s = await newStudent("nolimit", noLimitAcademy.id);
    await assign(s.id, noLimitPlan.id);
    const r = await prepay({ studentId: s.id, requestedMonths: months(2031, 1, 1), tender: { currency: "USD", amount: "100.00" } });
    expect(r).toEqual({ ok: false, error: "prepaymentUnavailable" });
  });

  it("a backdated receivedOn cannot select an older, more permissive limit than the one effective today", async () => {
    const backdateAcademy = await prisma.academy.create({ data: { organizationId: a.org.id, name: `Backdate ${suffix}`, slug: `backdate-${suffix}`, kioskTokenHash: `backdate-${suffix}` } });
    const backdatePlan = await prisma.paymentPlan.create({ data: { organizationId: a.org.id, academyId: backdateAcademy.id, name: `Backdate plan ${suffix}` } });
    await prisma.paymentPlanTerms.create({ data: { organizationId: a.org.id, planId: backdatePlan.id, effectiveYear: 2027, effectiveMonth: 1, priceAmount: "100.00", currency: "USD", monthsCovered: 1, createdById: a.admin.id } });
    // An OLDER, more permissive policy (limit 5), then a NEWER, stricter one (limit 1) effective before "today" (Dec 2030).
    await prisma.duesPolicyVersion.create({ data: { organizationId: a.org.id, academyId: backdateAcademy.id, effectiveYear: 2027, effectiveMonth: 1, dueDay: 20, graceDay: 5, lateFeeAmount: "20.00", lateFeeCurrency: "USD", maxPrepaidMonths: 5, createdById: a.admin.id } });
    await prisma.duesPolicyVersion.create({ data: { organizationId: a.org.id, academyId: backdateAcademy.id, effectiveYear: 2030, effectiveMonth: 11, dueDay: 20, graceDay: 5, lateFeeAmount: "20.00", lateFeeCurrency: "USD", maxPrepaidMonths: 1, createdById: a.admin.id } });
    const s = await newStudent("backdate", backdateAcademy.id);
    await assign(s.id, backdatePlan.id);
    // "Today" is Dec 2030 (the stricter, limit-1 version governs); receivedOn is backdated to Oct 15, 2030 — BEFORE the
    // stricter version became effective. Requesting 2 future months must still be refused against TODAY's limit of 1, not
    // the older, more permissive limit of 5 the backdated date would otherwise select.
    const r = await prepayMonthlyObligations(
      { context: context(), studentId: s.id, requestedMonths: months(2031, 1, 2), receivedOn: { year: 2030, month: 10, day: 15 }, tender: { currency: "USD", amount: "200.00" }, method: "EFECTIVO", maxBackdateDays: 90 },
      deps(),
    );
    expect(r).toEqual({ ok: false, error: "prepaymentLimitExceeded" });
  });
});

/**
 * The limit is a DIRECT POSITIONAL bound on each requested month's own calendar distance from currentMonth — NOT a
 * cumulative count of however much coverage already exists. A cumulative count is a real, distinct bug: a month already
 * covered from an earlier, since-superseded (more permissive) limit sits outside today's horizon and must never count
 * against a new, otherwise-in-bounds request; conversely a gapped coverage history could make a cumulative count wrongly
 * ADMIT a request that reaches too far. These tests prove the positional check and the existing gap/consecutive check are
 * independent — each fires only for its own reason, never the other's.
 */
describe("prepayMonthlyObligations: the limit is positional, not cumulative — the grandfathered-month counterexample", () => {
  let academy: { id: string };
  let plan: { id: string };
  const SEPT_2030 = at("2030-09-15T12:00:00");

  beforeAll(async () => {
    academy = await prisma.academy.create({ data: { organizationId: a.org.id, name: `Positional ${suffix}`, slug: `positional-${suffix}`, kioskTokenHash: `positional-${suffix}` } });
    plan = await prisma.paymentPlan.create({ data: { organizationId: a.org.id, academyId: academy.id, name: `Positional plan ${suffix}` } });
    await prisma.paymentPlanTerms.create({ data: { organizationId: a.org.id, planId: plan.id, effectiveYear: 2027, effectiveMonth: 1, priceAmount: "100.00", currency: "USD", monthsCovered: 1, createdById: a.admin.id } });
    await prisma.duesPolicyVersion.create({ data: { organizationId: a.org.id, academyId: academy.id, effectiveYear: 2027, effectiveMonth: 1, dueDay: 20, graceDay: 5, lateFeeAmount: "20.00", lateFeeCurrency: "USD", maxPrepaidMonths: 3, createdById: a.admin.id } });
  }, 30_000);

  it("a grandfathered January (covered while an earlier 'now' made it the horizon) does not count against a September request for Oct/Nov/Dec", async () => {
    const s = await newStudent("grandfathered", academy.id);
    await assign(s.id, plan.id);
    // Constructed exactly as the counterexample requires: a real prepayment made while "now" was December 2030 (so January
    // 2031 was legitimately that call's own first purchasable month, gap-check and all) — leaving October through December
    // 2030 completely uncovered. Nothing about this call is a bypass; it is the real writer, called with a different instant.
    const grandfather = await prepayMonthlyObligations(
      { context: context(), studentId: s.id, requestedMonths: [{ year: 2031, month: 1 }], receivedOn: { year: 2030, month: 12, day: 1 }, tender: { currency: "USD", amount: "100.00" }, method: "EFECTIVO", maxBackdateDays: 90 },
      deps({ now: at("2030-12-01T12:00:00") }),
    );
    expect(grandfather).toMatchObject({ ok: true });

    // Now "today" is September (this test's own current month), limit 3 (horizon through December). October, November and
    // December are each individually within that horizon and gapless from the true firstUncovered (October) — the buggy
    // cumulative count would see January (1 month "already covered ahead of September") and wrongly refuse 1 + 3 > 3.
    const janBefore = await prisma.duesObligation.findFirstOrThrow({ where: { organizationId: a.org.id, studentId: s.id, coverageYear: 2031, coverageMonth: 1 } });
    const r = await prepayMonthlyObligations(
      { context: context(), studentId: s.id, requestedMonths: months(2030, 10, 3), receivedOn: { year: 2030, month: 9, day: 15 }, tender: { currency: "USD", amount: "300.00" }, method: "EFECTIVO", maxBackdateDays: 90 },
      deps({ now: SEPT_2030 }),
    );
    expect(r).toMatchObject({ ok: true });
    if (!r.ok) return;
    expect(r.obligationIds).toHaveLength(3);

    // January's grandfathered coverage is completely untouched.
    expect(await prisma.duesObligation.findFirstOrThrow({ where: { organizationId: a.org.id, studentId: s.id, coverageYear: 2031, coverageMonth: 1 } })).toEqual(janBefore);
  });

  it("a month exactly at the horizon boundary succeeds; one month beyond it refuses prepaymentLimitExceeded", async () => {
    const atBoundary = await newStudent("boundary-at", academy.id);
    await assign(atBoundary.id, plan.id);
    const ok = await prepayMonthlyObligations(
      { context: context(), studentId: atBoundary.id, requestedMonths: months(2030, 10, 3), receivedOn: { year: 2030, month: 9, day: 15 }, tender: { currency: "USD", amount: "300.00" }, method: "EFECTIVO", maxBackdateDays: 90 },
      deps({ now: SEPT_2030 }),
    );
    expect(ok).toMatchObject({ ok: true }); // Oct, Nov, Dec — Dec is exactly currentMonth + 3, the horizon itself

    const beyond = await newStudent("boundary-beyond", academy.id);
    await assign(beyond.id, plan.id);
    const before = await ledgerCounts(a.org.id);
    const refused = await prepayMonthlyObligations(
      { context: context(), studentId: beyond.id, requestedMonths: months(2030, 10, 4), receivedOn: { year: 2030, month: 9, day: 15 }, tender: { currency: "USD", amount: "400.00" }, method: "EFECTIVO", maxBackdateDays: 90 },
      deps({ now: SEPT_2030 }),
    );
    expect(refused).toEqual({ ok: false, error: "prepaymentLimitExceeded" }); // Oct, Nov, Dec, Jan — Jan is one past the horizon
    expect(await ledgerCounts(a.org.id)).toEqual(before);
  });

  it("the horizon and the gap check are independent: a gap inside the horizon still refuses coverageGap, not the horizon", async () => {
    const generousAcademy = await prisma.academy.create({ data: { organizationId: a.org.id, name: `Generous ${suffix}`, slug: `generous-${suffix}`, kioskTokenHash: `generous-${suffix}` } });
    const generousPlan = await prisma.paymentPlan.create({ data: { organizationId: a.org.id, academyId: generousAcademy.id, name: `Generous plan ${suffix}` } });
    await prisma.paymentPlanTerms.create({ data: { organizationId: a.org.id, planId: generousPlan.id, effectiveYear: 2027, effectiveMonth: 1, priceAmount: "100.00", currency: "USD", monthsCovered: 1, createdById: a.admin.id } });
    await prisma.duesPolicyVersion.create({ data: { organizationId: a.org.id, academyId: generousAcademy.id, effectiveYear: 2027, effectiveMonth: 1, dueDay: 20, graceDay: 5, lateFeeAmount: "20.00", lateFeeCurrency: "USD", maxPrepaidMonths: 5, createdById: a.admin.id } });
    const s = await newStudent("gapinhorizon", generousAcademy.id);
    await assign(s.id, generousPlan.id);
    // Oct and Dec are both well within a 5-month horizon from September (through February) — a cumulative/positional bug
    // that only checked distance could never explain a refusal here except via the gap check itself.
    const r = await prepayMonthlyObligations(
      { context: context(), studentId: s.id, requestedMonths: [{ year: 2030, month: 10 }, { year: 2030, month: 12 }], receivedOn: { year: 2030, month: 9, day: 15 }, tender: { currency: "USD", amount: "200.00" }, method: "EFECTIVO", maxBackdateDays: 90 },
      deps({ now: SEPT_2030 }),
    );
    expect(r).toEqual({ ok: false, error: "coverageGap" });
  });

  it("the horizon and the gap check are independent: a gapless run from firstUncovered still refuses prepaymentLimitExceeded once it reaches past a tight horizon", async () => {
    const tightAcademy = await prisma.academy.create({ data: { organizationId: a.org.id, name: `Tight ${suffix}`, slug: `tight-${suffix}`, kioskTokenHash: `tight-${suffix}` } });
    const tightPlan = await prisma.paymentPlan.create({ data: { organizationId: a.org.id, academyId: tightAcademy.id, name: `Tight plan ${suffix}` } });
    await prisma.paymentPlanTerms.create({ data: { organizationId: a.org.id, planId: tightPlan.id, effectiveYear: 2027, effectiveMonth: 1, priceAmount: "100.00", currency: "USD", monthsCovered: 1, createdById: a.admin.id } });
    await prisma.duesPolicyVersion.create({ data: { organizationId: a.org.id, academyId: tightAcademy.id, effectiveYear: 2027, effectiveMonth: 1, dueDay: 20, graceDay: 5, lateFeeAmount: "20.00", lateFeeCurrency: "USD", maxPrepaidMonths: 2, createdById: a.admin.id } });
    const s = await newStudent("tighthorizon", tightAcademy.id);
    await assign(s.id, tightPlan.id);
    // Oct, Nov, Dec: gapless, starts exactly at firstUncovered (Oct) — the gap check alone would accept this. The horizon
    // (September + 2 = November) is what must refuse it, on December specifically.
    const r = await prepayMonthlyObligations(
      { context: context(), studentId: s.id, requestedMonths: months(2030, 10, 3), receivedOn: { year: 2030, month: 9, day: 15 }, tender: { currency: "USD", amount: "300.00" }, method: "EFECTIVO", maxBackdateDays: 90 },
      deps({ now: SEPT_2030 }),
    );
    expect(r).toEqual({ ok: false, error: "prepaymentLimitExceeded" });
  });

  it("a fully-consumed horizon (nothing purchasable remains) refuses cleanly with a typed result, never a thrown exception", async () => {
    const fullAcademy = await prisma.academy.create({ data: { organizationId: a.org.id, name: `Full ${suffix}`, slug: `full-${suffix}`, kioskTokenHash: `full-${suffix}` } });
    const fullPlan = await prisma.paymentPlan.create({ data: { organizationId: a.org.id, academyId: fullAcademy.id, name: `Full plan ${suffix}` } });
    await prisma.paymentPlanTerms.create({ data: { organizationId: a.org.id, planId: fullPlan.id, effectiveYear: 2027, effectiveMonth: 1, priceAmount: "100.00", currency: "USD", monthsCovered: 1, createdById: a.admin.id } });
    await prisma.duesPolicyVersion.create({ data: { organizationId: a.org.id, academyId: fullAcademy.id, effectiveYear: 2027, effectiveMonth: 1, dueDay: 20, graceDay: 5, lateFeeAmount: "20.00", lateFeeCurrency: "USD", maxPrepaidMonths: 1, createdById: a.admin.id } });
    const s = await newStudent("fullhorizon", fullAcademy.id);
    await assign(s.id, fullPlan.id);
    const first = await prepayMonthlyObligations(
      { context: context(), studentId: s.id, requestedMonths: [{ year: 2030, month: 10 }], receivedOn: { year: 2030, month: 9, day: 15 }, tender: { currency: "USD", amount: "100.00" }, method: "EFECTIVO", maxBackdateDays: 90 },
      deps({ now: SEPT_2030 }),
    );
    expect(first).toMatchObject({ ok: true }); // the entire 1-month horizon is now consumed

    let threw: unknown;
    let second: PrepayMonthlyObligationsResult | undefined;
    try {
      second = await prepayMonthlyObligations(
        { context: context(), studentId: s.id, requestedMonths: [{ year: 2030, month: 10 }], receivedOn: { year: 2030, month: 9, day: 16 }, tender: { currency: "USD", amount: "100.00" }, method: "EFECTIVO", maxBackdateDays: 90 },
        deps({ now: SEPT_2030 }),
      );
    } catch (e) {
      threw = e;
    }
    expect(threw, "must return a typed refusal, never throw").toBeUndefined();
    expect(second).toEqual({ ok: false, error: "prepaymentLimitExceeded" });
  });
});

describe("prepayMonthlyObligations: lowering the limit never changes existing purchased coverage", () => {
  it("existing coverage stays exactly as it is; only a new purchase attempt is gated by the lower limit", async () => {
    const academy = await prisma.academy.create({ data: { organizationId: a.org.id, name: `Lower ${suffix}`, slug: `lower-${suffix}`, kioskTokenHash: `lower-${suffix}` } });
    const plan = await prisma.paymentPlan.create({ data: { organizationId: a.org.id, academyId: academy.id, name: `Lower plan ${suffix}` } });
    await prisma.paymentPlanTerms.create({ data: { organizationId: a.org.id, planId: plan.id, effectiveYear: 2027, effectiveMonth: 1, priceAmount: "100.00", currency: "USD", monthsCovered: 1, createdById: a.admin.id } });
    await prisma.duesPolicyVersion.create({ data: { organizationId: a.org.id, academyId: academy.id, effectiveYear: 2027, effectiveMonth: 1, dueDay: 20, graceDay: 5, lateFeeAmount: "20.00", lateFeeCurrency: "USD", maxPrepaidMonths: 6, createdById: a.admin.id } });
    const s = await newStudent("lower", academy.id);
    await assign(s.id, plan.id);

    const five = await prepay({ studentId: s.id, requestedMonths: months(2031, 1, 5), tender: { currency: "USD", amount: "500.00" } });
    expect(five).toMatchObject({ ok: true });
    if (!five.ok) return;
    const obligationsBefore = await Promise.all(five.obligationIds.map((id) => prisma.duesObligation.findUniqueOrThrow({ where: { id } })));

    // The owner lowers the limit to 2, effective before "today" (Dec 2030).
    await prisma.duesPolicyVersion.create({ data: { organizationId: a.org.id, academyId: academy.id, effectiveYear: 2030, effectiveMonth: 11, dueDay: 20, graceDay: 5, lateFeeAmount: "20.00", lateFeeCurrency: "USD", maxPrepaidMonths: 2, createdById: a.admin.id } });

    // All 5 already-purchased months are completely untouched.
    const obligationsAfter = await Promise.all(five.obligationIds.map((id) => prisma.duesObligation.findUniqueOrThrow({ where: { id } })));
    expect(obligationsAfter).toEqual(obligationsBefore);

    // A new purchase attempt (even for just 1 more month) is now refused: 5 already stand ahead, exceeding the new limit of 2.
    const more = await prepay({ studentId: s.id, requestedMonths: [{ year: 2031, month: 6 }], tender: { currency: "USD", amount: "100.00" } });
    expect(more).toEqual({ ok: false, error: "prepaymentLimitExceeded" });
  });
});

describe("prepayMonthlyObligations: price and policy changes across the purchased span", () => {
  it("two consecutive future months at two different effective versions are each frozen at their own month's rate", async () => {
    const academy = await prisma.academy.create({ data: { organizationId: a.org.id, name: `Span ${suffix}`, slug: `span-${suffix}`, kioskTokenHash: `span-${suffix}` } });
    const plan = await prisma.paymentPlan.create({ data: { organizationId: a.org.id, academyId: academy.id, name: `Span plan ${suffix}` } });
    await prisma.paymentPlanTerms.create({ data: { organizationId: a.org.id, planId: plan.id, effectiveYear: 2027, effectiveMonth: 1, priceAmount: "100.00", currency: "USD", monthsCovered: 1, createdById: a.admin.id } });
    await prisma.paymentPlanTerms.create({ data: { organizationId: a.org.id, planId: plan.id, effectiveYear: 2031, effectiveMonth: 2, priceAmount: "110.00", currency: "USD", monthsCovered: 1, createdById: a.admin.id } });
    await prisma.duesPolicyVersion.create({ data: { organizationId: a.org.id, academyId: academy.id, effectiveYear: 2027, effectiveMonth: 1, dueDay: 20, graceDay: 5, lateFeeAmount: "20.00", lateFeeCurrency: "USD", maxPrepaidMonths: 5, createdById: a.admin.id } });
    const s = await newStudent("span", academy.id);
    await assign(s.id, plan.id);

    const r = await prepay({ studentId: s.id, requestedMonths: months(2031, 1, 2), tender: { currency: "USD", amount: "210.00" } });
    expect(r).toMatchObject({ ok: true, totalMinor: 21000 });
    if (!r.ok) return;
    const [jan, feb] = await Promise.all(r.obligationIds.map((id) => prisma.duesObligation.findUniqueOrThrow({ where: { id } })));
    expect(jan.amount.toFixed(2)).toBe("100.00");
    expect(feb.amount.toFixed(2)).toBe("110.00");
  });
});

/**
 * Genuine overlapping-transaction proof for BOTH serialization orders against `correctAssignment`, per the brief's exact
 * requirement — not sequential. `correctAssignment` locks only the specific `StudentPlanAssignment` row `FOR UPDATE` (not the
 * student row), and only permits correcting a row whose effective month is still future, so each fixture's assignment is
 * dated exactly at the purchase's own first purchasable month (itself future relative to "now").
 */
describe("prepayMonthlyObligations: correctAssignment race, complete provenance, both serialization orders", () => {
  let academy: { id: string };
  let planX: { id: string };
  let planY: { id: string };

  beforeAll(async () => {
    academy = await prisma.academy.create({ data: { organizationId: a.org.id, name: `Race ${suffix}`, slug: `race-${suffix}`, kioskTokenHash: `race-${suffix}` } });
    planX = await prisma.paymentPlan.create({ data: { organizationId: a.org.id, academyId: academy.id, name: `Race plan X ${suffix}` } });
    planY = await prisma.paymentPlan.create({ data: { organizationId: a.org.id, academyId: academy.id, name: `Race plan Y ${suffix}` } });
    await prisma.paymentPlanTerms.create({ data: { organizationId: a.org.id, planId: planX.id, effectiveYear: 2027, effectiveMonth: 1, priceAmount: "100.00", currency: "USD", monthsCovered: 1, createdById: a.admin.id } });
    await prisma.paymentPlanTerms.create({ data: { organizationId: a.org.id, planId: planY.id, effectiveYear: 2027, effectiveMonth: 1, priceAmount: "130.00", currency: "USD", monthsCovered: 1, createdById: a.admin.id } });
    await prisma.duesPolicyVersion.create({ data: { organizationId: a.org.id, academyId: academy.id, effectiveYear: 2027, effectiveMonth: 1, dueDay: 20, graceDay: 5, lateFeeAmount: "20.00", lateFeeCurrency: "USD", maxPrepaidMonths: 5, createdById: a.admin.id } });
  }, 30_000);

  it("purchase acquires the assignment lock first: correctAssignment queues and only proceeds after commit; provenance reflects the plan actually relied upon, permanently", async () => {
    const s = await newStudent("raceA", academy.id);
    const row = await assign(s.id, planX.id, 2031, 1); // effective exactly at the purchase's own first purchasable month

    let gateRelease!: () => void;
    const gate = new Promise<void>((r) => (gateRelease = r));
    let pausedResolve!: () => void;
    const paused = new Promise<void>((r) => (pausedResolve = r));
    const purchasing = prepay(
      { studentId: s.id, requestedMonths: [{ year: 2031, month: 1 }], tender: { currency: "USD", amount: "100.00" } },
      { afterPrepaymentObligationsWrittenForTest: async () => { pausedResolve(); await gate; } },
    );
    try {
      await paused; // the purchase has written its obligation and reached the pause point; transaction still open

      const correcting = correctAssignment(a.org.id, {} as Parameters<typeof correctAssignment>[1], formData({ assignmentId: row.id, expectedRevision: assignmentRevision(row), planId: planY.id }));
      const blocked = await waitUntilBlockedOnLock(['FROM "StudentPlanAssignment"', "FOR UPDATE"]);
      expect(blocked, "correctAssignment must genuinely block on the purchase's still-held assignment-row lock").toBe(true);

      gateRelease();
      const result = await purchasing;
      expect(result).toMatchObject({ ok: true });
      if (!result.ok) return;

      const correctionOutcome = await correcting;
      expect(correctionOutcome).toEqual({ ok: true });

      // The obligation's provenance audit entry reflects planX — what was ACTUALLY relied upon — permanently, even though
      // correctAssignment changed the row to planY immediately afterward.
      const provenance = await prisma.auditLog.findFirstOrThrow({ where: { organizationId: a.org.id, action: "duesObligation.prepaymentAssignment", entityId: result.obligationIds[0] } });
      expect(provenance.after).toMatchObject({ assignmentId: row.id, planId: planX.id, revision: assignmentRevision(row) });
      expect((await prisma.duesObligation.findUniqueOrThrow({ where: { id: result.obligationIds[0] } })).amount.toFixed(2)).toBe("100.00");
      expect((await prisma.studentPlanAssignment.findUniqueOrThrow({ where: { id: row.id, organizationId: a.org.id } })).planId).toBe(planY.id);
    } finally {
      gateRelease();
      await Promise.allSettled([purchasing]);
    }
  }, 20_000);

  it("correctAssignment acquires the row lock first: the purchase genuinely blocks, then its re-read after the lock sees the corrected plan", async () => {
    const s = await newStudent("raceB", academy.id);
    const row = await assign(s.id, planX.id, 2031, 1);

    const { startedPromise, release, held } = holdAssignmentLock(row.id, planY.id);
    await startedPromise;

    let purchasing: ReturnType<typeof prepay> | undefined;
    try {
      let done = false;
      purchasing = prepay({ studentId: s.id, requestedMonths: [{ year: 2031, month: 1 }], tender: { currency: "USD", amount: "130.00" } }).then((r) => ((done = true), r));
      const blocked = await waitUntilBlockedOnLock(['FROM "StudentPlanAssignment"', "FOR SHARE"]);
      expect(blocked, "the purchase must genuinely block on the held assignment-row lock").toBe(true);
      expect(done).toBe(false);

      release();
      await held; // the bystander commits planY, simulating correctAssignment's own committed write
      const result = await purchasing;
      expect(result).toMatchObject({ ok: true }); // 130.00 (planY's price) is the correct total ONLY if the re-read saw planY
      if (!result.ok) return;
      const provenance = await prisma.auditLog.findFirstOrThrow({ where: { organizationId: a.org.id, action: "duesObligation.prepaymentAssignment", entityId: result.obligationIds[0] } });
      expect(provenance.after).toMatchObject({ assignmentId: row.id, planId: planY.id });
      expect((await prisma.duesObligation.findUniqueOrThrow({ where: { id: result.obligationIds[0] } })).amount.toFixed(2)).toBe("130.00");
    } finally {
      release();
      await Promise.allSettled([held, purchasing]);
    }
  }, 20_000);
});

function formData(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

describe("prepayMonthlyObligations: preserves ordinary payment behavior", () => {
  it("an ordinary recordDuesPayment for a current, already-created obligation is unaffected by this writer's existence", async () => {
    const s = await newStudent("ordinary");
    const sep = await createMonthlyObligation({ context: context(), studentId: s.id, coverage: { year: 2030, month: 9 }, planTermsId: termsA.id, policyVersionId: policyBase.id }, deps());
    if (!sep.ok) throw new Error(sep.error);
    const r = await recordDuesPayment({ context: context(), studentId: s.id, receivedOn: { year: 2030, month: 10, day: 5 }, tender: { currency: "USD", amount: "100.00" }, method: "EFECTIVO", obligationIds: [sep.obligationId], maxBackdateDays: 90 }, deps());
    expect(r).toMatchObject({ ok: true });
  });
});

describe("reversePayment: prepaymentBlocksReversal (also covered directly in reverse-payment.test.ts)", () => {
  it("a payment settling a PREPAYMENT-origin obligation refuses reversal, permanently, even once the month has passed", async () => {
    const s = await newStudent("reversalblock");
    await assign(s.id, planA.id);
    const r = await prepay({ studentId: s.id, requestedMonths: months(2031, 1, 1), tender: { currency: "USD", amount: "100.00" } });
    expect(r).toMatchObject({ ok: true });
    if (!r.ok) return;
    const reversed = await reversePayment({ context: context(), paymentId: r.paymentId, reversalReason: "attempted reversal of a prepaid month" }, deps());
    expect(reversed).toEqual({ ok: false, error: "prepaymentBlocksReversal" });
    // Even once the calendar has moved well past January 2031, the restriction remains — origin never changes back.
    const stillBlocked = await reversePayment({ context: context(), paymentId: r.paymentId, reversalReason: "attempted again, months later" }, deps({ now: at("2031-06-01T12:00:00") }));
    expect(stillBlocked).toEqual({ ok: false, error: "prepaymentBlocksReversal" });
  });
});
