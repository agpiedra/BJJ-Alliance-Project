import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getTestPrismaClient } from "../helpers/test-db";
import { prisma as appPrisma } from "../../src/lib/prisma";
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
import { listPaymentHistoryForStudent, listOwnPaymentHistory } from "../../src/lib/dues/payment-history-queries";
import type { PortalSelfContext } from "../../src/lib/dues/ledger/dues-facts";

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
let otherTerms: { id: string };
let otherPolicy: { id: string };
const terms: Record<string, { id: string }> = {};
const feePolicy: Record<string, { id: string }> = {};

function context(org: Fixture, over: Partial<TenantContext> = {}): TenantContext {
  return { kind: "tenant", actorUserId: org.admin.id, organizationId: org.org.id, organizationRole: "ADMIN", academyIds: "ALL", selfStudentId: null, linkedStudentId: null, ...over };
}

function selfContext(org: Fixture, linkedStudentId: string, over: Partial<TenantContext> = {}): PortalSelfContext {
  // academyIds: [] is the real value resolveAcademyIds (resolve-context.ts) produces for a non-ADMIN role — an
  // ordinary pure STUDENT has no staff assignments. The self path never consults it (that's the whole point of
  // §3.3's no-branch-check design), so an ordinary success fixture asserting real own data below is exactly the
  // proof that an empty array doesn't matter here. `over` can still replace it (e.g. the coach-outside-branch
  // test passes a real, non-empty staff academyIds on purpose).
  return { ...context(org, { organizationRole: "STUDENT", academyIds: [], ...over }), linkedStudentId } as PortalSelfContext;
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

  // `otherAcademy`'s own plan/policy: `createMonthlyObligation` refuses `inapplicable` when the plan's own
  // academyId doesn't match the student's home academy, so a student homed here needs fixtures scoped to THIS
  // academy, not org `a`'s own default (`a.academy.id`-scoped) plan.
  const otherPlan = await prisma.paymentPlan.create({ data: { organizationId: a.org.id, academyId: otherAcademy.id, name: `PmtHist other plan ${suffix}` } });
  otherTerms = await prisma.paymentPlanTerms.create({
    data: { organizationId: a.org.id, planId: otherPlan.id, effectiveYear: 2030, effectiveMonth: 1, priceAmount: "100.00", currency: "USD", monthsCovered: 1, createdById: a.admin.id },
  });
  otherPolicy = await prisma.duesPolicyVersion.create({
    data: { organizationId: a.org.id, academyId: otherAcademy.id, effectiveYear: 2030, effectiveMonth: 1, dueDay: 20, graceDay: 5, lateFeeAmount: "20.00", lateFeeCurrency: "USD", createdById: a.admin.id },
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

  it("returns invalid for a malformed (empty) studentId — input validation, never reaching the database", async () => {
    const result = await listPaymentHistoryForStudent(context(a), "", {}, deps());
    expect(result).toEqual({ ok: false, error: "invalid" });
  });

  it("propagates a genuine database rejection for an otherwise valid, active, authorized request, rather than folding it into any typed outcome", async () => {
    const student = await newStudent(a);
    const dbError = new Error("connection lost");
    const spy = vi.spyOn(appPrisma.duesPayment, "findMany").mockRejectedValueOnce(dbError);
    try {
      await expect(listPaymentHistoryForStudent(context(a), student.id, {}, deps())).rejects.toBe(dbError);
    } finally {
      spy.mockRestore();
    }
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

  it("a DIRECTOR scoped to one branch cannot see a real payment belonging to a student homed at a different branch", async () => {
    const student = await newStudent(a, otherAcademy.id);
    const obligationResult = await createMonthlyObligation(
      { context: context(a), studentId: student.id, coverage: { year: 2030, month: 10 }, planTermsId: otherTerms.id, policyVersionId: otherPolicy.id },
      deps(),
    );
    if (!obligationResult.ok) throw new Error(`fixture obligation failed: ${obligationResult.error}`);
    const obligationId = obligationResult.obligationId;
    const recorded = await recordDuesPayment(
      { context: context(a), studentId: student.id, receivedOn: { year: 2030, month: 10, day: 20 }, tender: { currency: "USD", amount: "100.00" }, method: "EFECTIVO", obligationIds: [obligationId], maxBackdateDays: 30 },
      deps({ now: at("2030-10-21T12:00:00") }),
    );
    if (!recorded.ok) throw new Error("fixture payment failed");

    // First, an authorized (org-wide) context proves this payment genuinely exists and is readable at all.
    const authorized = await listPaymentHistoryForStudent(context(a), student.id, {}, deps());
    if (!authorized.ok) throw new Error("expected ok result");
    expect(authorized.rows.map((r) => r.id)).toContain(recorded.paymentId);

    // Then the branch-restricted DIRECTOR, excluding this student's own branch, must get nothing — a MEANINGFUL
    // empty success now, since real data exists and is being correctly withheld, not trivially absent.
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

describe("listPaymentHistoryForStudent: one student's own mixed-currency history is never summed", () => {
  it("shows a same-currency USD payment and a cross-currency CRC-tendered payment side by side, each with its own distinct currency and conversion evidence", async () => {
    const student = await newStudent(a);
    const usdObligation = await newObligation(a, student.id, 7);
    const crcObligation = await newObligation(a, student.id, 8);

    const quoteDate = freshQuoteDate();
    const quote = await enterExchangeRateQuote({ context: context(a), quoteDate, value: "500.00", expectedCurrentRevision: 0 }, deps());
    if (!quote.ok) throw new Error("fixture quote entry failed");

    // Payment 1: ordinary same-currency USD tender against the USD obligation — no conversion involved.
    const usdPayment = await recordDuesPayment(
      { context: context(a), studentId: student.id, receivedOn: { year: 2030, month: 7, day: 10 }, tender: { currency: "USD", amount: "100.00" }, method: "EFECTIVO", obligationIds: [usdObligation], maxBackdateDays: 30 },
      deps({ now: at("2030-07-10T12:00:00") }),
    );
    if (!usdPayment.ok) throw new Error("fixture USD payment failed");

    // Payment 2: a CRC tender against a USD obligation — the existing cross-currency conversion path, same student.
    const crcPayment = await recordDuesPayment(
      { context: context(a), studentId: student.id, receivedOn: { year: 2030, month: 8, day: 10 }, tender: { currency: "CRC", amount: "50000.00" }, method: "EFECTIVO", obligationIds: [crcObligation], maxBackdateDays: 30 },
      deps({ now: at("2030-08-10T12:00:00") }),
    );
    if (!crcPayment.ok) throw new Error("fixture CRC payment failed");

    // Both inspected through ONE reader call for this one student.
    const result = await listPaymentHistoryForStudent(context(a), student.id, {}, deps());
    if (!result.ok) throw new Error("expected ok result");
    const usdRow = result.rows.find((r) => r.id === usdPayment.paymentId);
    const crcRow = result.rows.find((r) => r.id === crcPayment.paymentId);
    expect(usdRow).toBeDefined();
    expect(crcRow).toBeDefined();

    // Same-currency payment: tender and settlement both report USD, and there is no conversion evidence.
    expect(usdRow!.tenderCurrency).toBe("USD");
    expect(usdRow!.tenderAmount).toBe("100.00");
    expect(usdRow!.conversion).toBeNull();
    expect(usdRow!.settlements[0].currency).toBe("USD");
    expect(usdRow!.settlements[0].principalAmount).toBe("100.00");
    expect(usdRow!.settlements[0].totalAmount).toBe("100.00");

    // Cross-currency payment: tenderCurrency/tenderAmount report the actual CRC tender; the settlement stays in
    // the OBLIGATION's own currency (USD, unconverted); conversion carries the stored snapshot evidence.
    expect(crcRow!.tenderCurrency).toBe("CRC");
    expect(crcRow!.tenderAmount).toBe("50000.00");
    expect(crcRow!.settlements[0].currency).toBe("USD");
    expect(crcRow!.settlements[0].principalAmount).toBe("100.00");
    expect(crcRow!.settlements[0].totalAmount).toBe("100.00");
    expect(crcRow!.conversion).not.toBeNull();
    expect(crcRow!.conversion!.appliedRateId).toBe(quote.quoteId);
    expect(Number(crcRow!.conversion!.appliedRateValue)).toBe(500);
    expect(crcRow!.conversion!.appliedRateRevision).toBe(1);

    // Never summed: each row's own currency and amounts are asserted independently above, with no combined total.
  });
});

describe("listOwnPaymentHistory: inactive gate and runtime identity guard (brief §3.3/§4.7)", () => {
  it("returns notActive when the ledger is not active, before any identity check", async () => {
    const student = await newStudent(a);
    const inactive: LedgerActivation = { isActive: async () => false };
    const result = await listOwnPaymentHistory(selfContext(a, student.id), {}, { activation: inactive, now: DEC_2030 });
    expect(result).toEqual({ ok: false, error: "notActive" });
  });

  it("refuses a null linkedStudentId before any database access (DB-spy proof)", async () => {
    const ctx = selfContext(a, null as unknown as string);
    const spy = vi.spyOn(appPrisma.duesPayment, "findMany");
    try {
      const result = await listOwnPaymentHistory(ctx, {}, deps());
      expect(result).toEqual({ ok: false, error: "invalid" });
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("refuses an undefined linkedStudentId before any database access (DB-spy proof)", async () => {
    const ctx = selfContext(a, undefined as unknown as string);
    const spy = vi.spyOn(appPrisma.duesPayment, "findMany");
    try {
      const result = await listOwnPaymentHistory(ctx, {}, deps());
      expect(result).toEqual({ ok: false, error: "invalid" });
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("refuses an empty-string linkedStudentId before any database access (DB-spy proof)", async () => {
    const ctx = selfContext(a, "");
    const spy = vi.spyOn(appPrisma.duesPayment, "findMany");
    try {
      const result = await listOwnPaymentHistory(ctx, {}, deps());
      expect(result).toEqual({ ok: false, error: "invalid" });
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("refuses a whitespace-only linkedStudentId before any database access (DB-spy proof)", async () => {
    const ctx = selfContext(a, "   ");
    const spy = vi.spyOn(appPrisma.duesPayment, "findMany");
    try {
      const result = await listOwnPaymentHistory(ctx, {}, deps());
      expect(result).toEqual({ ok: false, error: "invalid" });
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});

describe("listOwnPaymentHistory: no branch check — the coach-trains-elsewhere case (brief §2.5/§3.3/§4.4)", () => {
  it("a staff member scoped to one branch still sees their OWN real payment history for a linked student homed at a DIFFERENT branch", async () => {
    const student = await newStudent(a, otherAcademy.id);
    const obligationResult = await createMonthlyObligation(
      { context: context(a), studentId: student.id, coverage: { year: 2030, month: 11 }, planTermsId: otherTerms.id, policyVersionId: otherPolicy.id },
      deps(),
    );
    if (!obligationResult.ok) throw new Error(`fixture obligation failed: ${obligationResult.error}`);
    const recorded = await recordDuesPayment(
      { context: context(a), studentId: student.id, receivedOn: { year: 2030, month: 11, day: 20 }, tender: { currency: "USD", amount: "100.00" }, method: "EFECTIVO", obligationIds: [obligationResult.obligationId], maxBackdateDays: 30 },
      deps({ now: at("2030-11-21T12:00:00") }),
    );
    if (!recorded.ok) throw new Error("fixture payment failed");

    // The STAFF path, scoped to a DIFFERENT branch than the student's home academy, is correctly denied —
    // establishing the branch check is real and would have blocked this student if reused for the self path.
    const staffDenied = await listPaymentHistoryForStudent(context(a, { organizationRole: "DIRECTOR", academyIds: [a.academy.id] }), student.id, {}, deps());
    expect(staffDenied).toEqual({ ok: true, rows: [], nextCursor: null });

    // The SELF path, run by that same staff member for their OWN linked record (which happens to be this
    // other-branch student), must succeed — no branch check runs on this path at all.
    const selfResult = await listOwnPaymentHistory(selfContext(a, student.id, { organizationRole: "DIRECTOR", academyIds: [a.academy.id] }), {}, deps());
    if (!selfResult.ok) throw new Error("expected ok result");
    expect(selfResult.rows.map((r) => r.id)).toContain(recorded.paymentId);
  });
});

describe("listOwnPaymentHistory: identity isolation, never the staff branch-membership check (brief §4.1/§4.2)", () => {
  it("never returns a different student's payments, even one in the same branch", async () => {
    const me = await newStudent(a);
    const other = await newStudent(a);
    const otherObligation = await newObligation(a, other.id, 1);
    const otherPayment = await recordDuesPayment(
      { context: context(a), studentId: other.id, receivedOn: { year: 2030, month: 1, day: 20 }, tender: { currency: "USD", amount: "100.00" }, method: "EFECTIVO", obligationIds: [otherObligation], maxBackdateDays: 30 },
      deps({ now: at("2030-01-21T12:00:00") }),
    );
    if (!otherPayment.ok) throw new Error("fixture payment failed");

    const result = await listOwnPaymentHistory(selfContext(a, me.id), {}, deps());
    expect(result).toEqual({ ok: true, rows: [], nextCursor: null });
  });

  it("never returns another organization's payments for a coincidentally-reused student id, treated as empty success", async () => {
    const studentInA = await newStudent(a);
    const obligationId = await newObligation(a, studentInA.id, 1);
    const recorded = await recordDuesPayment(
      { context: context(a), studentId: studentInA.id, receivedOn: { year: 2030, month: 1, day: 20 }, tender: { currency: "USD", amount: "100.00" }, method: "EFECTIVO", obligationIds: [obligationId], maxBackdateDays: 30 },
      deps({ now: at("2030-01-21T12:00:00") }),
    );
    if (!recorded.ok) throw new Error("fixture payment failed");

    // org `b`'s own context, claiming (falsely, as if forged) org a's real student id as its own linkedStudentId —
    // the organizationId filter in the underlying query must still exclude it.
    const crossOrgCtx = selfContext(b, studentInA.id);
    const result = await listOwnPaymentHistory(crossOrgCtx, {}, deps());
    expect(result).toEqual({ ok: true, rows: [], nextCursor: null });
  });
});

describe("listOwnPaymentHistory: every call validates its OWN supplied context independently, never trusting an earlier call's identity (brief §4.5's reader-level scope)", () => {
  it("a second (paginated) call given a context whose linkedStudentId is null is refused on its own terms — this proves the READER re-validates identity on every call, not that any authorization re-resolution pipeline ran", async () => {
    const student = await newStudent(a);
    for (const m of [2, 3]) {
      const obligationId = await newObligation(a, student.id, m);
      const recorded = await recordDuesPayment(
        { context: context(a), studentId: student.id, receivedOn: { year: 2030, month: m, day: 20 }, tender: { currency: "USD", amount: "100.00" }, method: "EFECTIVO", obligationIds: [obligationId], maxBackdateDays: 30 },
        deps({ now: at(`2030-${String(m).padStart(2, "0")}-21T12:00:00`) }),
      );
      if (!recorded.ok) throw new Error("fixture payment failed");
    }

    const page1 = await listOwnPaymentHistory(selfContext(a, student.id), { limit: 1 }, deps());
    if (!page1.ok) throw new Error("expected ok result");
    expect(page1.rows).toHaveLength(1);
    expect(page1.nextCursor).not.toBeNull();

    // This does NOT exercise membership deactivation, context re-resolution, or any server-action-layer
    // revocation path — none of that exists at this library layer. It directly constructs a SECOND,
    // independent context with a manually-set null linkedStudentId and calls the reader with it, proving only
    // that `listOwnPaymentHistory` runs its own runtime guard on whatever context it is GIVEN on every call,
    // rather than silently carrying forward page 1's already-proven identity into page 2's cursor branch. A real
    // membership/link-revocation-between-requests integration test (deactivate the DB row, then re-resolve a
    // fresh TenantContext via resolveContext and observe the server action refuse) belongs to, and is deferred
    // to, the upcoming portal-action PR, which is the first layer where context resolution actually happens.
    const differentCtxWithNullIdentity = selfContext(a, null as unknown as string);
    const page2 = await listOwnPaymentHistory(differentCtxWithNullIdentity, { limit: 1, cursor: page1.nextCursor! }, deps());
    expect(page2).toEqual({ ok: false, error: "invalid" });
  });

  it("a cursor obtained under one student's context is never honored under a DIFFERENT student's context", async () => {
    const studentX = await newStudent(a);
    const studentY = await newStudent(a);
    const obligationX = await newObligation(a, studentX.id, 1);
    const paymentX = await recordDuesPayment(
      { context: context(a), studentId: studentX.id, receivedOn: { year: 2030, month: 1, day: 20 }, tender: { currency: "USD", amount: "100.00" }, method: "EFECTIVO", obligationIds: [obligationX], maxBackdateDays: 30 },
      deps({ now: at("2030-01-21T12:00:00") }),
    );
    if (!paymentX.ok) throw new Error("fixture payment failed");

    const obligationY = await newObligation(a, studentY.id, 1);
    const paymentY = await recordDuesPayment(
      { context: context(a), studentId: studentY.id, receivedOn: { year: 2030, month: 1, day: 20 }, tender: { currency: "USD", amount: "100.00" }, method: "EFECTIVO", obligationIds: [obligationY], maxBackdateDays: 30 },
      deps({ now: at("2030-01-21T12:00:00") }),
    );
    if (!paymentY.ok) throw new Error("fixture payment failed");

    // Reusing X's own payment id as a "cursor" under Y's context must be ignored (falls back to page 1 for Y),
    // never used to peek into X's page.
    const result = await listOwnPaymentHistory(selfContext(a, studentY.id), { cursor: paymentX.paymentId }, deps());
    if (!result.ok) throw new Error("expected ok result");
    expect(result.rows.map((r) => r.id)).toContain(paymentY.paymentId);
    expect(result.rows.map((r) => r.id)).not.toContain(paymentX.paymentId);
  });
});

describe("listOwnPaymentHistory: library pagination tests — notes omitted from the ACTUAL returned object on both of the function's own call shapes (brief §5.1). Real portal-page/\"load more\"-action integration is deferred to the UI PR.", () => {
  it("omits notes from the real object on a first call (no cursor), even though the underlying row has one", async () => {
    const student = await newStudent(a);
    const obligationId = await newObligation(a, student.id, 1);
    const recorded = await recordDuesPayment(
      { context: context(a), studentId: student.id, receivedOn: { year: 2030, month: 1, day: 20 }, tender: { currency: "USD", amount: "100.00" }, method: "EFECTIVO", obligationIds: [obligationId], maxBackdateDays: 30, notes: "a private staff note" },
      deps({ now: at("2030-01-21T12:00:00") }),
    );
    if (!recorded.ok) throw new Error("fixture payment failed");

    // First, the STAFF reader confirms the note genuinely exists on the underlying row (the test is non-vacuous).
    const staffResult = await listPaymentHistoryForStudent(context(a), student.id, {}, deps());
    if (!staffResult.ok) throw new Error("expected ok result");
    const staffRow = staffResult.rows.find((r) => r.id === recorded.paymentId);
    expect(staffRow?.notes).toBe("a private staff note");

    const selfResult = await listOwnPaymentHistory(selfContext(a, student.id), {}, deps());
    if (!selfResult.ok) throw new Error("expected ok result");
    const row = selfResult.rows.find((r) => r.id === recorded.paymentId);
    expect(row).toBeDefined();
    expect(row).not.toHaveProperty("notes");
    // Stronger than a type check: proves the property is absent from the real serialized object, not merely
    // typed away — a privacy leak via `as any`/spread would still show up here.
    expect(JSON.stringify(row)).not.toContain("a private staff note");
  });

  it("omits notes from the ACTUAL returned object on a genuinely nonempty SECOND (paginated) call too, not just the first — non-vacuous: two payments, two distinct private notes, a real second page", async () => {
    const student = await newStudent(a);
    const olderObligation = await newObligation(a, student.id, 4);
    const olderPayment = await recordDuesPayment(
      { context: context(a), studentId: student.id, receivedOn: { year: 2030, month: 4, day: 20 }, tender: { currency: "USD", amount: "100.00" }, method: "EFECTIVO", obligationIds: [olderObligation], maxBackdateDays: 30, notes: "older private note" },
      deps({ now: at("2030-04-21T12:00:00") }),
    );
    if (!olderPayment.ok) throw new Error("fixture payment failed");
    const newerObligation = await newObligation(a, student.id, 5);
    const newerPayment = await recordDuesPayment(
      { context: context(a), studentId: student.id, receivedOn: { year: 2030, month: 5, day: 20 }, tender: { currency: "USD", amount: "100.00" }, method: "EFECTIVO", obligationIds: [newerObligation], maxBackdateDays: 30, notes: "newer private note" },
      deps({ now: at("2030-05-21T12:00:00") }),
    );
    if (!newerPayment.ok) throw new Error("fixture payment failed");

    // orderBy is [receivedOn desc, id desc] — the newer (month 5) payment fills page 1; the OLDER (month 4) one is
    // genuinely what page 2 returns, not a request past the end of the data.
    const page1 = await listOwnPaymentHistory(selfContext(a, student.id), { limit: 1 }, deps());
    if (!page1.ok) throw new Error("expected ok result");
    expect(page1.rows).toHaveLength(1);
    expect(page1.rows[0]!.id).toBe(newerPayment.paymentId);
    expect(page1.nextCursor).not.toBeNull(); // proves more genuinely exists before requesting page 2

    const page2 = await listOwnPaymentHistory(selfContext(a, student.id), { limit: 1, cursor: page1.nextCursor! }, deps());
    if (!page2.ok) throw new Error("expected ok result");
    expect(page2.rows).toHaveLength(1); // a real, nonempty second page — not vacuous
    expect(page2.rows[0]!.id).toBe(olderPayment.paymentId); // the EXPECTED payment identity, not just "something"
    expect(page2.rows[0]).not.toHaveProperty("notes");
    expect(JSON.stringify(page2.rows[0])).not.toContain("older private note");
  });

  it("the student-facing row has exactly the allowlisted top-level and nested keys, with a GENUINE fee-bearing settlement — lateFee asserted non-null, never behind a conditional", async () => {
    const student = await newStudent(a);
    const obligationId = await newObligation(a, student.id, 5);
    // Fee assessed, deliberately left UN-waived — the payment below settles the obligation while the fee is
    // still active, so the settlement's own lateFeeId is genuinely set. Waiving it first (as the previous version
    // of this test did) leaves no active fee to settle, so settlement.lateFee comes back null and the conditional
    // assertion below it never runs — a vacuous test. This version has no conditional at all.
    const outcomes = await assessAsOf(a, student.id, 6, 10);
    const feeId = feeIdFor(outcomes, obligationId);
    const recorded = await recordDuesPayment(
      { context: context(a), studentId: student.id, receivedOn: { year: 2030, month: 6, day: 15 }, tender: { currency: "USD", amount: "120.00" }, method: "EFECTIVO", obligationIds: [obligationId], maxBackdateDays: 30 },
      deps({ now: at("2030-06-15T12:00:00") }),
    );
    if (!recorded.ok) throw new Error("fixture payment failed");

    const result = await listOwnPaymentHistory(selfContext(a, student.id), {}, deps());
    if (!result.ok) throw new Error("expected ok result");
    const row = result.rows.find((r) => r.id === recorded.paymentId)!;
    expect(Object.keys(row).sort()).toEqual(["conversion", "id", "method", "receivedOn", "reversedAt", "settlements", "tenderAmount", "tenderCurrency"].sort());
    const settlement = row.settlements[0]!;
    expect(Object.keys(settlement).sort()).toEqual(
      ["coverageYear", "coverageMonth", "currency", "id", "lateFee", "obligationId", "obligationType", "principalAmount", "reversedAt", "totalAmount"].sort(),
    );
    expect(settlement.lateFee).not.toBeNull();
    expect(Object.keys(settlement.lateFee!).sort()).toEqual(["amount", "id", "removalKind"].sort());
    expect(settlement.lateFee!.id).toBe(feeId);
    expect(settlement.lateFee!.amount).toBe("20.00");
    expect(settlement.lateFee!.removalKind).toBeNull(); // genuinely unwaived/unvoided at settlement time
    expect(settlement.principalAmount).toBe("100.00");
    expect(settlement.totalAmount).toBe("120.00"); // principal + fee, exact sum
  });

  it("the student-facing row shows a non-null conversion for a genuine cross-currency payment, with exactly the allowlisted keys, the stored values, and appliedRateId omitted", async () => {
    const student = await newStudent(a);
    const obligationId = await newObligation(a, student.id, 7);
    const quoteDate = freshQuoteDate();
    const quote = await enterExchangeRateQuote({ context: context(a), quoteDate, value: "500.00", expectedCurrentRevision: 0 }, deps());
    if (!quote.ok) throw new Error("fixture quote entry failed");
    const recorded = await recordDuesPayment(
      { context: context(a), studentId: student.id, receivedOn: { year: 2030, month: 7, day: 10 }, tender: { currency: "CRC", amount: "50000.00" }, method: "EFECTIVO", obligationIds: [obligationId], maxBackdateDays: 30 },
      deps({ now: at("2030-07-10T12:00:00") }),
    );
    if (!recorded.ok) throw new Error("fixture payment failed");

    const result = await listOwnPaymentHistory(selfContext(a, student.id), {}, deps());
    if (!result.ok) throw new Error("expected ok result");
    const row = result.rows.find((r) => r.id === recorded.paymentId)!;
    expect(row.conversion).not.toBeNull();
    expect(Object.keys(row.conversion!).sort()).toEqual(["appliedRateQuoteDate", "appliedRateRevision", "appliedRateValue", "appliedRoundingRule"].sort());
    expect(Number(row.conversion!.appliedRateValue)).toBe(500);
    expect(row.conversion!.appliedRateQuoteDate).toEqual(quoteDate);
    expect(row.conversion!.appliedRateRevision).toBe(1);
    expect(row.conversion!.appliedRoundingRule).toBe("HALF_UP_TO_COLON"); // USD obligation -> CRC tender direction
    expect(row.conversion).not.toHaveProperty("appliedRateId");
    // Stronger than a type/key check: the staff reader's own internal id never appears in the real serialized object.
    expect(JSON.stringify(row.conversion)).not.toContain(quote.quoteId);
  });
});

describe("listPaymentHistoryForStudent: staff behavior preserved unchanged by the extraction (brief §3.3 regression)", () => {
  it("the staff reader still returns the full row, including notes — unaffected by the new self path's projection", async () => {
    const student = await newStudent(a);
    const obligationId = await newObligation(a, student.id, 9);
    const recorded = await recordDuesPayment(
      { context: context(a), studentId: student.id, receivedOn: { year: 2030, month: 9, day: 20 }, tender: { currency: "USD", amount: "100.00" }, method: "EFECTIVO", obligationIds: [obligationId], maxBackdateDays: 30, notes: "staff-visible note" },
      deps({ now: at("2030-09-21T12:00:00") }),
    );
    if (!recorded.ok) throw new Error("fixture payment failed");

    const result = await listPaymentHistoryForStudent(context(a), student.id, {}, deps());
    if (!result.ok) throw new Error("expected ok result");
    const row = result.rows.find((r) => r.id === recorded.paymentId);
    expect(row?.notes).toBe("staff-visible note");
  });
});
