"use server";

import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { StudentStatus } from "@/generated/prisma/client";
import { isAcademyInScope, requireStaffSession } from "@/lib/auth/session";
import { getAtBeltSummary } from "@/lib/students/attendance-summary";
import {
  classifyEligibility,
  resolvePromotionTarget,
  type BeltRequirementLike,
  type PromotionTarget,
} from "@/lib/students/eligibility";
import type { ActionState } from "@/lib/action-state";

const confirmPromotionSchema = z.object({
  studentId: z.string().min(1),
  notes: z.string().optional(),
});

/**
 * Thrown inside the transaction purely to roll it back when the scoped
 * `updateMany` below matched no row — i.e. the student's belt/stripes no
 * longer equal `target.fromBelt`/`target.fromStripes` at write time, because
 * a concurrent confirm (or another mutation) already changed them since this
 * call's own fresh read. Never surfaces to the caller — caught immediately
 * after the transaction and turned into a graceful `{error: "conflict"}`.
 * Matches `src/app/[locale]/(staff)/students/[id]/actions.ts`'s `StudentWriteMissError`
 * convention (a private sentinel error, never a raw exception reaching the
 * client).
 */
class PromotionConflictError extends Error {
  constructor() {
    super("PROMOTION_CONFLICT");
    this.name = "PromotionConflictError";
  }
}

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
 * `student` (read A) is re-read here purely to re-check scope — never
 * trusting a hidden form field for `homeAcademyId` — and `isAcademyInScope`
 * is re-checked against that freshly-read value. Read A's `currentBelt`/
 * `currentStripes` are deliberately NOT used for anything else: fix round 1
 * (finding I-1) found that `getAtBeltSummary` performs its OWN internal
 * `findUniqueOrThrow` (read B) to compute `nextStripeAt`/
 * `remainingToNextStripe`/`examEligible`, and the original code paired read
 * A's belt/stripes with read B's progress numbers. A concurrent write
 * between the two reads made that pairing internally inconsistent — proven
 * to regress a student's stripe count and write a false, permanent
 * `Promotion`/`AuditLog` row. Every value that feeds the eligibility
 * decision (`classifyEligibility`, `resolvePromotionTarget`) and the audit
 * `before` snapshot now comes from `summary.currentBelt`/
 * `summary.currentStripes` (read B) instead — the SAME read that produced
 * the progress numbers it's paired with.
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
 * `"none"`), or throws (the unreachable-today, admin-reconfigurable-in-the-
 * future invariant violation of an exam-eligible BLACK belt with no next
 * belt — see its own doc comment), the action rejects with
 * `{error: "notEligible"}` and writes nothing — this covers the
 * stale-eligibility race above, that invariant edge case, AND a request for
 * a student who was never actually eligible in the first place, regardless
 * of how the request was constructed.
 *
 * Finding I-2: two concurrent confirms for the same student could both read
 * the same "before" state and both successfully write under READ COMMITTED,
 * producing two duplicate `Promotion` rows for one real promotion. Guarded
 * the same way `updateStudent`/`archiveStudent`/`approveStudent`/
 * `regenerateStudentCode` guard their own races: `tx.student.update` is now
 * `tx.student.updateMany`, scoped by `id` AND the exact belt/stripe state
 * this promotion transitions FROM (`target.fromBelt`/`target.fromStripes`,
 * themselves sourced from `summary` per the I-1 fix above). Postgres
 * re-evaluates that WHERE predicate after the winning transaction's row lock
 * releases, so a losing concurrent call's `updateMany` matches zero rows —
 * that's what closes the race, not a lock this code has to manage. A
 * `count !== 1` throws `PromotionConflictError` inside the transaction,
 * rolling back all three writes (`Promotion`, `Student`, `AuditLog`) so the
 * loser produces zero side effects, never a partial or duplicate one. The
 * catch below turns it into a graceful `{error: "conflict"}`.
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

  // Read A: used ONLY for the scope check (`homeAcademyId`) and the status
  // gate immediately below. Its `currentBelt`/`currentStripes` are
  // deliberately not selected — see the doc comment above (finding I-1).
  const student = await prisma.student.findUnique({
    where: { id: data.studentId },
    select: { id: true, homeAcademyId: true, status: true },
  });

  if (!student || !isAcademyInScope(session, student.homeAcademyId)) {
    return { error: "notFound" };
  }

  // Final whole-branch review finding N-1: a PENDING student (a self-signup
  // awaiting staff approval) or an ARCHIVED student (someone who has left
  // the academy) must never be permanently promoted — `listPromotionQueue`/
  // `listApproachingStudents` already only ever surface ACTIVE students
  // (`promotion-queue.ts`'s `classifyActiveStudents`), so this is the one
  // corner the write action itself must guard, since nothing upstream does.
  // Deliberately `!== ACTIVE` rather than `=== ARCHIVED`: PENDING is equally
  // reachable (a self-signup can legitimately accrue adjustment-based
  // attendance to a threshold through ordinary staff action before anyone
  // approves them) and must be rejected too, not just ARCHIVED.
  //
  // This check alone is NOT sufficient against the stale-queue race this
  // action's whole design defends against: another staff member could
  // archive this exact student strictly between this read and the
  // transaction's write below. That half of the fix is the `status:
  // StudentStatus.ACTIVE` clause added to the `tx.student.updateMany` WHERE
  // predicate further down — the same atomic guard mechanism that already
  // closes the belt/stripe race (finding I-2), re-evaluated by Postgres
  // after this transaction's row lock is acquired, so a status change
  // racing the write is caught there and returns a graceful
  // `{error: "conflict"}`, not a corrupted promotion.
  if (student.status !== StudentStatus.ACTIVE) {
    return { error: "notActive" };
  }

  // Read B (inside getAtBeltSummary): the single source of truth for both
  // the progress numbers AND the belt/stripes they were computed against.
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
    summary.currentStripes,
    requirement,
  );

  let target: PromotionTarget | null;
  try {
    target = resolvePromotionTarget(status, summary.currentBelt, summary.currentStripes);
  } catch {
    // Invariant violation (exam-eligible with no next belt) — unreachable
    // with today's seeded requirements, but a future admin-editable
    // BLACK requirement could make it reachable. Graceful rejection instead
    // of an unhandled 500.
    return { error: "notEligible" };
  }

  if (!target) {
    return { error: "notEligible" };
  }

  // Rebound to a `const` so the closure below keeps TypeScript's narrowing
  // (a `let` captured by a nested function widens back to its declared
  // `PromotionTarget | null` type inside the closure).
  const resolvedTarget = target;

  try {
    await prisma.$transaction(async (tx) => {
      await tx.promotion.create({
        data: {
          studentId: student.id,
          academyId: student.homeAcademyId,
          fromBelt: resolvedTarget.fromBelt,
          fromStripes: resolvedTarget.fromStripes,
          toBelt: resolvedTarget.toBelt,
          toStripes: resolvedTarget.toStripes,
          awardedById: session.userId,
          notes: data.notes || null,
        },
      });

      // Scoped by id AND the exact from-state this promotion transitions
      // out of (finding I-2) — a concurrent confirm/adjustment that already
      // changed the student's belt/stripes makes this match zero rows.
      // `status: ACTIVE` closes the N-1 stale-archive/pending race: this
      // action's own upfront read (above) can never observe a status change
      // that lands strictly between that read and this write, so the
      // WHERE predicate itself is the only thing that can catch it — a
      // loser here matches zero rows exactly like a belt/stripe mismatch
      // does, and gets the same graceful `{error: "conflict"}`.
      const result = await tx.student.updateMany({
        where: {
          id: student.id,
          status: StudentStatus.ACTIVE,
          currentBelt: resolvedTarget.fromBelt,
          currentStripes: resolvedTarget.fromStripes,
        },
        data:
          resolvedTarget.kind === "belt"
            ? { currentBelt: resolvedTarget.toBelt, currentStripes: 0, beltAwardedAt: new Date() }
            : { currentStripes: resolvedTarget.toStripes },
      });

      if (result.count !== 1) {
        throw new PromotionConflictError();
      }

      await tx.auditLog.create({
        data: {
          actorId: session.userId,
          academyId: student.homeAcademyId,
          action: "student.promote",
          entityType: "Student",
          entityId: student.id,
          before: { belt: summary.currentBelt, stripes: summary.currentStripes },
          after: { belt: resolvedTarget.toBelt, stripes: resolvedTarget.toStripes },
        },
      });
    });
  } catch (error) {
    if (error instanceof PromotionConflictError) {
      return { error: "conflict" };
    }
    throw error;
  }

  return { ok: true };
}
