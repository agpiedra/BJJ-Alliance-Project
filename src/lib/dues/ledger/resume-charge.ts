import { StudentStatus } from "@/generated/prisma/client";
import type { TenantContext } from "@/lib/tenant/types";
import { lockBranchShared, lockStudent, toDbDate, todayIn, type Tx } from "@/lib/dues/ledger/common";
import { inactiveLedgerActivation, type LedgerDeps } from "@/lib/dues/ledger/activation";
import { writeMonthlyObligationInTx, type CreateMonthlyObligationError } from "@/lib/dues/ledger/create-monthly-obligation";
import { checkMonthCoverageInTx, resolveMonthlyConfigCandidateInTx } from "@/lib/dues/ledger/monthly-config-resolution";
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
 * itself: status, history and audit are not left in place by this function in that case. For a
 * configuration-gap refusal (returned before any write below — see the coverage-then-configuration
 * ordering further down) that is because nothing was written at all. But a lost-race `"conflict"`
 * refusal from the final `student.updateMany` CAN occur after `writeMonthlyObligationInTx` already
 * performed a real write (a new obligation, or coverage row) earlier in this same call — this
 * function does not undo that write itself. Full rollback in that case depends entirely on the
 * caller (`resumeStudent`) treating this refusal as a thrown error inside its own `$transaction`.
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

  // CORRECTED (second review round): existing coverage must be checked BEFORE resolving assignment/terms/policy for
  // a HYPOTHETICAL new charge. The original order resolved assignment first, wrongly refusing `inapplicable` for a
  // student whose resume month was already covered but who happens to have no assignment for a charge that was
  // never going to be needed. `checkMonthCoverageInTx` reuses the IDENTICAL queries `writeMonthlyObligationInTx`
  // itself performs internally (`create-monthly-obligation.ts`) — not a second, drifting copy of this check — so
  // "already covered" means exactly the same thing here as it does there.
  const coverageCheck = await checkMonthCoverageInTx(tx, { organizationId, studentId: student.id, coverage });
  let chargedObligationId: string | null = coverageCheck.existingObligationId;

  if (!coverageCheck.covered) {
    // Genuinely uncovered: ONLY NOW does a hypothetical new charge's own configuration need to resolve — the
    // identical resolution shape `prepayMonthlyObligations` already uses per requested month, extracted
    // (genuine-return-to-training brief §6) so the genuine-return core can reuse it the identical way.
    const candidate = await resolveMonthlyConfigCandidateInTx(tx, { organizationId, studentId: student.id, homeAcademyId: student.homeAcademyId, coverage });
    if (!candidate.ok) return { ok: false, error: candidate.error };

    const written = await writeMonthlyObligationInTx(
      tx,
      { context, student, coverage, planTermsId: candidate.planTermsId, policyVersionId: candidate.policyVersionId, origin: "STAFF", minimumDueOn: resumeDate },
      deps,
    );
    // written.error === "coverageTaken"/an existing-MONTHLY `created: false` are both unreachable here in practice
    // (this branch only runs once this function's own fresh coverage check above already found neither) — kept as a
    // defensive fallback, never the primary mechanism, in case of a genuine race with a concurrent writer under the
    // same locks (the student lock already serializes against another resume; a concurrent DIFFERENT writer taking
    // the identical lock order could still interleave here in principle). Any other refusal here is a genuine
    // configuration gap — reached only when this function has not yet written anything — that refuses the WHOLE
    // attempt, matching §5's approved rule.
    if (!written.ok && written.error !== "coverageTaken") {
      return { ok: false, error: written.error as ResumeChargeError };
    }
    if (written.ok) chargedObligationId = written.obligationId;
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
      after: { status: StudentStatus.ACTIVE, chargedObligationId },
    },
  });

  return { ok: true };
}
