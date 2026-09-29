import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getTestPrismaClient } from "../helpers/test-db";
import { makeAccountingOrg } from "../helpers/accounting-org";
import type { TenantContext } from "../../src/lib/tenant/types";
import { createMonthlyObligation } from "../../src/lib/dues/ledger/create-monthly-obligation";
import { recordDuesPayment } from "../../src/lib/dues/ledger/record-payment";
import { assessLateFeesForStudent } from "../../src/lib/dues/late-fee-assessment";
import { correctLateFeeAndSettle } from "../../src/lib/dues/ledger/correct-late-fee";
import { reversePayment } from "../../src/lib/dues/ledger/reverse-payment";
import { waiveLateFee } from "../../src/lib/dues/ledger/waive-late-fee";
import type { LedgerActivation } from "../../src/lib/dues/ledger/activation";
import { versionRevision } from "../../src/lib/dues/config-input";

/**
 * Late-fee-waiver brief, proved against the REAL test database, following the exact fixture/concurrency conventions
 * `correct-late-fee.test.ts` and `reverse-payment.test.ts` already established. `waiveLateFee` touches exactly one
 * `DuesLateFee` row plus its audit entry — never a settlement, obligation or coverage row — so most of this suite proves
 * absence of side effects as much as the marker itself.
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
let terms: { id: string };
let feePolicy: { id: string };

function context(over: Partial<TenantContext> = {}): TenantContext {
  return { kind: "tenant", actorUserId: a.admin.id, organizationId: a.org.id, organizationRole: "ADMIN", academyIds: "ALL", selfStudentId: null, linkedStudentId: null, ...over };
}

let studentCounter = 0;
async function newStudent(label: string) {
  const n = ++studentCounter;
  return prisma.student.create({
    data: {
      organizationId: a.org.id, homeAcademyId: a.academy.id, firstName: "Waive", lastName: `${label}${n}`, phone: "00000000",
      email: `waive-${label}-${n}-${suffix}@example.com`, currentRankId: await a.rankId("WHITE"), codeHash: `waive-${label}-${n}-${suffix}`, status: "ACTIVE",
    },
  });
}

/** A MONTHLY obligation (due the 20th, grace to the 5th of the next month), USD 100 + a USD 20 fee. */
async function newObligation(studentId: string, month = 10) {
  const r = await createMonthlyObligation({ context: context(), studentId, coverage: { year: 2030, month }, planTermsId: terms.id, policyVersionId: feePolicy.id }, deps());
  if (!r.ok) throw new Error(`fixture obligation failed: ${r.error}`);
  return r.obligationId;
}

async function assessAsOf(studentId: string, month: number, day: number) {
  const r = await assessLateFeesForStudent(context(), studentId, deps({ now: at(`2030-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}T12:00:00`) }));
  if (!r.ok) throw new Error(`fixture assessment failed: ${r.reason}`);
  return r.outcomes;
}

function feeIdFor(outcomes: Awaited<ReturnType<typeof assessAsOf>>, obligationId: string): string {
  const outcome = outcomes.find((o) => o.obligationId === obligationId);
  if (!outcome || !("feeId" in outcome) || !outcome.feeId) throw new Error(`fixture: no assessed fee for obligation ${obligationId}`);
  return outcome.feeId;
}

async function currentFee(feeId: string) {
  return prisma.duesLateFee.findUniqueOrThrow({ where: { id: feeId } });
}
function feeRevision(row: { removedAt: Date | null; removalKind: string | null }): string {
  return versionRevision({ removedAt: row.removedAt ? row.removedAt.toISOString() : null, removalKind: row.removalKind });
}

async function pay(studentId: string, obligationIds: string[], amount: string, receivedOn: { year: number; month: number; day: number }, extraDeps: Record<string, unknown> = {}) {
  const r = await recordDuesPayment(
    { context: context(), studentId, receivedOn, tender: { currency: "USD", amount }, method: "EFECTIVO", obligationIds, maxBackdateDays: 90 },
    deps(extraDeps),
  );
  if (!r.ok) throw new Error(`fixture payment failed: ${r.error}`);
  return r;
}

const waive = (over: Partial<Parameters<typeof waiveLateFee>[0]> = {}, extraDeps: Record<string, unknown> = {}) =>
  waiveLateFee({ context: context(), lateFeeId: "", expectedRevision: "", removalReason: "goodwill exception, approved by owner", ...over }, deps(extraDeps));

const correct = (over: Partial<Parameters<typeof correctLateFeeAndSettle>[0]> = {}, extraDeps: Record<string, unknown> = {}) =>
  correctLateFeeAndSettle(
    {
      context: context(), lateFeeId: "", expectedRevision: "", removalReason: "student showed a receipt dated the actual payment date",
      receivedOn: { year: 2030, month: 11, day: 5 }, tender: { currency: "USD", amount: "100.00" }, method: "EFECTIVO", maxBackdateDays: 90,
      ...over,
    },
    deps(extraDeps),
  );

const reverse = (over: Partial<Parameters<typeof reversePayment>[0]> = {}, extraDeps: Record<string, unknown> = {}) =>
  reversePayment({ context: context(), paymentId: "", reversalReason: "owner-confirmed reversal", ...over }, deps(extraDeps));

async function ledgerCounts(organizationId: string) {
  return {
    payments: await prisma.duesPayment.count({ where: { organizationId } }),
    settlements: await prisma.duesSettlement.count({ where: { organizationId } }),
    fees: await prisma.duesLateFee.count({ where: { organizationId } }),
    waivedFees: await prisma.duesLateFee.count({ where: { organizationId, removalKind: "WAIVED" } }),
    voidedFees: await prisma.duesLateFee.count({ where: { organizationId, removalKind: "VOIDED" } }),
    audits: await prisma.auditLog.count({ where: { organizationId, action: { in: ["duesPayment.record", "duesLateFee.assess", "duesLateFee.void", "duesLateFee.waive", "duesPayment.reverse"] } } }),
  };
}

/**
 * A dedicated, test-controlled transaction that takes the student lock and holds it until `release()`. `startedPromise`
 * resolves with the holder's OWN backend pid (via `pg_backend_pid()`, captured right after the lock is acquired) so a test
 * can later prove a SPECIFIC waiter is blocked BY IT — not by an unrelated parallel test's hold on a different row. Every
 * test here uses a freshly created, unique student, so anything genuinely blocked by THIS holder's pid can only be a writer
 * THIS test itself started, never a coincidence from another integration test file running concurrently.
 */
function holdStudentLock(studentId: string) {
  let started!: (pid: number) => void;
  const startedPromise = new Promise<number>((r) => (started = r));
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const held = prisma.$transaction(
    async (tx) => {
      await tx.$queryRawUnsafe(`SELECT "id" FROM "Student" WHERE "id" = '${studentId}' FOR UPDATE`);
      const [{ pid }] = await tx.$queryRawUnsafe<{ pid: number }[]>(`SELECT pg_backend_pid() AS pid`);
      started(pid);
      await gate;
    },
    { timeout: 60_000 },
  );
  return { startedPromise, release, held };
}

async function waitUntilBlockedByHolder(holderPid: number, timeoutMs = 5000): Promise<boolean> {
  return waitUntilNBlockedByHolder(holderPid, 1, timeoutMs);
}

/**
 * Polls until at least `n` distinct backends are blocked, directly or transitively, BY `holderPid` specifically — walking the
 * actual blocking CHAIN Postgres reports (`pg_blocking_pids`), not a single direct-match test.
 *
 * Verified empirically against this exact Postgres version, not assumed: for row-level `SELECT ... FOR UPDATE` contention on
 * one row, `pg_blocking_pids` reports each waiter as blocked ONLY by the one process immediately ahead of it in the queue —
 * holder ← waiter1 ← waiter2 — never by the original holder for every waiter down the chain. A second queued waiter's own
 * `pg_blocking_pids` therefore never contains `holderPid` directly, even though it is genuinely, ultimately blocked by it.
 * (Confirmed with a standalone two-waiter probe: waiter1 reported `blockedBy: [holderPid]`, waiter2 reported
 * `blockedBy: [waiter1Pid]` — a naive direct-match check can never reach n=2, no matter how long it polls.) This walks that
 * chain in application code instead, so it still correctly identifies only THIS test's own writers — every test here uses a
 * freshly created, unique student, so a path back to THIS holder's specific pid can only run through a writer this test
 * itself started, never an unrelated parallel test's session on a different row.
 */
async function waitUntilNBlockedByHolder(holderPid: number, n: number, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = await prisma.$queryRaw<{ pid: number; blockedby: number[] }[]>`SELECT pid, pg_blocking_pids(pid) AS blockedby FROM pg_stat_activity WHERE wait_event_type = 'Lock'`;
    const chain = new Map(rows.map((r) => [r.pid, r.blockedby]));
    let reachingHolder = 0;
    for (const pid of chain.keys()) {
      let current = pid;
      const seen = new Set<number>();
      while (!seen.has(current)) {
        seen.add(current);
        const blockers = chain.get(current);
        if (!blockers) break;
        if (blockers.includes(holderPid)) {
          reachingHolder++;
          break;
        }
        const nextHop = blockers.find((b) => chain.has(b));
        if (nextHop === undefined) break;
        current = nextHop;
      }
    }
    if (reachingHolder >= n) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

beforeAll(async () => {
  a = await makeAccountingOrg("CUMULATIVE", "waive-a");
  b = await makeAccountingOrg("CUMULATIVE", "waive-b");
  const plan = await prisma.paymentPlan.create({ data: { organizationId: a.org.id, academyId: a.academy.id, name: `Waive plan ${suffix}` } });
  terms = await prisma.paymentPlanTerms.create({
    data: { organizationId: a.org.id, planId: plan.id, effectiveYear: 2027, effectiveMonth: 1, priceAmount: "100.00", currency: "USD", monthsCovered: 1, createdById: a.admin.id },
  });
  feePolicy = await prisma.duesPolicyVersion.create({
    data: { organizationId: a.org.id, academyId: a.academy.id, effectiveYear: 2027, effectiveMonth: 1, dueDay: 20, graceDay: 5, lateFeeAmount: "20.00", lateFeeCurrency: "USD", createdById: a.admin.id },
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

describe("waiveLateFee: waiving an owed, unpaid fee touches exactly one row plus its audit entry", () => {
  it("waives cleanly; assessment never recreates the fee; a later tuition-only payment settles with no fee attached", async () => {
    const s = await newStudent("waiveunpaid");
    const obligationId = await newObligation(s.id);
    const outcomes = await assessAsOf(s.id, 11, 6); // past Nov 5 grace: fee assessed, unpaid
    const feeId = feeIdFor(outcomes, obligationId);
    const before = await currentFee(feeId);
    expect(before.removedAt).toBeNull();
    const obligationBefore = await prisma.duesObligation.findUniqueOrThrow({ where: { id: obligationId } });

    const waived = await waive({ lateFeeId: feeId, expectedRevision: feeRevision(before) });
    expect(waived).toEqual({ ok: true, feeId });
    const after = await currentFee(feeId);
    expect(after.removalKind).toBe("WAIVED");
    expect(after.removedAt).not.toBeNull();
    expect(after.removedById).toBe(a.admin.id);
    expect(after.removalReason).toBe("goodwill exception, approved by owner");
    expect(await prisma.auditLog.count({ where: { organizationId: a.org.id, action: "duesLateFee.waive", entityId: feeId } })).toBe(1);
    // no settlement, obligation or coverage write of any kind
    expect(await prisma.duesSettlement.count({ where: { obligationId } })).toBe(0);
    expect(await prisma.duesObligation.findUniqueOrThrow({ where: { id: obligationId } })).toEqual(obligationBefore);

    // assessment never recreates a second fee row, and reports the existing (now-waived) one, never "notOwed"
    const reassessed = await assessAsOf(s.id, 11, 20);
    const outcome = reassessed.find((o) => o.obligationId === obligationId);
    expect(outcome).toMatchObject({ category: "alreadyAssessed", feeId });
    expect(await prisma.duesLateFee.count({ where: { obligationId } })).toBe(1);

    // a later payment settles at the tuition-only total — the waived fee is excluded, not re-charged
    const paid = await pay(s.id, [obligationId], "100.00", { year: 2030, month: 11, day: 25 });
    expect(paid.settlementIds).toHaveLength(1);
    const settlement = await prisma.duesSettlement.findUniqueOrThrow({ where: { id: paid.settlementIds[0] } });
    expect(settlement.lateFeeId).toBeNull();
  });
});

describe("waiveLateFee: an already-paid fee refuses outright (alreadyPaid), writing nothing", () => {
  it("a fee already included in an active settlement refuses alreadyPaid, fee row untouched", async () => {
    const s = await newStudent("alreadypaid");
    const obligationId = await newObligation(s.id);
    const paid = await pay(s.id, [obligationId], "120.00", { year: 2030, month: 11, day: 10 }); // late: tuition + fee, both settled
    const before = await prisma.duesLateFee.findFirstOrThrow({ where: { obligationId } });
    expect(paid.settlementIds).toHaveLength(1);
    const settlement = await prisma.duesSettlement.findUniqueOrThrow({ where: { id: paid.settlementIds[0] } });
    expect(settlement.lateFeeId).toBe(before.id);
    const beforeCounts = await ledgerCounts(a.org.id);

    const result = await waive({ lateFeeId: before.id, expectedRevision: feeRevision(before) });
    expect(result).toEqual({ ok: false, error: "alreadyPaid" });
    expect(await ledgerCounts(a.org.id)).toEqual(beforeCounts);
    expect(await currentFee(before.id)).toEqual(before);
  });
});

describe("waiveLateFee: a reversed settlement is history, not payment — the fee waives normally once reopened", () => {
  it("reversing a payment that included a valid fee, then waiving that now-unpaid fee, succeeds", async () => {
    const s = await newStudent("reversethenwaive");
    const obligationId = await newObligation(s.id);
    const paid = await pay(s.id, [obligationId], "120.00", { year: 2030, month: 11, day: 10 }); // late: tuition + fee
    const feeRow = await prisma.duesLateFee.findFirstOrThrow({ where: { obligationId } });

    // Still attached to an ACTIVE settlement: refused.
    const tooEarly = await waive({ lateFeeId: feeRow.id, expectedRevision: feeRevision(feeRow) });
    expect(tooEarly).toEqual({ ok: false, error: "alreadyPaid" });

    const reversed = await reverse({ paymentId: paid.paymentId });
    expect(reversed.ok).toBe(true);
    const settlementAfterReversal = await prisma.duesSettlement.findUniqueOrThrow({ where: { id: paid.settlementIds[0] } });
    expect(settlementAfterReversal.reversedAt).not.toBeNull(); // history now, not payment

    const result = await waive({ lateFeeId: feeRow.id, expectedRevision: feeRevision(feeRow) });
    expect(result).toEqual({ ok: true, feeId: feeRow.id });
    const after = await currentFee(feeRow.id);
    expect(after.removalKind).toBe("WAIVED");

    // Preserves reversePayment's VOIDED-only restriction: reversal above succeeded on a still-active (unwaived at the time) fee,
    // and a second reversal attempt is refused for an unrelated reason (alreadyReversed), never voidedFeeBlocksReversal — a
    // waived fee was never, and should never be, part of that check.
    const secondReversal = await reverse({ paymentId: paid.paymentId });
    expect(secondReversal).toMatchObject({ ok: false, error: "alreadyReversed" });
  });
});

describe("waiveLateFee: rollback proof", () => {
  it("a failure forced right after the removal marker and audit row still leaves the fee active", async () => {
    const s = await newStudent("rollback");
    const obligationId = await newObligation(s.id);
    const outcomes = await assessAsOf(s.id, 11, 6);
    const feeId = feeIdFor(outcomes, obligationId);
    const before = await currentFee(feeId);
    const beforeCounts = await ledgerCounts(a.org.id);

    await expect(
      waive({ lateFeeId: feeId, expectedRevision: feeRevision(before) }, { afterWaiveMarkersForTest: async () => { throw new Error("forced failure, proving rollback"); } }),
    ).rejects.toThrow("forced failure");

    const after = await currentFee(feeId);
    expect(after.removedAt).toBeNull();
    expect(after.removalKind).toBeNull();
    expect(await ledgerCounts(a.org.id)).toEqual(beforeCounts);
  });
});

describe("waiveLateFee: unauthorized, cross-tenant, out-of-branch, malformed, stale and repeated requests write nothing", () => {
  it("a non-ADMIN context is refused (notFound)", async () => {
    const s = await newStudent("nonadmin");
    const obligationId = await newObligation(s.id);
    const outcomes = await assessAsOf(s.id, 11, 6);
    const feeId = feeIdFor(outcomes, obligationId);
    const before = await currentFee(feeId);
    const beforeCounts = await ledgerCounts(a.org.id);

    const result = await waive({ context: context({ organizationRole: "DIRECTOR" }), lateFeeId: feeId, expectedRevision: feeRevision(before) });
    expect(result).toEqual({ ok: false, error: "notFound" });
    expect(await ledgerCounts(a.org.id)).toEqual(beforeCounts);
  });

  it("a fee belonging to a different organization is refused (notFound), never leaked across tenants", async () => {
    const bPlan = await prisma.paymentPlan.create({ data: { organizationId: b.org.id, academyId: b.academy.id, name: `B plan ${suffix}` } });
    const bTerms = await prisma.paymentPlanTerms.create({
      data: { organizationId: b.org.id, planId: bPlan.id, effectiveYear: 2027, effectiveMonth: 1, priceAmount: "100.00", currency: "USD", monthsCovered: 1, createdById: b.admin.id },
    });
    const bFeePolicy = await prisma.duesPolicyVersion.create({
      data: { organizationId: b.org.id, academyId: b.academy.id, effectiveYear: 2027, effectiveMonth: 1, dueDay: 20, graceDay: 5, lateFeeAmount: "20.00", lateFeeCurrency: "USD", createdById: b.admin.id },
    });
    const bStudent = await prisma.student.create({
      data: {
        organizationId: b.org.id, homeAcademyId: b.academy.id, firstName: "Waive", lastName: `B${suffix}`, phone: "00000000",
        email: `waive-b-${suffix}@example.com`, currentRankId: await b.rankId("WHITE"), codeHash: `waive-b-${suffix}`, status: "ACTIVE",
      },
    });
    const bContext: TenantContext = { kind: "tenant", actorUserId: b.admin.id, organizationId: b.org.id, organizationRole: "ADMIN", academyIds: "ALL", selfStudentId: null, linkedStudentId: null };
    const bObligation = await createMonthlyObligation({ context: bContext, studentId: bStudent.id, coverage: { year: 2030, month: 10 }, planTermsId: bTerms.id, policyVersionId: bFeePolicy.id }, deps());
    if (!bObligation.ok) throw new Error(`fixture: b-org obligation failed: ${bObligation.error}`);
    const bAssessed = await assessLateFeesForStudent(bContext, bStudent.id, deps({ now: at("2030-11-06T12:00:00") }));
    if (!bAssessed.ok) throw new Error(`fixture: b-org assessment failed: ${bAssessed.reason}`);
    const bOutcome = bAssessed.outcomes.find((o) => o.obligationId === bObligation.obligationId);
    if (!bOutcome || !("feeId" in bOutcome) || !bOutcome.feeId) throw new Error("fixture: no b-org fee assessed");
    const bFee = await prisma.duesLateFee.findUniqueOrThrow({ where: { id: bOutcome.feeId } });

    const result = await waive({ lateFeeId: bFee.id, expectedRevision: feeRevision(bFee) }); // org a's context, org b's lateFeeId
    expect(result).toEqual({ ok: false, error: "notFound" });
    expect((await currentFee(bFee.id)).removedAt).toBeNull();
  });

  it("a DIRECTOR scoped to a different branch is refused (notFound)", async () => {
    const otherAcademy = await prisma.academy.create({ data: { organizationId: a.org.id, name: `Other ${suffix}`, slug: `other-waive-${suffix}`, kioskTokenHash: `other-waive-${suffix}` } });
    const s = await newStudent("outofbranch");
    const obligationId = await newObligation(s.id);
    const outcomes = await assessAsOf(s.id, 11, 6);
    const feeId = feeIdFor(outcomes, obligationId);
    const before = await currentFee(feeId);
    const beforeCounts = await ledgerCounts(a.org.id);

    const result = await waive({ context: context({ organizationRole: "DIRECTOR", academyIds: [otherAcademy.id] }), lateFeeId: feeId, expectedRevision: feeRevision(before) });
    expect(result).toEqual({ ok: false, error: "notFound" });
    expect(await ledgerCounts(a.org.id)).toEqual(beforeCounts);
    await prisma.academy.delete({ where: { id: otherAcademy.id } });
  });

  const malformed: Array<{ label: string; lateFeeId?: unknown; expectedRevision?: unknown; removalReason?: unknown }> = [
    { label: "empty lateFeeId", lateFeeId: "" },
    { label: "non-string lateFeeId", lateFeeId: 12345 },
    { label: "null lateFeeId", lateFeeId: null },
    { label: "empty expectedRevision", expectedRevision: "" },
    { label: "non-string expectedRevision", expectedRevision: 42 },
    { label: "null expectedRevision", expectedRevision: null },
    { label: "empty removalReason", removalReason: "" },
    { label: "whitespace-only removalReason", removalReason: "   " },
    { label: "non-string removalReason", removalReason: 42 },
  ];
  for (const item of malformed) {
    it(`${item.label}: refuses invalid, never throws, writes nothing`, async () => {
      const s = await newStudent("malformed");
      const obligationId = await newObligation(s.id);
      const outcomes = await assessAsOf(s.id, 11, 6);
      const feeId = feeIdFor(outcomes, obligationId);
      const before = await currentFee(feeId);
      const beforeCounts = await ledgerCounts(a.org.id);

      const lateFeeId = "lateFeeId" in item ? item.lateFeeId : feeId;
      const expectedRevision = "expectedRevision" in item ? item.expectedRevision : feeRevision(before);
      const removalReason = "removalReason" in item ? item.removalReason : "goodwill exception, approved by owner";
      let result: Awaited<ReturnType<typeof waive>> | undefined;
      let threw: unknown;
      try {
        result = await waive({ lateFeeId: lateFeeId as never, expectedRevision: expectedRevision as never, removalReason: removalReason as never });
      } catch (e) {
        threw = e;
      }
      expect(threw, "must return a typed refusal, never throw").toBeUndefined();
      expect(result).toEqual({ ok: false, error: "invalid" });
      expect(await ledgerCounts(a.org.id)).toEqual(beforeCounts);
    });
  }

  it("a stale expectedRevision is refused, fee untouched", async () => {
    const s = await newStudent("stale");
    const obligationId = await newObligation(s.id);
    const outcomes = await assessAsOf(s.id, 11, 6);
    const feeId = feeIdFor(outcomes, obligationId);
    const beforeCounts = await ledgerCounts(a.org.id);

    const result = await waive({ lateFeeId: feeId, expectedRevision: "not-the-real-revision" });
    expect(result).toEqual({ ok: false, error: "stale" });
    expect((await currentFee(feeId)).removedAt).toBeNull();
    expect(await ledgerCounts(a.org.id)).toEqual(beforeCounts);
  });

  it("an already-waived fee refuses a second attempt (alreadyRemoved), without touching its existing removalKind/removalReason", async () => {
    const s = await newStudent("twice");
    const obligationId = await newObligation(s.id);
    const outcomes = await assessAsOf(s.id, 11, 6);
    const feeId = feeIdFor(outcomes, obligationId);
    const first = await waive({ lateFeeId: feeId, expectedRevision: feeRevision(await currentFee(feeId)), removalReason: "first reason, genuine" });
    expect(first.ok).toBe(true);
    const afterFirst = await currentFee(feeId);
    const beforeCounts = await ledgerCounts(a.org.id);

    const second = await waive({ lateFeeId: feeId, expectedRevision: feeRevision(afterFirst), removalReason: "a different reason, should never land" });
    expect(second).toEqual({ ok: false, error: "alreadyRemoved" });
    expect(await currentFee(feeId)).toEqual(afterFirst); // untouched: same reason, same removedAt, same removedById
    expect(await ledgerCounts(a.org.id)).toEqual(beforeCounts);
  });

  it("a void attempt on an already-waived fee, and a waiver attempt on an already-voided fee, both refuse alreadyRemoved", async () => {
    const s1 = await newStudent("waivedthenvoid");
    const obligationId1 = await newObligation(s1.id);
    const outcomes1 = await assessAsOf(s1.id, 11, 6);
    const feeId1 = feeIdFor(outcomes1, obligationId1);
    const waived1 = await waive({ lateFeeId: feeId1, expectedRevision: feeRevision(await currentFee(feeId1)) });
    expect(waived1.ok).toBe(true);
    const voidAttempt = await correct({ lateFeeId: feeId1, expectedRevision: "irrelevant: alreadyRemoved is checked first" });
    expect(voidAttempt).toMatchObject({ ok: false, error: "alreadyRemoved" });

    const s2 = await newStudent("voidedthenwaive");
    const obligationId2 = await newObligation(s2.id);
    const outcomes2 = await assessAsOf(s2.id, 11, 6);
    const feeId2 = feeIdFor(outcomes2, obligationId2);
    const before2 = await currentFee(feeId2);
    const voided2 = await correct({ lateFeeId: feeId2, expectedRevision: feeRevision(before2) });
    expect(voided2.ok).toBe(true);
    const waiveAttempt = await waive({ lateFeeId: feeId2, expectedRevision: "irrelevant: alreadyRemoved is checked first" });
    expect(waiveAttempt).toMatchObject({ ok: false, error: "alreadyRemoved" });
  });
});

/**
 * Genuine overlapping-transaction proof, not sequential: a bystander holds the student lock and captures its own backend pid
 * (`holdStudentLock`'s `startedPromise`); the FIRST real writer queued behind it is proven blocked, directly or transitively,
 * BY THAT SPECIFIC PID (`waitUntilBlockedByHolder(holderPid)`, walking Postgres's own `pg_blocking_pids` chain — see that
 * helper's own comment for why a chain walk, not a single direct match, is required); the SECOND real writer is then also
 * queued and both are proven simultaneously on a path back to that SAME holder pid (`waitUntilNBlockedByHolder(holderPid,
 * 2)`) before the bystander ever releases. This identifies the two specific writers THIS test itself started, not merely "two
 * backends somewhere are waiting on a lock with similar-looking query text" — a count unrelated parallel integration test
 * files' own concurrent `lockStudent` calls could otherwise satisfy under real parallel test execution, since every test here
 * uses a freshly created, unique student and a path back to this exact pid can only run through this test's own writers.
 * PostgreSQL grants a row's FOR UPDATE lock to waiters in the order they queued, so releasing the bystander deterministically
 * lets whichever writer queued FIRST run to completion before the second is ever granted the lock — a real race arbitrated by
 * the database, not a scripted sequential await.
 */
describe("waiveLateFee: genuine overlapping transactions with a live recordDuesPayment attempt", () => {
  it("waiver wins (queued first): the payment queued second validates against the waived, tuition-only total", async () => {
    const s = await newStudent("waiverwins");
    const obligationId = await newObligation(s.id);
    const outcomes = await assessAsOf(s.id, 11, 6);
    const feeId = feeIdFor(outcomes, obligationId);
    const before = await currentFee(feeId);

    const { startedPromise, release, held } = holdStudentLock(s.id);
    const holderPid = await startedPromise;

    let waiving: ReturnType<typeof waive> | undefined;
    let paying: ReturnType<typeof pay> | undefined;
    try {
      let waiveDone = false;
      waiving = waive({ lateFeeId: feeId, expectedRevision: feeRevision(before) }).then((r) => ((waiveDone = true), r));
      expect(await waitUntilBlockedByHolder(holderPid), "the waiver must genuinely block on the bystander's held lock").toBe(true);
      expect(waiveDone).toBe(false);

      let payDone = false;
      // Tuition-only: this total is correct ONLY once the waiver has actually committed — a stale, pre-waiver read would still
      // owe the fee, making this total short and refusing (notASelectableTotal). Success here proves the payment observed the
      // waiver's committed effect, not a snapshot taken before it queued.
      paying = pay(s.id, [obligationId], "100.00", { year: 2030, month: 11, day: 25 }).then((r) => ((payDone = true), r));
      expect(await waitUntilNBlockedByHolder(holderPid, 2), "both the waiver and the payment must be simultaneously blocked on the bystander's lock").toBe(true);
      expect(payDone).toBe(false);

      release();
      await held;
      const waived = await waiving;
      expect(waived).toEqual({ ok: true, feeId });
      const paid = await paying;
      expect(paid.settlementIds).toHaveLength(1);
      const settlement = await prisma.duesSettlement.findUniqueOrThrow({ where: { id: paid.settlementIds[0] } });
      expect(settlement.lateFeeId).toBeNull();
    } finally {
      release(); // idempotent
      await Promise.allSettled(([held, waiving, paying] as (Promise<unknown> | undefined)[]).filter((p) => p !== undefined));
    }
  }, 20_000);

  it("payment wins (queued first): the waiver queued second observes the fee is now paid and refuses alreadyPaid", async () => {
    const s = await newStudent("paymentwins");
    const obligationId = await newObligation(s.id);
    const outcomes = await assessAsOf(s.id, 11, 6);
    const feeId = feeIdFor(outcomes, obligationId);
    const before = await currentFee(feeId);

    const { startedPromise, release, held } = holdStudentLock(s.id);
    const holderPid = await startedPromise;

    let waiving: ReturnType<typeof waive> | undefined;
    let paying: ReturnType<typeof pay> | undefined;
    try {
      let payDone = false;
      // Tuition + fee: correct only while the fee is still active — this is the real historical state at the moment this
      // payment is queued, since it queues BEFORE the waiver.
      paying = pay(s.id, [obligationId], "120.00", { year: 2030, month: 11, day: 25 }).then((r) => ((payDone = true), r));
      expect(await waitUntilBlockedByHolder(holderPid), "the payment must genuinely block on the bystander's held lock").toBe(true);
      expect(payDone).toBe(false);

      let waiveDone = false;
      waiving = waive({ lateFeeId: feeId, expectedRevision: feeRevision(before) }).then((r) => ((waiveDone = true), r));
      expect(await waitUntilNBlockedByHolder(holderPid, 2), "both the payment and the waiver must be simultaneously blocked on the bystander's lock").toBe(true);
      expect(waiveDone).toBe(false);

      release();
      await held;
      const paid = await paying;
      expect(paid.settlementIds).toHaveLength(1);
      const settlement = await prisma.duesSettlement.findUniqueOrThrow({ where: { id: paid.settlementIds[0] } });
      expect(settlement.lateFeeId).toBe(feeId);

      const waived = await waiving;
      expect(waived).toEqual({ ok: false, error: "alreadyPaid" });
      const feeAfter = await currentFee(feeId);
      expect(feeAfter.removedAt).toBeNull(); // refused, not silently waived
    } finally {
      release(); // idempotent
      await Promise.allSettled(([held, waiving, paying] as (Promise<unknown> | undefined)[]).filter((p) => p !== undefined));
    }
  }, 20_000);
});
