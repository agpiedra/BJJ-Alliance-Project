"use server";

import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { isAcademyInScope, requireStaffSession } from "@/lib/auth/session";
import { getAtBeltSummary } from "@/lib/students/attendance-summary";
import {
  classifyEligibility,
  resolvePromotionTarget,
  type BeltRequirementLike,
} from "@/lib/students/eligibility";
import type { ActionState } from "@/lib/action-state";

const confirmPromotionSchema = z.object({
  studentId: z.string().min(1),
  notes: z.string().optional(),
});

/**
 * ADMIN/DIRECTOR only — spec §3 explicitly excludes INSTRUCTOR from
 * promotions (unlike `addAttendanceAdjustment`'s wider ADMIN/DIRECTOR/
 * INSTRUCTOR grant for attendance marking/correction).
 *
 * `studentId` is the only client-submitted field that drives the actual
 * promotion decision — an optional `notes` field is accepted and passed
 * through verbatim to `Promotion.notes`, but nothing else the client could
 * submit (a `toBelt`/`toStripes`, say) is ever trusted. The entire point of
 * this action is that eligibility is recomputed FRESH, from the database,
 * at the moment of confirmation — never from anything the request carries.
 *
 * Same independent re-fetch-and-check-scope discipline as every other write
 * in this app: `student` is re-read here (never trusting a hidden form
 * field for `homeAcademyId`), and `isAcademyInScope` is re-checked against
 * that freshly-read value.
 *
 * The stale-eligibility race this action defends against: a staff member
 * opens the promotion queue, sees a student is eligible, then before they
 * click "confirm" a correction (or another staff member's action) drops the
 * student back below the threshold. Trusting the queue's snapshot would let
 * a promotion be recorded for a student who is, at the moment of writing,
 * genuinely not eligible. So `getAtBeltSummary` + `classifyEligibility` +
 * `resolvePromotionTarget` are all recomputed here, right before the
 * transaction opens, using the same single-call design Task 3's Step 0
 * consolidation gave `promotion-queue.ts`'s `classifyActiveStudents` — one
 * `getAtBeltSummary` call already carries `attendancesPerStripe`/
 * `maxStripes`/`attendancesForExam`, so there is no second, separate
 * belt-requirement lookup to keep in sync with it.
 *
 * If `resolvePromotionTarget` returns `null` (status is `"approaching"` or
 * `"none"`), the action rejects with `{error: "notEligible"}` and writes
 * nothing — this covers both the stale-eligibility race above AND a request
 * for a student who was never actually eligible in the first place,
 * regardless of how the request was constructed.
 *
 * Unlike `updateStudent`/`archiveStudent`/`approveStudent`/
 * `regenerateStudentCode` (all scoped `updateMany` + row-count-check, since
 * a race could move/delete the row between the scope check and the write),
 * this is a plain `update` — matching Task 4's admin kiosk-token pattern
 * from Phase 3 for a similarly-shaped single-row update after an upfront
 * scope check. There is no client-submitted "which row" ambiguity here
 * beyond the `studentId` already validated against scope immediately before
 * the transaction opens, via a `findUnique` read whose result also seeds
 * this transaction's promotion target and audit `before` snapshot.
 *
 * The `Promotion` row and its `AuditLog` row are written in the SAME
 * transaction as the `Student` update, so none of the three can exist
 * without the others.
 */
export async function confirmPromotion(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const session = await requireStaffSession(["ADMIN", "DIRECTOR"]);

  const parsed = confirmPromotionSchema.safeParse(Object.fromEntries(formData.entries()));
  if (!parsed.success) {
    return { error: "invalid", fieldErrors: parsed.error.flatten().fieldErrors };
  }

  const data = parsed.data;

  const student = await prisma.student.findUnique({
    where: { id: data.studentId },
    select: { id: true, currentBelt: true, currentStripes: true, homeAcademyId: true, beltAwardedAt: true },
  });

  if (!student || !isAcademyInScope(session, student.homeAcademyId)) {
    return { error: "notFound" };
  }

  const summary = await getAtBeltSummary(student.id);
  const requirement: BeltRequirementLike = {
    attendancesPerStripe: summary.attendancesPerStripe,
    maxStripes: summary.maxStripes,
    attendancesForExam: summary.attendancesForExam,
  };
  const status = classifyEligibility(
    {
      nextStripeAt: summary.nextStripeAt,
      remainingToNextStripe: summary.remainingToNextStripe,
      examEligible: summary.examEligible,
    },
    student.currentStripes,
    requirement,
  );

  const target = resolvePromotionTarget(status, student.currentBelt, student.currentStripes);

  if (!target) {
    return { error: "notEligible" };
  }

  await prisma.$transaction(async (tx) => {
    await tx.promotion.create({
      data: {
        studentId: student.id,
        academyId: student.homeAcademyId,
        fromBelt: target.fromBelt,
        fromStripes: target.fromStripes,
        toBelt: target.toBelt,
        toStripes: target.toStripes,
        awardedById: session.userId,
        notes: data.notes || null,
      },
    });

    await tx.student.update({
      where: { id: student.id },
      data:
        target.kind === "belt"
          ? { currentBelt: target.toBelt, currentStripes: 0, beltAwardedAt: new Date() }
          : { currentStripes: target.toStripes },
    });

    await tx.auditLog.create({
      data: {
        actorId: session.userId,
        academyId: student.homeAcademyId,
        action: "student.promote",
        entityType: "Student",
        entityId: student.id,
        before: { belt: student.currentBelt, stripes: student.currentStripes },
        after: { belt: target.toBelt, stripes: target.toStripes },
      },
    });
  });

  return { ok: true };
}
