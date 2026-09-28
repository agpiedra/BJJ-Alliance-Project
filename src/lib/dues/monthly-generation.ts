import type { TenantContext } from "@/lib/tenant/types";
import type { YearMonth } from "@/lib/dues/calendar";
import { eligibleAndAssigned, type AssignmentRow, type StatusHistoryRow } from "@/lib/dues/eligibility";
import { createMonthlyObligationInTx, isValidCoverageMonth, type CreateMonthlyObligationError } from "@/lib/dues/ledger/create-monthly-obligation";
import { fromDbDate, inTenantScope, latestEffective, lockBranchShared, lockStudent } from "@/lib/dues/ledger/common";
import type { LedgerDeps } from "@/lib/dues/ledger/activation";
import { prisma } from "@/lib/prisma";

/**
 * Monthly-generation brief (§5, §8): the one function that connects `eligibleAndAssigned` (the pure reader) and
 * `createMonthlyObligationInTx` (the ledger's transaction-aware core) for one student, one branch, one coverage month.
 *
 * ONE transaction per student, in the ledger's existing lock order — branch FOR SHARE, then student FOR UPDATE — with the
 * status/assignment reads and the eligibility decision happening INSIDE that same held lock, before the terms/policy locks
 * `createMonthlyObligationInTx` takes. This is what closes both assignment races the brief describes: `assignPlan`
 * (`assignment-actions.ts`) now takes the same student lock before its own write, so whichever transaction — this one or a
 * concurrent `assignPlan` call — acquires the student lock first fully determines what the other sees. This function does
 * NOT retry, wait or loop if it finds no assignment: one read, one decision, reported honestly (brief §5.3 — the lock
 * guarantees a CONSISTENT answer, never that an obligation gets created regardless of ordering).
 *
 * Reports three distinct outcome categories (brief §2/§3), never one "skipped" bucket: `notEligible` (the pure function's
 * own three non-eligible outcomes — nothing to fix), `configurationGap` (eligible, but no effective priced terms/policy
 * for this month, or `createMonthlyObligationInTx` refused for a configuration reason — something to go fix),
 * `failure` (a real concurrency conflict or an unexpected error — investigate, never treat as a skip). `created` and
 * `alreadyCovered` are the two success shapes, matching `createMonthlyObligationInTx`'s own existing duplicate/
 * `coverageTaken` handling exactly (§4) — nothing new to guard there.
 *
 * No caller. Not a route, not a server action, no scheduler entry (`vercel.json`'s `crons` array is untouched, §7) — a
 * plain library function, tested by calling it directly, closed by the same `LedgerActivation` default (inactive)
 * `createMonthlyObligationInTx` itself checks.
 *
 * `month` is validated (`isValidCoverageMonth`) before anything else — before the student lookup, before any lock, before
 * eligibility or configuration is read — so a malformed month never reaches those, not even as a wasted query.
 */
export type MonthlyGenerationOutcome =
  | { category: "created"; obligationId: string }
  | { category: "alreadyCovered"; reason: "existingObligation" | "packageCoverage"; obligationId?: string }
  | { category: "notEligible"; reason: "UNDECIDABLE" | "NOT_ELIGIBLE" | "NO_ASSIGNMENT" }
  | { category: "configurationGap"; reason: "noEffectiveVersion" | CreateMonthlyObligationError }
  | { category: "failure"; reason: CreateMonthlyObligationError | "unexpected"; detail?: unknown };

export async function generateMonthlyObligationForStudent(
  context: TenantContext,
  studentId: string,
  month: YearMonth,
  deps: LedgerDeps = {},
): Promise<MonthlyGenerationOutcome> {
  if (!isValidCoverageMonth(month)) return { category: "failure", reason: "invalid" };
  const organizationId = context.organizationId;

  // Re-read the student scoped to the organization; a forged or foreign id is a failure, never trusted — the same
  // discipline createMonthlyObligation's own pre-transaction lookup already uses.
  const student = await prisma.student.findFirst({ where: { id: studentId, organizationId }, select: { id: true, homeAcademyId: true } });
  if (!student || !inTenantScope(context, student.homeAcademyId)) return { category: "failure", reason: "notFound" };

  try {
    return await prisma.$transaction(async (tx): Promise<MonthlyGenerationOutcome> => {
      // Same order createMonthlyObligationInTx uses: branch FOR SHARE, then student FOR UPDATE.
      const branch = await lockBranchShared(tx, organizationId, student.homeAcademyId);
      if (!branch) return { category: "failure", reason: "notFound" };
      const locked = await lockStudent(tx, organizationId, student.id);
      if (!locked || locked.homeAcademyId !== student.homeAcademyId) return { category: "failure", reason: "conflict" };

      // Status and assignment history, read fresh now that the student lock is held — this is what makes a concurrent
      // assignPlan call for this same student wait behind (or have already committed before) this read.
      const statusRows = await tx.studentStatusChange.findMany({
        where: { organizationId, studentId: student.id },
        select: { effectiveOn: true, sequence: true, status: true },
      });
      const statusHistory: StatusHistoryRow[] = statusRows.map((row) => ({ effectiveOn: fromDbDate(row.effectiveOn), sequence: row.sequence, status: row.status }));

      const assignmentRows = await tx.studentPlanAssignment.findMany({
        where: { organizationId, studentId: student.id },
        select: { effectiveYear: true, effectiveMonth: true, planId: true },
      });
      const planIds = [...new Set(assignmentRows.map((row) => row.planId).filter((id): id is string => id !== null))];
      const plans = planIds.length ? await tx.paymentPlan.findMany({ where: { organizationId, id: { in: planIds } }, select: { id: true, academyId: true } }) : [];
      const planAcademyById = new Map(plans.map((plan) => [plan.id, plan.academyId]));
      const assignments: AssignmentRow[] = assignmentRows.map((row) => ({
        effectiveYear: row.effectiveYear,
        effectiveMonth: row.effectiveMonth,
        planId: row.planId,
        planAcademyId: row.planId ? (planAcademyById.get(row.planId) ?? null) : null,
      }));

      const eligibility = eligibleAndAssigned(statusHistory, assignments, student.homeAcademyId, month);
      if (eligibility.outcome !== "ELIGIBLE") return { category: "notEligible", reason: eligibility.outcome };

      // Resolve a CANDIDATE effective terms/policy id — createMonthlyObligationInTx re-validates independently (brief §2);
      // this is only a plain "latest effective at or before target" query, not a guarantee.
      const termsCandidates = await tx.paymentPlanTerms.findMany({
        where: { organizationId, planId: eligibility.planId },
        select: { id: true, effectiveYear: true, effectiveMonth: true },
      });
      const policyCandidates = await tx.duesPolicyVersion.findMany({
        where: { organizationId, academyId: student.homeAcademyId },
        select: { id: true, effectiveYear: true, effectiveMonth: true },
      });
      const termsCandidate = latestEffective(termsCandidates, month);
      const policyCandidate = latestEffective(policyCandidates, month);
      if (!termsCandidate || !policyCandidate) return { category: "configurationGap", reason: "noEffectiveVersion" };

      const result = await createMonthlyObligationInTx(
        tx,
        { context, student, coverage: month, planTermsId: termsCandidate.id, policyVersionId: policyCandidate.id },
        deps,
      );

      if (result.ok) {
        return result.created
          ? { category: "created", obligationId: result.obligationId }
          : { category: "alreadyCovered", reason: "existingObligation", obligationId: result.obligationId };
      }
      if (result.error === "coverageTaken") return { category: "alreadyCovered", reason: "packageCoverage" };
      if (result.error === "conflict" || result.error === "notActive" || result.error === "invalid") return { category: "failure", reason: result.error };
      // staleVersion | inapplicable | notFound | currencyMismatch: our own candidate resolution was wrong, or a config row
      // disappeared mid-transaction — either way a configuration gap to go fix, never a failure to alarm on.
      return { category: "configurationGap", reason: result.error };
    });
  } catch (error) {
    return { category: "failure", reason: "unexpected", detail: error instanceof Error ? error.message : error };
  }
}
