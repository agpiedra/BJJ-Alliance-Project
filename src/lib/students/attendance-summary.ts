import { prisma } from "@/lib/prisma";
import { AttendanceMatchSource, type Prisma, type PromotionMode, type Track } from "@/generated/prisma/client";
import { DateTime } from "luxon";
import { ZONE } from "@/lib/scheduling/zone";
import { evaluatePromotion, InvalidPromotionConfigError, type NextTarget } from "@/lib/promotion/engine";
import type { ResolvedTrackConfig } from "@/lib/promotion/config";
import type { BeltVisualData } from "@/components/belt-graphic/belt-graphic";

export interface AtBeltSummary {
  currentBelt: string;
  /** Phase 3a rev 19: labels are per-organization data, not `belt.<code>`
   * message keys — a caller with its own locale picks one of these two. */
  currentBeltLabelEs: string;
  currentBeltLabelEn: string;
  /** Phase 3b: the real per-rank color data for BeltGraphic/BeltBar. */
  currentBeltVisual: BeltVisualData;
  currentStripes: number;
  atBeltCount: number;
  lifetimeCount: number;
  attendancesPerStripe: number;
  maxStripes: number;
  attendancesForExam: number;
  /** MULTI_ACADEMY_AND_KIDS_BELTS.md Phase 2c-i: the engine's own vocabulary. */
  nextTarget: NextTarget;
  remainingAttendance: number | null;
  isEligible: boolean;
  /** Phase 2d: the Promociones card picks its display branch (attendance count vs. due date vs. "at the coach's discretion") from this. */
  mode: PromotionMode;
  /** Non-null only for TIME/HYBRID's active target — the engine's own dueDate, not recomputed here. */
  dueDate: Date | null;
  /**
   * Phase 2c-ii: award.ts needs the CURRENT rank's own id/order (from this
   * same read — never a separate lookup, see finding I-1's history) to
   * resolve the "to" rank for a real write: same rank (stripe award) or the
   * real next rank by track order (belt award), never eligibility.ts's old
   * hardcoded BELT_ORDER array.
   */
  currentRankId: string;
  track: Track;
  currentRankOrder: number;
}

/**
 * Which `AttendanceRecord` rows count toward belt progress.
 *
 * A class can be marked `countsTowardPromotion: false` (the seeded Saturday
 * Striking class is exactly this, and Task 9's schedule editor lets an admin
 * mark any class that way) — the flag had no consumer at all, so a Striking
 * check-in silently advanced a student's belt progress.
 *
 * `classSessionId: null` rows are manual staff adjustments (Task 8). They have
 * no class to inherit a flag from and count: they carry a human-reviewed
 * `reason` and exist precisely to correct the ledger.
 *
 * The ONE exception is `matchSource: UNMATCHED` (REDESIGN_BRIEF.md Phase 9):
 * a tap that matched no class window on a day with no classes at all, saved
 * rather than dropped so the student doesn't lose it. It is `classSessionId:
 * null` for a completely different reason than an adjustment — nobody has
 * reviewed it, and there is no evidence it corresponds to attending anything.
 * Counting it would let a portal self-check-in on a Sunday (no physical
 * presence required at all) advance a belt immediately and permanently unless
 * staff happened to notice the "Sin asignar" pill on the Kiosco page. Excluded
 * here, therefore, until a human resolves it: once staff (or the student's own
 * "¿No es esta clase?") reassign it with `Cambiar`, `classSessionId` becomes
 * non-null and the row falls under the second arm's `countsTowardPromotion`
 * check like any other check-in — review-then-count needs no further logic.
 * A manual `ADJUSTMENT` row is unaffected: `matchSource` defaults to `AUTO`
 * (prisma/schema.prisma), so only genuinely-unmatched taps are filtered.
 *
 * This filters `atBeltCount` ONLY — the one number belt math reads
 * (`nextTarget` / `remainingAttendance` / `isEligible` all derive from it).
 * It deliberately does NOT filter `lifetimeCount`, which no belt math
 * touches: its only consumer renders it as "Lifetime attendances" /
 * "Asistencias totales" on the student detail page, a plain physical-attendance
 * total. The distinction between the two counts is temporal (before vs. after
 * `beltAwardedAt`), not promotion-relevance, so hiding Striking classes from
 * the lifetime total would just make it wrong.
 *
 * The ledger itself is untouched either way — `performCheckIn` still records
 * every physical check-in, including Striking ones, because that is a true
 * attendance fact.
 */
const PROMOTION_RELEVANT: Prisma.AttendanceRecordWhereInput = {
  OR: [
    { classSessionId: null, NOT: { matchSource: AttendanceMatchSource.UNMATCHED } },
    { classSession: { countsTowardPromotion: true } },
  ],
};

/**
 * `configByTrack` — resolved ONCE per request/batch by the caller via
 * `resolvePromotionConfigMap`, never looked up in here. A lookup inside this
 * per-student function would be an N+1 on every list surface that calls it
 * for many students (the promotion queue, the roster page) — see
 * `resolvePromotionConfigMap`'s own doc comment.
 */
export async function getAtBeltSummary(
  studentId: string,
  organizationId: string,
  configByTrack: Map<Track, ResolvedTrackConfig>,
): Promise<AtBeltSummary> {
  const student = await prisma.student.findUniqueOrThrow({
    where: { id: studentId, organizationId },
    select: {
      track: true,
      currentStripes: true,
      beltAwardedAt: true,
      timeAnchorAt: true,
      // MULTI_ACADEMY_AND_KIDS_BELTS.md Phase 2: currentRankId is a required
      // FK, so the requirement row is guaranteed present — no separate
      // lookup, no per-academy override fallback (dropped; branch overrides
      // never existed in real data and are undefined anyway once a
      // student's attendance pools cross-branch into one progression), and
      // no "missing config" error path left to handle.
      currentRank: {
        select: {
          id: true,
          code: true,
          labelEs: true,
          labelEn: true,
          order: true,
          maxStripes: true,
          attendancesPerStripe: true,
          attendancesForExam: true,
          monthsPerStripe: true,
          monthsForExam: true,
          isTerminal: true,
          primaryColor: true,
          centerStripeColor: true,
          barColor: true,
          stripeColors: true,
          visibleStripeSlots: true,
        },
      },
    },
  });

  const config = configByTrack.get(student.track);
  if (!config) {
    // A genuine org-level config gap (PromotionConfig row missing for this
    // track) — never a per-student data gap, so it must never be mistaken
    // for the vanished-student P2025 case callers like promotion-queue.ts
    // rely on distinguishing. Reuses engine.ts's own error type rather than
    // inventing a third one for the same "org config is broken" concept.
    throw new InvalidPromotionConfigError(`No PromotionConfig found for organization/track ${student.track}.`);
  }

  const [atBeltAgg, lifetimeAgg] = await Promise.all([
    prisma.attendanceRecord.aggregate({
      where: { studentId, organizationId, occurredAt: { gte: student.beltAwardedAt }, ...PROMOTION_RELEVANT },
      _sum: { delta: true },
    }),
    // Unfiltered on purpose: every physical attendance ever, promotion-relevant
    // or not (see PROMOTION_RELEVANT's comment).
    prisma.attendanceRecord.aggregate({
      where: { studentId, organizationId },
      _sum: { delta: true },
    }),
  ]);

  const atBeltCount = atBeltAgg._sum.delta ?? 0;
  const lifetimeCount = lifetimeAgg._sum.delta ?? 0;

  // attendancesPerStripe/attendancesForExam are nullable on BeltRank (null
  // only means "this track has never used ATTENDANCE/HYBRID mode" — see
  // BeltRank's schema doc comment); every seeded rank today is ATTENDANCE,
  // so these are populated except BLACK's terminal 0/0. evaluatePromotion
  // itself gets the raw nullable values — BLACK short-circuits to "NONE"
  // before either field is ever read, so the null-vs-0 distinction never
  // matters for real data; the ??-to-0 here is purely for this function's
  // own display-oriented output fields.
  const attendancesPerStripe = student.currentRank.attendancesPerStripe ?? 0;
  const attendancesForExam = student.currentRank.attendancesForExam ?? 0;

  const engineResult = evaluatePromotion({
    mode: config.mode,
    currentStripes: student.currentStripes,
    maxStripes: student.currentRank.maxStripes,
    isTerminal: student.currentRank.isTerminal,
    hasNextRank: !student.currentRank.isTerminal,
    attendancesPerStripe: student.currentRank.attendancesPerStripe,
    attendancesForExam: student.currentRank.attendancesForExam,
    promotionRelevantAttendance: atBeltCount,
    monthsPerStripe: student.currentRank.monthsPerStripe,
    monthsForExam: student.currentRank.monthsForExam,
    timeAnchorAt: student.timeAnchorAt ? DateTime.fromJSDate(student.timeAnchorAt, { zone: ZONE }) : null,
    evaluationDate: DateTime.now().setZone(ZONE),
  });

  return {
    currentBelt: student.currentRank.code,
    currentBeltLabelEs: student.currentRank.labelEs,
    currentBeltLabelEn: student.currentRank.labelEn,
    currentBeltVisual: {
      primaryColor: student.currentRank.primaryColor,
      centerStripeColor: student.currentRank.centerStripeColor,
      barColor: student.currentRank.barColor,
      stripeColors: student.currentRank.stripeColors,
      maxStripes: student.currentRank.maxStripes,
      visibleStripeSlots: student.currentRank.visibleStripeSlots,
    },
    currentStripes: student.currentStripes,
    atBeltCount,
    lifetimeCount,
    attendancesPerStripe,
    maxStripes: student.currentRank.maxStripes,
    attendancesForExam,
    nextTarget: engineResult.nextTarget,
    remainingAttendance: engineResult.remainingAttendance,
    isEligible: engineResult.isEligible,
    mode: config.mode,
    dueDate: engineResult.dueDate ? engineResult.dueDate.toJSDate() : null,
    currentRankId: student.currentRank.id,
    track: student.track,
    currentRankOrder: student.currentRank.order,
  };
}
