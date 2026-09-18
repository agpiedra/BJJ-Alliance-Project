"use server";

import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { resolveAcademyBySlug, resolveOrganizationForSignup } from "@/lib/tenant/platform-lookups";
import { hashSecret } from "@/lib/crypto";
import { generateStudentCode } from "@/lib/students/generate-code";
import { notifyNewSignup } from "@/lib/notifications/notify-new-signup";
import { fireAndForget } from "@/lib/notifications/fire-and-forget";
import { Role, StudentStatus } from "@/generated/prisma/client";

const signupSchema = z
  .object({
    // .max(100): this value reaches Resend's email `subject` field
    // unescaped (EmailChannel embeds it in NEW_SIGNUP's title) — bounding it
    // here keeps an unbounded, newline-permitting public input out of an
    // email header, matching currentStripes' existing min/max convention below.
    firstName: z.string().min(1).max(100),
    lastName: z.string().min(1).max(100),
    phone: z.string().min(1),
    email: z.string().email(),
    // MULTI_ACADEMY_AND_KIDS_BELTS.md Phase 5 — no longer a fixed
    // z.enum(["escazu", "escalante"]): valid values now depend on which
    // organization's academies the form actually listed, which this schema
    // can't know statically. Membership in that organization is verified
    // below, server-side, against `orgSlug` — never trusted from this
    // string alone.
    homeAcademySlug: z.string().min(1),
    currentBelt: z.enum(["WHITE", "BLUE", "PURPLE", "BROWN", "BLACK"]),
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

/**
 * `orgSlug` comes from the URL segment (`/o/[orgSlug]/signup`), bound by
 * `signup-form.tsx` — same "explicit argument, re-validated server-side"
 * shape as every other action in this codebase that accepts an
 * organization identifier from a page prop rather than trusting a hidden
 * form field. Re-resolved here from scratch (never trusted as a bare
 * override) via the exact same `resolveOrganizationForSignup` the page
 * used to render the form, so a stale page (the organization got
 * suspended between page load and submit) is refused, not silently allowed.
 */
export async function signup(orgSlug: string, _prevState: SignupState, formData: FormData): Promise<SignupState> {
  const raw = Object.fromEntries(formData.entries());
  const parsed = signupSchema.safeParse(raw);

  if (!parsed.success) {
    return { error: "invalid", fieldErrors: parsed.error.flatten().fieldErrors };
  }

  const data = parsed.data;

  const organization = await resolveOrganizationForSignup(orgSlug);
  if (!organization) {
    return { error: "organizationUnavailable" };
  }

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
  //
  // homeAcademySlug is checked against the ALREADY-RESOLVED organization
  // above, not merely "does this slug exist anywhere" — resolveAcademyBySlug
  // is a global, cross-org lookup (see platform-lookups.ts for why it can't
  // be organization-scoped by construction), so the explicit
  // organizationId match below is what actually prevents a crafted request
  // from attaching a signup to a different organization's academy than the
  // URL claims.
  const homeAcademy = await resolveAcademyBySlug(data.homeAcademySlug);
  if (!homeAcademy || homeAcademy.organizationId !== organization.id) {
    return { error: "invalid", fieldErrors: { homeAcademySlug: ["invalid"] } };
  }

  const existingStudentWithoutAccount = await prisma.student.findFirst({
    where: { email: data.email, organizationId: homeAcademy.organizationId, userId: null },
    select: { id: true },
  });

  if (existingStudentWithoutAccount) {
    return {
      error: "emailLinkedToExistingStudent",
      fieldErrors: { email: ["emailLinkedToExistingStudent"] },
    };
  }

  const { code, codeHash } = await generateStudentCode(homeAcademy.organizationId);

  // No authenticated tenant context exists yet at signup time (this is a
  // public, unauthenticated endpoint), so this is a plain organizationId-
  // scoped lookup rather than getScopedDb — matching every other query in
  // this file.
  const rank = await prisma.beltRank.findFirstOrThrow({
    where: { organizationId: homeAcademy.organizationId, track: "ADULT", code: data.currentBelt },
    select: { id: true },
  });

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
        organizationId: homeAcademy.organizationId,
        firstName: data.firstName,
        lastName: data.lastName,
        phone: data.phone,
        email: data.email,
        currentRankId: rank.id,
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

  // See fire-and-forget.ts for why this is wrapped in after() with a
  // fallback rather than left as a bare un-awaited promise.
  fireAndForget("notifyNewSignup", () => notifyNewSignup(studentId, homeAcademy.organizationId));

  return { ok: true, code };
}
