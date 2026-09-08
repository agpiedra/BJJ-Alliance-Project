"use server";

import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { generateStudentCode } from "@/lib/students/generate-code";
import { isAcademyInScope, requireStaffSession } from "@/lib/auth/session";
import { Prisma, StudentStatus } from "@/generated/prisma/client";
import type { ActionState } from "@/lib/action-state";

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
 */
class StudentWriteMissError extends Error {
  constructor() {
    super("STUDENT_WRITE_MISS");
    this.name = "StudentWriteMissError";
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
 * re-checks `isAcademyInScope` against its *real*, freshly-read
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
export async function updateStudent(_prevState: ActionState, formData: FormData): Promise<ActionState> {
  const session = await requireStaffSession(["ADMIN", "DIRECTOR"]);

  const raw = Object.fromEntries(formData.entries());
  const parsed = updateStudentSchema.safeParse(raw);

  if (!parsed.success) {
    return { error: "invalid", fieldErrors: parsed.error.flatten().fieldErrors };
  }

  const data = parsed.data;

  // The same read that gates scope doubles as the `before` snapshot — only
  // the fields this form can actually change, and never `codeHash`.
  const student = await prisma.student.findUnique({
    where: { id: data.studentId },
    select: {
      id: true,
      homeAcademyId: true,
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

  if (!student || !isAcademyInScope(session, student.homeAcademyId)) {
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
        where: { id: student.id, homeAcademyId: student.homeAcademyId },
        data: after,
      });

      if (result.count === 0) {
        throw new StudentWriteMissError();
      }

      await tx.auditLog.create({
        data: {
          actorId: session.userId,
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

  return { ok: true };
}

const studentIdSchema = z.object({ studentId: z.string().min(1) });

/**
 * ADMIN/DIRECTOR only. Flips `status` to ARCHIVED — never a `delete()` call.
 * Same independent re-fetch-and-check-scope discipline as `updateStudent`,
 * and the same transaction-wrapped audit row.
 */
export async function archiveStudent(_prevState: ActionState, formData: FormData): Promise<ActionState> {
  const session = await requireStaffSession(["ADMIN", "DIRECTOR"]);

  const parsed = studentIdSchema.safeParse(Object.fromEntries(formData.entries()));
  if (!parsed.success) {
    return { error: "notFound" };
  }

  const student = await prisma.student.findUnique({
    where: { id: parsed.data.studentId },
    select: { id: true, homeAcademyId: true, status: true },
  });

  if (!student || !isAcademyInScope(session, student.homeAcademyId)) {
    return { error: "notFound" };
  }

  try {
    await prisma.$transaction(async (tx) => {
      const result = await tx.student.updateMany({
        where: { id: student.id, homeAcademyId: student.homeAcademyId },
        data: { status: StudentStatus.ARCHIVED },
      });

      if (result.count === 0) {
        throw new StudentWriteMissError();
      }

      await tx.auditLog.create({
        data: {
          actorId: session.userId,
          academyId: student.homeAcademyId,
          action: "student.archive",
          entityType: "Student",
          entityId: student.id,
          before: { status: student.status },
          after: { status: StudentStatus.ARCHIVED },
        },
      });
    });
  } catch (error) {
    if (error instanceof StudentWriteMissError) {
      return { error: "notFound" };
    }
    throw error;
  }

  return { ok: true };
}

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
 */
export async function approveStudent(_prevState: ActionState, formData: FormData): Promise<ActionState> {
  const session = await requireStaffSession(["ADMIN", "DIRECTOR"]);

  const parsed = studentIdSchema.safeParse(Object.fromEntries(formData.entries()));
  if (!parsed.success) {
    return { error: "notFound" };
  }

  const student = await prisma.student.findUnique({
    where: { id: parsed.data.studentId },
    select: { id: true, homeAcademyId: true, status: true },
  });

  if (!student || !isAcademyInScope(session, student.homeAcademyId)) {
    return { error: "notFound" };
  }

  if (student.status !== StudentStatus.PENDING) {
    return { error: "notPending" };
  }

  try {
    await prisma.$transaction(async (tx) => {
      const result = await tx.student.updateMany({
        where: {
          id: student.id,
          homeAcademyId: student.homeAcademyId,
          status: StudentStatus.PENDING,
        },
        data: { status: StudentStatus.ACTIVE },
      });

      if (result.count === 0) {
        throw new StudentWriteMissError();
      }

      await tx.auditLog.create({
        data: {
          actorId: session.userId,
          academyId: student.homeAcademyId,
          action: "student.approve",
          entityType: "Student",
          entityId: student.id,
          before: { status: StudentStatus.PENDING },
          after: { status: StudentStatus.ACTIVE },
        },
      });
    });
  } catch (error) {
    if (error instanceof StudentWriteMissError) {
      return { error: "notPending" };
    }
    throw error;
  }

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
  _prevState: RegenerateCodeState,
  formData: FormData,
): Promise<RegenerateCodeState> {
  const session = await requireStaffSession();

  const parsed = studentIdSchema.safeParse(Object.fromEntries(formData.entries()));
  if (!parsed.success) {
    return { error: "notFound" };
  }

  const student = await prisma.student.findUnique({
    where: { id: parsed.data.studentId },
    select: { id: true, homeAcademyId: true },
  });

  if (!student || !isAcademyInScope(session, student.homeAcademyId)) {
    return { error: "notFound" };
  }

  const { code, codeHash } = await generateStudentCode();

  try {
    await prisma.$transaction(async (tx) => {
      const result = await tx.student.updateMany({
        where: { id: student.id, homeAcademyId: student.homeAcademyId },
        data: { codeHash },
      });

      if (result.count === 0) {
        throw new StudentWriteMissError();
      }

      await tx.auditLog.create({
        data: {
          actorId: session.userId,
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
