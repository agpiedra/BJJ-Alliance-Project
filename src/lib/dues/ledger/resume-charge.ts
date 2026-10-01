import { StudentStatus } from "@/generated/prisma/client";
import type { TenantContext } from "@/lib/tenant/types";
import { latestEffective, lockAssignmentShared, lockBranchShared, lockStudent, toDbDate, todayIn, type Tx } from "@/lib/dues/ledger/common";
import { inactiveLedgerActivation, type LedgerDeps } from "@/lib/dues/ledger/activation";
import { writeMonthlyObligationInTx, type CreateMonthlyObligationError } from "@/lib/dues/ledger/create-monthly-obligation";
import { appendStatusChange } from "@/lib/students/status-history";

/**
 * Enrollment/resume integration plan §2-§6: the gated financial half of `resumeStudent`
 * (`src/app/[locale]/(staff)/students/[id]/actions.ts`), extracted into this ledger-side,
 * `deps`-injectable core so `resumeStudent`'s own exported signature never needs an activation or
 * date override — the one testable composition boundary the plan requires. `resumeStudent` calls
 * this with the default production `deps` ({}); only a test ever injects `deps.activation`/`deps.now`
 * to exercise the branch below `notActive`. Caller-owned prerequisites: none — this function takes
 * its own locks and does its own activation check, exactly like every other outermost ledger entry
 * point in this codebase.
 *
 * On `{ ok: false, error: "notActive" }`, the caller must run its own unchanged, pre-existing
 * inactive-path code — this is not a user-facing error, it is the signal that billing is not active
 * for this organization at all. Every other `ok: false` is a genuine refusal of the resume attempt
 * itself: status, history and audit are NOT written by the caller in that case, and nothing in this
 * function writes anything before the configuration/coverage checks below all pass.
 */
export type ResumeChargeError = "notActive" | "conflict" | "notFound" | Exclude<CreateMonthlyObligationError, "notActive" | "invalid" | "futureMonth" | "conflict" | "coverageTaken">;

export type ResumeChargeResult = { ok: true } | { ok: false; error: ResumeChargeError };

export async function resumeChargeInTx(
  tx: Tx,
  args: { context: TenantContext; student: { id: string; homeAcademyId: string } },
  deps: LedgerDeps = {},
): Promise<ResumeChargeResult> {
  const { context, student } = args;
  const organizationId = context.organizationId;
  const activation = deps.activation ?? inactiveLedgerActivation;
  if (!(await activation.isActive(organizationId))) return { ok: false, error: "notActive" };

  // Lock order: branch FOR SHARE, then student FOR UPDATE — the ledger's own established sequence
  // (common.ts), reversing resumeStudent's own current student-only order on this path only.
  const branch = await lockBranchShared(tx, organizationId, student.homeAcademyId);
  if (!branch) return { ok: false, error: "notFound" };
  const locked = await lockStudent(tx, organizationId, student.id);
  if (!locked || locked.homeAcademyId !== student.homeAcademyId) return { ok: false, error: "conflict" };

  // Re-read fresh under the lock — the pre-lock caller's own read could already be stale.
  const fresh = await tx.student.findUniqueOrThrow({ where: { id: student.id, organizationId }, select: { status: true } });
  if (fresh.status !== StudentStatus.INACTIVE) return { ok: false, error: "conflict" };
  if (deps.afterResumeLocksForTest) await deps.afterResumeLocksForTest();

  // ONE resume instant, captured under lock, reused for both the obligation's dueOn floor and the
  // status-history effectiveOn below — never a second clock read on this path.
  const resumeInstant = (deps.now ?? (() => new Date()))();
  const resumeDate = todayIn(branch.timezone, resumeInstant);
  const coverage = { year: resumeDate.year, month: resumeDate.month };

  // Resolve the effective assignment, then terms and policy for this one month — the identical
  // resolution shape `prepayMonthlyObligations` already uses per requested month.
  const assignments = await tx.studentPlanAssignment.findMany({
    where: { organizationId, studentId: student.id },
    select: { id: true, planId: true, effectiveYear: true, effectiveMonth: true },
  });
  const candidate = latestEffective(assignments, coverage);
  if (!candidate) return { ok: false, error: "inapplicable" }; // no assignment at all for this month: config gap
  if (!(await lockAssignmentShared(tx, organizationId, candidate.id))) return { ok: false, error: "notFound" };
  const assignment = await tx.studentPlanAssignment.findUniqueOrThrow({ where: { id: candidate.id, organizationId } });
  if (assignment.planId === null) return { ok: false, error: "inapplicable" }; // explicitly unassigned: config gap

  const termsCandidates = await tx.paymentPlanTerms.findMany({ where: { organizationId, planId: assignment.planId }, select: { id: true, effectiveYear: true, effectiveMonth: true } });
  const termsCandidate = latestEffective(termsCandidates, coverage);
  const policyHistory = await tx.duesPolicyVersion.findMany({ where: { organizationId, academyId: student.homeAcademyId }, select: { id: true, effectiveYear: true, effectiveMonth: true } });
  const policyCandidate = latestEffective(policyHistory, coverage);
  if (!termsCandidate || !policyCandidate) return { ok: false, error: "inapplicable" }; // config gap

  const written = await writeMonthlyObligationInTx(
    tx,
    { context, student, coverage, planTermsId: termsCandidate.id, policyVersionId: policyCandidate.id, origin: "STAFF", minimumDueOn: resumeDate },
    deps,
  );
  // Approved outcome rule: an existing MONTHLY (created: false) or package coverage (coverageTaken)
  // both let resume proceed without a new charge — everything else is a genuine configuration gap
  // that refuses the WHOLE attempt. Nothing has been written yet at this point either way.
  if (!written.ok && written.error !== "coverageTaken") {
    return { ok: false, error: written.error as ResumeChargeError };
  }
  if (deps.afterResumeObligationWrittenForTest) await deps.afterResumeObligationWrittenForTest();

  const result = await tx.student.updateMany({
    where: { id: student.id, organizationId, homeAcademyId: student.homeAcademyId, status: StudentStatus.INACTIVE },
    data: { status: StudentStatus.ACTIVE },
  });
  if (result.count === 0) return { ok: false, error: "conflict" };

  await appendStatusChange(tx, {
    organizationId,
    studentId: student.id,
    status: StudentStatus.ACTIVE,
    effectiveOn: toDbDate(resumeDate),
    source: "EVENT",
    actorId: context.actorUserId,
  });

  await tx.auditLog.create({
    data: {
      actorId: context.actorUserId,
      organizationId,
      academyId: student.homeAcademyId,
      action: "student.resume",
      entityType: "Student",
      entityId: student.id,
      before: { status: StudentStatus.INACTIVE },
      after: { status: StudentStatus.ACTIVE, chargedObligationId: written.ok ? written.obligationId : null },
    },
  });

  return { ok: true };
}
