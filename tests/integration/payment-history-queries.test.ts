import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getTestPrismaClient } from "../helpers/test-db";
import { makeAccountingOrg } from "../helpers/accounting-org";
import type { TenantContext } from "../../src/lib/tenant/types";
import { createMonthlyObligation } from "../../src/lib/dues/ledger/create-monthly-obligation";
import { recordDuesPayment } from "../../src/lib/dues/ledger/record-payment";
import { assessLateFeesForStudent } from "../../src/lib/dues/late-fee-assessment";
import { waiveLateFee } from "../../src/lib/dues/ledger/waive-late-fee";
import { reversePayment } from "../../src/lib/dues/ledger/reverse-payment";
import { enterExchangeRateQuote } from "../../src/lib/dues/ledger/exchange-rate";
import { versionRevision } from "../../src/lib/dues/config-input";
import type { LedgerActivation } from "../../src/lib/dues/ledger/activation";
import { listPaymentHistoryForStudent } from "../../src/lib/dues/payment-history-queries";

/**
 * ROSTER-STUDENT-DETAIL-INTEGRATION-BRIEF.md §7: reader tests for `listPaymentHistoryForStudent` against the real
 * test database. Reuses the real `createMonthlyObligation`/`assessLateFeesForStudent`/`recordDuesPayment`/
 * `reversePayment`/`waiveLateFee`/`enterExchangeRateQuote` engine functions to produce genuine fixtures, matching
 * `financial-corrections-queries.test.ts`'s own established conventions.
 */
const prisma = getTestPrismaClient();
type Fixture = Awaited<ReturnType<typeof makeAccountingOrg>>;
const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
const ACTIVE: LedgerActivation = { isActive: async () => true };
const at = (isoLocal: string) => () => new Date(`${isoLocal}-06:00`);
const DEC_2030 = at("2030-12-01T12:00:00");
const deps = (extra: Record<string, unknown> = {}) => ({ activation: ACTIVE, now: DEC_2030, ...extra });

let a: Fixture;
let b: Fixture;
let otherAcademy: { id: string };
const terms: Record<string, { id: string }> = {};
const feePolicy: Record<string, { id: string }> = {};
let crcAcademy: { id: string };
let crcTerms: { id: string };
let crcPolicy: { id: string };

function context(org: Fixture, over: Partial<TenantContext> = {}): TenantContext {
  return { kind: "tenant", actorUserId: org.admin.id, organizationId: org.org.id, organizationRole: "ADMIN", academyIds: "ALL", selfStudentId: null, linkedStudentId: null, ...over };
}

let studentCounter = 0;
async function newStudent(org: Fixture, academyId = org.academy.id) {
  const n = ++studentCounter;
  return prisma.student.create({
    data: {
      organizationId: org.org.id, homeAcademyId: academyId, firstName: "PmtHist", lastName: `S${n}`, phone: "00000000",
      email: `pmthist-${n}-${suffix}@example.com`, currentRankId: await org.rankId("WHITE"), codeHash: `pmthist-${n}-${suffix}`, status: "ACTIVE",
    },
  });
}

async function newObligation(org: Fixture, studentId: string, month = 1) {
  const key = org.org.id;
  const r = await createMonthlyObligation({ context: context(org), studentId, coverage: { year: 2030, month }, planTermsId: terms[key].id, policyVersionId: feePolicy[key].id }, deps());
  if (!r.ok) throw new Error(`fixture obligation failed: ${r.error}`);
  return r.obligationId;
}

async function assessAsOf(org: Fixture, studentId: string, month: number, day: number) {
  const r = await assessLateFeesForStudent(context(org), studentId, deps({ now: at(`2030-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}T12:00:00`) }));
  if (!r.ok) throw new Error(`fixture assessment failed: ${r.reason}`);
  return r.outcomes;
}
function feeIdFor(outcomes: Awaited<ReturnType<typeof assessAsOf>>, obligationId: string): string {
  const outcome = outcomes.find((o) => o.obligationId === obligationId);
  if (!outcome || !("feeId" in outcome) || !outcome.feeId) throw new Error(`fixture: no assessed fee for obligation ${obligationId}`);
  return outcome.feeId;
}
function feeRevision(row: { removedAt: Date | null; removalKind: string | null }): string {
  return versionRevision({ removedAt: row.removedAt ? row.removedAt.toISOString() : null, removalKind: row.removalKind });
}

async function seedPlanAndPolicy(org: Fixture) {
  const plan = await prisma.paymentPlan.create({ data: { organizationId: org.org.id, academyId: org.academy.id, name: `PmtHist plan ${suffix}-${org.org.id}` } });
  terms[org.org.id] = await prisma.paymentPlanTerms.create({
    data: { organizationId: org.org.id, planId: plan.id, effectiveYear: 2030, effectiveMonth: 1, priceAmount: "100.00", currency: "USD", monthsCovered: 1, createdById: org.admin.id },
  });
  feePolicy[org.org.id] = await prisma.duesPolicyVersion.create({
    data: { organizationId: org.org.id, academyId: org.academy.id, effectiveYear: 2030, effectiveMonth: 1, dueDay: 20, graceDay: 5, lateFeeAmount: "20.00", lateFeeCurrency: "USD", createdById: org.admin.id },
  });
}

let quoteDateCounter = 0;
function freshQuoteDate(): { year: number; month: number; day: number } {
  const day = 1 + (quoteDateCounter++ % 27);
  return { year: 2030, month: 6, day };
}

beforeAll(async () => {
  a = await makeAccountingOrg("CUMULATIVE", "pmthist-a");
  b = await makeAccountingOrg("CUMULATIVE", "pmthist-b");
  await seedPlanAndPolicy(a);
  await seedPlanAndPolicy(b);
  otherAcademy = await prisma.academy.create({ data: { organizationId: a.org.id, name: "PmtHist other branch", slug: `pmthist-other-${suffix}`, kioskTokenHash: `pmthist-other-${suffix}` } });

  // A SEPARATE academy for the CRC-currency fixtures: `DuesPolicyVersion` is unique on (academyId, effectiveYear,
  // effectiveMonth), and `latestEffective` resolution is scoped per academy, so a CRC policy sharing `a.academy.id`
  // would compete with `seedPlanAndPolicy`'s own USD policy for "latest effective" — a separate branch sidesteps that
  // entirely, matching `dues-currency-settlement.test.ts`'s own established fixture shape.
  crcAcademy = await prisma.academy.create({ data: { organizationId: a.org.id, name: "PmtHist CRC branch", slug: `pmthist-crc-${suffix}`, kioskTokenHash: `pmthist-crc-${suffix}` } });
  const crcPlan = await prisma.paymentPlan.create({ data: { organizationId: a.org.id, academyId: crcAcademy.id, name: `PmtHist CRC plan ${suffix}` } });
  crcTerms = await prisma.paymentPlanTerms.create({
    data: { organizationId: a.org.id, planId: crcPlan.id, effectiveYear: 2027, effectiveMonth: 1, priceAmount: "50000.00", currency: "CRC", monthsCovered: 1, createdById: a.admin.id },
  });
  crcPolicy = await prisma.duesPolicyVersion.create({
    data: { organizationId: a.org.id, academyId: crcAcademy.id, effectiveYear: 2027, effectiveMonth: 1, dueDay: 20, graceDay: 5, lateFeeAmount: "10000.00", lateFeeCurrency: "CRC", createdById: a.admin.id },
  });
}, 60_000);

async function cleanupLedgerRows(org: Fixture) {
  await prisma.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL session_replication_role = replica");
      // `ExchangeRateQuote` included here (never via a plain `deleteMany`): it carries the same "rows are never
      // deleted" DB-level guard as the other append-only ledger tables, bypassed the same way, in the same transaction.
      for (const table of ["DuesSettlement", "DuesPayment", "DuesLateFee", "DuesCoverage", "DuesObligation", "ExchangeRateQuote"]) {
        await tx.$executeRawUnsafe(`DELETE FROM "${table}" WHERE "organizationId" = $1`, org.org.id);
      }
    },
    { timeout: 60_000 },
  );
  await prisma.auditLog.deleteMany({ where: { organizationId: org.org.id } });
  await prisma.paymentPlanTerms.deleteMany({ where: { organizationId: org.org.id } });
  await prisma.duesPolicyVersion.deleteMany({ where: { organizationId: org.org.id } });
  await prisma.paymentPlan.deleteMany({ where: { organizationId: org.org.id } });
}

afterAll(async () => {
  if (a) await cleanupLedgerRows(a);
  if (b) await cleanupLedgerRows(b);
  await a?.drop();
  await b?.drop();
}, 120_000);

describe("listPaymentHistoryForStudent: three-way inactive-gate discrimination", () => {
  it("returns notActive when the ledger is not active for this organization, distinct from an empty success", async () => {
    const student = await newStudent(a);
    const inactive: LedgerActivation = { isActive: async () => false };
    const result = await listPaymentHistoryForStudent(context(a), student.id, {}, { activation: inactive, now: DEC_2030 });
    expect(result).toEqual({ ok: false, error: "notActive" });
  });

  it("returns a genuinely empty success for an in-scope student with no payments yet", async () => {
    const student = await newStudent(a);
    const result = await listPaymentHistoryForStudent(context(a), student.id, {}, deps());
    expect(result).toEqual({ ok: true, rows: [], nextCursor: null });
  });

  it("returns invalid (a read failure) for a malformed studentId, distinct from both outcomes above", async () => {
    const result = await listPaymentHistoryForStudent(context(a), "", {}, deps());
    expect(result).toEqual({ ok: false, error: "invalid" });
  });
});

describe("listPaymentHistoryForStudent: tenant and branch scoping", () => {
  it("never returns a different organization's payments, and treats it as empty success (no existence leak)", async () => {
    const student = await newStudent(b);
    const obligationId = await newObligation(b, student.id, 1);
    const recorded = await recordDuesPayment(
      { context: context(b), studentId: student.id, receivedOn: { year: 2030, month: 1, day: 20 }, tender: { currency: "USD", amount: "100.00" }, method: "EFECTIVO", obligationIds: [obligationId], maxBackdateDays: 30 },
      deps({ now: at("2030-01-21T12:00:00") }),
    );
    if (!recorded.ok) throw new Error("fixture payment failed");

    const result = await listPaymentHistoryForStudent(context(a), student.id, {}, deps());
    expect(result).toEqual({ ok: true, rows: [], nextCursor: null });
  });

  it("a DIRECTOR scoped to one branch gets an empty success for a student homed at a different branch", async () => {
    const student = await newStudent(a, otherAcademy.id);
    const director = context(a, { organizationRole: "DIRECTOR", academyIds: [a.academy.id] });
    const result = await listPaymentHistoryForStudent(director, student.id, {}, deps());
    expect(result).toEqual({ ok: true, rows: [], nextCursor: null });
  });
});

describe("listPaymentHistoryForStudent: reversed payment retains full original settlement detail", () => {
  it("includes a reversed payment with reversedAt populated and its exact original principal + fee breakdown intact", async () => {
    const student = await newStudent(a);
    const obligationId = await newObligation(a, student.id, 1);
    const outcomes = await assessAsOf(a, student.id, 2, 10);
    const feeId = feeIdFor(outcomes, obligationId);

    const recorded = await recordDuesPayment(
      { context: context(a), studentId: student.id, receivedOn: { year: 2030, month: 2, day: 15 }, tender: { currency: "USD", amount: "120.00" }, method: "EFECTIVO", obligationIds: [obligationId], maxBackdateDays: 30 },
      deps({ now: at("2030-02-15T12:00:00") }),
    );
    if (!recorded.ok) throw new Error("fixture payment failed");

    const reversed = await reversePayment({ context: context(a), paymentId: recorded.paymentId, reversalReason: "test reversal" }, deps());
    expect(reversed.ok).toBe(true);

    const result = await listPaymentHistoryForStudent(context(a), student.id, {}, deps());
    if (!result.ok) throw new Error("expected ok result");
    const row = result.rows.find((r) => r.id === recorded.paymentId);
    expect(row).toBeDefined();
    expect(row!.reversedAt).not.toBeNull();
    expect(row!.settlements).toHaveLength(1);
    const settlement = row!.settlements[0];
    expect(settlement.obligationId).toBe(obligationId);
    expect(settlement.principalAmount).toBe("100.00");
    expect(settlement.lateFee).not.toBeNull();
    expect(settlement.lateFee!.id).toBe(feeId);
    expect(settlement.lateFee!.amount).toBe("20.00");
    expect(settlement.totalAmount).toBe("120.00");
  });
});

describe("listPaymentHistoryForStudent: the reversal-before-waiver-before-resettlement sequence", () => {
  it("keeps both payments' distinct original breakdowns, and reports the fee's CURRENT removalKind on the historical settlement that once included it", async () => {
    const student = await newStudent(a);
    const obligationId = await newObligation(a, student.id, 3);
    const outcomes = await assessAsOf(a, student.id, 4, 10);
    const feeId = feeIdFor(outcomes, obligationId);

    // Step 1: payment settles the obligation INCLUDING the fee.
    const firstPayment = await recordDuesPayment(
      { context: context(a), studentId: student.id, receivedOn: { year: 2030, month: 4, day: 15 }, tender: { currency: "USD", amount: "120.00" }, method: "EFECTIVO", obligationIds: [obligationId], maxBackdateDays: 30 },
      deps({ now: at("2030-04-15T12:00:00") }),
    );
    if (!firstPayment.ok) throw new Error("fixture first payment failed");

    // Step 2: that payment is reversed.
    const reversed = await reversePayment({ context: context(a), paymentId: firstPayment.paymentId, reversalReason: "test reversal" }, deps());
    expect(reversed.ok).toBe(true);

    // Step 3: only now (no active settlement references it) is the fee waived.
    const fee = await prisma.duesLateFee.findUniqueOrThrow({ where: { id: feeId } });
    const waived = await waiveLateFee({ context: context(a), lateFeeId: feeId, expectedRevision: feeRevision(fee), removalReason: "owner forgave it" }, deps());
    expect(waived.ok).toBe(true);

    // Step 4: the obligation is re-settled by a second payment, with no fee (it is waived, so no longer assessed).
    const secondPayment = await recordDuesPayment(
      { context: context(a), studentId: student.id, receivedOn: { year: 2030, month: 4, day: 16 }, tender: { currency: "USD", amount: "100.00" }, method: "EFECTIVO", obligationIds: [obligationId], maxBackdateDays: 30 },
      deps({ now: at("2030-04-16T12:00:00") }),
    );
    if (!secondPayment.ok) throw new Error("fixture second payment failed");

    const result = await listPaymentHistoryForStudent(context(a), student.id, {}, deps());
    if (!result.ok) throw new Error("expected ok result");

    const row1 = result.rows.find((r) => r.id === firstPayment.paymentId);
    const row2 = result.rows.find((r) => r.id === secondPayment.paymentId);
    expect(row1).toBeDefined();
    expect(row2).toBeDefined();

    // Payment 1 (reversed): its settlement still shows the fee it historically included, now reporting the fee's
    // CURRENT removalKind (WAIVED) — two separate facts, never conflated.
    expect(row1!.reversedAt).not.toBeNull();
    expect(row1!.settlements[0].lateFee).not.toBeNull();
    expect(row1!.settlements[0].lateFee!.id).toBe(feeId);
    expect(row1!.settlements[0].lateFee!.removalKind).toBe("WAIVED");
    expect(row1!.settlements[0].totalAmount).toBe("120.00");

    // Payment 2 (the resettlement): no fee, distinct breakdown from payment 1.
    expect(row2!.reversedAt).toBeNull();
    expect(row2!.settlements[0].lateFee).toBeNull();
    expect(row2!.settlements[0].totalAmount).toBe("100.00");
  });
});

describe("listPaymentHistoryForStudent: cursor pagination", () => {
  it("reaches an older payment beyond the first page, with no duplicates or omissions", async () => {
    const student = await newStudent(a);
    const paymentIds: string[] = [];
    for (let m = 5; m <= 9; m++) {
      const obligationId = await newObligation(a, student.id, m);
      const recorded = await recordDuesPayment(
        { context: context(a), studentId: student.id, receivedOn: { year: 2030, month: m, day: 20 }, tender: { currency: "USD", amount: "100.00" }, method: "EFECTIVO", obligationIds: [obligationId], maxBackdateDays: 30 },
        deps({ now: at(`2030-${String(m).padStart(2, "0")}-21T12:00:00`) }),
      );
      if (!recorded.ok) throw new Error("fixture payment failed");
      paymentIds.push(recorded.paymentId);
    }

    const page1 = await listPaymentHistoryForStudent(context(a), student.id, { limit: 2 }, deps());
    if (!page1.ok) throw new Error("expected ok result");
    expect(page1.rows).toHaveLength(2);
    expect(page1.nextCursor).not.toBeNull();

    const page2 = await listPaymentHistoryForStudent(context(a), student.id, { limit: 2, cursor: page1.nextCursor! }, deps());
    if (!page2.ok) throw new Error("expected ok result");
    expect(page2.rows).toHaveLength(2);
    const page1Ids = page1.rows.map((r) => r.id);
    const page2Ids = page2.rows.map((r) => r.id);
    expect(page1Ids.some((id) => page2Ids.includes(id))).toBe(false);

    const page3 = await listPaymentHistoryForStudent(context(a), student.id, { limit: 2, cursor: page2.nextCursor! }, deps());
    if (!page3.ok) throw new Error("expected ok result");
    const allSeen = [...page1Ids, ...page2Ids, ...page3.rows.map((r) => r.id)];
    expect(new Set(allSeen).size).toBe(5);
    for (const id of paymentIds) expect(allSeen).toContain(id);
  });

  it("ignores a cursor that does not belong to this student, never using it to peek into another student's page", async () => {
    const studentA = await newStudent(a);
    const studentC = await newStudent(a);
    const obligationA = await newObligation(a, studentA.id, 1);
    const paymentA = await recordDuesPayment(
      { context: context(a), studentId: studentA.id, receivedOn: { year: 2030, month: 1, day: 20 }, tender: { currency: "USD", amount: "100.00" }, method: "EFECTIVO", obligationIds: [obligationA], maxBackdateDays: 30 },
      deps({ now: at("2030-01-21T12:00:00") }),
    );
    if (!paymentA.ok) throw new Error("fixture payment failed");

    const obligationC = await newObligation(a, studentC.id, 1);
    const paymentC = await recordDuesPayment(
      { context: context(a), studentId: studentC.id, receivedOn: { year: 2030, month: 1, day: 20 }, tender: { currency: "USD", amount: "100.00" }, method: "EFECTIVO", obligationIds: [obligationC], maxBackdateDays: 30 },
      deps({ now: at("2030-01-21T12:00:00") }),
    );
    if (!paymentC.ok) throw new Error("fixture payment failed");

    const result = await listPaymentHistoryForStudent(context(a), studentA.id, { cursor: paymentC.paymentId }, deps());
    if (!result.ok) throw new Error("expected ok result");
    expect(result.rows.map((r) => r.id)).toContain(paymentA.paymentId);
    expect(result.rows.map((r) => r.id)).not.toContain(paymentC.paymentId);
  });
});

describe("listPaymentHistoryForStudent: stored cross-currency evidence survives a later quote correction", () => {
  it("leaves an earlier payment's snapshotted rate evidence unchanged after the quote is later corrected to a new revision", async () => {
    const student = await newStudent(a);
    const obligationId = await newObligation(a, student.id, 6);

    const quoteDate = freshQuoteDate();
    const firstQuote = await enterExchangeRateQuote({ context: context(a), quoteDate, value: "500.00", expectedCurrentRevision: 0 }, deps());
    if (!firstQuote.ok) throw new Error("fixture quote entry failed");
    const firstQuoteRow = await prisma.exchangeRateQuote.findUniqueOrThrow({ where: { id: firstQuote.quoteId } });

    const payment = await recordDuesPayment(
      { context: context(a), studentId: student.id, receivedOn: { year: 2030, month: 6, day: 10 }, tender: { currency: "CRC", amount: "50000.00" }, method: "EFECTIVO", obligationIds: [obligationId], maxBackdateDays: 30 },
      deps({ now: at("2030-06-10T12:00:00") }),
    );
    if (!payment.ok) throw new Error("fixture payment failed");

    // A later correction bumps the revision — must never retroactively change what the already-recorded payment reports.
    const corrected = await enterExchangeRateQuote({ context: context(a), quoteDate, value: "510.00", expectedCurrentRevision: 1 }, deps());
    expect(corrected.ok).toBe(true);

    const result = await listPaymentHistoryForStudent(context(a), student.id, {}, deps());
    if (!result.ok) throw new Error("expected ok result");
    const row = result.rows.find((r) => r.id === payment.paymentId);
    expect(row).toBeDefined();
    expect(row!.conversion).not.toBeNull();
    expect(row!.conversion!.appliedRateId).toBe(firstQuoteRow.id);
    expect(row!.conversion!.appliedRateRevision).toBe(1);
    expect(Number(row!.conversion!.appliedRateValue)).toBe(500);
  });
});

describe("listPaymentHistoryForStudent: currency is never summed across rows", () => {
  it("keeps a USD payment's and a CRC payment's settlement currency fully separate", async () => {
    // Two DIFFERENT students, since a MONTHLY plan/policy applies to exactly one branch (`writeMonthlyObligationInTx`'s
    // own `plan.academyId !== student.homeAcademyId` refusal) — the USD and CRC fixtures live on different branches.
    const usdStudent = await newStudent(a);
    const usdObligation = await newObligation(a, usdStudent.id, 7);
    const crcStudent = await newStudent(a, crcAcademy.id);
    const crcObligation = await createMonthlyObligation(
      { context: context(a), studentId: crcStudent.id, coverage: { year: 2030, month: 7 }, planTermsId: crcTerms.id, policyVersionId: crcPolicy.id },
      deps(),
    ).then((r) => {
      if (!r.ok) throw new Error(`fixture obligation failed: ${r.error}`);
      return r.obligationId;
    });

    const usdPayment = await recordDuesPayment(
      { context: context(a), studentId: usdStudent.id, receivedOn: { year: 2030, month: 7, day: 10 }, tender: { currency: "USD", amount: "100.00" }, method: "EFECTIVO", obligationIds: [usdObligation], maxBackdateDays: 30 },
      deps({ now: at("2030-07-10T12:00:00") }),
    );
    if (!usdPayment.ok) throw new Error("fixture USD payment failed");
    const crcPayment = await recordDuesPayment(
      { context: context(a), studentId: crcStudent.id, receivedOn: { year: 2030, month: 7, day: 11 }, tender: { currency: "CRC", amount: "50000.00" }, method: "EFECTIVO", obligationIds: [crcObligation], maxBackdateDays: 30 },
      deps({ now: at("2030-07-11T12:00:00") }),
    );
    if (!crcPayment.ok) throw new Error("fixture CRC payment failed");

    const usdResult = await listPaymentHistoryForStudent(context(a), usdStudent.id, {}, deps());
    const crcResult = await listPaymentHistoryForStudent(context(a), crcStudent.id, {}, deps());
    if (!usdResult.ok || !crcResult.ok) throw new Error("expected ok results");
    const usdRow = usdResult.rows.find((r) => r.id === usdPayment.paymentId);
    const crcRow = crcResult.rows.find((r) => r.id === crcPayment.paymentId);
    expect(usdRow!.settlements[0].currency).toBe("USD");
    expect(usdRow!.tenderCurrency).toBe("USD");
    expect(crcRow!.settlements[0].currency).toBe("CRC");
    expect(crcRow!.tenderCurrency).toBe("CRC");
  });
});
