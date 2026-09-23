import type { DateTime } from "luxon";
import type { PromotionMode, StripeAccounting } from "@/generated/prisma/client";

/**
 * The pure, mode-aware calculation core. Never mutates anything; awarding is a
 * separate, explicit, manual step (docs/PROMOTION_PROGRESS_PROPOSAL.md: no
 * promotion is ever automatic - reaching a threshold means "eligible for
 * instructor review").
 *
 * Two attendance accountings, chosen per track (PromotionConfig.stripeAccounting):
 *  - PER_INTERVAL (the academy's decided rule): `promotionRelevantAttendance` is
 *    already "qualifying days since the last award" - the database query owns
 *    the interval and the one-day-counts-once rule - so every target is just
 *    that count against one threshold, and progress is 0 after every award.
 *  - CUMULATIVE (pre-activation, kept until an organization is moved over by
 *    scripts/promotion-accounting.ts): the old since-belt-anchor total, where
 *    stripe N needs N x the threshold.
 * Time-based ranks (black belt) never read the attendance count at all.
 */

export type NextTarget = "STRIPE" | "BELT" | "NONE";

export interface EngineInput {
  mode: PromotionMode;
  /** Defaults to CUMULATIVE so a caller that predates PER_INTERVAL keeps its behavior. */
  accounting?: StripeAccounting;
  currentStripes: number;
  maxStripes: number;
  /**
   * A terminal rank has no belt beyond it, ever — but it can still have real
   * degrees to progress through (e.g. black belt tracked 1st-6th). Terminal
   * + below maxStripes -> "STRIPE"; terminal + at maxStripes -> "NONE",
   * never "BELT". See resolveNextTarget.
   */
  isTerminal: boolean;
  /** Whether a next rank exists in track order. Expected to equal `!isTerminal` under a validated config, but kept as its own input so this function never has to assume validateTrackConfig already ran. */
  hasNextRank: boolean;
  /** Null only when this track has never used ATTENDANCE/HYBRID mode — see BeltRank's own doc comment. */
  attendancesPerStripe: number | null;
  attendancesForExam: number | null;
  /**
   * PER_INTERVAL: qualifying days since the last award (never negative).
   * CUMULATIVE: cumulative promotion-relevant attendance since the belt anchor;
   * can be negative (adjustments) — preserved as-is for eligibility math; only
   * `percent` is clamped for display.
   */
  promotionRelevantAttendance: number;
  /** Null only when this track has never used TIME/HYBRID mode. */
  monthsPerStripe: number | null;
  monthsForExam: number | null;
  /**
   * Months to reach degree i+1 from degree i (index = CURRENT degree count).
   * Empty/absent = every degree uses monthsPerStripe. An index beyond a
   * non-empty array, while degrees remain, is "not configured yet" - never
   * "impossible" and never an error.
   */
  stripeIntervalMonths?: number[];
  /** Null means "the last-award date is unknown" — a per-student data gap, not a config error. The result reports `timeAnchorMissing`; no due date is ever estimated. */
  timeAnchorAt: DateTime | null;
  evaluationDate: DateTime;
}

export interface EngineResult {
  nextTarget: NextTarget;
  remainingAttendance: number | null;
  dueDate: DateTime | null;
  /**
   * Null (not 0) whenever there is nothing meaningful to show progress
   * toward: MANUAL mode, or nextTarget "NONE". A 0% bar reads as "no
   * progress made," which is a different and wrong claim from "not
   * applicable" — same reasoning as remainingAttendance/dueDate being
   * nullable.
   */
  percent: number | null;
  isEligible: boolean;
  /**
   * The attendance count the current target requires, in the SAME units as
   * `promotionRelevantAttendance` (PER_INTERVAL: the interval threshold;
   * CUMULATIVE: the cumulative total). Null when there is no attendance target
   * (time-based rank, MANUAL, or nothing next). One place computes it so the
   * display consumers never rebuild it from `count + remaining` - which is wrong
   * the moment the count passes the threshold.
   */
  target: number | null;
  /** A time-based target whose last-award date is unknown: no due date, never eligible. Not an error. */
  timeAnchorMissing: boolean;
  /** A time-based degree with no configured interval yet. Not eligible, not impossible, not an error. */
  notConfigured: boolean;
}

const NO_TARGET: Pick<EngineResult, "target" | "timeAnchorMissing" | "notConfigured"> = {
  target: null,
  timeAnchorMissing: false,
  notConfigured: false,
};

/** An org-level configuration defect (missing/non-positive threshold for the active mode) — never silently treated as automatic eligibility. */
export class InvalidPromotionConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidPromotionConfigError";
  }
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}

function requirePositive(value: number | null | undefined, field: string): number {
  if (value === null || value === undefined || value <= 0) {
    throw new InvalidPromotionConfigError(`${field} must be a positive number for this track's active mode.`);
  }
  return value;
}

/**
 * Terminal + below maxStripes still progresses through real degrees
 * (STRIPE); terminal + at maxStripes stops (NONE), never BELT — there is no
 * next rank. Non-terminal + at maxStripes moves to BELT, provided a next
 * rank actually exists (defensive: a validated config always agrees on
 * isTerminal ↔ hasNextRank, but this function doesn't assume that).
 */
function resolveNextTarget(input: EngineInput): NextTarget {
  if (input.currentStripes < input.maxStripes) {
    return "STRIPE";
  }
  if (input.isTerminal || !input.hasNextRank) {
    return "NONE";
  }
  return "BELT";
}

function evaluateAttendance(input: EngineInput, nextTarget: "STRIPE" | "BELT"): EngineResult {
  const attendancesPerStripe = requirePositive(input.attendancesPerStripe, "attendancesPerStripe");
  const count = input.promotionRelevantAttendance;

  if (input.accounting === "PER_INTERVAL") {
    // The interval already reset at the last award, so a stripe/degree needs the
    // per-stripe threshold and the belt needs the exam threshold, on their own.
    const target =
      nextTarget === "STRIPE" ? attendancesPerStripe : requirePositive(input.attendancesForExam, "attendancesForExam");
    const remaining = Math.max(0, target - count);
    return {
      nextTarget,
      remainingAttendance: remaining,
      dueDate: null,
      percent: clampPercent((count / target) * 100),
      isEligible: remaining <= 0,
      ...NO_TARGET,
      target,
    };
  }

  if (nextTarget === "STRIPE") {
    const target = (input.currentStripes + 1) * attendancesPerStripe;
    const remaining = Math.max(0, target - count);
    return {
      nextTarget,
      remainingAttendance: remaining,
      dueDate: null,
      percent: clampPercent((count / target) * 100),
      isEligible: remaining <= 0,
      ...NO_TARGET,
      target,
    };
  }

  // BELT: attendance accrued since the last stripe was awarded, measured
  // against the extra exam requirement (same arithmetic as the old module's
  // attendancesIntoCurrentStripeSpan).
  const attendancesForExam = requirePositive(input.attendancesForExam, "attendancesForExam");
  const intoSpan = count - input.currentStripes * attendancesPerStripe;
  const isEligible = intoSpan >= attendancesForExam;
  return {
    nextTarget,
    remainingAttendance: isEligible ? null : Math.max(0, attendancesForExam - intoSpan),
    dueDate: null,
    percent: clampPercent((intoSpan / attendancesForExam) * 100),
    isEligible,
    ...NO_TARGET,
    target: input.currentStripes * attendancesPerStripe + attendancesForExam,
  };
}

function evaluateTime(input: EngineInput, nextTarget: "STRIPE" | "BELT"): EngineResult {
  // One-step-ahead only: the due date is always the anchor plus exactly one
  // interval, never scaled by how many intervals have actually elapsed —
  // this is what stops a delayed check from awarding several degrees at
  // once (spec: "a delayed time-based award does not automatically award
  // several degrees"). Every award writes the new anchor; this function only
  // ever answers "is the next one due yet?".
  //
  // Which interval: a rank may configure a different number of months per
  // degree (`stripeIntervalMonths`, index = current degree count). A degree
  // past the configured list is "not configured yet" - reported as such, never
  // thrown and never treated as eligible or impossible.
  const perDegree = input.stripeIntervalMonths ?? [];
  if (nextTarget === "STRIPE" && perDegree.length > 0 && input.currentStripes >= perDegree.length) {
    return { nextTarget, remainingAttendance: null, dueDate: null, percent: null, isEligible: false, ...NO_TARGET, notConfigured: true };
  }
  const monthsRequired =
    nextTarget === "STRIPE" && perDegree.length > 0
      ? requirePositive(perDegree[input.currentStripes], "stripeIntervalMonths")
      : requirePositive(
          nextTarget === "STRIPE" ? input.monthsPerStripe : input.monthsForExam,
          nextTarget === "STRIPE" ? "monthsPerStripe" : "monthsForExam",
        );

  // A per-student data gap, not a config error: without the last-award date no
  // due date exists, and none is ever estimated. Attendance progress elsewhere
  // is unaffected - this only says the time target cannot be dated yet.
  if (input.timeAnchorAt === null) {
    return { nextTarget, remainingAttendance: null, dueDate: null, percent: null, isEligible: false, ...NO_TARGET, timeAnchorMissing: true };
  }
  const dueDate = input.timeAnchorAt.plus({ months: monthsRequired });
  const isEligible = input.evaluationDate >= dueDate;
  const totalMs = dueDate.diff(input.timeAnchorAt).as("milliseconds");
  const elapsedMs = input.evaluationDate.diff(input.timeAnchorAt).as("milliseconds");
  return {
    nextTarget,
    remainingAttendance: null,
    dueDate,
    percent: totalMs > 0 ? clampPercent((elapsedMs / totalMs) * 100) : null,
    isEligible,
    ...NO_TARGET,
  };
}

function evaluateHybrid(input: EngineInput, nextTarget: "STRIPE" | "BELT"): EngineResult {
  const attendanceResult = evaluateAttendance(input, nextTarget);
  const timeResult = evaluateTime(input, nextTarget);
  return {
    nextTarget,
    remainingAttendance: attendanceResult.remainingAttendance,
    dueDate: timeResult.dueDate,
    // The limiting (further-from-done) dimension is what a director needs
    // to see — both must be satisfied, so the smaller percent is the real
    // bottleneck.
    percent: clampPercent(Math.min(attendanceResult.percent ?? 100, timeResult.percent ?? 100)),
    isEligible: attendanceResult.isEligible && timeResult.isEligible,
    target: attendanceResult.target,
    timeAnchorMissing: timeResult.timeAnchorMissing,
    notConfigured: timeResult.notConfigured,
  };
}

/**
 * Supply the resolved config/state for one student's track; get back the
 * next target and whether they're eligible now. Never mutates anything —
 * awarding is a separate, explicit step. Throws InvalidPromotionConfigError
 * for a missing/non-positive threshold the active mode needs — never silently
 * treats it as automatic eligibility (spec: "Do not silently turn invalid
 * requirements into automatic eligibility"). A time-based student with no
 * last-award date is NOT an error: the result says `timeAnchorMissing`, has no
 * due date, and is never eligible.
 */
export function evaluatePromotion(input: EngineInput): EngineResult {
  const nextTarget = resolveNextTarget(input);
  if (nextTarget === "NONE") {
    return { nextTarget, remainingAttendance: null, dueDate: null, percent: null, isEligible: false, ...NO_TARGET };
  }

  switch (input.mode) {
    case "ATTENDANCE":
      return evaluateAttendance(input, nextTarget);
    case "TIME":
      return evaluateTime(input, nextTarget);
    case "HYBRID":
      return evaluateHybrid(input, nextTarget);
    case "MANUAL":
      // Report the next target for display, but never mark automatic
      // eligibility — spec: "report the next target for display but never
      // mark automatic eligibility."
      return { nextTarget, remainingAttendance: null, dueDate: null, percent: null, isEligible: false, ...NO_TARGET };
  }
}
