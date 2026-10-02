"use server";

import { revalidatePath } from "next/cache";
import { getLocale } from "next-intl/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { generateStudentCode } from "@/lib/students/generate-code";
import { grantStudentMembership, revokeStudentMembership } from "@/lib/students/student-membership";
import { isAcademyInTenantScope, resolveActionContext } from "@/lib/tenant/context";
import { getScopedDb } from "@/lib/tenant/scoped-client";
import { Prisma, StudentStatus } from "@/generated/prisma/client";
import type { ActionState } from "@/lib/action-state";
import { lockStudent } from "@/lib/students/lock";
import { appendStatusChange, todayInAsDbDate } from "@/lib/students/status-history";
import { resumeChargeInTx } from "@/lib/dues/ledger/resume-charge";
import { genuineReturnChargeInTx } from "@/lib/dues/ledger/genuine-return-charge";
import { resolvePlanId } from "@/lib/dues/assignment-core";
import { EnrollmentRefusedError } from "@/lib/dues/enrollment-refused-error";
import { StudentWriteMissError, approveStudentInTx } from "./approve-student-core";

/**
 * `currentBelt` / `currentStripes` are deliberately ABSENT from this schema
 * and from the update payload below. A belt or stripe change is not a plain
 * field edit: Phase 4's promotion flow owns it, and must write a `Promotion`
 * row and reset `beltAwardedAt` in the same breath. Letting this form set
 * them silently would leave the student's belt disagreeing with their
 * promotion history and with the attendance-since-last-promotion counter
 * Phase 3 derives from `beltAwardedAt` — a corrupted data model with no
 * audit trail explaining it. The detail page renders them read-only.
 */
const updateStudentSchema = z
  .object({
    studentId: z.string().min(1),
    firstName: z.string().min(1),
    lastName: z.string().min(1),
    phone: z.string().min(1),
    email: z.string().email(),
    dateOfBirth: z.string().optional(),
    guardianName: z.string().optional(),
    guardianPhone: z.string().optional(),
    emergencyContact: z.string().optional(),
    notes: z.string().optional(),
  })
  .refine(
    (data) => {
      if (!data.dateOfBirth) return true;
      const age = (Date.now() - new Date(data.dateOfBirth).getTime()) / (365.25 * 24 * 60 * 60 * 1000);
      if (age < 18) return !!data.guardianName && !!data.guardianPhone;
      return true;
    },
    { message: "guardianRequiredForMinor", path: ["guardianName"] },
  );

/**
 * A server action does not re-render the page it was called from unless it says that page is
 * stale. Approve, archive, restore and edit change the student's status or details, which the
 * detail page shows (the badge, and which of Approve / Archive / Restore is offered) and the
 * roster lists — so without this "Student approved." appeared next to a badge that still read
 * Pending, with the Approve button still there to be clicked a second time.
 *
 * Best-effort, never the reason a committed change reports failure: `revalidatePath` needs
 * Next's request-scoped store, which does not exist when an action is called directly (the
 * integration tests do), and the change has already been committed by now.
 */
async function refreshStudentPages(studentId: string): Promise<void> {
  try {
    const locale = await getLocale();
    revalidatePath(`/${locale}/students/${studentId}`);
    revalidatePath(`/${locale}/students`);
  } catch (error) {
    console.error("[students] failed to revalidate the student pages", { studentId, error });
  }
}

/** `Date | null` -> a JSON-safe value for an `AuditLog.before`/`after` snapshot. */
function isoOrNull(date: Date | null | undefined): string | null {
  return date ? date.toISOString() : null;
}

/**
 * Thrown inside a transaction purely to roll it back when the scoped
 * `updateMany` matched no row (the row moved academy, or was deleted,
 * between the scope check and the write). Never surfaces to the caller —
 * each action catches it and returns the same `notFound` the pre-audit
 * code did.
 *
 * Now defined in `./approve-student-core` (a plain, non-"use server" module) and imported here, so
 * `approveStudentInTx`'s own `instanceof` checks against it share the same class identity across the module
 * boundary — see that file's own doc comment for why it could not stay declared in both places.
 */

/** Tags a genuine refusal from `resumeChargeInTx`'s gated path (a configuration gap, or a lost race) so it can be
 * thrown — forcing this transaction to roll back. A configuration-gap refusal has written nothing to roll back; a
 * lost-race `"conflict"` refusal can follow a real write `resumeChargeInTx` already made earlier in the same call
 * (see that function's own doc comment) — rollback of that write depends entirely on this throw, not on
 * `resumeChargeInTx` itself having written nothing. Converted back to a specific `ActionState` error afterward. */
class ResumeChargeRefusedError extends Error {
  constructor(public readonly reason: string) {
    super(`resume charge refused: ${reason}`);
    this.name = "ResumeChargeRefusedError";
  }
}

/** Mirrors `ResumeChargeRefusedError` for `returnToTraining`/`genuineReturnChargeInTx`. UNLIKE resume, this action
 * has no non-gated fallback path at all — every refusal `genuineReturnChargeInTx` can return, including `notActive`,
 * forces this same rollback-by-throw (nothing it can return has already been safely handled another way). */
class GenuineReturnChargeRefusedError extends Error {
  constructor(public readonly reason: string) {
    super(`genuine return charge refused: ${reason}`);
    this.name = "GenuineReturnChargeRefusedError";
  }
}

/**
 * ADMIN/DIRECTOR only (spec-adjacent to Task 7's createStudent gate).
 * `homeAcademyId` and `status` are deliberately not editable here — academy
 * transfer isn't a feature this task builds, and archiving/approving have
 * their own dedicated actions below. Belt/stripes are Phase 4's (see the
 * schema comment above).
 *
 * Every write in this file independently re-fetches the target row and
 * re-checks `isAcademyInTenantScope` against its *real*, freshly-read
 * `homeAcademyId` — never a hidden form field, and never the session's
 * cached scope alone (a DIRECTOR's assignments can't change mid-request, but
 * the row's academy is the thing that actually determines ownership). The
 * update itself is scoped by `id` *and* `homeAcademyId` in the same
 * `updateMany` call, with the affected row count checked, rather than
 * trusting `error === null` — so a race where the row's academy changed
 * between the check and the write still can't silently succeed out of
 * scope.
 *
 * The `AuditLog` row is written inside the SAME interactive transaction as
 * the mutation, so an audit row can never exist without its mutation nor a
 * mutation without its audit row. The row-count check lives inside the
 * transaction too and rolls it back by throwing, rather than committing an
 * audit row for a write that affected nothing.
 */
export async function updateStudent(
  organizationId: string,
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const auth = await resolveActionContext(organizationId, ["ADMIN", "DIRECTOR"]);
  if (!auth.ok) return { error: "notFound" };
  const context = auth.context;

  const raw = Object.fromEntries(formData.entries());
  const parsed = updateStudentSchema.safeParse(raw);

  if (!parsed.success) {
    return { error: "invalid", fieldErrors: parsed.error.flatten().fieldErrors };
  }

  const data = parsed.data;

  // The same read that gates scope doubles as the `before` snapshot — only
  // the fields this form can actually change, and never `codeHash`.
  const student = await getScopedDb(context).student.findUnique({
    where: { id: data.studentId },
    select: {
      id: true,
      homeAcademyId: true,
      organizationId: true,
      firstName: true,
      lastName: true,
      phone: true,
      email: true,
      dateOfBirth: true,
      guardianName: true,
      guardianPhone: true,
      emergencyContact: true,
      notes: true,
    },
  });

  // Organization scope is enforced structurally by `getScopedDb` above.
  // `isAcademyInTenantScope` only checks branch-level scope on top of that,
  // and returns true unconditionally for ADMIN's "ALL", which says nothing
  // about which organization the student belongs to.
  if (!student || !isAcademyInTenantScope(context, student.homeAcademyId)) {
    return { error: "notFound" };
  }

  const after = {
    firstName: data.firstName,
    lastName: data.lastName,
    phone: data.phone,
    email: data.email,
    dateOfBirth: data.dateOfBirth ? new Date(data.dateOfBirth) : null,
    guardianName: data.guardianName || null,
    guardianPhone: data.guardianPhone || null,
    emergencyContact: data.emergencyContact || null,
    notes: data.notes || null,
  };

  try {
    await prisma.$transaction(async (tx) => {
      const result = await tx.student.updateMany({
        where: { id: student.id, organizationId: student.organizationId, homeAcademyId: student.homeAcademyId },
        data: after,
      });

      if (result.count === 0) {
        throw new StudentWriteMissError();
      }

      await tx.auditLog.create({
        data: {
          actorId: context.actorUserId,
          organizationId: student.organizationId,
          academyId: student.homeAcademyId,
          action: "student.update",
          entityType: "Student",
          entityId: student.id,
          before: {
            firstName: student.firstName,
            lastName: student.lastName,
            phone: student.phone,
            email: student.email,
            dateOfBirth: isoOrNull(student.dateOfBirth),
            guardianName: student.guardianName,
            guardianPhone: student.guardianPhone,
            emergencyContact: student.emergencyContact,
            notes: student.notes,
          },
          after: { ...after, dateOfBirth: isoOrNull(after.dateOfBirth) },
        },
      });
    });
  } catch (error) {
    if (error instanceof StudentWriteMissError) {
      return { error: "notFound" };
    }
    throw error;
  }

  await refreshStudentPages(parsed.data.studentId);
  return { ok: true };
}

const studentIdSchema = z.object({ studentId: z.string().min(1) });

/**
 * ADMIN/DIRECTOR only. Flips `status` to ARCHIVED — never a `delete()` call.
 * Same independent re-fetch-and-check-scope discipline as `updateStudent`,
 * and the same transaction-wrapped audit row.
 *
 * Records the status the student is being archived FROM in `statusBeforeArchive`,
 * which is what `restoreStudent` returns them to. Archiving an already-archived
 * student is a quiet no-op: writing again would overwrite that stored status
 * with ARCHIVED and make the archive unrestorable.
 */
export async function archiveStudent(
  organizationId: string,
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const auth = await resolveActionContext(organizationId, ["ADMIN", "DIRECTOR"]);
  if (!auth.ok) return { error: "notFound" };
  const context = auth.context;

  const parsed = studentIdSchema.safeParse(Object.fromEntries(formData.entries()));
  if (!parsed.success) {
    return { error: "notFound" };
  }

  const student = await getScopedDb(context).student.findUnique({
    where: { id: parsed.data.studentId },
    select: { id: true, homeAcademyId: true, organizationId: true, status: true, userId: true, homeAcademy: { select: { timezone: true } } },
  });

  if (!student || !isAcademyInTenantScope(context, student.homeAcademyId)) {
    return { error: "notFound" };
  }

  if (student.status === StudentStatus.ARCHIVED) return { ok: true };

  try {
    await prisma.$transaction(async (tx) => {
      // Eligibility-prerequisites brief, 3.2: every status-changing action locks the student row FIRST, before its own update
      // and before the history row's `sequence` is computed — this is what makes `sequence` reflect the true commit order.
      const locked = await lockStudent(tx, student.organizationId, student.id);
      if (!locked) throw new StudentWriteMissError();

      const result = await tx.student.updateMany({
        // The status they are archived FROM is re-asserted in the WHERE, so a
        // concurrent change (an approval) cannot leave the stored value wrong.
        where: { id: student.id, organizationId: student.organizationId, homeAcademyId: student.homeAcademyId, status: student.status },
        data: { status: StudentStatus.ARCHIVED, statusBeforeArchive: student.status },
      });

      if (result.count === 0) {
        throw new StudentWriteMissError();
      }

      // They leave the portal with the roster (a STUDENT membership only — never a staff one).
      const membership = await revokeStudentMembership(tx, student);

      await appendStatusChange(tx, {
        organizationId: student.organizationId,
        studentId: student.id,
        status: StudentStatus.ARCHIVED,
        effectiveOn: todayInAsDbDate(student.homeAcademy.timezone, new Date()),
        source: "EVENT",
        actorId: context.actorUserId,
      });

      await tx.auditLog.create({
        data: {
          actorId: context.actorUserId,
          organizationId: student.organizationId,
          academyId: student.homeAcademyId,
          action: "student.archive",
          entityType: "Student",
          entityId: student.id,
          before: { status: student.status },
          after: { status: StudentStatus.ARCHIVED, membership },
        },
      });
    });
  } catch (error) {
    if (error instanceof StudentWriteMissError) {
      return { error: "notFound" };
    }
    throw error;
  }

  await refreshStudentPages(parsed.data.studentId);
  return { ok: true };
}

/**
 * ADMIN/DIRECTOR only. The reverse of `archiveStudent`: an ARCHIVED student goes
 * back to the status they had, and their portal access with it.
 *
 * "The status they had" is `statusBeforeArchive` — STORED at archive time, read
 * here, cleared after. It is never read from the audit log: an audit row records
 * what happened and gets pruned, rotated and exported, so a code path that
 * depended on one would quietly start doing the wrong thing the day rows are
 * trimmed (the third application of this codebase's "store what you will need
 * later" — after the currency snapshot on `PaymentPeriod` and the belt anchor on
 * a promotion credit).
 *
 * A student archived BEFORE that column existed has nothing stored, and comes
 * back PENDING. Unknown history is never guessed as "approved": a wrong PENDING
 * shows up in the awaiting-approval queue and is one click from ACTIVE, whereas
 * a wrong ACTIVE would silently give a rejected applicant a roster place and
 * portal access with no prompt to anyone. (There are none in production; this is
 * for development data and anything archived before the column.)
 *
 * The membership follows the status: only a student restored to ACTIVE or
 * INACTIVE — someone who had been approved — gets their `STUDENT` membership back
 * (via `grantStudentMembership`, which never overwrites a staff role). A PENDING
 * student gets none, exactly as before they were archived. Only an ARCHIVED
 * student can be restored; that precondition is re-asserted in the update's own
 * WHERE, so two concurrent restores cannot both count.
 */
export async function restoreStudent(
  organizationId: string,
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const auth = await resolveActionContext(organizationId, ["ADMIN", "DIRECTOR"]);
  if (!auth.ok) return { error: "notFound" };
  const context = auth.context;

  const parsed = studentIdSchema.safeParse(Object.fromEntries(formData.entries()));
  if (!parsed.success) {
    return { error: "notFound" };
  }

  const student = await getScopedDb(context).student.findUnique({
    where: { id: parsed.data.studentId },
    select: {
      id: true,
      homeAcademyId: true,
      organizationId: true,
      status: true,
      userId: true,
      statusBeforeArchive: true,
      homeAcademy: { select: { timezone: true } },
    },
  });

  if (!student || !isAcademyInTenantScope(context, student.homeAcademyId)) {
    return { error: "notFound" };
  }

  if (student.status !== StudentStatus.ARCHIVED) {
    return { error: "notArchived" };
  }

  const stored = student.statusBeforeArchive;
  const fromStoredStatus = stored !== null && stored !== StudentStatus.ARCHIVED;
  const target = fromStoredStatus ? stored : StudentStatus.PENDING;

  try {
    await prisma.$transaction(async (tx) => {
      const locked = await lockStudent(tx, student.organizationId, student.id);
      if (!locked) throw new StudentWriteMissError();

      const result = await tx.student.updateMany({
        where: {
          id: student.id,
          organizationId: student.organizationId,
          homeAcademyId: student.homeAcademyId,
          status: StudentStatus.ARCHIVED,
        },
        data: { status: target, statusBeforeArchive: null },
      });

      if (result.count === 0) {
        throw new StudentWriteMissError();
      }

      const membership = target === StudentStatus.PENDING ? ("none" as const) : await grantStudentMembership(tx, student);

      await appendStatusChange(tx, {
        organizationId: student.organizationId,
        studentId: student.id,
        status: target,
        effectiveOn: todayInAsDbDate(student.homeAcademy.timezone, new Date()),
        source: "EVENT",
        actorId: context.actorUserId,
      });

      await tx.auditLog.create({
        data: {
          actorId: context.actorUserId,
          organizationId: student.organizationId,
          academyId: student.homeAcademyId,
          action: "student.restore",
          entityType: "Student",
          entityId: student.id,
          before: { status: StudentStatus.ARCHIVED },
          // `fromStoredStatus: false` marks the null case (archived before the column existed).
          after: { status: target, membership, fromStoredStatus },
        },
      });
    });
  } catch (error) {
    if (error instanceof StudentWriteMissError) {
      return { error: "notArchived" };
    }
    throw error;
  }

  await refreshStudentPages(parsed.data.studentId);
  return { ok: true };
}

const approveStudentSchema = z.object({ studentId: z.string().min(1), planId: z.string().optional() });

// approveStudentInTx (the gated financial half of approveStudent, below) now lives in ./approve-student-core — a
// plain, non-"use server" module, imported above — rather than being defined here. See that file's own doc comment
// for exactly why: every exported async function in a "use server" file becomes a directly client-invocable server
// action, and approveStudentInTx trusts locks/validation its caller (approveStudent) already did.

/**
 * ADMIN/DIRECTOR only. The PENDING -> ACTIVE approval path for a
 * self-signed-up student (public `/signup` creates the row as PENDING; the
 * dashboard's pending-approvals count is what surfaces it to staff).
 *
 * Only a genuinely PENDING row can be approved — approving an already-ACTIVE
 * student is a no-op worth reporting rather than silently succeeding, and
 * approving an ARCHIVED one would quietly resurrect someone staff removed.
 * Both are rejected with `notPending`. The status precondition is re-asserted
 * in the `updateMany`'s own WHERE clause, not just checked beforehand, so two
 * concurrent approvals can't both count as having done the transition.
 *
 * Enrollment/resume integration plan §7.5-§7.6: when billing is active, this now also resolves/creates the
 * student's monthly-plan assignment for the enrollment month and the resulting SIGNUP(+MONTHLY) charge, atomically
 * with the approval itself — via `approveStudentInTx` above, composed with the default, production `deps` ({}).
 * This function's own exported signature is unchanged by that: no activation dependency, no date override.
 */
export async function approveStudent(
  organizationId: string,
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const auth = await resolveActionContext(organizationId, ["ADMIN", "DIRECTOR"]);
  if (!auth.ok) return { error: "notFound" };
  const context = auth.context;

  const parsed = approveStudentSchema.safeParse(Object.fromEntries(formData.entries()));
  if (!parsed.success) {
    return { error: "notFound" };
  }

  const student = await getScopedDb(context).student.findUnique({
    where: { id: parsed.data.studentId },
    select: { id: true, homeAcademyId: true, organizationId: true, status: true, userId: true, homeAcademy: { select: { timezone: true } } },
  });

  if (!student || !isAcademyInTenantScope(context, student.homeAcademyId)) {
    return { error: "notFound" };
  }

  if (student.status !== StudentStatus.PENDING) {
    return { error: "notPending" };
  }

  const planIdRaw = parsed.data.planId && parsed.data.planId.length > 0 ? parsed.data.planId : null;
  const plan = planIdRaw ? await resolvePlanId(student.organizationId, student.homeAcademyId, planIdRaw) : { ok: true as const, value: null };
  if (!plan.ok) return { error: "invalid", fieldErrors: { planId: ["invalid"] } };

  try {
    await prisma.$transaction((tx) =>
      approveStudentInTx(tx, { context, student: { id: student.id, organizationId: student.organizationId, homeAcademyId: student.homeAcademyId, timezone: student.homeAcademy.timezone, userId: student.userId }, planId: plan.value }, {}),
    );
  } catch (error) {
    if (error instanceof EnrollmentRefusedError) {
      return { error: error.reason };
    }
    if (error instanceof StudentWriteMissError) {
      return { error: "notPending" };
    }
    throw error;
  }

  await refreshStudentPages(parsed.data.studentId);
  return { ok: true };
}

/**
 * ADMIN/DIRECTOR only (same gate as `archiveStudent`/`restoreStudent`). Eligibility-prerequisites brief, 3.2: pauses an ACTIVE
 * student, effective today. This is a status fact only — it does not itself decide any month's billing (that is 6.2's job,
 * `src/lib/dues/eligibility.ts`, unbuilt and uncalled in this PR) and it writes nothing to any ledger table. Existing debt is
 * untouched at any status; `recordDuesPayment` already accepts payment regardless of the student's current status.
 *
 * Refuses from `PENDING`, `ARCHIVED` or an already-`INACTIVE` student — pausing can never be used to skip approval or
 * restoration. Never triggered by attendance or absence; this is exclusively an explicit staff action.
 */
export async function pauseStudent(
  organizationId: string,
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const auth = await resolveActionContext(organizationId, ["ADMIN", "DIRECTOR"]);
  if (!auth.ok) return { error: "notFound" };
  const context = auth.context;

  const parsed = studentIdSchema.safeParse(Object.fromEntries(formData.entries()));
  if (!parsed.success) {
    return { error: "notFound" };
  }

  const student = await getScopedDb(context).student.findUnique({
    where: { id: parsed.data.studentId },
    select: { id: true, homeAcademyId: true, organizationId: true, status: true, homeAcademy: { select: { timezone: true } } },
  });

  if (!student || !isAcademyInTenantScope(context, student.homeAcademyId)) {
    return { error: "notFound" };
  }

  if (student.status !== StudentStatus.ACTIVE) {
    return { error: "notActive" };
  }

  try {
    await prisma.$transaction(async (tx) => {
      const locked = await lockStudent(tx, student.organizationId, student.id);
      if (!locked) throw new StudentWriteMissError();

      const result = await tx.student.updateMany({
        where: { id: student.id, organizationId: student.organizationId, homeAcademyId: student.homeAcademyId, status: StudentStatus.ACTIVE },
        data: { status: StudentStatus.INACTIVE },
      });

      if (result.count === 0) {
        throw new StudentWriteMissError();
      }

      await appendStatusChange(tx, {
        organizationId: student.organizationId,
        studentId: student.id,
        status: StudentStatus.INACTIVE,
        effectiveOn: todayInAsDbDate(student.homeAcademy.timezone, new Date()),
        source: "EVENT",
        actorId: context.actorUserId,
      });

      await tx.auditLog.create({
        data: {
          actorId: context.actorUserId,
          organizationId: student.organizationId,
          academyId: student.homeAcademyId,
          action: "student.pause",
          entityType: "Student",
          entityId: student.id,
          before: { status: StudentStatus.ACTIVE },
          after: { status: StudentStatus.INACTIVE },
        },
      });
    });
  } catch (error) {
    if (error instanceof StudentWriteMissError) {
      return { error: "notActive" };
    }
    throw error;
  }

  await refreshStudentPages(parsed.data.studentId);
  return { ok: true };
}

/**
 * ADMIN/DIRECTOR only. The reverse of `pauseStudent`: an INACTIVE student becomes ACTIVE again, effective today.
 *
 * Whether — and how — resuming bills the coverage month it happens in is the approved rule documented in the
 * eligibility-prerequisites brief, section 3.4, and implemented by `resumeChargeInTx` (resume-charge.ts), composed
 * below. This action's own exported signature carries no activation dependency and no date override of any kind —
 * production always calls `resumeChargeInTx` with the default `deps` ({}), under which billing is unconditionally
 * inactive and that function's own first check returns immediately, before taking any lock. Only a test, importing
 * `resumeChargeInTx` directly, ever injects `deps.activation`/`deps.now` to exercise the gated financial path — this
 * action itself has no way to do so, by construction, not merely by convention. When billing is inactive, this
 * action's own behavior is byte-identical to before: it writes only the status column, its `StudentStatusChange` row
 * and its audit row, atomically.
 */
export async function resumeStudent(
  organizationId: string,
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const auth = await resolveActionContext(organizationId, ["ADMIN", "DIRECTOR"]);
  if (!auth.ok) return { error: "notFound" };
  const context = auth.context;

  const parsed = studentIdSchema.safeParse(Object.fromEntries(formData.entries()));
  if (!parsed.success) {
    return { error: "notFound" };
  }

  const student = await getScopedDb(context).student.findUnique({
    where: { id: parsed.data.studentId },
    select: { id: true, homeAcademyId: true, organizationId: true, status: true, homeAcademy: { select: { timezone: true } } },
  });

  if (!student || !isAcademyInTenantScope(context, student.homeAcademyId)) {
    return { error: "notFound" };
  }

  if (student.status !== StudentStatus.INACTIVE) {
    return { error: "notInactive" };
  }

  try {
    await prisma.$transaction(async (tx) => {
      const charged = await resumeChargeInTx(tx, { context, student: { id: student.id, homeAcademyId: student.homeAcademyId } }, {});
      if (charged.ok) return; // the gated path already wrote status/history/audit/obligation together

      if (charged.error !== "notActive") {
        // A genuine refusal on the gated path (a configuration gap, or a lost race) — the whole attempt refuses.
        // A configuration gap has written nothing; a lost-race "conflict" can follow a real write made earlier in
        // this same call, and this throw is what rolls that write back (see ResumeChargeRefusedError's own comment).
        throw new ResumeChargeRefusedError(charged.error);
      }

      // Billing inactive (the only path reachable in production today) — unchanged from before this PR.
      const locked = await lockStudent(tx, student.organizationId, student.id);
      if (!locked) throw new StudentWriteMissError();

      const result = await tx.student.updateMany({
        where: { id: student.id, organizationId: student.organizationId, homeAcademyId: student.homeAcademyId, status: StudentStatus.INACTIVE },
        data: { status: StudentStatus.ACTIVE },
      });

      if (result.count === 0) {
        throw new StudentWriteMissError();
      }

      await appendStatusChange(tx, {
        organizationId: student.organizationId,
        studentId: student.id,
        status: StudentStatus.ACTIVE,
        effectiveOn: todayInAsDbDate(student.homeAcademy.timezone, new Date()),
        source: "EVENT",
        actorId: context.actorUserId,
      });

      await tx.auditLog.create({
        data: {
          actorId: context.actorUserId,
          organizationId: student.organizationId,
          academyId: student.homeAcademyId,
          action: "student.resume",
          entityType: "Student",
          entityId: student.id,
          before: { status: StudentStatus.INACTIVE },
          after: { status: StudentStatus.ACTIVE },
        },
      });
    });
  } catch (error) {
    if (error instanceof StudentWriteMissError) {
      return { error: "notInactive" };
    }
    if (error instanceof ResumeChargeRefusedError) {
      return { error: `resumeCharge:${error.reason}` };
    }
    throw error;
  }

  await refreshStudentPages(parsed.data.studentId);
  return { ok: true };
}

const returnToTrainingSchema = z.object({ studentId: z.string().min(1), archiveEventId: z.string().min(1) });

/**
 * ADMIN/DIRECTOR only (D21, same gate as every status action in this file). Genuine-return-to-training brief: a new,
 * separate action — NEVER composing `restoreStudent`, which stays completely unchanged (D22) for the purely
 * administrative case. Eligible only for a currently `ARCHIVED` student whose `statusBeforeArchive` is `ACTIVE` or
 * `INACTIVE` (D20) — someone who actually trained before, not merely a `PENDING` applicant who was archived without
 * ever being approved. Status always becomes `ACTIVE` (never the stored `statusBeforeArchive` value, unlike
 * `restoreStudent`): a genuine return means training again now, regardless of what they held before the archive.
 *
 * `archiveEventId` is a hidden field the page embeds only for an eligible student with a trustworthy
 * (`EVENT`-sourced) archive history (`resolveTrustworthyArchiveEvent`, `@/lib/students/archive-event.ts`) — it binds
 * this specific submission to that specific archive event, re-verified fresh under the student lock by
 * `genuineReturnChargeInTx` before any write. This is the mechanism that tells a stale or lost-race retry apart from
 * a legitimate new attempt across two different archive-and-return cycles; see that function's own doc comment.
 *
 * This action's own exported signature carries no activation dependency and no date override of any kind —
 * production always calls `genuineReturnChargeInTx` with the default `deps` ({}), under which billing is
 * unconditionally inactive and that function's own first check refuses `notActive` immediately, before taking any
 * lock. UNLIKE `resumeStudent`, there is no non-gated fallback behavior here at all: this is a brand-new financial
 * action with nothing useful to do while billing is inactive (today, always) — its own caller (`page.tsx`) renders
 * no usable UI in that case.
 */
export async function returnToTraining(
  organizationId: string,
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const auth = await resolveActionContext(organizationId, ["ADMIN", "DIRECTOR"]);
  if (!auth.ok) return { error: "notFound" };
  const context = auth.context;

  const parsed = returnToTrainingSchema.safeParse(Object.fromEntries(formData.entries()));
  if (!parsed.success) {
    return { error: "notFound" };
  }

  const student = await getScopedDb(context).student.findUnique({
    where: { id: parsed.data.studentId },
    select: { id: true, homeAcademyId: true, organizationId: true, userId: true },
  });

  if (!student || !isAcademyInTenantScope(context, student.homeAcademyId)) {
    return { error: "notFound" };
  }

  try {
    await prisma.$transaction(async (tx) => {
      const charged = await genuineReturnChargeInTx(
        tx,
        { context, student: { id: student.id, homeAcademyId: student.homeAcademyId, userId: student.userId }, archiveEventId: parsed.data.archiveEventId },
        {},
      );
      if (charged.ok) return;
      throw new GenuineReturnChargeRefusedError(charged.error);
    });
  } catch (error) {
    if (error instanceof GenuineReturnChargeRefusedError) {
      return { error: error.reason };
    }
    throw error;
  }

  await refreshStudentPages(parsed.data.studentId);
  return { ok: true };
}

export type RegenerateCodeState = ActionState & { code?: string };

/**
 * Any staff role (spec §4.1: "staff can regenerate a student's code" — no
 * role restriction stated, unlike edit/archive). Same independent
 * re-fetch-and-check-scope discipline as the actions above. Returns the
 * new plaintext code once in the action state — it is never persisted or
 * logged, only `codeHash` is written, matching `generateStudentCode`'s
 * existing contract from Task 6/7.
 *
 * The audit row records only THAT a regeneration happened, never the old or
 * new `codeHash`. Phase 1's final review replaced bcrypt with a keyed HMAC
 * for `codeHash` specifically so it could be a safe DB-level unique
 * constraint — the digest is the check-in secret's only stored form, and
 * copying it into an append-only audit table (readable by a wider audience,
 * retained far longer than the code itself) would create a second place it
 * could leak from and defeat the point of treating it as sensitive.
 */
export async function regenerateStudentCode(
  organizationId: string,
  _prevState: RegenerateCodeState,
  formData: FormData,
): Promise<RegenerateCodeState> {
  const auth = await resolveActionContext(organizationId, ["ADMIN", "DIRECTOR", "INSTRUCTOR"]);
  if (!auth.ok) return { error: "notFound" };
  const context = auth.context;

  const parsed = studentIdSchema.safeParse(Object.fromEntries(formData.entries()));
  if (!parsed.success) {
    return { error: "notFound" };
  }

  const student = await getScopedDb(context).student.findUnique({
    where: { id: parsed.data.studentId },
    select: { id: true, homeAcademyId: true, organizationId: true },
  });

  if (!student || !isAcademyInTenantScope(context, student.homeAcademyId)) {
    return { error: "notFound" };
  }

  const { code, codeHash } = await generateStudentCode(student.organizationId);

  try {
    await prisma.$transaction(async (tx) => {
      const result = await tx.student.updateMany({
        where: { id: student.id, organizationId: student.organizationId, homeAcademyId: student.homeAcademyId },
        data: { codeHash },
      });

      if (result.count === 0) {
        throw new StudentWriteMissError();
      }

      await tx.auditLog.create({
        data: {
          actorId: context.actorUserId,
          organizationId: student.organizationId,
          academyId: student.homeAcademyId,
          action: "student.regenerateCode",
          entityType: "Student",
          entityId: student.id,
          // Deliberately no codeHash — see the doc comment above. The
          // timestamp is the entire payload. `Prisma.DbNull` (not JS `null`,
          // which Prisma rejects for a nullable Json column) writes a real
          // SQL NULL rather than the JSON literal `null`.
          before: Prisma.DbNull,
          after: { regeneratedAt: new Date().toISOString() },
        },
      });
    });
  } catch (error) {
    if (error instanceof StudentWriteMissError) {
      return { error: "notFound" };
    }
    throw error;
  }

  return { ok: true, code };
}
