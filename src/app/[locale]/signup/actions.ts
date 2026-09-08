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
