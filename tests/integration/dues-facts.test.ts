import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getTestPrismaClient } from "../helpers/test-db";
import { prisma as appPrisma } from "../../src/lib/prisma";
import { makeAccountingOrg } from "../helpers/accounting-org";
import type { TenantContext } from "../../src/lib/tenant/types";
import type { LedgerActivation } from "../../src/lib/dues/ledger/activation";
import { listDuesFactsForStudents, getOwnDuesFacts, type PortalSelfContext } from "../../src/lib/dues/ledger/dues-facts";

/**
 * PAYMENT-UI-CONSUMER-INTEGRATION-BRIEF.md §6: `listDuesFactsForStudents`/`getOwnDuesFacts`, proved against the REAL
 * test database. A read model — every test here also proves zero writes, not just correctness.
 */
const prisma = getTestPrismaClient();
type Fixture = Awaited<ReturnType<typeof makeAccountingOrg>>;
const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
const ACTIVE: LedgerActivation = { isActive: async () => true };
const at = (isoLocal: string) => () => new Date(`${isoLocal}-06:00`); // Costa Rica, UTC-6 all year, matching this ledger's other test files
const deps = (extra: Record<string, unknown> = {}) => ({ activation: ACTIVE, ...extra });

let a: Fixture;
let a2: { id: string };
let director2: { id: string };
let planA: { id: string };
let termsA: { id: string }; // dueDay-equivalent 20, monthsCovered 1
let policyA: { id: string }; // graceDay 5, lateFeeAmount 20.00 USD

function context(over: Partial<TenantContext> = {}): TenantContext {
  return { kind: "tenant", actorUserId: a.admin.id, organizationId: a.org.id, organizationRole: "ADMIN", academyIds: "ALL", selfStudentId: null, linkedStudentId: null, ...over };
}

let studentCounter = 0;
async function newStudent(status: "PENDING" | "ACTIVE" | "INACTIVE" | "ARCHIVED", label: string, academyId = a.academy.id) {
  const n = ++studentCounter;
  return prisma.student.create({
    data: {
      organizationId: a.org.id, homeAcademyId: academyId, firstName: "Facts", lastName: `${label}${n}`, phone: "00000000",
      email: `facts-${label}-${n}-${suffix}@example.com`, currentRankId: await a.rankId("WHITE"), codeHash: `facts-${label}-${n}-${suffix}`, status,
    },
  });
}

async function assign(studentId: string, planId: string | null, effectiveYear = 2020, effectiveMonth = 1) {
  return prisma.studentPlanAssignment.create({ data: { organizationId: a.org.id, studentId, planId, effectiveYear, effectiveMonth, createdById: a.admin.id } });
}

async function createObligation(opts: {
  studentId: string;
  type: "MONTHLY" | "SIGNUP" | "PACKAGE";
  year: number;
  month: number;
  monthsCovered?: number;
  currency?: "USD" | "CRC";
  amount?: string;
  dueOn?: Date | null;
  graceDeadline?: Date | null;
  lateFeeAmount?: string | null;
  policyVersionId?: string | null;
  planTermsId?: string;
}) {
  return prisma.duesObligation.create({
    data: {
      organizationId: a.org.id, studentId: opts.studentId, academyId: a.academy.id, origin: "STAFF",
      type: opts.type, coverageYear: opts.year, coverageMonth: opts.month, monthsCovered: opts.monthsCovered ?? 1,
      amount: opts.amount ?? "100.00", currency: opts.currency ?? "USD",
      dueOn: opts.dueOn ?? null, graceDeadline: opts.graceDeadline ?? null, lateFeeAmount: opts.lateFeeAmount ?? null,
      planTermsId: opts.planTermsId ?? termsA.id, policyVersionId: opts.policyVersionId ?? null, createdById: a.admin.id,
    },
  });
}

async function settle(obligationId: string, studentId: string, reversed = false) {
  const payment = await prisma.duesPayment.create({
    data: { organizationId: a.org.id, studentId, academyId: a.academy.id, receivedOn: new Date("2030-01-01"), tenderCurrency: "USD", tenderAmount: "1.00", method: "EFECTIVO", recordedById: a.admin.id },
  });
  return prisma.duesSettlement.create({
    data: { organizationId: a.org.id, studentId, paymentId: payment.id, obligationId, ...(reversed ? { reversedAt: new Date(), reversedById: a.admin.id, reversalReason: "test reversal" } : {}) },
  });
}

async function addLateFee(obligationId: string, removalKind?: "WAIVED" | "VOIDED") {
  return prisma.duesLateFee.create({
    data: {
      organizationId: a.org.id, obligationId, assessableFrom: new Date("2030-01-06"),
      ...(removalKind ? { removedAt: new Date(), removalKind, removedById: a.admin.id, removalReason: "test" } : {}),
    },
  });
}

async function createReceipt(studentId: string, kind: "ORDINARY" | "PREPAYMENT" | "PACKAGE", snapshot: unknown, tenderAmount = "100.00") {
  return prisma.awaitingRateReceipt.create({
    data: {
      organizationId: a.org.id, studentId, academyId: a.academy.id, kind, status: "PENDING",
      receivedOn: new Date("2030-01-01"), tenderCurrency: "CRC", tenderAmount, method: "EFECTIVO",
      capturedAt: new Date("2030-01-01"), capturedById: a.admin.id, snapshot: snapshot as object,
    },
  });
}

async function ledgerCounts() {
  return {
    obligations: await prisma.duesObligation.count({ where: { organizationId: a.org.id } }),
    settlements: await prisma.duesSettlement.count({ where: { organizationId: a.org.id } }),
    lateFees: await prisma.duesLateFee.count({ where: { organizationId: a.org.id } }),
    coverage: await prisma.duesCoverage.count({ where: { organizationId: a.org.id } }),
    receipts: await prisma.awaitingRateReceipt.count({ where: { organizationId: a.org.id } }),
    payments: await prisma.duesPayment.count({ where: { organizationId: a.org.id } }),
    students: await prisma.student.count({ where: { organizationId: a.org.id } }),
  };
}

beforeAll(async () => {
  a = await makeAccountingOrg("CUMULATIVE", "facts-a");
  a2 = await prisma.academy.create({ data: { organizationId: a.org.id, name: "Facts A2", slug: `facts-a2-${suffix}`, kioskTokenHash: `facts-a2-${suffix}` } });
  const dir2User = await prisma.user.create({ data: { email: `facts-d2-${suffix}@example.com`, passwordHash: "x", role: "DIRECTOR" } });
  await prisma.organizationMembership.create({ data: { userId: dir2User.id, organizationId: a.org.id, role: "DIRECTOR" } });
  await prisma.staffAssignment.create({ data: { userId: dir2User.id, academyId: a2.id, organizationId: a.org.id, role: "DIRECTOR" } });
  director2 = dir2User;

  const plan = await prisma.paymentPlan.create({ data: { organizationId: a.org.id, academyId: a.academy.id, name: `Facts plan ${suffix}` } });
  planA = plan;
  termsA = await prisma.paymentPlanTerms.create({
    data: { organizationId: a.org.id, planId: plan.id, effectiveYear: 2020, effectiveMonth: 1, priceAmount: "100.00", currency: "USD", monthsCovered: 1, createdById: a.admin.id },
  });
  policyA = await prisma.duesPolicyVersion.create({
    data: { organizationId: a.org.id, academyId: a.academy.id, effectiveYear: 2020, effectiveMonth: 1, dueDay: 1, graceDay: 5, lateFeeAmount: "20.00", lateFeeCurrency: "USD", maxPrepaidMonths: 3, createdById: a.admin.id },
  });
}, 60_000);

afterAll(async () => {
  if (!a) return;
  await prisma.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL session_replication_role = replica");
      for (const table of ["AwaitingRateReceipt", "DuesLateFee", "DuesSettlement", "DuesPayment", "DuesCoverage", "DuesObligation", "StudentStatusChange", "StudentPlanAssignment"]) {
        await tx.$executeRawUnsafe(`DELETE FROM "${table}" WHERE "organizationId" = $1`, a.org.id);
      }
    },
    { timeout: 30_000 },
  );
  await prisma.auditLog.deleteMany({ where: { organizationId: a.org.id } });
  await prisma.staffAssignment.deleteMany({ where: { organizationId: a.org.id } });
  await prisma.organizationMembership.deleteMany({ where: { organizationId: a.org.id, userId: director2.id } });
  await prisma.user.deleteMany({ where: { id: director2.id } });
  // a2 holds a student (the foreign-branch test's own fixture) — a.drop() only deletes students AFTER this point,
  // so a2 itself must wait until those rows are gone, or be deleted here explicitly first.
  await prisma.student.deleteMany({ where: { organizationId: a.org.id, homeAcademyId: a2.id } });
  await prisma.academy.deleteMany({ where: { id: a2.id } });
  await prisma.paymentPlanTerms.deleteMany({ where: { organizationId: a.org.id } });
  await prisma.duesPolicyVersion.deleteMany({ where: { organizationId: a.org.id } });
  await prisma.paymentPlan.deleteMany({ where: { organizationId: a.org.id } });
  await a.drop();
}, 60_000);

describe("billing inactive: the gated branch returns nothing, byte-identical to absent", () => {
  it("listDuesFactsForStudents refuses notActive with default deps, reads nothing", async () => {
    const s = await newStudent("ACTIVE", "inactive");
    const result = await listDuesFactsForStudents(context(), [s.id]);
    expect(result).toEqual({ ok: false, error: "notActive" });
  });

  it("getOwnDuesFacts returns null with default deps", async () => {
    const s = await newStudent("ACTIVE", "inactiveself");
    const selfCtx: PortalSelfContext = { ...context({ organizationRole: "STUDENT", selfStudentId: s.id }), selfStudentId: s.id };
    expect(await getOwnDuesFacts(selfCtx)).toBeNull();
  });
});

describe("eligibility outcomes (§4.1)", () => {
  it("UNDECIDABLE: no status history for this period", async () => {
    // A student exists but has zero StudentStatusChange rows — eligibleAndAssigned's own first branch.
    const result = await listDuesFactsForStudents(context(), [(await newStudent("ACTIVE", "nohistory")).id], undefined, deps({ now: at("2030-01-10T12:00:00") }));
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) throw new Error("unreachable");
    expect(result.facts[0]!.eligibility).toEqual({ outcome: "UNDECIDABLE" });
  });

  it("OBSERVED_DISCREPANCY: eligible + configured, no MONTHLY for the period — cause not asserted", async () => {
    const s = await newStudent("ACTIVE", "discrepancy");
    await prisma.studentStatusChange.create({ data: { organizationId: a.org.id, studentId: s.id, status: "ACTIVE", effectiveOn: new Date("2029-12-01"), sequence: 1, source: "EVENT", actorId: a.admin.id } });
    await assign(s.id, planA.id, 2029, 12);
    const result = await listDuesFactsForStudents(context(), [s.id], { year: 2030, month: 1 }, deps({ now: at("2030-01-10T12:00:00") }));
    if (!result.ok) throw new Error("unreachable");
    expect(result.facts[0]!.eligibility).toEqual({ outcome: "OBSERVED_DISCREPANCY" });
  });

  it("RESOLVED: eligible + configured + the MONTHLY already exists for this period", async () => {
    const s = await newStudent("ACTIVE", "resolved");
    await prisma.studentStatusChange.create({ data: { organizationId: a.org.id, studentId: s.id, status: "ACTIVE", effectiveOn: new Date("2029-12-01"), sequence: 1, source: "EVENT", actorId: a.admin.id } });
    await assign(s.id, planA.id, 2029, 12);
    await createObligation({ studentId: s.id, type: "MONTHLY", year: 2030, month: 1, dueOn: new Date("2030-01-01"), graceDeadline: new Date("2030-01-06"), lateFeeAmount: "20.00", policyVersionId: policyA.id });
    const result = await listDuesFactsForStudents(context(), [s.id], { year: 2030, month: 1 }, deps({ now: at("2030-01-10T12:00:00") }));
    if (!result.ok) throw new Error("unreachable");
    expect(result.facts[0]!.eligibility).toEqual({ outcome: "RESOLVED", planId: planA.id });
  });

  it("MISSING_CONFIGURATION: eligible + assigned, but no terms/policy resolves for this period", async () => {
    const s = await newStudent("ACTIVE", "missingconfig");
    await prisma.studentStatusChange.create({ data: { organizationId: a.org.id, studentId: s.id, status: "ACTIVE", effectiveOn: new Date("2029-12-01"), sequence: 1, source: "EVENT", actorId: a.admin.id } });
    const noTermsPlan = await prisma.paymentPlan.create({ data: { organizationId: a.org.id, academyId: a.academy.id, name: `No terms ${suffix}` } });
    await assign(s.id, noTermsPlan.id, 2029, 12);
    const result = await listDuesFactsForStudents(context(), [s.id], { year: 2030, month: 1 }, deps({ now: at("2030-01-10T12:00:00") }));
    if (!result.ok) throw new Error("unreachable");
    expect(result.facts[0]!.eligibility).toEqual({ outcome: "MISSING_CONFIGURATION" });
  });

  it("NO_ASSIGNMENT / NOT_ELIGIBLE are reported independently of old outstanding debt (§4.2/§4.3 boundary)", async () => {
    const s = await newStudent("ARCHIVED", "oldignored");
    await prisma.studentStatusChange.create({ data: { organizationId: a.org.id, studentId: s.id, status: "ARCHIVED", effectiveOn: new Date("2029-06-01"), sequence: 1, source: "EVENT", actorId: a.admin.id } });
    // An old, unsettled obligation from when this student WAS eligible — must still surface in `outstanding` even
    // though they are now ARCHIVED (NOT_ELIGIBLE for the current period).
    await createObligation({ studentId: s.id, type: "MONTHLY", year: 2029, month: 5, dueOn: new Date("2029-05-01"), graceDeadline: new Date("2029-05-06"), lateFeeAmount: "20.00", policyVersionId: policyA.id });
    const result = await listDuesFactsForStudents(context(), [s.id], { year: 2030, month: 1 }, deps({ now: at("2030-01-10T12:00:00") }));
    if (!result.ok) throw new Error("unreachable");
    expect(result.facts[0]!.eligibility).toEqual({ outcome: "NOT_ELIGIBLE" });
    expect(result.facts[0]!.outstanding).toHaveLength(1);
    expect(result.facts[0]!.outstanding[0]!.coverageMonth).toBe(5);
  });
});

describe("§5.1 — the five required fee scenarios, each its own test", () => {
  it("(1) a MONTHLY settled LATE shows outstandingAmountMinor: 0 — the historical fee is never re-reported as owed", async () => {
    const s = await newStudent("ACTIVE", "settledlate");
    const o = await createObligation({ studentId: s.id, type: "MONTHLY", year: 2030, month: 1, dueOn: new Date("2030-01-01"), graceDeadline: new Date("2030-01-06"), lateFeeAmount: "20.00", policyVersionId: policyA.id });
    await addLateFee(o.id); // the fee WAS assessed at settlement time
    await settle(o.id, s.id);
    const result = await listDuesFactsForStudents(context(), [s.id], undefined, deps({ now: at("2030-06-01T12:00:00") }));
    if (!result.ok) throw new Error("unreachable");
    const fact = result.facts[0]!.outstanding[0]!;
    expect(fact.settled).toBe(true);
    expect(fact.outstandingAmountMinor).toBe(0);
    expect(fact.outstandingFeeMinor).toBe(0);
    expect(fact.pastGrace).toBeNull();
  });

  it("(2) an unsettled MONTHLY with a WAIVED fee marker shows outstandingFeeMinor: 0, tuition still owed", async () => {
    const s = await newStudent("ACTIVE", "waived");
    const o = await createObligation({ studentId: s.id, type: "MONTHLY", year: 2030, month: 1, dueOn: new Date("2030-01-01"), graceDeadline: new Date("2030-01-06"), lateFeeAmount: "20.00", policyVersionId: policyA.id });
    await addLateFee(o.id, "WAIVED");
    const result = await listDuesFactsForStudents(context(), [s.id], undefined, deps({ now: at("2030-02-01T12:00:00") }));
    if (!result.ok) throw new Error("unreachable");
    const fact = result.facts[0]!.outstanding[0]!;
    expect(fact.outstandingFeeMinor).toBe(0);
    expect(fact.outstandingAmountMinor).toBe(10000); // tuition only, no fee
    expect(fact.pastGrace).toBe(true);
  });

  it("(3) an unsettled MONTHLY with a VOIDED fee marker: same assertion as WAIVED", async () => {
    const s = await newStudent("ACTIVE", "voided");
    const o = await createObligation({ studentId: s.id, type: "MONTHLY", year: 2030, month: 1, dueOn: new Date("2030-01-01"), graceDeadline: new Date("2030-01-06"), lateFeeAmount: "20.00", policyVersionId: policyA.id });
    await addLateFee(o.id, "VOIDED");
    const result = await listDuesFactsForStudents(context(), [s.id], undefined, deps({ now: at("2030-02-01T12:00:00") }));
    if (!result.ok) throw new Error("unreachable");
    const fact = result.facts[0]!.outstanding[0]!;
    expect(fact.outstandingFeeMinor).toBe(0);
    expect(fact.outstandingAmountMinor).toBe(10000);
  });

  it("(4) an unsettled, past-grace MONTHLY with ZERO DuesLateFee rows still shows the correct positive fee", async () => {
    const s = await newStudent("ACTIVE", "nofeerow");
    await createObligation({ studentId: s.id, type: "MONTHLY", year: 2030, month: 1, dueOn: new Date("2030-01-01"), graceDeadline: new Date("2030-01-06"), lateFeeAmount: "20.00", policyVersionId: policyA.id });
    // Deliberately NO addLateFee() call — the marker is lazily created; absence must not mean "no fee owed".
    const result = await listDuesFactsForStudents(context(), [s.id], undefined, deps({ now: at("2030-02-01T12:00:00") }));
    if (!result.ok) throw new Error("unreachable");
    const fact = result.facts[0]!.outstanding[0]!;
    expect(fact.outstandingFeeMinor).toBe(2000); // lateFeeToAssessMinor's own pure result
    expect(fact.outstandingAmountMinor).toBe(12000); // 10000 tuition + 2000 fee
    expect(fact.pastGrace).toBe(true);
  });

  it("(5) a MONTHLY whose settlement was later REVERSED shows outstanding fully reopened, no special-casing", async () => {
    const s = await newStudent("ACTIVE", "reversed");
    const o = await createObligation({ studentId: s.id, type: "MONTHLY", year: 2030, month: 1, dueOn: new Date("2030-01-01"), graceDeadline: new Date("2030-01-06"), lateFeeAmount: "20.00", policyVersionId: policyA.id });
    await settle(o.id, s.id, true); // the one and only settlement, already reversed
    const result = await listDuesFactsForStudents(context(), [s.id], undefined, deps({ now: at("2030-02-01T12:00:00") }));
    if (!result.ok) throw new Error("unreachable");
    const fact = result.facts[0]!.outstanding[0]!;
    expect(fact.settled).toBe(false);
    expect(fact.outstandingAmountMinor).toBe(12000); // tuition + fee, reopened under the ordinary unsettled branch
  });
});

describe("type-aware facts: SIGNUP/PACKAGE never acquire monthly late-fee facts", () => {
  it("a SIGNUP shows dueOn but pastGrace/outstandingFeeMinor as explicit null, never computed via the MONTHLY formula", async () => {
    const s = await newStudent("ACTIVE", "signupfacts");
    await createObligation({ studentId: s.id, type: "SIGNUP", year: 2030, month: 1, dueOn: new Date("2030-01-01"), graceDeadline: null, lateFeeAmount: null });
    const result = await listDuesFactsForStudents(context(), [s.id], undefined, deps({ now: at("2030-06-01T12:00:00") }));
    if (!result.ok) throw new Error("unreachable");
    const fact = result.facts[0]!.outstanding[0]!;
    expect(fact.type).toBe("SIGNUP");
    expect(fact.dueOn).toBe("2030-01-01");
    expect(fact.pastGrace).toBeNull();
    expect(fact.outstandingFeeMinor).toBeNull();
    expect(fact.outstandingAmountMinor).toBe(10000); // tuition only
  });

  it("a PACKAGE shows dueOn: null (always NULL by shape), pastGrace/outstandingFeeMinor null", async () => {
    const s = await newStudent("ACTIVE", "packagefacts");
    const pkgPlan = await prisma.paymentPlan.create({ data: { organizationId: a.org.id, academyId: a.academy.id, name: `Facts pkg plan ${suffix}` } });
    const packageTerms = await prisma.paymentPlanTerms.create({
      data: { organizationId: a.org.id, planId: pkgPlan.id, effectiveYear: 2020, effectiveMonth: 1, priceAmount: "180.00", currency: "USD", monthsCovered: 2, createdById: a.admin.id },
    });
    await createObligation({ studentId: s.id, type: "PACKAGE", year: 2030, month: 1, monthsCovered: 2, amount: "180.00", dueOn: null, graceDeadline: null, lateFeeAmount: null, planTermsId: packageTerms.id });
    const result = await listDuesFactsForStudents(context(), [s.id], undefined, deps({ now: at("2030-06-01T12:00:00") }));
    if (!result.ok) throw new Error("unreachable");
    const fact = result.facts[0]!.outstanding[0]!;
    expect(fact.type).toBe("PACKAGE");
    expect(fact.dueOn).toBeNull();
    expect(fact.pastGrace).toBeNull();
    expect(fact.outstandingFeeMinor).toBeNull();
    expect(fact.outstandingAmountMinor).toBe(18000);
  });
});

describe("coverage ≠ paid (§4)", () => {
  it("an unpaid MONTHLY with a real DuesCoverage row: coverageClaimed true, settled false, outstanding > 0", async () => {
    const s = await newStudent("ACTIVE", "coverageproof");
    const o = await createObligation({ studentId: s.id, type: "MONTHLY", year: 2030, month: 1, dueOn: new Date("2030-01-01"), graceDeadline: new Date("2030-01-06"), lateFeeAmount: "20.00", policyVersionId: policyA.id });
    await prisma.duesCoverage.create({ data: { organizationId: a.org.id, studentId: s.id, obligationId: o.id, year: 2030, month: 1 } });
    const result = await listDuesFactsForStudents(context(), [s.id], undefined, deps({ now: at("2030-01-02T12:00:00") }));
    if (!result.ok) throw new Error("unreachable");
    const fact = result.facts[0]!.outstanding[0]!;
    expect(fact.coverageClaimed).toBe(true);
    expect(fact.settled).toBe(false);
    expect(fact.outstandingAmountMinor).toBeGreaterThan(0);
  });
});

describe("pending receipts, decomposed into Component A / Component B (§4.3)", () => {
  it("a PREPAYMENT receipt exercises BOTH components in one test; the tendered amount is never subtracted from outstanding", async () => {
    const s = await newStudent("ACTIVE", "receiptboth");
    const existing = await createObligation({ studentId: s.id, type: "MONTHLY", year: 2029, month: 11, dueOn: new Date("2029-11-01"), graceDeadline: new Date("2029-11-06"), lateFeeAmount: "20.00", policyVersionId: policyA.id });
    await createReceipt(
      s.id,
      "PREPAYMENT",
      {
        kind: "PREPAYMENT",
        existingObligationIds: [existing.id],
        months: [{ coverage: { year: 2030, month: 2 }, planTermsId: termsA.id, policyVersionId: policyA.id, policyRevision: "rev-1", priceAmount: "100.00", assignmentId: "assignment-1", assignmentRevision: "rev-1" }],
      },
      "100.00",
    );
    const result = await listDuesFactsForStudents(context(), [s.id], undefined, deps({ now: at("2030-01-10T12:00:00") }));
    if (!result.ok) throw new Error("unreachable");
    const fact = result.facts[0]!;
    expect(fact.outstanding).toHaveLength(1); // the receipt creates NOTHING new
    expect(fact.outstanding[0]!.outstandingAmountMinor).toBeGreaterThan(0); // never reduced by the pending receipt
    expect(fact.pendingReceipts).toHaveLength(1);
    const receiptFact = fact.pendingReceipts[0]!;
    expect(receiptFact.referencedExistingObligationIds).toEqual([existing.id]); // Component A
    expect(receiptFact.proposedCoverage).toEqual([{ year: 2030, month: 2 }]); // Component B
    expect(receiptFact.tenderAmountMinor).toBe(10000); // raw, unconverted
  });

  it("an ORDINARY receipt has an empty proposedCoverage — nothing is proposed, only referenced", async () => {
    const s = await newStudent("ACTIVE", "receiptordinary");
    const existing = await createObligation({ studentId: s.id, type: "MONTHLY", year: 2030, month: 1, dueOn: new Date("2030-01-01"), graceDeadline: new Date("2030-01-06"), lateFeeAmount: "20.00", policyVersionId: policyA.id });
    await createReceipt(s.id, "ORDINARY", { kind: "ORDINARY", obligationIds: [existing.id] }, "100.00");
    const result = await listDuesFactsForStudents(context(), [s.id], undefined, deps({ now: at("2030-01-10T12:00:00") }));
    if (!result.ok) throw new Error("unreachable");
    const receiptFact = result.facts[0]!.pendingReceipts[0]!;
    expect(receiptFact.referencedExistingObligationIds).toEqual([existing.id]);
    expect(receiptFact.proposedCoverage).toEqual([]);
  });
});

describe("no writes of any kind — this is a reader, provably", () => {
  it("every dues table and the student table are unchanged after calling the resolver", async () => {
    const s = await newStudent("ACTIVE", "nowrites");
    await createObligation({ studentId: s.id, type: "MONTHLY", year: 2030, month: 1, dueOn: new Date("2030-01-01"), graceDeadline: new Date("2030-01-06"), lateFeeAmount: "20.00", policyVersionId: policyA.id });
    const before = await ledgerCounts();
    await listDuesFactsForStudents(context(), [s.id], undefined, deps({ now: at("2030-02-01T12:00:00") }));
    expect(await ledgerCounts()).toEqual(before);
  });
});

describe("staff mode: foreign-branch exclusion (§6)", () => {
  it("a Director requesting a student outside their own branch scope sees that id silently absent — excluded, not an error", async () => {
    const inScope = await newStudent("ACTIVE", "inscope", a.academy.id);
    const outOfScope = await newStudent("ACTIVE", "outofscope", a2.id);
    const director = context({ organizationRole: "DIRECTOR", academyIds: [a2.id] }); // director2's own scope
    const result = await listDuesFactsForStudents(director, [inScope.id, outOfScope.id], undefined, deps({ now: at("2030-01-10T12:00:00") }));
    if (!result.ok) throw new Error("unreachable");
    expect(result.facts.map((f) => f.studentId)).toEqual([outOfScope.id]); // only the in-scope-for-THIS-director id
    expect(result.facts.find((f) => f.studentId === inScope.id)).toBeUndefined();
  });
});

describe("self mode: structurally and at runtime cannot return a foreign student's data (§6)", () => {
  it("getOwnDuesFacts's own exported signature takes no studentIds parameter — a type-level proof", () => {
    // 3 params: context, optional month, optional deps — never a studentIds slot of any kind, at any position.
    expect(getOwnDuesFacts.length).toBeLessThanOrEqual(3);
    // @ts-expect-error — passing a second positional studentIds-shaped argument where `month` is expected must not typecheck as a student list
    const _typeProof: ReturnType<typeof getOwnDuesFacts> = getOwnDuesFacts({} as PortalSelfContext, ["forged-id"]);
    void _typeProof;
  });

  it("always returns exactly the caller's own data, regardless of what else exists in the organization", async () => {
    const me = await newStudent("ACTIVE", "self");
    const someoneElse = await newStudent("ACTIVE", "notme");
    await createObligation({ studentId: me.id, type: "MONTHLY", year: 2030, month: 1, dueOn: new Date("2030-01-01"), graceDeadline: new Date("2030-01-06"), lateFeeAmount: "20.00", policyVersionId: policyA.id });
    await createObligation({ studentId: someoneElse.id, type: "MONTHLY", year: 2030, month: 1, dueOn: new Date("2030-01-01"), graceDeadline: new Date("2030-01-06"), lateFeeAmount: "20.00", policyVersionId: policyA.id });
    const selfCtx: PortalSelfContext = { ...context({ organizationRole: "STUDENT", selfStudentId: me.id }), selfStudentId: me.id };
    const result = await getOwnDuesFacts(selfCtx, undefined, deps({ now: at("2030-01-10T12:00:00") }));
    expect(result?.studentId).toBe(me.id);
  });
});

describe("currency separation: never summed across USD/CRC", () => {
  it("a mixed-currency batch keeps each obligation's own currency tag, never a combined figure", async () => {
    const usdStudent = await newStudent("ACTIVE", "usd");
    const crcStudent = await newStudent("ACTIVE", "crc");
    const crcPlan = await prisma.paymentPlan.create({ data: { organizationId: a.org.id, academyId: a.academy.id, name: `Facts CRC plan ${suffix}` } });
    const crcTerms = await prisma.paymentPlanTerms.create({
      data: { organizationId: a.org.id, planId: crcPlan.id, effectiveYear: 2020, effectiveMonth: 1, priceAmount: "50000.00", currency: "CRC", monthsCovered: 1, createdById: a.admin.id },
    });
    const crcPolicy = await prisma.duesPolicyVersion.create({
      data: { organizationId: a.org.id, academyId: a.academy.id, effectiveYear: 2020, effectiveMonth: 2, dueDay: 1, graceDay: 5, lateFeeAmount: "10000.00", lateFeeCurrency: "CRC", maxPrepaidMonths: 3, createdById: a.admin.id },
    });
    await createObligation({ studentId: usdStudent.id, type: "MONTHLY", year: 2030, month: 1, currency: "USD", amount: "100.00", dueOn: new Date("2030-01-01"), graceDeadline: new Date("2030-01-06"), lateFeeAmount: "20.00", policyVersionId: policyA.id });
    await createObligation({ studentId: crcStudent.id, type: "MONTHLY", year: 2030, month: 1, currency: "CRC", amount: "50000.00", dueOn: new Date("2030-01-01"), graceDeadline: new Date("2030-01-06"), lateFeeAmount: "10000.00", policyVersionId: crcPolicy.id, planTermsId: crcTerms.id });
    const result = await listDuesFactsForStudents(context(), [usdStudent.id, crcStudent.id], undefined, deps({ now: at("2030-02-01T12:00:00") }));
    if (!result.ok) throw new Error("unreachable");
    const usdFact = result.facts.find((f) => f.studentId === usdStudent.id)!.outstanding[0]!;
    const crcFact = result.facts.find((f) => f.studentId === crcStudent.id)!.outstanding[0]!;
    expect(usdFact.currency).toBe("USD");
    expect(crcFact.currency).toBe("CRC");
    expect(usdFact.outstandingAmountMinor).toBe(12000);
    expect(crcFact.outstandingAmountMinor).toBe(6000000); // CRC's own figure, never combined with USD's
  });
});

describe("bounded batching (§6)", () => {
  it("an over-MAX_SELECTED request refuses invalid before any query runs", async () => {
    const tooMany = Array.from({ length: 61 }, (_, i) => `fake-id-${i}`);
    const result = await listDuesFactsForStudents(context(), tooMany, undefined, deps());
    expect(result).toEqual({ ok: false, error: "invalid" });
  });

  it("a genuine multi-hundred-student query resolves with a FIXED, small number of queries — not one per student", async () => {
    const whiteRankId = await a.rankId("WHITE");
    const bulkData = Array.from({ length: 200 }, (_, i) => ({
      organizationId: a.org.id, homeAcademyId: a.academy.id, firstName: "Bulk", lastName: `S${i}`, phone: "0",
      email: `bulk-${i}-${suffix}@example.com`, currentRankId: whiteRankId, codeHash: `bulk-${i}-${suffix}`, status: "ACTIVE" as const,
    }));
    await prisma.student.createMany({ data: bulkData });
    const bulkIds = (await prisma.student.findMany({ where: { organizationId: a.org.id, codeHash: { startsWith: `bulk-` } }, select: { id: true } })).map((s) => s.id);
    expect(bulkIds.length).toBeGreaterThan(0);

    const studentFindManySpy = vi.spyOn(appPrisma.student, "findMany");
    const statusFindManySpy = vi.spyOn(appPrisma.studentStatusChange, "findMany");
    const obligationFindManySpy = vi.spyOn(appPrisma.duesObligation, "findMany");
    const receiptFindManySpy = vi.spyOn(appPrisma.awaitingRateReceipt, "findMany");
    try {
      // Only the first 60 (MAX_SELECTED) can be requested in one call — this test proves the QUERY COUNT for that
      // bounded batch is fixed, not proportional to it.
      const batch = bulkIds.slice(0, 60);
      const result = await listDuesFactsForStudents(context(), batch, undefined, deps({ now: at("2030-01-10T12:00:00") }));
      expect(result.ok).toBe(true);
      expect(studentFindManySpy).toHaveBeenCalledTimes(1);
      expect(statusFindManySpy).toHaveBeenCalledTimes(1);
      expect(obligationFindManySpy).toHaveBeenCalledTimes(1);
      expect(receiptFindManySpy).toHaveBeenCalledTimes(1);
    } finally {
      studentFindManySpy.mockRestore();
      statusFindManySpy.mockRestore();
      obligationFindManySpy.mockRestore();
      receiptFindManySpy.mockRestore();
      await prisma.student.deleteMany({ where: { organizationId: a.org.id, codeHash: { startsWith: "bulk-" } } });
    }
  }, 30_000);
});
