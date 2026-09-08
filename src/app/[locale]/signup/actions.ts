"use server";

import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { hashSecret } from "@/lib/crypto";
import { generateStudentCode } from "@/lib/students/generate-code";
import { Belt, Role, StudentStatus } from "@/generated/prisma/client";

const signupSchema = z
  .object({
    firstName: z.string().min(1),
    lastName: z.string().min(1),
    phone: z.string().min(1),
    email: z.string().email(),
    homeAcademySlug: z.enum(["escazu", "escalante"]),
    currentBelt: z.nativeEnum(Belt),
    currentStripes: z.coerce.number().int().min(0).max(4),
    password: z.string().min(8),
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

export type SignupState = {
  ok?: true;
  code?: string;
  /**
   * Set when this signup CLAIMED an existing staff-created Student row
   * rather than creating a new one. No `code` accompanies it — the student
   * keeps the check-in code staff already handed them, so the success
   * screen must say that instead of showing a blank code.
   */
  linked?: true;
  error?: string;
  fieldErrors?: Record<string, string[]>;
};

export async function signup(_prevState: SignupState, formData: FormData): Promise<SignupState> {
  const raw = Object.fromEntries(formData.entries());
  const parsed = signupSchema.safeParse(raw);

  if (!parsed.success) {
    return { error: "invalid", fieldErrors: parsed.error.flatten().fieldErrors };
  }

  const data = parsed.data;

  const existingEmail = await prisma.user.findUnique({ where: { email: data.email } });
  if (existingEmail) {
    return { error: "emailTaken", fieldErrors: { email: ["emailTaken"] } };
  }

  // A student staff already entered by hand (in person or over the phone)
  // who is only now creating their own portal login. Without this check
  // they'd end up with TWO Student rows at the same email: the staff one
  // holding their real belt, academy and handed-over check-in code, and a
  // second self-signup one that the roster, attendance and promotion
  // history would then be split across. `userId: null` is what distinguishes
  // "staff-created, not yet claimed" from a row that already belongs to
  // someone's account.
  const existingStudentWithoutAccount = await prisma.student.findFirst({
    where: { email: data.email, userId: null },
  });

  if (existingStudentWithoutAccount) {
    await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          email: data.email,
          passwordHash: await hashSecret(data.password),
          role: Role.STUDENT,
        },
      });

      // ONLY `userId` is written. `codeHash`, `currentBelt`,
      // `currentStripes`, `homeAcademyId` and `status` were set by staff and
      // are the source of truth — the signup form's own values for those are
      // discarded on this path, never allowed to overwrite them. Otherwise a
      // purple belt could self-signup as "white, 0 stripes" and silently
      // reset their own rank, or move themselves to another academy, and the
      // 4-digit code staff already handed them would stop working.
      await tx.student.update({
        where: { id: existingStudentWithoutAccount.id },
        data: { userId: user.id },
      });

      await tx.auditLog.create({
        data: {
          // The acting principal here is the student themselves, not a staff
          // member — this is a self-service event, and the brand-new user id
          // is the only honest actor to attribute it to.
          actorId: user.id,
          academyId: existingStudentWithoutAccount.homeAcademyId,
          action: "student.linkedSelfSignup",
          entityType: "Student",
          entityId: existingStudentWithoutAccount.id,
          before: { userId: null },
          after: { userId: user.id },
        },
      });
    });

    // No new code is issued on this path and none is returned: the student
    // already has the one staff handed them, and `codeHash` was left
    // untouched, so surfacing a freshly generated code here would show them
    // a code that does not work.
    return { ok: true, linked: true };
  }

  const homeAcademy = await prisma.academy.findUniqueOrThrow({ where: { slug: data.homeAcademySlug } });
  const { code, codeHash } = await generateStudentCode();

  await prisma.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: {
        email: data.email,
        passwordHash: await hashSecret(data.password),
        role: Role.STUDENT,
      },
    });

    await tx.student.create({
      data: {
        userId: user.id,
        homeAcademyId: homeAcademy.id,
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
        status: StudentStatus.PENDING,
      },
    });
  });

  // Staff-notification stub: query-time "pending approvals" count on the
  // dashboard (Task 9) is the notification mechanism for Phase 2 — no
  // dedicated Notification table yet (YAGNI; spec's "bell icon" system is
  // out of this phase's scope).

  return { ok: true, code };
}
