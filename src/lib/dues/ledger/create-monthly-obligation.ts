import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import type { TenantContext } from "@/lib/tenant/types";
import { compareYearMonth, dueDateFor, graceDeadlineFor, type YearMonth } from "@/lib/dues/calendar";
import { currentMonthIn } from "@/lib/dues/config-input";
import { inactiveLedgerActivation, type LedgerDeps } from "@/lib/dues/ledger/activation";
import { inTenantScope, latestEffective, lockBranchShared, lockPolicyShared, lockStudent, lockTermsShared, toDbDate } from "@/lib/dues/ledger/common";

/**
 * Create ONE monthly obligation and its coverage row, atomically (ledger writer 1 of 2, PR 4a).
 *
 * A plain library function: no server action, route, job or caller, and closed by default (see `activation.ts`). It decides nothing about
 * WHO is billed or WHEN: eligibility, status history, assignments and the monthly job are separate work. The caller supplies the student,
 * the month and the two configuration versions; this function proves the versions are the right ones and snapshots them.
 *
 * One transaction, in the ledger's global lock order (see `common.ts`): branch FOR SHARE, student FOR UPDATE, then the terms and policy
 * rows FOR SHARE, and only after those locks are their values read. A refusal returns before anything is written; a failure after the
 * first insert rolls back the obligation, the coverage row and the audit row together.
 *
 * Not in scope, on purpose: future months (prepayment, D24), packages, signup, opening balances, job origin, status eligibility.
 */
export type CreateMonthlyObligationError =
  | "notActive"
  | "invalid"
  | "notFound"
  | "futureMonth"
  | "staleVersion"
  | "inapplicable"
  | "currencyMismatch"
  | "coverageTaken"
  | "conflict";

export type CreateMonthlyObligationResult = { ok: true; created: boolean; obligationId: string } | { ok: false; error: CreateMonthlyObligationError };

const refuse = (error: CreateMonthlyObligationError): CreateMonthlyObligationResult => ({ ok: false, error });

export async function createMonthlyObligation(
  args: { context: TenantContext; studentId: string; coverage: YearMonth; planTermsId: string; policyVersionId: string },
  deps: LedgerDeps = {},
): Promise<CreateMonthlyObligationResult> {
  const { context, studentId, coverage, planTermsId, policyVersionId } = args;
  const organizationId = context.organizationId;
  const activation = deps.activation ?? inactiveLedgerActivation;
  if (!(await activation.isActive(organizationId))) return refuse("notActive");

  if (![coverage.year, coverage.month].every(Number.isInteger) || coverage.year < 2000 || coverage.year > 2100 || coverage.month < 1 || coverage.month > 12) {
    return refuse("invalid");
  }
  if (typeof studentId !== "string" || typeof planTermsId !== "string" || typeof policyVersionId !== "string") return refuse("invalid");

  // Re-read the student scoped to the organization; a forged or foreign id is `notFound`, never trusted.
  const student = await prisma.student.findFirst({ where: { id: studentId, organizationId }, select: { id: true, homeAcademyId: true } });
  if (!student || !inTenantScope(context, student.homeAcademyId)) return refuse("notFound");

  return prisma.$transaction(async (tx): Promise<CreateMonthlyObligationResult> => {
    // 1. branch FOR SHARE (waits for an in-flight configuration save), 2. student FOR UPDATE
    const branch = await lockBranchShared(tx, organizationId, student.homeAcademyId);
    if (!branch) return refuse("notFound");
    const locked = await lockStudent(tx, organizationId, student.id);
    if (!locked || locked.homeAcademyId !== student.homeAcademyId) return refuse("conflict"); // moved branches while we waited: retry

    const now = (deps.now ?? (() => new Date()))();
    if (compareYearMonth(coverage, currentMonthIn(branch.timezone, now)) > 0) return refuse("futureMonth");

    // A duplicate returns the existing obligation and changes nothing: no snapshot edit, no coverage row, no audit row.
    const existing = await tx.duesObligation.findFirst({
      where: { organizationId, studentId: student.id, type: "MONTHLY", coverageYear: coverage.year, coverageMonth: coverage.month },
      select: { id: true },
    });
    if (existing) return { ok: true, created: false, obligationId: existing.id };
    const taken = await tx.duesCoverage.findFirst({ where: { organizationId, studentId: student.id, year: coverage.year, month: coverage.month }, select: { id: true } });
    if (taken) return refuse("coverageTaken");

    // The named versions must exist in THIS organization (a foreign or unknown id is notFound), then be locked BEFORE any value is read.
    const termsRef = await tx.paymentPlanTerms.findFirst({ where: { id: planTermsId, organizationId }, select: { id: true, planId: true } });
    const policyRef = await tx.duesPolicyVersion.findFirst({ where: { id: policyVersionId, organizationId }, select: { id: true, academyId: true } });
    if (!termsRef || !policyRef) return refuse("notFound");
    // 3. terms, then policy, FOR SHARE (a fixed order)
    if (!(await lockTermsShared(tx, organizationId, termsRef.id)) || !(await lockPolicyShared(tx, organizationId, policyRef.id))) return refuse("notFound");

    // Values are read only now, from the locked rows.
    const terms = await tx.paymentPlanTerms.findFirstOrThrow({ where: { id: termsRef.id, organizationId } });
    const policy = await tx.duesPolicyVersion.findFirstOrThrow({ where: { id: policyRef.id, organizationId } });

    // The named versions must be the ones EFFECTIVE for the coverage month: a later, superseded or not-yet-effective id is stale.
    const termsHistory = await tx.paymentPlanTerms.findMany({ where: { organizationId, planId: terms.planId }, select: { id: true, effectiveYear: true, effectiveMonth: true } });
    const policyHistory = await tx.duesPolicyVersion.findMany({ where: { organizationId, academyId: policy.academyId }, select: { id: true, effectiveYear: true, effectiveMonth: true } });
    if (latestEffective(termsHistory, coverage)?.id !== terms.id || latestEffective(policyHistory, coverage)?.id !== policy.id) return refuse("staleVersion");

    // They must apply to this student: the plan and the policy belong to the student's branch, and the terms cover exactly one month.
    const plan = await tx.paymentPlan.findFirst({ where: { id: terms.planId, organizationId }, select: { academyId: true } });
    if (!plan || plan.academyId !== student.homeAcademyId || policy.academyId !== student.homeAcademyId || terms.monthsCovered !== 1) return refuse("inapplicable");
    if (terms.currency !== policy.lateFeeCurrency) return refuse("currencyMismatch");

    const due = dueDateFor(coverage, policy.dueDay);
    const grace = graceDeadlineFor(coverage, policy.graceDay);
    const amount = terms.priceAmount.toFixed(2);
    const lateFeeAmount = policy.lateFeeAmount.toFixed(2);

    const obligation = await tx.duesObligation.create({
      data: {
        organizationId,
        studentId: student.id,
        academyId: student.homeAcademyId,
        type: "MONTHLY",
        origin: "STAFF",
        coverageYear: coverage.year,
        coverageMonth: coverage.month,
        monthsCovered: 1,
        amount,
        currency: terms.currency,
        lateFeeAmount,
        dueOn: toDbDate(due),
        graceDeadline: toDbDate(grace),
        planTermsId: terms.id,
        policyVersionId: policy.id,
        createdById: context.actorUserId,
      },
    });
    await tx.duesCoverage.create({ data: { organizationId, studentId: student.id, obligationId: obligation.id, year: coverage.year, month: coverage.month } });
    await tx.auditLog.create({
      data: {
        actorId: context.actorUserId,
        organizationId,
        academyId: student.homeAcademyId,
        action: "duesObligation.create",
        entityType: "DuesObligation",
        entityId: obligation.id,
        before: Prisma.DbNull,
        // strings, so the exact amounts survive JSON
        after: {
          studentId: student.id, type: "MONTHLY", origin: "STAFF", coverage: `${coverage.year}-${String(coverage.month).padStart(2, "0")}`, amount, currency: terms.currency,
          lateFeeAmount, dueOn: `${due.year}-${String(due.month).padStart(2, "0")}-${String(due.day).padStart(2, "0")}`,
          graceDeadline: `${grace.year}-${String(grace.month).padStart(2, "0")}-${String(grace.day).padStart(2, "0")}`, planTermsId: terms.id, policyVersionId: policy.id,
        },
      },
    });
    return { ok: true, created: true, obligationId: obligation.id };
  });
}
