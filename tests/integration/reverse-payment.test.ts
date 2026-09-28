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
import type { LedgerActivation } from "../../src/lib/dues/ledger/activation";
import { toDbDate } from "../../src/lib/dues/ledger/common";
import { versionRevision } from "../../src/lib/dues/config-input";

/**
 * Payment-reversal brief, proved against the REAL test database, following the exact fixture/concurrency conventions
 * `correct-late-fee.test.ts` already established. Decision A (a valid, never-voided fee is simply left alone — verified by
 * settling, reversing, and settling again with no duplicate fee row) and Decision B (a VOIDED fee refuses the WHOLE reversal,
 * writing nothing) are both exercised, alongside the writer's own "trust nothing" checks and its rollback mechanism.
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
      organizationId: a.org.id, homeAcademyId: a.academy.id, firstName: "Reverse", lastName: `${label}${n}`, phone: "00000000",
      email: `reverse-${label}-${n}-${suffix}@example.com`, currentRankId: await a.rankId("WHITE"), codeHash: `reverse-${label}-${n}-${suffix}`, status: "ACTIVE",
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

async function pay(studentId: string, obligationIds: string[], amount: string, receivedOn: { year: number; month: number; day: number }, extraDeps: Record<string, unknown> = {}) {
  const r = await recordDuesPayment(
    { context: context(), studentId, receivedOn, tender: { currency: "USD", amount }, method: "EFECTIVO", obligationIds, maxBackdateDays: 90 },
    deps(extraDeps),
  );
  if (!r.ok) throw new Error(`fixture payment failed: ${r.error}`);
  return r;
}

const reverse = (over: Partial<Parameters<typeof reversePayment>[0]> = {}, extraDeps: Record<string, unknown> = {}) =>
  reversePayment({ context: context(), paymentId: "", reversalReason: "owner-confirmed reversal", ...over }, deps(extraDeps));

async function currentPayment(id: string) {
  return prisma.duesPayment.findUniqueOrThrow({ where: { id } });
}
async function settlementsFor(paymentId: string) {
  return prisma.duesSettlement.findMany({ where: { paymentId } });
}

async function ledgerCounts(organizationId: string) {
  return {
    payments: await prisma.duesPayment.count({ where: { organizationId } }),
    reversedPayments: await prisma.duesPayment.count({ where: { organizationId, reversedAt: { not: null } } }),
    settlements: await prisma.duesSettlement.count({ where: { organizationId } }),
    reversedSettlements: await prisma.duesSettlement.count({ where: { organizationId, reversedAt: { not: null } } }),
    fees: await prisma.duesLateFee.count({ where: { organizationId } }),
    audits: await prisma.auditLog.count({ where: { organizationId, action: { in: ["duesPayment.record", "duesLateFee.void", "duesLateFee.assess", "duesPayment.reverse"] } } }),
  };
}

/** A dedicated, test-controlled transaction that takes the student lock and holds it until `release()`. */
function holdStudentLock(studentId: string) {
  let started!: () => void;
  const startedPromise = new Promise<void>((r) => (started = r));
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const held = prisma.$transaction(
    async (tx) => {
      await tx.$queryRawUnsafe(`SELECT "id" FROM "Student" WHERE "id" = '${studentId}' FOR UPDATE`);
      started();
      await gate;
    },
    { timeout: 60_000 },
  );
  return { startedPromise, release, held };
}

async function waitUntilBlockedOnLock(matches: string[], timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = await prisma.$queryRawUnsafe<{ query: string }[]>(`SELECT query FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query IS NOT NULL`);
    if (rows.some((row) => matches.every((m) => row.query.includes(m)))) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

beforeAll(async () => {
  a = await makeAccountingOrg("CUMULATIVE", "reverse-a");
  b = await makeAccountingOrg("CUMULATIVE", "reverse-b");
  const plan = await prisma.paymentPlan.create({ data: { organizationId: a.org.id, academyId: a.academy.id, name: `Reverse plan ${suffix}` } });
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

describe("reversePayment: Decision A — a valid, never-voided fee needs no special handling", () => {
  it("settle tuition + fee, reverse, settle again: exactly one DuesLateFee row remains, never duplicated", async () => {
    const s = await newStudent("settletwice");
    const obligationId = await newObligation(s.id);
    const paid = await pay(s.id, [obligationId], "120.00", { year: 2030, month: 11, day: 10 }); // after Nov 5 grace: late
    expect(await prisma.duesLateFee.count({ where: { obligationId } })).toBe(1);

    const result = await reverse({ paymentId: paid.paymentId });
    expect(result).toMatchObject({ ok: true, paymentId: paid.paymentId, settlementIds: paid.settlementIds });
    expect((await currentPayment(paid.paymentId)).reversedAt).not.toBeNull();
    for (const st of await settlementsFor(paid.paymentId)) expect(st.reversedAt).not.toBeNull();

    const repaid = await pay(s.id, [obligationId], "120.00", { year: 2030, month: 11, day: 15 });
    expect(repaid.paymentId).not.toBe(paid.paymentId);
    expect(await prisma.duesLateFee.count({ where: { obligationId } })).toBe(1); // never duplicated
  });
});

describe("reversePayment: reverses every settlement of a multi-obligation payment atomically", () => {
  it("a payment covering two obligations: both settlements change together", async () => {
    const s = await newStudent("multi");
    const ob1 = await newObligation(s.id, 9);
    const ob2 = await newObligation(s.id, 10);
    const paid = await pay(s.id, [ob1, ob2], "200.00", { year: 2030, month: 9, day: 15 }); // on time for both
    expect(paid.settlementIds).toHaveLength(2);

    const result = await reverse({ paymentId: paid.paymentId });
    expect(result).toMatchObject({ ok: true, settlementIds: expect.arrayContaining(paid.settlementIds) });
    const settlements = await settlementsFor(paid.paymentId);
    expect(settlements).toHaveLength(2);
    for (const st of settlements) expect(st.reversedAt).not.toBeNull();
    expect(await prisma.duesLateFee.count({ where: { obligationId: { in: [ob1, ob2] } } })).toBe(0);
  });
});

describe("reversePayment: Decision B — a VOIDED fee refuses the whole reversal, writing nothing", () => {
  it("reversing the settlement that resulted from voiding its own fee is refused (voidedFeeBlocksReversal)", async () => {
    // The only reachable way today for an obligation to carry a VOIDED fee is via `correctLateFeeAndSettle`, which voids the fee
    // and settles the obligation in the SAME transaction (correction refuses `alreadySettled` otherwise) — so the settlement whose
    // obligation has a VOIDED fee is necessarily the correction's own. This is the exact case the brief's Decision B disclaimer
    // covers: refusing here is a conservative restriction on current fee state, not a claim this settlement's creation "caused" it.
    const s = await newStudent("voided");
    const obligationId = await newObligation(s.id);
    const outcomes = await assessAsOf(s.id, 11, 6);
    const feeId = feeIdFor(outcomes, obligationId);
    const before = await prisma.duesLateFee.findUniqueOrThrow({ where: { id: feeId } });
    const corrected = await correctLateFeeAndSettle(
      {
        context: context(), lateFeeId: feeId, expectedRevision: versionRevision({ removedAt: before.removedAt ? before.removedAt.toISOString() : null, removalKind: before.removalKind }),
        removalReason: "student showed a receipt dated the actual payment date", receivedOn: { year: 2030, month: 11, day: 5 }, tender: { currency: "USD", amount: "100.00" }, method: "EFECTIVO", maxBackdateDays: 90,
      },
      deps(),
    );
    expect(corrected.ok).toBe(true);
    if (!corrected.ok) return;
    const beforeCounts = await ledgerCounts(a.org.id);

    const result = await reverse({ paymentId: corrected.paymentId });
    expect(result).toMatchObject({ ok: false, error: "voidedFeeBlocksReversal" });
    expect(await ledgerCounts(a.org.id)).toEqual(beforeCounts);
    expect((await currentPayment(corrected.paymentId)).reversedAt).toBeNull();
  });
});

describe("reversePayment: rollback proof", () => {
  it("a failure forced right after the reversal markers and audit row still leaves everything un-reversed", async () => {
    const s = await newStudent("rollback");
    const obligationId = await newObligation(s.id);
    const paid = await pay(s.id, [obligationId], "100.00", { year: 2030, month: 10, day: 1 }); // on time, no fee
    const beforeCounts = await ledgerCounts(a.org.id);

    await expect(
      reverse({ paymentId: paid.paymentId }, { afterReversalMarkersForTest: async () => { throw new Error("forced failure, proving rollback"); } }),
    ).rejects.toThrow("forced failure");

    expect((await currentPayment(paid.paymentId)).reversedAt).toBeNull();
    for (const st of await settlementsFor(paid.paymentId)) expect(st.reversedAt).toBeNull();
    expect(await ledgerCounts(a.org.id)).toEqual(beforeCounts);
  });
});

describe("reversePayment: unauthorized, cross-tenant, out-of-branch, malformed and repeated requests write nothing", () => {
  it("a non-ADMIN context is refused (notFound)", async () => {
    const s = await newStudent("nonadmin");
    const obligationId = await newObligation(s.id);
    const paid = await pay(s.id, [obligationId], "100.00", { year: 2030, month: 10, day: 1 });
    const beforeCounts = await ledgerCounts(a.org.id);

    const result = await reverse({ context: context({ organizationRole: "DIRECTOR" }), paymentId: paid.paymentId });
    expect(result).toMatchObject({ ok: false, error: "notFound" });
    expect(await ledgerCounts(a.org.id)).toEqual(beforeCounts);
  });

  it("a payment belonging to a different organization is refused (notFound), never leaked across tenants", async () => {
    const bPlan = await prisma.paymentPlan.create({ data: { organizationId: b.org.id, academyId: b.academy.id, name: `B plan ${suffix}` } });
    const bTerms = await prisma.paymentPlanTerms.create({
      data: { organizationId: b.org.id, planId: bPlan.id, effectiveYear: 2027, effectiveMonth: 1, priceAmount: "100.00", currency: "USD", monthsCovered: 1, createdById: b.admin.id },
    });
    const bFeePolicy = await prisma.duesPolicyVersion.create({
      data: { organizationId: b.org.id, academyId: b.academy.id, effectiveYear: 2027, effectiveMonth: 1, dueDay: 20, graceDay: 5, lateFeeAmount: "20.00", lateFeeCurrency: "USD", createdById: b.admin.id },
    });
    const bStudent = await prisma.student.create({
      data: {
        organizationId: b.org.id, homeAcademyId: b.academy.id, firstName: "Reverse", lastName: `B${suffix}`, phone: "00000000",
        email: `reverse-b-${suffix}@example.com`, currentRankId: await b.rankId("WHITE"), codeHash: `reverse-b-${suffix}`, status: "ACTIVE",
      },
    });
    const bContext: TenantContext = { kind: "tenant", actorUserId: b.admin.id, organizationId: b.org.id, organizationRole: "ADMIN", academyIds: "ALL", selfStudentId: null, linkedStudentId: null };
    const bObligation = await createMonthlyObligation({ context: bContext, studentId: bStudent.id, coverage: { year: 2030, month: 10 }, planTermsId: bTerms.id, policyVersionId: bFeePolicy.id }, deps());
    if (!bObligation.ok) throw new Error(`fixture: b-org obligation failed: ${bObligation.error}`);
    const bPaid = await recordDuesPayment(
      { context: bContext, studentId: bStudent.id, receivedOn: { year: 2030, month: 10, day: 1 }, tender: { currency: "USD", amount: "100.00" }, method: "EFECTIVO", obligationIds: [bObligation.obligationId], maxBackdateDays: 90 },
      deps(),
    );
    if (!bPaid.ok) throw new Error(`fixture: b-org payment failed: ${bPaid.error}`);

    const result = await reverse({ paymentId: bPaid.paymentId }); // org a's context, org b's paymentId
    expect(result).toMatchObject({ ok: false, error: "notFound" });
    expect((await currentPayment(bPaid.paymentId)).reversedAt).toBeNull();
  });

  it("a DIRECTOR scoped to a different branch is refused (notFound)", async () => {
    const otherAcademy = await prisma.academy.create({ data: { organizationId: a.org.id, name: `Other ${suffix}`, slug: `other-${suffix}`, kioskTokenHash: `other-${suffix}` } });
    const s = await newStudent("outofbranch");
    const obligationId = await newObligation(s.id);
    const paid = await pay(s.id, [obligationId], "100.00", { year: 2030, month: 10, day: 1 });
    const beforeCounts = await ledgerCounts(a.org.id);

    const result = await reverse({ context: context({ organizationRole: "DIRECTOR", academyIds: [otherAcademy.id] }), paymentId: paid.paymentId });
    expect(result).toMatchObject({ ok: false, error: "notFound" });
    expect(await ledgerCounts(a.org.id)).toEqual(beforeCounts);
    await prisma.academy.delete({ where: { id: otherAcademy.id } });
  });

  const malformed: Array<{ label: string; paymentId?: unknown; reversalReason?: unknown }> = [
    { label: "empty paymentId", paymentId: "" },
    { label: "non-string paymentId", paymentId: 12345 },
    { label: "null paymentId", paymentId: null },
    { label: "empty reversalReason", reversalReason: "" },
    { label: "whitespace-only reversalReason", reversalReason: "   " },
    { label: "non-string reversalReason", reversalReason: 42 },
  ];
  for (const item of malformed) {
    it(`${item.label}: refuses invalid, never throws, writes nothing`, async () => {
      const s = await newStudent("malformed");
      const obligationId = await newObligation(s.id);
      const paid = await pay(s.id, [obligationId], "100.00", { year: 2030, month: 10, day: 1 });
      const beforeCounts = await ledgerCounts(a.org.id);

      const paymentId = "paymentId" in item ? item.paymentId : paid.paymentId;
      const reversalReason = "reversalReason" in item ? item.reversalReason : "owner-confirmed reversal";
      let result: Awaited<ReturnType<typeof reverse>> | undefined;
      let threw: unknown;
      try {
        result = await reverse({ paymentId: paymentId as never, reversalReason: reversalReason as never });
      } catch (e) {
        threw = e;
      }
      expect(threw, "must return a typed refusal, never throw").toBeUndefined();
      expect(result).toEqual({ ok: false, error: "invalid" });
      expect(await ledgerCounts(a.org.id)).toEqual(beforeCounts);
    });
  }

  it("an already-reversed payment refuses a second attempt (alreadyReversed), writes nothing further", async () => {
    const s = await newStudent("twice");
    const obligationId = await newObligation(s.id);
    const paid = await pay(s.id, [obligationId], "100.00", { year: 2030, month: 10, day: 1 });
    const first = await reverse({ paymentId: paid.paymentId });
    expect(first.ok).toBe(true);
    const beforeCounts = await ledgerCounts(a.org.id);

    const second = await reverse({ paymentId: paid.paymentId });
    expect(second).toMatchObject({ ok: false, error: "alreadyReversed" });
    expect(await ledgerCounts(a.org.id)).toEqual(beforeCounts);
  });
});

describe("reversePayment: defensive backstops with no live path today, forced by direct test data manipulation", () => {
  it("a settlement whose obligation is not MONTHLY is refused (unsupportedObligationType)", async () => {
    const s = await newStudent("package");
    const packagePlan = await prisma.paymentPlan.create({ data: { organizationId: a.org.id, academyId: a.academy.id, name: `Package plan ${suffix}` } });
    const packageTerms = await prisma.paymentPlanTerms.create({
      data: { organizationId: a.org.id, planId: packagePlan.id, effectiveYear: 2027, effectiveMonth: 1, priceAmount: "300.00", currency: "USD", monthsCovered: 2, createdById: a.admin.id },
    });
    const obligation = await prisma.duesObligation.create({
      data: {
        organizationId: a.org.id, studentId: s.id, academyId: a.academy.id, type: "PACKAGE", origin: "STAFF",
        coverageYear: 2030, coverageMonth: 6, monthsCovered: 2, amount: "300.00", currency: "USD",
        lateFeeAmount: null, dueOn: null, graceDeadline: null, planTermsId: packageTerms.id, policyVersionId: null, createdById: a.admin.id,
      },
    });
    const payment = await prisma.duesPayment.create({
      data: { organizationId: a.org.id, studentId: s.id, academyId: a.academy.id, receivedOn: toDbDate({ year: 2030, month: 6, day: 1 }), tenderCurrency: "USD", tenderAmount: "300.00", method: "EFECTIVO", recordedById: a.admin.id },
    });
    await prisma.duesSettlement.create({ data: { organizationId: a.org.id, studentId: s.id, paymentId: payment.id, obligationId: obligation.id, lateFeeId: null } });

    const result = await reverse({ paymentId: payment.id });
    expect(result).toMatchObject({ ok: false, error: "unsupportedObligationType" });
    expect((await currentPayment(payment.id)).reversedAt).toBeNull();
  });

  it("a settlement already reversed while its payment is not is refused (inconsistentState) — a state nothing today can produce", async () => {
    const s = await newStudent("inconsistent");
    const obligationId = await newObligation(s.id);
    const paid = await pay(s.id, [obligationId], "100.00", { year: 2030, month: 10, day: 1 });
    await prisma.duesSettlement.update({
      where: { id: paid.settlementIds[0] },
      data: { reversedAt: new Date(), reversedById: a.admin.id, reversalReason: "test-only: force an inconsistent state directly" },
    });

    const result = await reverse({ paymentId: paid.paymentId });
    expect(result).toMatchObject({ ok: false, error: "inconsistentState" });
    expect((await currentPayment(paid.paymentId)).reversedAt).toBeNull();
  });
});

describe("reversePayment: concurrency — serializes on the student lock", () => {
  it("reversal waits for a concurrent holder of the student lock, then proceeds", async () => {
    const s = await newStudent("concurrency");
    const obligationId = await newObligation(s.id);
    const paid = await pay(s.id, [obligationId], "100.00", { year: 2030, month: 10, day: 1 });

    const { startedPromise, release, held } = holdStudentLock(s.id);
    await startedPromise;
    let reversalDone = false;
    const reversing = reverse({ paymentId: paid.paymentId }).then((r) => ((reversalDone = true), r));
    const blocked = await waitUntilBlockedOnLock(['FROM "Student"', "FOR UPDATE"]);
    expect(blocked).toBe(true);
    expect(reversalDone).toBe(false);
    release();
    await held;
    expect((await reversing).ok).toBe(true);
  });

  it("reversal vs. a live recordDuesPayment attempt for the same student: serialized, no lost update", async () => {
    // A holds a payment about to be reversed; B is a second, still-unpaid obligation for the same student. A combined payment for
    // [A, B] can only succeed once A is genuinely open again — it fails `alreadySettled`/`notOldestFirst` against a stale view of
    // A. Proving the real `recordDuesPayment` call succeeds here (not just that reversal itself returned ok) is the actual proof
    // that it saw the reversal's committed effect, not a lock that merely serialized without the write being visible after.
    const s = await newStudent("vspayment");
    const obligationA = await newObligation(s.id, 9); // due Sep 20, grace Oct 5
    const obligationB = await newObligation(s.id, 10); // due Oct 20, grace Nov 5
    const paidA = await pay(s.id, [obligationA], "100.00", { year: 2030, month: 9, day: 15 }); // on time

    const { startedPromise, release, held } = holdStudentLock(s.id);
    await startedPromise;
    let reversalDone = false;
    const reversing = reverse({ paymentId: paidA.paymentId }).then((r) => ((reversalDone = true), r));
    const blocked = await waitUntilBlockedOnLock(['FROM "Student"', "FOR UPDATE"]);
    expect(blocked, "reversePayment must genuinely wait on the student row lock").toBe(true);
    expect(reversalDone).toBe(false);
    release();
    await held;
    expect((await reversing).ok).toBe(true);

    // The real recordDuesPayment writer, run only now: it must see A as open, not the stale pre-reversal snapshot.
    const combined = await pay(s.id, [obligationA, obligationB], "200.00", { year: 2030, month: 10, day: 1 });
    expect(combined.settlementIds).toHaveLength(2);
    expect(await prisma.duesSettlement.count({ where: { obligationId: obligationA, reversedAt: null } })).toBe(1);
    expect(await prisma.duesSettlement.count({ where: { obligationId: obligationB, reversedAt: null } })).toBe(1);
  });

  it("reversal vs. a live assessLateFeesForStudent run for the same student: serialized, consistent fee state", async () => {
    // The fee on A survives the reversal untouched (Decision A). Running the real assessLateFeesForStudent runner only after
    // reversal completes must see that existing fee row and correctly report `alreadyAssessed`, never a duplicate — proving the
    // runner's own fresh read reflects the reversal's committed write, not a lock that merely blocked without a visible effect.
    const s = await newStudent("vsassess");
    const obligationId = await newObligation(s.id);
    const paid = await pay(s.id, [obligationId], "120.00", { year: 2030, month: 11, day: 10 }); // after Nov 5 grace: late, assesses a fee
    expect(await prisma.duesLateFee.count({ where: { obligationId } })).toBe(1);

    const { startedPromise, release, held } = holdStudentLock(s.id);
    await startedPromise;
    let reversalDone = false;
    const reversing = reverse({ paymentId: paid.paymentId }).then((r) => ((reversalDone = true), r));
    const blocked = await waitUntilBlockedOnLock(['FROM "Student"', "FOR UPDATE"]);
    expect(blocked, "reversePayment must genuinely wait on the student row lock").toBe(true);
    expect(reversalDone).toBe(false);
    release();
    await held;
    expect((await reversing).ok).toBe(true);

    // The real assessLateFeesForStudent runner, run only now: it must see the fee row reversal left untouched.
    const assessed = await assessLateFeesForStudent(context(), s.id, deps());
    expect(assessed.ok).toBe(true);
    if (!assessed.ok) return;
    expect(assessed.outcomes.find((o) => o.obligationId === obligationId)).toMatchObject({ category: "alreadyAssessed" });
    expect(await prisma.duesLateFee.count({ where: { obligationId } })).toBe(1); // never duplicated
  });

  it("reversal vs. a live correctLateFeeAndSettle attempt for the same student: serialized, no cross-contamination", async () => {
    // A wrongly-assessed fee on obligation X (correctable); an unrelated, already-paid obligation Y on the same student is what
    // gets reversed. Running the real correctLateFeeAndSettle writer only after the reversal completes proves it operates on a
    // fresh, post-reversal view of the student's ledger, and that the two writers' effects never bleed into each other.
    const s = await newStudent("vscorrect");
    // X must stay the OLDER obligation: once Y's reversal reopens it, oldest-first would otherwise block X's correction. Y is
    // settled BEFORE X is even created, so the later assessAsOf run (which assesses every open obligation) never touches Y.
    const obligationY = await newObligation(s.id, 10); // due Oct 20, grace Nov 5, newer and unrelated
    const paidY = await pay(s.id, [obligationY], "100.00", { year: 2030, month: 10, day: 1 }); // on time, unrelated to X's fee
    const obligationX = await newObligation(s.id, 8); // due Aug 20, grace Sep 5 — older than Y
    const outcomes = await assessAsOf(s.id, 9, 6);
    const feeId = feeIdFor(outcomes, obligationX);
    const before = await prisma.duesLateFee.findUniqueOrThrow({ where: { id: feeId } });

    const { startedPromise, release, held } = holdStudentLock(s.id);
    await startedPromise;
    let reversalDone = false;
    const reversing = reverse({ paymentId: paidY.paymentId }).then((r) => ((reversalDone = true), r));
    const blocked = await waitUntilBlockedOnLock(['FROM "Student"', "FOR UPDATE"]);
    expect(blocked, "reversePayment must genuinely wait on the student row lock").toBe(true);
    expect(reversalDone).toBe(false);
    release();
    await held;
    expect((await reversing).ok).toBe(true);

    // The real correctLateFeeAndSettle writer, run only now: X's fee is untouched by Y's reversal, so this must succeed exactly
    // as it would in isolation.
    const corrected = await correctLateFeeAndSettle(
      {
        context: context(), lateFeeId: feeId, expectedRevision: versionRevision({ removedAt: before.removedAt ? before.removedAt.toISOString() : null, removalKind: before.removalKind }),
        removalReason: "student showed a receipt dated the actual payment date", receivedOn: { year: 2030, month: 9, day: 5 }, tender: { currency: "USD", amount: "100.00" }, method: "EFECTIVO", maxBackdateDays: 90,
      },
      deps(),
    );
    expect(corrected.ok).toBe(true);
    if (!corrected.ok) return;
    expect((await prisma.duesLateFee.findUniqueOrThrow({ where: { id: feeId } })).removalKind).toBe("VOIDED");
    // Y stayed genuinely reversed — the correction on X never touched it.
    expect(await prisma.duesSettlement.count({ where: { obligationId: obligationY, reversedAt: null } })).toBe(0);
  });

  it("two concurrent reversals of the same payment: only one wins, the loser refuses cleanly", async () => {
    const s = await newStudent("tworeversals");
    const obligationId = await newObligation(s.id);
    const paid = await pay(s.id, [obligationId], "100.00", { year: 2030, month: 10, day: 1 });

    const [r1, r2] = await Promise.all([reverse({ paymentId: paid.paymentId }), reverse({ paymentId: paid.paymentId })]);
    const results = [r1, r2];
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    const losses = results.filter((r) => !r.ok);
    expect(losses).toHaveLength(1);
    expect((losses[0] as { error: string }).error).toBe("alreadyReversed");
  });
});
