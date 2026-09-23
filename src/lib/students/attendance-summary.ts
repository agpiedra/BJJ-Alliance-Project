import { prisma } from "@/lib/prisma";
import {
  AttendanceMatchSource,
  type Prisma,
  type ProgressBaselineKind,
  type PromotionMode,
  type StripeAccounting,
  type Track,
} from "@/generated/prisma/client";
import { DateTime } from "luxon";
import { ZONE } from "@/lib/scheduling/zone";
import { evaluatePromotion, InvalidPromotionConfigError, type NextTarget } from "@/lib/promotion/engine";
import { sumPromotionCredits } from "@/lib/promotion/credit";
import { listContributingDays, type ContributingDay } from "@/lib/promotion/progress-days";
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
  /** Real attendance since beltAwardedAt PLUS any PromotionCredit granted for
   * this same belt period (Phase 3d) — "the one number belt math reads," per
   * this field's own long-standing framing below; every progress-bar
   * reconstruction across the app (`current: atBeltCount, target: atBeltCount
   * + remainingAttendance`) already treats it this way, so folding the
   * credit in here (rather than a separate field) needs no changes anywhere
   * else. `creditedClasses` below is the same number broken out on its own,
   * purely for explicit display — never silently blended into copy that
   * says "attendances." */
  atBeltCount: number;
  /** The portion of `atBeltCount` above that came from a PromotionCredit
   * grant for the CURRENT belt period, not a real check-in. Zero for an
   * uncredited student — structurally identical to "no credit," since no
   * PromotionCredit row exists to sum in that case. */
  creditedClasses: number;
  lifetimeCount: number;
  attendancesPerStripe: number;
  maxStripes: number;
  attendancesForExam: number;
  /** MULTI_ACADEMY_AND_KIDS_BELTS.md Phase 2c-i: the engine's own vocabulary. */
  nextTarget: NextTarget;
  remainingAttendance: number | null;
  /** "Eligible for instructor review" - never an automatic award. */
  isEligible: boolean;
  /** Which accounting produced `atBeltCount` (see PromotionConfig.stripeAccounting). */
  accounting: StripeAccounting;
  /**
   * What `atBeltCount` is measured against, from the engine - the ONLY place a
   * display target comes from. Null for a time-based degree, MANUAL, or nothing
   * next. Consumers must not rebuild it as `atBeltCount + remainingAttendance`:
   * that is wrong the moment the count passes the threshold.
   */
  target: number | null;
  /** The engine's own progress percentage, already clamped to 0..100; null when there is nothing meaningful to show progress toward. */
  percent: number | null;
  /** Time-based target, last-award date unknown: no due date, never eligible. */
  timeAnchorMissing: boolean;
  /** Time-based degree whose interval is not configured yet (not "impossible"). */
  notConfigured: boolean;
  /**
   * PER_INTERVAL only, and only once the threshold is reached: the Costa Rica
   * ledger day (`YYYY-MM-DD`) of the qualifying day that reached it - RECALCULATED
   * from current records on every read, never stored, and never used to decide an
   * award (awards re-evaluate live). Null otherwise.
   */
  reachedOn: string | null;
  /** Start of the current PER_INTERVAL interval and where it came from (the award instant, or the system's tracking baseline). */
  progressBaselineAt: Date;
  progressBaselineKind: ProgressBaselineKind;
  /** The EFFECTIVE mode for this student's rank (the rank's own `progressionMode`, else the track's) - the Promociones card picks its display branch (attendance count vs. due date vs. "at the coach's discretion") from this. */
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

/** The guarded client or a transaction on it - the award path evaluates inside its own transaction. */
type ProgressClient = Pick<typeof prisma, "student" | "attendanceRecord" | "promotionCredit" | "$queryRaw">;

export interface EvaluateOptions {
  /**
   * Evaluate AS OF this instant: it is the time-based evaluation date AND the
   * exclusive upper bound of the qualifying days (PER_INTERVAL). The award path
   * passes the award boundary so eligibility and the audited evidence describe
   * exactly the interval being closed. Omitted = now, unbounded.
   */
  at?: Date;
}

/**
 * The one evaluation path: every surface that shows or decides progress (staff
 * list, student page, portal, kiosk, dashboard, analytics, the award itself)
 * reads its result, so none of them recomputes a target of its own.
 *
 * Also returns the qualifying days behind the count (PER_INTERVAL) - the audited
 * evidence an award records. A caller that does not need them ignores the field.
 */
export async function evaluateStudentProgress(
  client: ProgressClient,
  studentId: string,
  organizationId: string,
  configByTrack: Map<Track, ResolvedTrackConfig>,
  options: EvaluateOptions = {},
): Promise<{ summary: AtBeltSummary; days: ContributingDay[] }> {
  const student = await client.student.findUniqueOrThrow({
    where: { id: studentId, organizationId },
    select: {
      track: true,
      currentStripes: true,
      beltAwardedAt: true,
      timeAnchorAt: true,
      progressBaselineAt: true,
      progressBaselineKind: true,
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
          progressionMode: true,
          stripeIntervalMonths: true,
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

  const perInterval = config.accounting === "PER_INTERVAL";
  // The rank may override the track's mode (adult white-brown attendance, black time).
  const mode = student.currentRank.progressionMode ?? config.mode;

  let atBeltCount: number;
  let creditedClasses = 0;
  let days: ContributingDay[] = [];
  if (perInterval) {
    // Qualifying days since the last award, one per CR calendar day. Legacy credits
    // and arbitrary +/- adjustments are deliberately NOT read (academy decision:
    // no head-start credits, no arbitrary progress credit).
    days = await listContributingDays(client, {
      studentId,
      organizationId,
      from: student.progressBaselineAt,
      until: options.at,
    });
    atBeltCount = days.length;
  } else {
    const [atBeltAgg, credited] = await Promise.all([
      client.attendanceRecord.aggregate({
        where: { studentId, organizationId, occurredAt: { gte: student.beltAwardedAt }, ...PROMOTION_RELEVANT },
        _sum: { delta: true },
      }),
      // Phase 3d: scoped to the CURRENT belt period only — see PromotionCredit's
      // own schema doc comment for why a credit from a since-superseded belt
      // period is excluded by this query alone.
      sumPromotionCredits(studentId, organizationId, student.beltAwardedAt),
    ]);
    creditedClasses = credited;
    // atBeltCount folds the credit in — every existing progress-bar consumer
    // already treats it as "the number belt math reads", not a strict
    // physical-attendance count.
    atBeltCount = (atBeltAgg._sum.delta ?? 0) + creditedClasses;
  }

  // Unfiltered on purpose: every physical attendance ever, promotion-relevant
  // or not (see PROMOTION_RELEVANT's comment). Never touches PromotionCredit —
  // a real, physical-attendance total, per this field's own doc comment.
  const lifetimeAgg = await client.attendanceRecord.aggregate({
    where: { studentId, organizationId },
    _sum: { delta: true },
  });
  const lifetimeCount = lifetimeAgg._sum.delta ?? 0;

  // attendancesPerStripe/attendancesForExam are nullable on BeltRank (null
  // only means "this rank has never used ATTENDANCE/HYBRID mode" — a
  // time-based black belt has none); the ??-to-0 here is purely for this
  // function's own display-oriented output fields. evaluatePromotion itself
  // gets the raw nullable values.
  const attendancesPerStripe = student.currentRank.attendancesPerStripe ?? 0;
  const attendancesForExam = student.currentRank.attendancesForExam ?? 0;

  const evaluationDate = DateTime.fromJSDate(options.at ?? new Date(), { zone: ZONE });
  const engineResult = evaluatePromotion({
    mode,
    accounting: config.accounting,
    currentStripes: student.currentStripes,
    maxStripes: student.currentRank.maxStripes,
    isTerminal: student.currentRank.isTerminal,
    hasNextRank: !student.currentRank.isTerminal,
    attendancesPerStripe: student.currentRank.attendancesPerStripe,
    attendancesForExam: student.currentRank.attendancesForExam,
    promotionRelevantAttendance: atBeltCount,
    monthsPerStripe: student.currentRank.monthsPerStripe,
    monthsForExam: student.currentRank.monthsForExam,
    stripeIntervalMonths: student.currentRank.stripeIntervalMonths,
    timeAnchorAt: student.timeAnchorAt ? DateTime.fromJSDate(student.timeAnchorAt, { zone: ZONE }) : null,
    evaluationDate,
  });

  const reachedOn =
    perInterval && engineResult.target !== null && atBeltCount >= engineResult.target
      ? (days[engineResult.target - 1]?.day ?? null)
      : null;

  return {
    days,
    summary: {
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
      creditedClasses,
      lifetimeCount,
      attendancesPerStripe,
      maxStripes: student.currentRank.maxStripes,
      attendancesForExam,
      nextTarget: engineResult.nextTarget,
      remainingAttendance: engineResult.remainingAttendance,
      isEligible: engineResult.isEligible,
      accounting: config.accounting,
      target: engineResult.target,
      percent: engineResult.percent,
      timeAnchorMissing: engineResult.timeAnchorMissing,
      notConfigured: engineResult.notConfigured,
      reachedOn,
      progressBaselineAt: student.progressBaselineAt,
      progressBaselineKind: student.progressBaselineKind,
      mode,
      dueDate: engineResult.dueDate ? engineResult.dueDate.toJSDate() : null,
      currentRankId: student.currentRank.id,
      track: student.track,
      currentRankOrder: student.currentRank.order,
    },
  };
}

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
  return (await evaluateStudentProgress(prisma, studentId, organizationId, configByTrack)).summary;
}
