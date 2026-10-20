import type { Tx } from "@/lib/students/lock";

/**
 * Everything the stage-8 readiness report reads, as plain data (amounts as canonical `toFixed(2)` strings, dates as
 * `YYYY-MM-DD`), so the pure evaluation and fingerprint code never touches Prisma types or the database.
 */
export interface ReadinessSnapshot {
  organization: { id: string; currency: string };
  branches: { id: string; timezone: string }[];
  plans: { id: string; academyId: string; name: string; active: boolean }[];
  terms: { id: string; planId: string; effectiveYear: number; effectiveMonth: number; priceAmount: string; currency: string; monthsCovered: number }[];
  policies: {
    id: string;
    academyId: string;
    effectiveYear: number;
    effectiveMonth: number;
    dueDay: number;
    graceDay: number;
    lateFeeAmount: string;
    lateFeeCurrency: string;
    maxPrepaidMonths: number | null;
  }[];
  students: { id: string; homeAcademyId: string; status: string }[];
  statusChanges: { id: string; studentId: string; status: string; effectiveOn: string; sequence: number; source: string }[];
  assignments: { id: string; studentId: string; planId: string | null; effectiveYear: number; effectiveMonth: number }[];
  legacyPayments: {
    id: string;
    studentId: string;
    year: number;
    month: number;
    status: string;
    amount: string | null;
    currency: string;
    planId: string;
    promoName: string | null;
    promoRecurring: boolean;
  }[];
  monthlyObligations: { id: string; studentId: string; coverageYear: number; coverageMonth: number }[];
  coverage: { id: string; studentId: string; year: number; month: number }[];
  /** Stage 8b: ACTIVE opening-debt drafts (never withdrawn) — the only drafts whose content exists outside the loader. */
  openingItems: {
    id: string;
    studentId: string;
    coverageYear: number;
    coverageMonth: number;
    amount: string;
    currency: string;
    note: string;
    legacyPaymentPeriodId: string | null;
  }[];
  /** Stage 8b: every withdrawn draft (EDITED or WITHDRAWN), identity and marker only. Its amount, currency and note never leave
   * the loader, so nothing can count or hash them; the row's permanent presence is what stops a stale confirmation reviving
   * after an add-and-withdraw (plan §5). */
  withdrawnOpeningItems: { id: string; studentId: string; withdrawalKind: string; supersededById: string | null }[];
}

const isoDate = (d: Date) => d.toISOString().slice(0, 10);

/**
 * Plain reads — no `FOR SHARE`/`FOR UPDATE` (a read-only transaction refuses them, and nothing here may block a writer).
 * Every query is filtered by `organizationId` explicitly. Meant to run inside `runReadOnlySnapshot`, so all of them see one
 * snapshot.
 *
 * `afterFirstRead` is a TEST-ONLY pause point (the same convention as `LedgerDeps.beforeLateFeeInsert`): production never
 * passes it. It lets a test commit a concurrent change between two reads and prove the later reads still see the snapshot.
 */
export async function loadReadinessSnapshot(
  tx: Tx,
  organizationId: string,
  testHooks: { afterFirstRead?: () => Promise<void> } = {},
): Promise<ReadinessSnapshot> {
  const organization = await tx.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { id: true, currency: true } });
  if (testHooks.afterFirstRead) await testHooks.afterFirstRead();

  const where = { organizationId };
  const branches = await tx.academy.findMany({ where, select: { id: true, timezone: true } });
  const plans = await tx.paymentPlan.findMany({ where, select: { id: true, academyId: true, name: true, active: true } });
  const terms = await tx.paymentPlanTerms.findMany({
    where,
    select: { id: true, planId: true, effectiveYear: true, effectiveMonth: true, priceAmount: true, currency: true, monthsCovered: true },
  });
  const policies = await tx.duesPolicyVersion.findMany({
    where,
    select: { id: true, academyId: true, effectiveYear: true, effectiveMonth: true, dueDay: true, graceDay: true, lateFeeAmount: true, lateFeeCurrency: true, maxPrepaidMonths: true },
  });
  const students = await tx.student.findMany({ where, select: { id: true, homeAcademyId: true, status: true } });
  const statusChanges = await tx.studentStatusChange.findMany({ where, select: { id: true, studentId: true, status: true, effectiveOn: true, sequence: true, source: true } });
  const assignments = await tx.studentPlanAssignment.findMany({ where, select: { id: true, studentId: true, planId: true, effectiveYear: true, effectiveMonth: true } });
  const legacyPayments = await tx.paymentPeriod.findMany({
    where,
    select: { id: true, studentId: true, year: true, month: true, status: true, amount: true, currency: true, planId: true, promoName: true, promoRecurring: true },
  });
  const monthlyObligations = await tx.duesObligation.findMany({
    where: { organizationId, type: "MONTHLY" },
    select: { id: true, studentId: true, coverageYear: true, coverageMonth: true },
  });
  const coverage = await tx.duesCoverage.findMany({ where, select: { id: true, studentId: true, year: true, month: true } });
  // ALL drafts, active and withdrawn (rows are never deleted), in one read of the same snapshot.
  const drafts = await tx.duesOpeningItem.findMany({
    where,
    select: {
      id: true, studentId: true, coverageYear: true, coverageMonth: true, amount: true, currency: true, note: true, legacyPaymentPeriodId: true,
      withdrawnAt: true, withdrawalKind: true, supersededById: true,
    },
  });

  return {
    organization: { id: organization.id, currency: organization.currency },
    branches,
    plans,
    terms: terms.map((t) => ({ ...t, priceAmount: t.priceAmount.toFixed(2) })),
    policies: policies.map((p) => ({ ...p, lateFeeAmount: p.lateFeeAmount.toFixed(2) })),
    students,
    statusChanges: statusChanges.map((s) => ({ ...s, effectiveOn: isoDate(s.effectiveOn) })),
    assignments,
    legacyPayments: legacyPayments.map((p) => ({ ...p, amount: p.amount === null ? null : p.amount.toFixed(2) })),
    monthlyObligations,
    coverage,
    openingItems: drafts
      .filter((d) => d.withdrawnAt === null)
      .map(({ id, studentId, coverageYear, coverageMonth, amount, currency, note, legacyPaymentPeriodId }) => ({
        id, studentId, coverageYear, coverageMonth, amount: amount.toFixed(2), currency, note, legacyPaymentPeriodId,
      })),
    withdrawnOpeningItems: drafts
      .filter((d) => d.withdrawnAt !== null)
      .map(({ id, studentId, withdrawalKind, supersededById }) => ({ id, studentId, withdrawalKind: withdrawalKind!, supersededById })),
  };
}
