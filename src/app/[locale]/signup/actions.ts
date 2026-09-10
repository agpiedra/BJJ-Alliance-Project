"use server";

import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { hashSecret } from "@/lib/crypto";
import { generateStudentCode } from "@/lib/students/generate-code";
import { notifyNewSignup } from "@/lib/notifications/notify-new-signup";
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
  // who has not yet claimed a portal login. Without this check they'd end up
  // with TWO Student rows at the same email: the staff one holding their real
  // belt, academy and handed-over check-in code, and a second self-signup one
  // that the roster, attendance and promotion history would then be split
  // across. `userId: null` is what distinguishes "staff-created, not yet
  // claimed" from a row that already belongs to someone's account.
  //
  // This signup is REFUSED, and nothing is written — no `User`, no change to
  // the existing `Student`, not even an audit row (there is no mutation to
  // audit). Auto-linking on an email match would be an account-takeover
  // vector: this phase has no email verification, so anyone who knows or
  // guesses a staff-registered student's email could claim their record —
  // and, because the record is typically already ACTIVE, would land an
  // immediately-live account that skipped the staff review a normal PENDING
  // self-signup requires. That is strictly worse than the duplicate rows this
  // check exists to prevent. Real account linking needs actual identity
  // verification (a verified email, or a staff-mediated flow) and is Phase 8
  // territory; "refuse and send them to their academy" is the safe answer
  // here, and it still fixes the duplicate-row bug outright.
  const existingStudentWithoutAccount = await prisma.student.findFirst({
    where: { email: data.email, userId: null },
    select: { id: true },
  });

  if (existingStudentWithoutAccount) {
    return {
      error: "emailLinkedToExistingStudent",
      fieldErrors: { email: ["emailLinkedToExistingStudent"] },
    };
  }

  const homeAcademy = await prisma.academy.findUniqueOrThrow({ where: { slug: data.homeAcademySlug } });
  const { code, codeHash } = await generateStudentCode();

  const studentId = await prisma.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: {
        email: data.email,
        passwordHash: await hashSecret(data.password),
        role: Role.STUDENT,
      },
    });

    const student = await tx.student.create({
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

    return student.id;
  });

  notifyNewSignup(studentId).catch((error) => {
    console.error("notifyNewSignup failed (non-fatal)", error);
  });

  return { ok: true, code };
}
