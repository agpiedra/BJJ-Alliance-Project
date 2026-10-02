import { StudentStatus } from "@/generated/prisma/client";
import type { TenantContext } from "@/lib/tenant/types";
import { lockBranchShared, lockStudent, toDbDate, todayIn, type Tx } from "@/lib/dues/ledger/common";
import { inactiveLedgerActivation, type LedgerDeps } from "@/lib/dues/ledger/activation";
import { writeMonthlyObligationInTx, type CreateMonthlyObligationError } from "@/lib/dues/ledger/create-monthly-obligation";
import { checkMonthCoverageInTx, resolveMonthlyConfigCandidateInTx } from "@/lib/dues/ledger/monthly-config-resolution";
import { grantStudentMembership } from "@/lib/students/student-membership";
import { appendStatusChange } from "@/lib/students/status-history";
import { resolveTrustworthyArchiveEvent } from "@/lib/students/archive-event";

/**
 * Genuine-return-to-training brief, the gated financial core of `returnToTraining`
 * (`src/app/[locale]/(staff)/students/[id]/actions.ts`), composed with the default, production `deps` ({}) exactly
 * like `resumeChargeInTx`/`enrollmentChargeInTx`. UNLIKE those two, this action has no non-gated fallback behavior
 * at all: `returnToTraining` is a brand-new financial action with nothing useful to do while billing is inactive
 * (today, always) — its own caller renders no usable UI in that case (§7), and a direct invocation while inactive
 * simply refuses `notActive`.
 *
 * Archive-event binding (§4) is the core correctness mechanism this function owns: the caller embeds the student's
 * latest trustworthy (`EVENT`-sourced) `StudentStatusChange.id` as `archiveEventId` when the action is offered: this
 * function re-resolves that SAME trustworthy event, fresh, under the student lock, and refuses unless it still
 * matches. One check — current eligibility + current event id, both re-read fresh under the lock — catches both an
 * immediate retry and a delayed, cross-archive retry identically (§5): a committed earlier attempt means the
 * student is no longer ARCHIVED (`notEligible`) or a later archive-and-return cycle has produced a newer event
 * (`staleArchiveEvent`); a never-committed earlier attempt (a configuration-gap refusal, zero writes) leaves the
 * same event current, so a later retry naturally re-passes this check and executes with ITS OWN actual return
 * date/month, captured fresh under this same lock — never a stored, stale date, since none is ever accepted from
 * the caller to begin with.
 *
 * Status (`ARCHIVED → ACTIVE`, unconditionally — never the value `statusBeforeArchive` held, unlike `restoreStudent`
 * — a genuine return always means training again, regardless of whether they were paused or active before the
 * archive), membership, history and the return-month charge all commit in this one transaction, under the student
 * lock. No `SIGNUP` is ever created here — only `writeMonthlyObligationInTx` (MONTHLY only) is composed.
 */
export type GenuineReturnChargeError =
  | "notActive"
  | "notFound"
  | "conflict"
  | "notEligible"
  | "noTrustworthyArchiveEvent"
  | "staleArchiveEvent"
  | Exclude<CreateMonthlyObligationError, "notActive" | "invalid" | "futureMonth" | "conflict" | "coverageTaken">;

export type GenuineReturnChargeResult = { ok: true; obligationId: string | null } | { ok: false; error: GenuineReturnChargeError };

export async function genuineReturnChargeInTx(
  tx: Tx,
  args: { context: TenantContext; student: { id: string; homeAcademyId: string; userId: string | null }; archiveEventId: string },
  deps: LedgerDeps = {},
): Promise<GenuineReturnChargeResult> {
  const { context, student, archiveEventId } = args;
  const organizationId = context.organizationId;
  const activation = deps.activation ?? inactiveLedgerActivation;
  if (!(await activation.isActive(organizationId))) return { ok: false, error: "notActive" };

  // Lock order: branch FOR SHARE, then student FOR UPDATE — the ledger's own established sequence (common.ts).
  const branch = await lockBranchShared(tx, organizationId, student.homeAcademyId);
  if (!branch) return { ok: false, error: "notFound" };
  const locked = await lockStudent(tx, organizationId, student.id);
  if (!locked || locked.homeAcademyId !== student.homeAcademyId) return { ok: false, error: "conflict" };

  // The authoritative re-check (§4/§5): re-resolve eligibility (D20) AND the trustworthy archive event fresh, under
  // this same lock — the pre-lock caller's own read (and the archiveEventId it embedded in the form) could already
  // be stale, either because this attempt already committed once, or because a later archive-and-return cycle has
  // since produced its own, newer event.
  const eventCheck = await resolveTrustworthyArchiveEvent(tx, organizationId, student.id);
  if (!eventCheck.ok) return { ok: false, error: eventCheck.reason };
  if (eventCheck.archiveEventId !== archiveEventId) return { ok: false, error: "staleArchiveEvent" };
  if (deps.afterGenuineReturnLocksForTest) await deps.afterGenuineReturnLocksForTest();

  // ONE return instant, captured under lock, reused for both the obligation's dueOn floor and the status-history
  // effectiveOn below — never a second clock read, and never a caller-supplied date of any kind.
  const returnInstant = (deps.now ?? (() => new Date()))();
  const returnDate = todayIn(branch.timezone, returnInstant);
  const coverage = { year: returnDate.year, month: returnDate.month };

  const coverageCheck = await checkMonthCoverageInTx(tx, { organizationId, studentId: student.id, coverage });
  let chargedObligationId: string | null = coverageCheck.existingObligationId;

  if (!coverageCheck.covered) {
    const candidate = await resolveMonthlyConfigCandidateInTx(tx, { organizationId, studentId: student.id, homeAcademyId: student.homeAcademyId, coverage });
    // A genuine configuration gap: nothing has been written yet, so this refuses the WHOLE attempt (§5) — the SAME
    // event id stays current, so a later retry is a legitimate fresh attempt, not a stale one.
    if (!candidate.ok) return { ok: false, error: candidate.error };

    const written = await writeMonthlyObligationInTx(
      tx,
      { context, student, coverage, planTermsId: candidate.planTermsId, policyVersionId: candidate.policyVersionId, origin: "STAFF", minimumDueOn: returnDate },
      deps,
    );
    // written.error === "coverageTaken"/an existing-MONTHLY `created: false` are both unreachable here in practice
    // (this branch only runs once this function's own fresh coverage check above already found neither) — kept as a
    // defensive fallback, matching `resumeChargeInTx`'s own identical reasoning, never the primary mechanism.
    if (!written.ok && written.error !== "coverageTaken") {
      return { ok: false, error: written.error as GenuineReturnChargeError };
    }
    if (written.ok) chargedObligationId = written.obligationId;
  }
  if (deps.afterGenuineReturnObligationWrittenForTest) await deps.afterGenuineReturnObligationWrittenForTest();

  const result = await tx.student.updateMany({
    where: { id: student.id, organizationId, homeAcademyId: student.homeAcademyId, status: StudentStatus.ARCHIVED, statusBeforeArchive: { in: [StudentStatus.ACTIVE, StudentStatus.INACTIVE] } },
    data: { status: StudentStatus.ACTIVE, statusBeforeArchive: null },
  });
  if (result.count === 0) return { ok: false, error: "conflict" };

  const membership = await grantStudentMembership(tx, { userId: student.userId, organizationId });

  await appendStatusChange(tx, {
    organizationId,
    studentId: student.id,
    status: StudentStatus.ACTIVE,
    effectiveOn: toDbDate(returnDate),
    source: "EVENT",
    actorId: context.actorUserId,
  });

  await tx.auditLog.create({
    data: {
      actorId: context.actorUserId,
      organizationId,
      academyId: student.homeAcademyId,
      action: "student.returnToTraining",
      entityType: "Student",
      entityId: student.id,
      before: { status: StudentStatus.ARCHIVED, archiveEventId },
      after: { status: StudentStatus.ACTIVE, membership, chargedObligationId },
    },
  });

  return { ok: true, obligationId: chargedObligationId };
}
