import type { YearMonth } from "@/lib/dues/calendar";
import { latestEffective, lockAssignmentShared, type Tx } from "@/lib/dues/ledger/common";

/**
 * Genuine-return-to-training brief §2/§6: extracted from `resumeChargeInTx`'s own inline logic, reused by that
 * function AND the new genuine-return core specifically — `enrollmentChargeInTx` stays excluded (it needs the
 * resolved price/currency values firsthand, under its own lock, for decisions resume and return never make: is this
 * a package plan, does enrollment land before or after the due day). Traced through `writeMonthlyObligationInTx`:
 * there is no rigor gap in reusing a cheap, unlocked pre-check here, since that function performs the authoritative
 * lock-then-read-then-staleness check itself, unconditionally, for every caller.
 */

/** Whether `coverage` is already claimed for this student, by either an existing MONTHLY obligation or a bare
 * coverage row — the identical two-query shape `writeMonthlyObligationInTx` itself performs internally, so "already
 * covered" means exactly the same thing here as it does there. */
export async function checkMonthCoverageInTx(
  tx: Tx,
  args: { organizationId: string; studentId: string; coverage: YearMonth },
): Promise<{ covered: boolean; existingObligationId: string | null }> {
  const { organizationId, studentId, coverage } = args;
  const existingMonthly = await tx.duesObligation.findFirst({
    where: { organizationId, studentId, type: "MONTHLY", coverageYear: coverage.year, coverageMonth: coverage.month },
    select: { id: true },
  });
  const coverageTaken = existingMonthly ? null : await tx.duesCoverage.findFirst({ where: { organizationId, studentId, year: coverage.year, month: coverage.month }, select: { id: true } });
  return { covered: existingMonthly !== null || coverageTaken !== null, existingObligationId: existingMonthly?.id ?? null };
}

export type ConfigCandidateResult = { ok: true; planTermsId: string; policyVersionId: string } | { ok: false; error: "inapplicable" | "notFound" };

/** Resolves the effective assignment for `coverage` (locked via `lockAssignmentShared`, so a concurrent
 * `correctAssignment` for the same row cannot interleave), then candidate terms/policy ids via a plain
 * `latestEffective` lookup — never locked here, since `writeMonthlyObligationInTx` re-resolves, locks and validates
 * them from scratch; a stale candidate is caught there (`staleVersion`), exactly as it would be for any other
 * caller. A missing assignment, an explicitly unassigned one, or no effective terms/policy are all `inapplicable`
 * (a genuine configuration gap) — not `notFound` (which is reserved for the assignment row itself vanishing between
 * the unlocked read and the lock, a real but narrow race). */
export async function resolveMonthlyConfigCandidateInTx(
  tx: Tx,
  args: { organizationId: string; studentId: string; homeAcademyId: string; coverage: YearMonth },
): Promise<ConfigCandidateResult> {
  const { organizationId, studentId, homeAcademyId, coverage } = args;
  const assignments = await tx.studentPlanAssignment.findMany({
    where: { organizationId, studentId },
    select: { id: true, planId: true, effectiveYear: true, effectiveMonth: true },
  });
  const candidate = latestEffective(assignments, coverage);
  if (!candidate) return { ok: false, error: "inapplicable" };
  if (!(await lockAssignmentShared(tx, organizationId, candidate.id))) return { ok: false, error: "notFound" };
  const assignment = await tx.studentPlanAssignment.findUniqueOrThrow({ where: { id: candidate.id, organizationId } });
  if (assignment.planId === null) return { ok: false, error: "inapplicable" };

  const termsCandidates = await tx.paymentPlanTerms.findMany({ where: { organizationId, planId: assignment.planId }, select: { id: true, effectiveYear: true, effectiveMonth: true } });
  const termsCandidate = latestEffective(termsCandidates, coverage);
  const policyHistory = await tx.duesPolicyVersion.findMany({ where: { organizationId, academyId: homeAcademyId }, select: { id: true, effectiveYear: true, effectiveMonth: true } });
  const policyCandidate = latestEffective(policyHistory, coverage);
  if (!termsCandidate || !policyCandidate) return { ok: false, error: "inapplicable" };

  return { ok: true, planTermsId: termsCandidate.id, policyVersionId: policyCandidate.id };
}
