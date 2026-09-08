"use server";

import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { generateStudentCode } from "@/lib/students/generate-code";
import { isAcademyInScope, requireStaffSession } from "@/lib/auth/session";
import { Belt, StudentStatus } from "@/generated/prisma/client";
import type { ActionState } from "@/lib/action-state";

const updateStudentSchema = z
  .object({
    studentId: z.string().min(1),
    firstName: z.string().min(1),
    lastName: z.string().min(1),
    phone: z.string().min(1),
    email: z.string().email(),
    currentBelt: z.nativeEnum(Belt),
    currentStripes: z.coerce.number().int().min(0).max(4),
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
 * ADMIN/DIRECTOR only (spec-adjacent to Task 7's createStudent gate).
 * `homeAcademyId` and `status` are deliberately not editable here — academy
 * transfer isn't a feature this task builds, and archiving has its own
 * dedicated action below.
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
 */
export async function updateStudent(_prevState: ActionState, formData: FormData): Promise<ActionState> {
  const session = await requireStaffSession(["ADMIN", "DIRECTOR"]);

  const raw = Object.fromEntries(formData.entries());
  const parsed = updateStudentSchema.safeParse(raw);

  if (!parsed.success) {
    return { error: "invalid", fieldErrors: parsed.error.flatten().fieldErrors };
  }

  const data = parsed.data;

  const student = await prisma.student.findUnique({
    where: { id: data.studentId },
    select: { id: true, homeAcademyId: true },
  });

  if (!student || !isAcademyInScope(session, student.homeAcademyId)) {
    return { error: "notFound" };
  }

  const result = await prisma.student.updateMany({
    where: { id: student.id, homeAcademyId: student.homeAcademyId },
    data: {
      firstName: data.firstName,
      lastName: data.lastName,
      phone: data.phone,
      email: data.email,
      currentBelt: data.currentBelt,
      currentStripes: data.currentStripes,
      dateOfBirth: data.dateOfBirth ? new Date(data.dateOfBirth) : null,
      guardianName: data.guardianName || null,
      guardianPhone: data.guardianPhone || null,
      emergencyContact: data.emergencyContact || null,
      notes: data.notes || null,
    },
  });

  if (result.count === 0) {
    return { error: "notFound" };
  }

  return { ok: true };
}

const studentIdSchema = z.object({ studentId: z.string().min(1) });

/**
 * ADMIN/DIRECTOR only. Flips `status` to ARCHIVED — never a `delete()` call.
 * Same independent re-fetch-and-check-scope discipline as `updateStudent`.
 */
export async function archiveStudent(_prevState: ActionState, formData: FormData): Promise<ActionState> {
  const session = await requireStaffSession(["ADMIN", "DIRECTOR"]);

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

  const result = await prisma.student.updateMany({
    where: { id: student.id, homeAcademyId: student.homeAcademyId },
    data: { status: StudentStatus.ARCHIVED },
  });

  if (result.count === 0) {
    return { error: "notFound" };
  }

  return { ok: true };
}

export type RegenerateCodeState = ActionState & { code?: string };

/**
 * Any staff role (spec §4.1: "staff can regenerate a student's code" — no
 * role restriction stated, unlike edit/archive). Same independent
 * re-fetch-and-check-scope discipline as the two actions above. Returns the
 * new plaintext code once in the action state — it is never persisted or
 * logged, only `codeHash` is written, matching `generateStudentCode`'s
 * existing contract from Task 6/7.
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

  const result = await prisma.student.updateMany({
    where: { id: student.id, homeAcademyId: student.homeAcademyId },
    data: { codeHash },
  });

  if (result.count === 0) {
    return { error: "notFound" };
  }

  return { ok: true, code };
}
