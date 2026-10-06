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
import { versionRevision } from "../../src/lib/dues/config-input";
import type { LedgerActivation } from "../../src/lib/dues/ledger/activation";
import { listCorrectableLateFees, listReversiblePayments, getLateFeeById, getPaymentById } from "../../src/lib/dues/financial-corrections-queries";

/**
 * Owner financial-corrections UI brief §7: reader tests for all three new reads — tenant/branch scoping, correct
 * exclusion of already-removed fees / already-reversed payments from the CANDIDATE lists, the recovery reads'
 * own opposite requirement (must find the exact target even after it has left the candidate set), and the
 * server-computed revision token's correctness (matches the SAME `versionRevision` helper the writers themselves
 * use). Reuses the real `createMonthlyObligation`/`assessLateFeesForStudent`/`recordDuesPayment` engine functions to
 * produce genuine fixtures — never a shortcut past them, matching `correct-late-fee.test.ts`'s own established
 * fixture conventions.
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
const terms: Record<string, { id: string }> = {};
const feePolicy: Record<string, { id: string }> = {};

function context(org: Fixture, over: Partial<TenantContext> = {}): TenantContext {
  return { kind: "tenant", actorUserId: org.admin.id, organizationId: org.org.id, organizationRole: "ADMIN", academyIds: "ALL", selfStudentId: null, linkedStudentId: null, ...over };
}

let studentCounter = 0;
async function newStudent(org: Fixture) {
  const n = ++studentCounter;
  return prisma.student.create({
    data: {
      organizationId: org.org.id, homeAcademyId: org.academy.id, firstName: "FinCorr", lastName: `S${n}`, phone: "00000000",
      email: `fincorr-${n}-${suffix}@example.com`, currentRankId: await org.rankId("WHITE"), codeHash: `fincorr-${n}-${suffix}`, status: "ACTIVE",
    },
  });
}

async function newObligation(org: Fixture, studentId: string, month = 10) {
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
  const plan = await prisma.paymentPlan.create({ data: { organizationId: org.org.id, academyId: org.academy.id, name: `FinCorr plan ${suffix}-${org.org.id}` } });
  terms[org.org.id] = await prisma.paymentPlanTerms.create({
    data: { organizationId: org.org.id, planId: plan.id, effectiveYear: 2030, effectiveMonth: 1, priceAmount: "100.00", currency: "USD", monthsCovered: 1, createdById: org.admin.id },
  });
  feePolicy[org.org.id] = await prisma.duesPolicyVersion.create({
    data: { organizationId: org.org.id, academyId: org.academy.id, effectiveYear: 2030, effectiveMonth: 1, dueDay: 20, graceDay: 5, lateFeeAmount: "20.00", lateFeeCurrency: "USD", createdById: org.admin.id },
  });
}

beforeAll(async () => {
  a = await makeAccountingOrg("CUMULATIVE", "fincorr-a");
  b = await makeAccountingOrg("CUMULATIVE", "fincorr-b");
  await seedPlanAndPolicy(a);
  await seedPlanAndPolicy(b);
}, 60_000);

async function cleanupLedgerRows(org: Fixture) {
  await prisma.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL session_replication_role = replica");
      for (const table of ["DuesSettlement", "DuesPayment", "DuesLateFee", "DuesCoverage", "DuesObligation"]) {
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

describe("listCorrectableLateFees", () => {
  it("returns only this student's own unremoved fees, scoped to the organization, with a server-computed revision token", async () => {
    const student = await newStudent(a);
    const obligationId = await newObligation(a, student.id, 10);
    const outcomes = await assessAsOf(a, student.id, 11, 10);
    const feeId = feeIdFor(outcomes, obligationId);
    const fee = await prisma.duesLateFee.findUniqueOrThrow({ where: { id: feeId } });

    const rows = await listCorrectableLateFees(context(a), student.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(feeId);
    expect(rows[0].expectedRevision).toBe(feeRevision(fee));
  });

  it("excludes an already-removed (waived) fee from the candidate list", async () => {
    const student = await newStudent(a);
    const obligationId = await newObligation(a, student.id, 11);
    const outcomes = await assessAsOf(a, student.id, 12, 10);
    const feeId = feeIdFor(outcomes, obligationId);
    const fee = await prisma.duesLateFee.findUniqueOrThrow({ where: { id: feeId } });
    const waived = await waiveLateFee({ context: context(a), lateFeeId: feeId, expectedRevision: feeRevision(fee), removalReason: "owner forgave it" }, deps());
    expect(waived.ok).toBe(true);

    const rows = await listCorrectableLateFees(context(a), student.id);
    expect(rows.find((r) => r.id === feeId)).toBeUndefined();
  });

  it("never returns a different organization's fee, even for the same studentId pattern (tenant scoping)", async () => {
    const student = await newStudent(b);
    const rows = await listCorrectableLateFees(context(a), student.id);
    expect(rows).toEqual([]);
  });
});

describe("getLateFeeById (recovery read)", () => {
  it("finds the exact fee even after it has already left the candidate list (waived) — unlike the filtered list", async () => {
    const student = await newStudent(a);
    const obligationId = await newObligation(a, student.id, 1);
    const outcomes = await assessAsOf(a, student.id, 2, 10);
    const feeId = feeIdFor(outcomes, obligationId);
    const fee = await prisma.duesLateFee.findUniqueOrThrow({ where: { id: feeId } });
    await waiveLateFee({ context: context(a), lateFeeId: feeId, expectedRevision: feeRevision(fee), removalReason: "owner forgave it" }, deps());

    const status = await getLateFeeById(context(a), feeId);
    expect(status).not.toBeNull();
    expect(status!.removalKind).toBe("WAIVED");
    expect(status!.removedAt).not.toBeNull();
  });

  it("returns null for a fee belonging to a different organization", async () => {
    const student = await newStudent(b);
    const obligationId = await newObligation(b, student.id, 1);
    const outcomes = await assessAsOf(b, student.id, 2, 10);
    const feeId = feeIdFor(outcomes, obligationId);
    expect(await getLateFeeById(context(a), feeId)).toBeNull();
  });
});

describe("listReversiblePayments / getPaymentById (recovery read)", () => {
  it("lists a not-yet-reversed payment with a correctly-computed restriction shape, and excludes it once reversed", async () => {
    const student = await newStudent(a);
    const obligationId = await newObligation(a, student.id, 3);
    const recorded = await recordDuesPayment(
      { context: context(a), studentId: student.id, receivedOn: { year: 2030, month: 3, day: 20 }, tender: { currency: "USD", amount: "100.00" }, method: "EFECTIVO", obligationIds: [obligationId], maxBackdateDays: 30 },
      deps({ now: at("2030-03-21T12:00:00") }),
    );
    if (!recorded.ok) throw new Error(`fixture payment failed: ${recorded.error}`);

    const before = await listReversiblePayments(context(a), student.id);
    const row = before.find((p) => p.id === recorded.paymentId);
    expect(row).toBeDefined();
    expect(row!.restrictions).toEqual({ hasUnsupportedObligationType: false, hasPrepaymentOrigin: false, hasVoidedFee: false });

    const reversed = await reversePayment({ context: context(a), paymentId: recorded.paymentId, reversalReason: "test reversal" }, deps());
    expect(reversed.ok).toBe(true);

    const after = await listReversiblePayments(context(a), student.id);
    expect(after.find((p) => p.id === recorded.paymentId)).toBeUndefined();

    // Recovery read: still finds it, unlike the filtered list above.
    const status = await getPaymentById(context(a), recorded.paymentId);
    expect(status).not.toBeNull();
    expect(status!.reversedAt).not.toBeNull();
  });

  it("flags hasVoidedFee for a payment whose settled obligation now carries a VOIDED late fee", async () => {
    const student = await newStudent(a);
    const obligationId = await newObligation(a, student.id, 4);
    const outcomes = await assessAsOf(a, student.id, 5, 10);
    const feeId = feeIdFor(outcomes, obligationId);
    const fee = await prisma.duesLateFee.findUniqueOrThrow({ where: { id: feeId } });
    // Void-and-settle via the correction writer itself — the real way a VOIDED fee + active settlement co-occur.
    const { correctLateFeeAndSettle } = await import("../../src/lib/dues/ledger/correct-late-fee");
    const corrected = await correctLateFeeAndSettle(
      { context: context(a), lateFeeId: feeId, expectedRevision: feeRevision(fee), removalReason: "on time after all", receivedOn: { year: 2030, month: 4, day: 25 }, tender: { currency: "USD", amount: "100.00" }, method: "EFECTIVO", maxBackdateDays: 30 },
      deps({ now: at("2030-04-25T12:00:00") }),
    );
    if (!corrected.ok) throw new Error(`fixture correction failed: ${corrected.error}`);

    const rows = await listReversiblePayments(context(a), student.id);
    const row = rows.find((p) => p.id === corrected.paymentId);
    expect(row).toBeDefined();
    expect(row!.restrictions.hasVoidedFee).toBe(true);
  });

  it("bounds the list to the requested limit", async () => {
    const student = await newStudent(a);
    for (let m = 6; m <= 9; m++) {
      const obligationId = await newObligation(a, student.id, m);
      const recorded = await recordDuesPayment(
        { context: context(a), studentId: student.id, receivedOn: { year: 2030, month: m, day: 20 }, tender: { currency: "USD", amount: "100.00" }, method: "EFECTIVO", obligationIds: [obligationId], maxBackdateDays: 30 },
        deps({ now: at(`2030-${String(m).padStart(2, "0")}-21T12:00:00`) }),
      );
      if (!recorded.ok) throw new Error(`fixture payment failed: ${recorded.error}`);
    }
    const rows = await listReversiblePayments(context(a), student.id, 2);
    expect(rows).toHaveLength(2);
  });
});
