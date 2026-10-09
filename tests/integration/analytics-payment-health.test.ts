import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getTestPrismaClient } from "../helpers/test-db";
import { makeAccountingOrg } from "../helpers/accounting-org";
import { hashSecret } from "../../src/lib/crypto";
import { awaitingRateReceiptSnapshotSchema } from "../../src/lib/dues/ledger/awaiting-rate-receipt";
import { currentCrDateParts } from "../../src/lib/payments/get-current-period";
import { prisma as appPrisma } from "../../src/lib/prisma";
import * as duesFactsModule from "../../src/lib/dues/ledger/dues-facts";
import * as paymentHealthModule from "../../src/lib/analytics/payment-health";
import type { TenantContext } from "../../src/lib/tenant/types";
import type { LedgerDeps } from "../../src/lib/dues/ledger/activation";

/**
 * REMAINING-LEDGER-CONSUMERS-BRIEF.md §2.2/§6.1 Decision 3 (PR 6): "Current month covered by settled payments" —
 * the analytics `paymentHealthPercent` ledger cutover. Two layers:
 *
 * 1. Reader-level (`getLedgerPaymentHealth` called directly, a pinned `now`): every numerator/denominator rule the
 *    brief lists, one fresh org per scenario — settled PACKAGE despite MISSING_CONFIGURATION, unpaid coverage,
 *    settled-plus-old-debt, SIGNUP-only, unassigned/no-obligations, pending conversion, reversed settlement,
 *    duplicate-count prevention, different branch-local months at one instant, exact partial-failure counts, and
 *    empty population.
 * 2. Consumer-level (`getHeadlineTiles`, real wall-clock `now` — not injectable there): real tenant/branch
 *    isolation, and the active-vs-legacy exclusivity proof (spying the REAL `prisma.paymentPeriod.findMany` call
 *    `legacyPaymentHealth` issues, and the cross-module `getLedgerPaymentHealth` import — never the same-module
 *    `legacyPaymentHealth` export, which a same-module spy cannot reliably intercept).
 *
 * `getLedgerPaymentHealth`/`getHeadlineTiles` take no `deps` override of their own — both always resolve activation
 * through the real `inactiveLedgerActivation` singleton, exactly like every other page-level ledger consumer
 * (`payments-page-ledger-render.test.ts`, `dashboard-page-ledger-render.test.ts`) — so this file mocks
 * `@/lib/dues/ledger/activation` at the TOP LEVEL (Vitest's static `vi.mock` hoisting requires this; a nested
 * `vi.mock` inside `describe` is not reliably hoisted) rather than injecting a per-call override.
 *
 * `createMonthlyObligation`'s own unconditional `futureMonth` refusal means every obligation's `coverage` must be
 * `<=` the writer's own `now` in the SAME branch timezone — so every fixed-clock fixture's `writerDeps.now` is
 * pinned to the SAME instant whose branch-local month the test targets, never a separate, drifting clock.
 */
let mockActive = true;
vi.mock("@/lib/dues/ledger/activation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/dues/ledger/activation")>();
  return { ...actual, inactiveLedgerActivation: { isActive: async () => mockActive } };
});

const { createMonthlyObligation } = await import("../../src/lib/dues/ledger/create-monthly-obligation");
const { recordDuesPayment } = await import("../../src/lib/dues/ledger/record-payment");
const { purchasePackage } = await import("../../src/lib/dues/ledger/purchase-package");
const { reversePayment } = await import("../../src/lib/dues/ledger/reverse-payment");
const { listDuesFactsForStudents } = await import("../../src/lib/dues/ledger/dues-facts");
const { getHeadlineTiles } = await import("../../src/lib/analytics/headline-tiles");
const { resolveAnalyticsFilters } = await import("../../src/lib/analytics/filters");

const prisma = getTestPrismaClient();

const NOW = new Date("2031-06-15T12:00:00-06:00"); // America/Costa_Rica -> 2031-06-15 -> target month {2031, 6}
const writerDeps = { now: () => NOW };

type Fixture = Awaited<ReturnType<typeof makeAccountingOrg>>;

function suffix() {
  return `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
}

function tenantContext(org: Fixture): TenantContext {
  return { kind: "tenant", actorUserId: org.admin.id, organizationId: org.org.id, organizationRole: "ADMIN", academyIds: "ALL", selfStudentId: null, linkedStudentId: null };
}

let studentCounter = 0;
async function newStudent(org: Fixture, academyId: string) {
  const n = ++studentCounter;
  const s = suffix();
  return prisma.student.create({
    data: {
      organizationId: org.org.id, homeAcademyId: academyId, firstName: "PayHealth", lastName: `S${n}-${s}`, phone: "00000000",
      email: `payhealth-${n}-${s}@example.com`, currentRankId: await org.rankId("WHITE"), codeHash: `payhealth-${n}-${s}`, status: "ACTIVE",
    },
  });
}

async function seedPlanAndPolicy(
  org: Fixture,
  academyId: string,
  currency: "USD" | "CRC",
  effectiveYear: number,
  effectiveMonth: number,
  maxPrepaidMonths?: number,
) {
  const s = suffix();
  const plan = await prisma.paymentPlan.create({ data: { organizationId: org.org.id, academyId, name: `PH plan ${s}` } });
  const terms = await prisma.paymentPlanTerms.create({
    data: { organizationId: org.org.id, planId: plan.id, effectiveYear, effectiveMonth, priceAmount: "100.00", currency, monthsCovered: 1, createdById: org.admin.id },
  });
  const policy = await prisma.duesPolicyVersion.create({
    data: { organizationId: org.org.id, academyId, effectiveYear, effectiveMonth, dueDay: 20, graceDay: 5, lateFeeAmount: "20.00", lateFeeCurrency: currency, maxPrepaidMonths, createdById: org.admin.id },
  });
  return { plan, terms, policy };
}

async function seedPackagePlan(
  org: Fixture,
  academyId: string,
  monthsCovered: number,
  currency: "USD" | "CRC",
  effectiveYear: number,
  effectiveMonth: number,
  priceAmount: string,
) {
  const s = suffix();
  const plan = await prisma.paymentPlan.create({ data: { organizationId: org.org.id, academyId, name: `PH package plan ${s}` } });
  const terms = await prisma.paymentPlanTerms.create({
    data: { organizationId: org.org.id, planId: plan.id, effectiveYear, effectiveMonth, priceAmount, currency, monthsCovered, createdById: org.admin.id },
  });
  return { plan, terms };
}

async function newMonthlyObligation(
  org: Fixture,
  studentId: string,
  terms: { id: string },
  policy: { id: string },
  coverage: { year: number; month: number },
  deps: LedgerDeps = writerDeps,
) {
  const r = await createMonthlyObligation({ context: tenantContext(org), studentId, coverage, planTermsId: terms.id, policyVersionId: policy.id }, deps);
  if (!r.ok) throw new Error(`fixture obligation failed: ${r.error}`);
  return r.obligationId;
}

async function newSignupObligation(
  org: Fixture,
  studentId: string,
  academyId: string,
  terms: { id: string },
  coverage: { year: number; month: number },
  currency: "USD" | "CRC" = "USD",
) {
  return prisma.duesObligation.create({
    data: {
      organizationId: org.org.id, studentId, academyId, origin: "STAFF", type: "SIGNUP",
      coverageYear: coverage.year, coverageMonth: coverage.month, monthsCovered: 1, amount: "50.00", currency,
      dueOn: new Date(`${coverage.year}-${String(coverage.month).padStart(2, "0")}-05`), graceDeadline: null, lateFeeAmount: null,
      planTermsId: terms.id, policyVersionId: null, createdById: org.admin.id,
    },
  });
}

async function settle(
  org: Fixture,
  studentId: string,
  obligationIds: string[],
  amount: string,
  currency: "USD" | "CRC",
  receivedOn: { year: number; month: number; day: number },
  deps: LedgerDeps = writerDeps,
) {
  const r = await recordDuesPayment(
    { context: tenantContext(org), studentId, receivedOn, tender: { currency, amount }, method: "EFECTIVO", obligationIds, maxBackdateDays: 60 },
    deps,
  );
  if (!r.ok) throw new Error(`fixture settle failed: ${r.error}`);
  return r;
}

async function purchaseSettledPackage(
  org: Fixture,
  studentId: string,
  planTermsId: string,
  startMonth: { year: number; month: number },
  priceAmount: string,
  currency: "USD" | "CRC",
  receivedOn: { year: number; month: number; day: number },
  deps: LedgerDeps = writerDeps,
) {
  const r = await purchasePackage(
    { context: tenantContext(org), studentId, planTermsId, requestedStartMonth: startMonth, receivedOn, tender: { currency, amount: priceAmount }, method: "EFECTIVO", maxBackdateDays: 60 },
    deps,
  );
  if (!r.ok) throw new Error(`fixture package purchase failed: ${r.error}`);
  return r;
}

/**
 * Direct fixture rows (no real writer) — `recordDuesPayment`'s own oldest-first ordering rule
 * (`resolveMonthlyDebtItemsInTx`'s `notOldestFirst` refusal) makes it IMPOSSIBLE to settle a current-month
 * obligation through the real writer while an older one stays open, so "a real settled current month coexisting
 * with real old unsettled debt" cannot be produced through `recordDuesPayment`/`purchasePackage` at all. This
 * isolates the READER's own rule (old debt never disqualifies) from the WRITER's own unrelated business rule
 * (settle oldest-first) by seeding the settlement directly, schema-shaped exactly like `recordDuesPaymentInTx`'s
 * own write (`writeSettlementInTx`) would produce for a single-item, no-fee settlement.
 */
async function directSettle(org: Fixture, studentId: string, academyId: string, obligationId: string, amount: string, currency: "USD" | "CRC", receivedOn: Date) {
  const payment = await prisma.duesPayment.create({
    data: { organizationId: org.org.id, studentId, academyId, receivedOn, tenderCurrency: currency, tenderAmount: amount, method: "EFECTIVO", recordedById: org.admin.id },
  });
  return prisma.duesSettlement.create({ data: { organizationId: org.org.id, studentId, paymentId: payment.id, obligationId } });
}

async function newPendingReceipt(org: Fixture, studentId: string, academyId: string, obligationIds: string[]) {
  const snapshot = { kind: "ORDINARY" as const, obligationIds };
  const parsed = awaitingRateReceiptSnapshotSchema.safeParse(snapshot);
  if (!parsed.success) throw new Error(`fixture: invalid ORDINARY snapshot: ${parsed.error.message}`);
  return prisma.awaitingRateReceipt.create({
    data: {
      organizationId: org.org.id, studentId, academyId, kind: "ORDINARY", status: "PENDING",
      receivedOn: new Date("2031-06-01"), tenderCurrency: "CRC", tenderAmount: "100.00", method: "EFECTIVO",
      capturedAt: new Date(), capturedById: org.admin.id, snapshot,
    },
  });
}

/** Direct fixture row (no real writer) — effective safely before any target month used in this file. */
async function assignPlan(org: Fixture, studentId: string, planId: string) {
  return prisma.studentPlanAssignment.create({ data: { organizationId: org.org.id, studentId, planId, effectiveYear: 2025, effectiveMonth: 1, createdById: org.admin.id } });
}

/** Direct fixture row (no real writer) — marks ACTIVE safely before any target month used in this file. */
async function markActiveSince(org: Fixture, studentId: string) {
  return prisma.studentStatusChange.create({ data: { organizationId: org.org.id, studentId, status: "ACTIVE", effectiveOn: new Date("2025-01-01"), sequence: 1, source: "EVENT", actorId: org.admin.id } });
}

async function dropDeps(org: Fixture) {
  await prisma.studentPlanAssignment.deleteMany({ where: { organizationId: org.org.id } });
  await prisma.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL session_replication_role = replica");
      for (const table of ["AwaitingRateReceipt", "DuesSettlement", "DuesPayment", "DuesLateFee", "DuesCoverage", "DuesObligation"]) {
        await tx.$executeRawUnsafe(`DELETE FROM "${table}" WHERE "organizationId" = $1`, org.org.id);
      }
    },
    { timeout: 60_000 },
  );
  await prisma.paymentPlanTerms.deleteMany({ where: { organizationId: org.org.id } });
  await prisma.duesPolicyVersion.deleteMany({ where: { organizationId: org.org.id } });
  await prisma.paymentPlan.deleteMany({ where: { organizationId: org.org.id } });
}

describe("getLedgerPaymentHealth (reader-level)", () => {
  beforeAll(() => {
    mockActive = true;
  });

  it("REQUIRED: a settled PACKAGE counts despite the student's periodic MONTHLY eligibility reporting MISSING_CONFIGURATION", async () => {
    const org = await makeAccountingOrg("CUMULATIVE", "ph-package-missing-config");
    try {
      const { terms: pkgTerms } = await seedPackagePlan(org, org.academy.id, 3, "USD", 2025, 1, "300.00");
      // maxPrepaidMonths required for validatePackageSpanInTx; independent of the MISSING_CONFIGURATION MONTHLY
      // eligibility outcome below, which is driven entirely by the package terms' own monthsCovered (!== 1).
      await prisma.duesPolicyVersion.create({
        data: { organizationId: org.org.id, academyId: org.academy.id, effectiveYear: 2025, effectiveMonth: 1, dueDay: 20, graceDay: 5, lateFeeAmount: "20.00", lateFeeCurrency: "USD", maxPrepaidMonths: 12, createdById: org.admin.id },
      });
      const student = await newStudent(org, org.academy.id);
      await markActiveSince(org, student.id);
      await assignPlan(org, student.id, pkgTerms.planId);

      // Prove the premise: this student's periodic MONTHLY eligibility is genuinely MISSING_CONFIGURATION (assigned
      // to a PACKAGE-shaped terms row, which can never back a MONTHLY — termsCandidate.monthsCovered !== 1) BEFORE
      // the package purchase, so the test exercises a real precondition, not an assumed one.
      const preCheck = await listDuesFactsForStudents(tenantContext(org), [student.id], { year: 2031, month: 6 }, writerDeps);
      if (!preCheck.ok) throw new Error("fixture: pre-check facts read failed");
      expect(preCheck.facts[0]?.eligibility.outcome).toBe("MISSING_CONFIGURATION");

      await purchaseSettledPackage(org, student.id, pkgTerms.id, { year: 2031, month: 6 }, "300.00", "USD", { year: 2031, month: 6, day: 15 });

      const result = await paymentHealthModule.getLedgerPaymentHealth(tenantContext(org), [student.id], NOW);
      expect(result).toMatchObject({ percent: 100, confirmedPaidCount: 1, successfullyCheckedCount: 1, unknownCount: 0 });
    } finally {
      await dropDeps(org);
      await org.drop();
    }
  });

  it("REQUIRED: unpaid coverage (an existing, unsettled MONTHLY for the current month) never counts", async () => {
    const org = await makeAccountingOrg("CUMULATIVE", "ph-unpaid-coverage");
    try {
      const { terms, policy } = await seedPlanAndPolicy(org, org.academy.id, "USD", 2025, 1);
      const student = await newStudent(org, org.academy.id);
      await newMonthlyObligation(org, student.id, terms, policy, { year: 2031, month: 6 });

      const result = await paymentHealthModule.getLedgerPaymentHealth(tenantContext(org), [student.id], NOW);
      expect(result).toMatchObject({ percent: 0, confirmedPaidCount: 0, successfullyCheckedCount: 1, unknownCount: 0 });
    } finally {
      await dropDeps(org);
      await org.drop();
    }
  });

  it("REQUIRED: a settled MONTHLY for an OLD month never counts toward the CURRENT month's numerator — coverage must match the target month, not merely exist and be settled", async () => {
    const org = await makeAccountingOrg("CUMULATIVE", "ph-old-month-settled-excluded");
    try {
      const { terms, policy } = await seedPlanAndPolicy(org, org.academy.id, "USD", 2025, 1);
      const student = await newStudent(org, org.academy.id);
      // Settled, but for January — not the June target month this `now` resolves to. No June obligation exists
      // at all for this student.
      const oldObligationId = await newMonthlyObligation(org, student.id, terms, policy, { year: 2031, month: 1 });
      // receivedOn is when the payment was RECEIVED (recent), independent of the obligation's own January
      // coverage month — kept within `maxBackdateDays` of `NOW` (June 15). By June, January's own grace
      // deadline has long passed, so the late fee (100.00 tuition + 20.00 fee = 120.00) is owed too.
      await settle(org, student.id, [oldObligationId], "120.00", "USD", { year: 2031, month: 6, day: 1 });

      const result = await paymentHealthModule.getLedgerPaymentHealth(tenantContext(org), [student.id], NOW);
      expect(result).toMatchObject({ percent: 0, confirmedPaidCount: 0, successfullyCheckedCount: 1, unknownCount: 0 });
    } finally {
      await dropDeps(org);
      await org.drop();
    }
  });

  it("REQUIRED: a settled current-month MONTHLY still counts even though the SAME student has real, unrelated, old unsettled debt", async () => {
    const org = await makeAccountingOrg("CUMULATIVE", "ph-current-plus-old-debt");
    try {
      const { terms, policy } = await seedPlanAndPolicy(org, org.academy.id, "USD", 2025, 1);
      const student = await newStudent(org, org.academy.id);
      // Old, unrelated, deliberately unsettled debt — must never disqualify the current month's own settlement.
      // `recordDuesPayment`'s own oldest-first rule makes this coexistence unreachable through the real writer
      // (see `directSettle`'s own doc comment), so the current month's settlement is seeded directly here.
      await newMonthlyObligation(org, student.id, terms, policy, { year: 2031, month: 1 });
      const currentObligationId = await newMonthlyObligation(org, student.id, terms, policy, { year: 2031, month: 6 });
      await directSettle(org, student.id, org.academy.id, currentObligationId, "100.00", "USD", new Date("2031-06-15"));

      const result = await paymentHealthModule.getLedgerPaymentHealth(tenantContext(org), [student.id], NOW);
      expect(result).toMatchObject({ percent: 100, confirmedPaidCount: 1, successfullyCheckedCount: 1, unknownCount: 0 });
    } finally {
      await dropDeps(org);
      await org.drop();
    }
  });

  it("REQUIRED: a fully settled SIGNUP never counts — SIGNUP claims zero coverage rows by shape, settlement notwithstanding", async () => {
    const org = await makeAccountingOrg("CUMULATIVE", "ph-signup-only");
    try {
      const { terms } = await seedPlanAndPolicy(org, org.academy.id, "USD", 2025, 1);
      const student = await newStudent(org, org.academy.id);
      const signupId = (await newSignupObligation(org, student.id, org.academy.id, terms, { year: 2031, month: 6 })).id;
      await settle(org, student.id, [signupId], "50.00", "USD", { year: 2031, month: 6, day: 15 });

      const coverageCount = await prisma.duesCoverage.count({ where: { organizationId: org.org.id, studentId: student.id } });
      expect(coverageCount).toBe(0); // the premise: SIGNUP really does claim nothing

      const result = await paymentHealthModule.getLedgerPaymentHealth(tenantContext(org), [student.id], NOW);
      expect(result).toMatchObject({ percent: 0, confirmedPaidCount: 0, successfullyCheckedCount: 1, unknownCount: 0 });
    } finally {
      await dropDeps(org);
      await org.drop();
    }
  });

  it("REQUIRED: an unassigned student with zero obligations is checked successfully but never counted", async () => {
    const org = await makeAccountingOrg("CUMULATIVE", "ph-unassigned");
    try {
      const student = await newStudent(org, org.academy.id);

      const result = await paymentHealthModule.getLedgerPaymentHealth(tenantContext(org), [student.id], NOW);
      expect(result).toMatchObject({ percent: 0, confirmedPaidCount: 0, successfullyCheckedCount: 1, unknownCount: 0 });
    } finally {
      await dropDeps(org);
      await org.drop();
    }
  });

  it("REQUIRED: a pending-conversion receipt on an unsettled current-month MONTHLY never counts toward the numerator", async () => {
    const org = await makeAccountingOrg("CUMULATIVE", "ph-pending-conversion");
    try {
      const { terms, policy } = await seedPlanAndPolicy(org, org.academy.id, "USD", 2025, 1);
      const student = await newStudent(org, org.academy.id);
      const obligationId = await newMonthlyObligation(org, student.id, terms, policy, { year: 2031, month: 6 });
      await newPendingReceipt(org, student.id, org.academy.id, [obligationId]);

      const result = await paymentHealthModule.getLedgerPaymentHealth(tenantContext(org), [student.id], NOW);
      expect(result).toMatchObject({ percent: 0, confirmedPaidCount: 0, successfullyCheckedCount: 1, unknownCount: 0 });
    } finally {
      await dropDeps(org);
      await org.drop();
    }
  });

  it("REQUIRED: a reversed settlement un-settles the obligation again — it stops counting after reversal", async () => {
    const org = await makeAccountingOrg("CUMULATIVE", "ph-reversed-settlement");
    try {
      const { terms, policy } = await seedPlanAndPolicy(org, org.academy.id, "USD", 2025, 1);
      const student = await newStudent(org, org.academy.id);
      const obligationId = await newMonthlyObligation(org, student.id, terms, policy, { year: 2031, month: 6 });
      const settled = await settle(org, student.id, [obligationId], "100.00", "USD", { year: 2031, month: 6, day: 15 });

      const before = await paymentHealthModule.getLedgerPaymentHealth(tenantContext(org), [student.id], NOW);
      expect(before).toMatchObject({ percent: 100, confirmedPaidCount: 1 });

      const reversed = await reversePayment({ context: tenantContext(org), paymentId: settled.paymentId, reversalReason: "test reversal" }, writerDeps);
      if (!reversed.ok) throw new Error(`fixture: reversal failed: ${reversed.error}`);

      const after = await paymentHealthModule.getLedgerPaymentHealth(tenantContext(org), [student.id], NOW);
      expect(after).toMatchObject({ percent: 0, confirmedPaidCount: 0, successfullyCheckedCount: 1, unknownCount: 0 });
    } finally {
      await dropDeps(org);
      await org.drop();
    }
  });

  it("REQUIRED: a settled multi-month PACKAGE counts its student exactly ONCE, even though it writes several DuesCoverage rows", async () => {
    const org = await makeAccountingOrg("CUMULATIVE", "ph-duplicate-prevention");
    try {
      const { terms: pkgTerms } = await seedPackagePlan(org, org.academy.id, 3, "USD", 2025, 1, "300.00");
      // maxPrepaidMonths required for validatePackageSpanInTx; a dedicated policy row, independent of any MONTHLY terms.
      await prisma.duesPolicyVersion.create({
        data: { organizationId: org.org.id, academyId: org.academy.id, effectiveYear: 2025, effectiveMonth: 1, dueDay: 20, graceDay: 5, lateFeeAmount: "20.00", lateFeeCurrency: "USD", maxPrepaidMonths: 12, createdById: org.admin.id },
      });
      const student = await newStudent(org, org.academy.id);
      await purchaseSettledPackage(org, student.id, pkgTerms.id, { year: 2031, month: 6 }, "300.00", "USD", { year: 2031, month: 6, day: 15 });

      const coverageCount = await prisma.duesCoverage.count({ where: { organizationId: org.org.id, studentId: student.id } });
      expect(coverageCount).toBe(3); // the premise: three real coverage rows (Jun/Jul/Aug), ONE obligation

      const result = await paymentHealthModule.getLedgerPaymentHealth(tenantContext(org), [student.id], NOW);
      expect(result).toMatchObject({ percent: 100, confirmedPaidCount: 1, successfullyCheckedCount: 1, unknownCount: 0 });
    } finally {
      await dropDeps(org);
      await org.drop();
    }
  });

  it("REQUIRED: two students in different branch timezones resolve to different target months from the SAME captured instant, each correctly", async () => {
    // A single instant that is late-June in Costa Rica (UTC-6) but already July across the date line in
    // Kiritimati (UTC+14) — proves `todayIn`'s per-student branch-local resolution, not one shared "today".
    const crossNow = new Date("2031-06-30T23:30:00-06:00");
    const crossWriterDeps = { now: () => crossNow };
    const org = await makeAccountingOrg("CUMULATIVE", "ph-cross-timezone");
    try {
      const academyB = await prisma.academy.create({
        data: { organizationId: org.org.id, name: "PH Kiritimati", slug: `ph-kiritimati-${suffix()}`, kioskTokenHash: `ph-kiritimati-hash-${suffix()}`, timezone: "Pacific/Kiritimati" },
      });
      const { terms: termsA, policy: policyA } = await seedPlanAndPolicy(org, org.academy.id, "USD", 2025, 1);
      const { terms: termsB, policy: policyB } = await seedPlanAndPolicy(org, academyB.id, "USD", 2025, 1);

      const studentA = await newStudent(org, org.academy.id);
      const obligationA = await newMonthlyObligation(org, studentA.id, termsA, policyA, { year: 2031, month: 6 }, crossWriterDeps);
      await settle(org, studentA.id, [obligationA], "100.00", "USD", { year: 2031, month: 6, day: 30 }, crossWriterDeps);

      const studentB = await newStudent(org, academyB.id);
      const obligationB = await newMonthlyObligation(org, studentB.id, termsB, policyB, { year: 2031, month: 7 }, crossWriterDeps);
      await settle(org, studentB.id, [obligationB], "100.00", "USD", { year: 2031, month: 7, day: 1 }, crossWriterDeps);

      const result = await paymentHealthModule.getLedgerPaymentHealth(tenantContext(org), [studentA.id, studentB.id], crossNow);
      expect(result).toMatchObject({ percent: 100, confirmedPaidCount: 2, successfullyCheckedCount: 2, unknownCount: 0 });
    } finally {
      await dropDeps(org);
      await org.drop();
    }
  });

  it("REQUIRED: an exact partial-failure count — a failed per-student read contributes to unknownCount only, never confirmedPaidCount, alongside a real successful one", async () => {
    const org = await makeAccountingOrg("CUMULATIVE", "ph-partial-failure");
    try {
      const { terms, policy } = await seedPlanAndPolicy(org, org.academy.id, "USD", 2025, 1);
      const confirmed = await newStudent(org, org.academy.id);
      const confirmedObligationId = await newMonthlyObligation(org, confirmed.id, terms, policy, { year: 2031, month: 6 });
      await settle(org, confirmed.id, [confirmedObligationId], "100.00", "USD", { year: 2031, month: 6, day: 15 });
      const failed = await newStudent(org, org.academy.id);
      await newMonthlyObligation(org, failed.id, terms, policy, { year: 2031, month: 6 }); // would also qualify if settled — left unsettled, irrelevant once its read fails

      const real = duesFactsModule.listDuesFactsForStudents;
      const spy = vi.spyOn(duesFactsModule, "listDuesFactsForStudents").mockImplementation(async (...args) => {
        const result = await real(...args);
        if (!result.ok) return result;
        return { ...result, facts: result.facts.filter((f) => f.studentId !== failed.id) };
      });
      let result: paymentHealthModule.PaymentHealthResult;
      try {
        result = await paymentHealthModule.getLedgerPaymentHealth(tenantContext(org), [confirmed.id, failed.id], NOW);
      } finally {
        spy.mockRestore();
      }

      expect(result).toMatchObject({ percent: null, confirmedPaidCount: 1, successfullyCheckedCount: 1, unknownCount: 1 });
    } finally {
      await dropDeps(org);
      await org.drop();
    }
  });

  it("REQUIRED: an empty population returns the withheld EMPTY_PAYMENT_HEALTH shape without touching the database", async () => {
    const result = await paymentHealthModule.getLedgerPaymentHealth(
      { kind: "tenant", actorUserId: "x", organizationId: "nonexistent-org", organizationRole: "ADMIN", academyIds: "ALL", selfStudentId: null, linkedStudentId: null },
      [],
      NOW,
    );
    expect(result).toEqual(paymentHealthModule.EMPTY_PAYMENT_HEALTH);
  });
});

describe("getHeadlineTiles: ledger-active payment health (consumer-level)", () => {
  let fixture: Fixture;
  let academyB: { id: string };
  let director: { id: string };
  let otherOrg: Fixture;

  beforeAll(async () => {
    mockActive = true;
    fixture = await makeAccountingOrg("CUMULATIVE", "ph-tiles-isolation");
    otherOrg = await makeAccountingOrg("CUMULATIVE", "ph-tiles-isolation-other");
    academyB = await prisma.academy.create({ data: { organizationId: fixture.org.id, name: "PH Tiles B", slug: `ph-tiles-b-${suffix()}`, kioskTokenHash: `ph-tiles-b-${suffix()}` } });
    const directorUser = await prisma.user.create({ data: { email: `ph-tiles-director-${suffix()}@example.com`, passwordHash: await hashSecret("irrelevant-password-123"), role: "DIRECTOR" } });
    await prisma.organizationMembership.create({ data: { userId: directorUser.id, organizationId: fixture.org.id, role: "DIRECTOR" } });
    await prisma.staffAssignment.create({ data: { userId: directorUser.id, organizationId: fixture.org.id, academyId: fixture.academy.id, role: "DIRECTOR" } });
    director = directorUser;
  }, 60_000);

  afterAll(async () => {
    mockActive = true;
    await prisma.staffAssignment.deleteMany({ where: { userId: director.id } });
    await prisma.organizationMembership.deleteMany({ where: { userId: director.id } });
    await prisma.user.deleteMany({ where: { id: director.id } });
    await dropDeps(fixture);
    await fixture.drop();
    await dropDeps(otherOrg);
    await otherOrg.drop();
  }, 120_000);

  function filtersFor(context: Parameters<typeof resolveAnalyticsFilters>[0], academyId: string | null) {
    return resolveAnalyticsFilters(context, { academy: academyId ?? "ambas" });
  }

  it("REQUIRED: a DIRECTOR scoped to academy A never sees academy B's (same-org) settled debtor, and an ADMIN sees both but never a genuinely foreign organization's", async () => {
    mockActive = true;
    const { year, month } = currentCrDateParts(); // real wall-clock current month — getHeadlineTiles's own ledgerNow is not injectable
    const { terms: termsA, policy: policyA } = await seedPlanAndPolicy(fixture, fixture.academy.id, "USD", 2025, 1);
    const { terms: termsB, policy: policyB } = await seedPlanAndPolicy(fixture, academyB.id, "USD", 2025, 1);
    const { terms: termsOther, policy: policyOther } = await seedPlanAndPolicy(otherOrg, otherOrg.academy.id, "USD", 2025, 1);
    const realNowDeps = {}; // real new Date() — matches getHeadlineTiles's own un-injectable ledgerNow

    const branchADebtor = await newStudent(fixture, fixture.academy.id);
    const obA = await newMonthlyObligation(fixture, branchADebtor.id, termsA, policyA, { year, month }, realNowDeps);
    await settle(fixture, branchADebtor.id, [obA], "100.00", "USD", { year, month, day: 1 }, realNowDeps);

    const branchBDebtor = await newStudent(fixture, academyB.id);
    const obB = await newMonthlyObligation(fixture, branchBDebtor.id, termsB, policyB, { year, month }, realNowDeps);
    await settle(fixture, branchBDebtor.id, [obB], "100.00", "USD", { year, month, day: 1 }, realNowDeps);

    const foreignOrgDebtor = await newStudent(otherOrg, otherOrg.academy.id);
    const obOther = await newMonthlyObligation(otherOrg, foreignOrgDebtor.id, termsOther, policyOther, { year, month }, realNowDeps);
    await settle(otherOrg, foreignOrgDebtor.id, [obOther], "100.00", "USD", { year, month, day: 1 }, realNowDeps);

    const directorContext: TenantContext = { kind: "tenant", actorUserId: director.id, organizationId: fixture.org.id, organizationRole: "DIRECTOR", academyIds: [fixture.academy.id], selfStudentId: null, linkedStudentId: null };
    const ownScope = await getHeadlineTiles(directorContext, filtersFor(directorContext, fixture.academy.id));
    expect(ownScope.paymentHealthConfirmedPaidCount).toBe(1);
    expect(ownScope.paymentHealthLedgerActive).toBe(true);

    const adminContext = tenantContext(fixture);
    const adminCombined = await getHeadlineTiles(adminContext, filtersFor(adminContext, null));
    expect(adminCombined.paymentHealthConfirmedPaidCount).toBe(2); // branchADebtor + branchBDebtor, never the foreign org's

    const otherAdminContext = tenantContext(otherOrg);
    const otherScope = await getHeadlineTiles(otherAdminContext, filtersFor(otherAdminContext, null));
    expect(otherScope.paymentHealthConfirmedPaidCount).toBe(1); // foreignOrgDebtor counts only within its own organization
  });

  it("REQUIRED: the active path never issues the legacy PaymentPeriod query, and the inactive path never calls the ledger reader", async () => {
    const context = tenantContext(fixture);
    const filters = filtersFor(context, fixture.academy.id);

    mockActive = true;
    const legacySpy = vi.spyOn(appPrisma.paymentPeriod, "findMany");
    try {
      await getHeadlineTiles(context, filters);
      expect(legacySpy).not.toHaveBeenCalled();
    } finally {
      legacySpy.mockRestore();
    }

    mockActive = false;
    const ledgerSpy = vi.spyOn(paymentHealthModule, "getLedgerPaymentHealth");
    try {
      await getHeadlineTiles(context, filters);
      expect(ledgerSpy).not.toHaveBeenCalled();
    } finally {
      ledgerSpy.mockRestore();
      mockActive = true;
    }
  });
});
