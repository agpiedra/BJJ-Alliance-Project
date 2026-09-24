"use server";

import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { generateStudentCode } from "@/lib/students/generate-code";
import { isAcademyInTenantScope, resolveActionContext } from "@/lib/tenant/context";
import { getScopedDb } from "@/lib/tenant/scoped-client";
import { Prisma, StudentStatus } from "@/generated/prisma/client";
import type { ActionState } from "@/lib/action-state";

const createStudentSchema = z
  .object({
    firstName: z.string().min(1),
    lastName: z.string().min(1),
    phone: z.string().min(1),
    email: z.string().email(),
    homeAcademyId: z.string().min(1),
    // MULTI_ACADEMY_AND_KIDS_BELTS.md Phase 3c-i: "add a required track
    // control... selecting the track filters the rank dropdown to that
    // track's ranks." The client already has the real BeltRank id from the
    // rankOptions it was given (the same rows the dropdown was built from),
    // so it submits that id directly rather than a belt code the server
    // re-resolves — currentRankId is still re-validated below against
    // `track` and the org's own scoped rank table, never trusted bare.
    track: z.enum(["ADULT", "KIDS"]),
    currentRankId: z.string().min(1),
    currentStripes: z.coerce.number().int().min(0),
    // Roughly when this belt was awarded - a HISTORICAL date, optional and possibly unknown. Omitted
    // means "starting today". It never blocks progress and never seeds any: academy progress
    // always starts at 0 from the moment the system begins tracking the student
    // (Student.progressBaselineAt, set by the database default), and there are no head-start
    // credits (docs/PROMOTION_PROGRESS_PROPOSAL.md).
    beltAwardedAt: z.string().optional(),
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
  organizationId: string,
  _prevState: CreateStudentState,
  formData: FormData,
): Promise<CreateStudentState> {
  const auth = await resolveActionContext(organizationId, ["ADMIN", "DIRECTOR"]);
  if (!auth.ok) return { error: "forbiddenAcademy", fieldErrors: { homeAcademyId: ["forbiddenAcademy"] } };
  const context = auth.context;

  const raw = Object.fromEntries(formData.entries());
  const parsed = createStudentSchema.safeParse(raw);

  if (!parsed.success) {
    return { error: "invalid", fieldErrors: parsed.error.flatten().fieldErrors };
  }

  const data = parsed.data;

  const academy = await getScopedDb(context).academy.findUnique({
    where: { id: data.homeAcademyId },
    select: { organizationId: true },
  });
  // Never trust a client-submitted academy id, even from an authenticated
  // DIRECTOR — a DIRECTOR assigned only to Escalante must not be able to
  // create a student at Escazú just because the form field said so (e.g.
  // devtools tampering with a hidden field for a single-academy director).
  // The UI only ever offers in-scope academies as options; this check is
  // the actual, server-side gate. `getScopedDb` returns `null` outright for
  // an academy in another organization (structural, not a manual compare);
  // `isAcademyInTenantScope` only checks branch-level scope on top of that
  // and returns true unconditionally for ADMIN's "ALL", which says nothing
  // about which organization the academy belongs to.
  if (!academy || !isAcademyInTenantScope(context, data.homeAcademyId)) {
    return { error: "forbiddenAcademy", fieldErrors: { homeAcademyId: ["forbiddenAcademy"] } };
  }

  const { code, codeHash } = await generateStudentCode(academy.organizationId);

  // Re-validate the submitted rank against the submitted track and this
  // org's own scoped catalog — never trust a client-submitted id bare, even
  // though the UI only ever offers ids it fetched itself (the same
  // reasoning as homeAcademyId above). A plain scoped read, not part of the
  // write transaction below (which stays on the raw client because it must
  // combine a tenant-scoped write with an AuditLog row atomically, and
  // AuditLog is deliberately outside getScopedDb's reach; see that
  // wrapper's own module doc comment for why).
  const rank = await getScopedDb(context).beltRank.findFirst({
    where: { id: data.currentRankId, track: data.track },
    select: { id: true, code: true, maxStripes: true },
  });
  if (!rank) {
    return { error: "invalid", fieldErrors: { currentRankId: ["invalid"] } };
  }
  if (data.currentStripes > rank.maxStripes) {
    return { error: "invalid", fieldErrors: { currentStripes: ["invalid"] } };
  }

  // The historical belt date exactly as staff typed it (or now when omitted). Progress does not read it.
  const beltAwardedAt = data.beltAwardedAt ? new Date(data.beltAwardedAt) : new Date();

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
        organizationId: academy.organizationId,
        track: data.track,
        firstName: data.firstName,
        lastName: data.lastName,
        phone: data.phone,
        email: data.email,
        currentRankId: rank.id,
        currentStripes: data.currentStripes,
        beltAwardedAt,
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
        actorId: context.actorUserId,
        organizationId: context.organizationId,
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
          track: student.track,
          currentBelt: rank.code,
          currentStripes: student.currentStripes,
          status: student.status,
        },
      },
    });
  });

  return { ok: true, code };
}
