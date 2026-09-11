"use server";

import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { generateStudentCode } from "@/lib/students/generate-code";
import { isAcademyInScope, requireStaffSession } from "@/lib/auth/session";
import { Belt, Prisma, StudentStatus } from "@/generated/prisma/client";
import type { ActionState } from "@/lib/action-state";

const createStudentSchema = z
  .object({
    firstName: z.string().min(1),
    lastName: z.string().min(1),
    phone: z.string().min(1),
    email: z.string().email(),
    homeAcademyId: z.string().min(1),
    currentBelt: z.nativeEnum(Belt),
    currentStripes: z.coerce.number().int().min(0).max(4),
    dateOfBirth: z.string().optional(),
    guardianName: z.string().optional(),
    guardianPhone: z.string().optional(),
    emergencyContact: z.string().optional(),
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

export type CreateStudentState = ActionState & { code?: string };

/**
 * Staff-side manual creation (spec §4.6: "Staff can also create students
 * manually from the dashboard and hand over the generated code"). Unlike
 * public signup, this never creates a `User` row — staff-created students
 * get only the generated check-in code, no portal password yet, matching
 * `Student.userId` being nullable for exactly this case.
 */
export async function createStudent(
  _prevState: CreateStudentState,
  formData: FormData,
): Promise<CreateStudentState> {
  const session = await requireStaffSession(["ADMIN", "DIRECTOR"]);

  const raw = Object.fromEntries(formData.entries());
  const parsed = createStudentSchema.safeParse(raw);

  if (!parsed.success) {
    return { error: "invalid", fieldErrors: parsed.error.flatten().fieldErrors };
  }

  const data = parsed.data;

  // Never trust a client-submitted academy id, even from an authenticated
  // DIRECTOR — a DIRECTOR assigned only to Escalante must not be able to
  // create a student at Escazú just because the form field said so (e.g.
  // devtools tampering with a hidden field for a single-academy director).
  // The UI only ever offers in-scope academies as options; this check is
  // the actual, server-side gate.
  if (!isAcademyInScope(session, data.homeAcademyId)) {
    return { error: "forbiddenAcademy", fieldErrors: { homeAcademyId: ["forbiddenAcademy"] } };
  }

  const { code, codeHash } = await generateStudentCode();

  // The create and its audit row go in one interactive transaction, so an
  // audit row can never exist without the student it describes, nor a
  // student appear with no record of who created them.
  await prisma.$transaction(async (tx) => {
    // Staff created this student directly (in person or over the phone) —
    // there's no self-signup review step to wait on, so this row starts
    // ACTIVE rather than the PENDING that public /signup uses.
    const student = await tx.student.create({
      data: {
        homeAcademyId: data.homeAcademyId,
        firstName: data.firstName,
        lastName: data.lastName,
        phone: data.phone,
        email: data.email,
        currentBelt: data.currentBelt,
        currentStripes: data.currentStripes,
        dateOfBirth: data.dateOfBirth ? new Date(data.dateOfBirth) : undefined,
        guardianName: data.guardianName,
        guardianPhone: data.guardianPhone,
        emergencyContact: data.emergencyContact,
        codeHash,
        status: StudentStatus.ACTIVE,
        userId: null,
      },
    });

    await tx.auditLog.create({
      data: {
        actorId: session.userId,
        academyId: student.homeAcademyId,
        action: "student.create",
        entityType: "Student",
        entityId: student.id,
        // SQL NULL, not the JSON literal `null` — Prisma rejects a bare JS
        // `null` for a nullable Json column.
        before: Prisma.DbNull,
        // Non-sensitive fields only. `codeHash` is deliberately excluded —
        // it is the student's check-in secret in its only stored form, and
        // copying it into an append-only audit table would create a second
        // place it could leak from (see the note on `regenerateStudentCode`).
        after: {
          firstName: student.firstName,
          lastName: student.lastName,
          homeAcademyId: student.homeAcademyId,
          currentBelt: student.currentBelt,
          currentStripes: student.currentStripes,
          status: student.status,
        },
      },
    });
  });

  return { ok: true, code };
}
