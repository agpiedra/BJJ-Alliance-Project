import type { DateTime } from "luxon";
import type { PromotionMode } from "@/generated/prisma/client";

/**
 * MULTI_ACADEMY_AND_KIDS_BELTS.md Phase 2b — the pure, mode-aware calculation
 * core. Not wired to a caller yet (that's Phase 2c: the approval queue and
 * awarding actions migrate off eligibility.ts onto this). eligibility.ts is
 * kept until then — see this file's characterization test
 * (tests/unit/promotion-engine-characterization.test.ts), which must stay
 * green in CI for the whole time both implementations coexist so they can't
 * silently diverge. eligibility.ts and the characterization test are deleted
 * together, in the same commit, once Phase 2c migrates its last caller.
 */

export type NextTarget = "STRIPE" | "BELT" | "NONE";

export interface EngineInput {
  mode: PromotionMode;
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
  /** Cumulative promotion-relevant attendance since the belt anchor. Can be negative (adjustments) — preserved as-is for eligibility math; only `percent` is clamped for display. */
  promotionRelevantAttendance: number;
  /** Null only when this track has never used TIME/HYBRID mode. */
  monthsPerStripe: number | null;
  monthsForExam: number | null;
  /** Null means "this student has no time anchor yet" — a per-student data gap, not a config error. See MissingTimeAnchorError. */
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
}

/** An org-level configuration defect (missing/non-positive threshold for the active mode) — never silently treated as automatic eligibility. */
export class InvalidPromotionConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidPromotionConfigError";
  }
}

/**
 * Per-student data gap (a TIME/HYBRID track student with no timeAnchorAt),
 * not an org config defect — distinctly typed so a caller evaluating many
 * students (e.g. the approval queue) can skip just that one row rather than
 * failing the whole batch the way InvalidPromotionConfigError should.
 */
export class MissingTimeAnchorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MissingTimeAnchorError";
  }
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}

function requirePositive(value: number | null, field: string): number {
  if (value === null || value <= 0) {
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

  if (nextTarget === "STRIPE") {
    const target = (input.currentStripes + 1) * attendancesPerStripe;
    const remaining = Math.max(0, target - input.promotionRelevantAttendance);
    return {
      nextTarget,
      remainingAttendance: remaining,
      dueDate: null,
      percent: clampPercent((input.promotionRelevantAttendance / target) * 100),
      isEligible: remaining <= 0,
    };
  }

  // BELT: attendance accrued since the last stripe was awarded, measured
  // against the extra exam requirement (same arithmetic as the old module's
  // attendancesIntoCurrentStripeSpan).
  const attendancesForExam = requirePositive(input.attendancesForExam, "attendancesForExam");
  const intoSpan = input.promotionRelevantAttendance - input.currentStripes * attendancesPerStripe;
  const isEligible = intoSpan >= attendancesForExam;
  return {
    nextTarget,
    remainingAttendance: isEligible ? null : Math.max(0, attendancesForExam - intoSpan),
    dueDate: null,
    percent: clampPercent((intoSpan / attendancesForExam) * 100),
    isEligible,
  };
}

function evaluateTime(input: EngineInput, nextTarget: "STRIPE" | "BELT"): EngineResult {
  if (input.timeAnchorAt === null) {
    throw new MissingTimeAnchorError("Student has no timeAnchorAt configured for a TIME/HYBRID track.");
  }
  // One-step-ahead only: the due date is always the anchor plus exactly one
  // interval, never scaled by how many intervals have actually elapsed —
  // this is what stops a delayed check from awarding several degrees at
  // once (spec: "a delayed time-based award does not automatically award
  // several degrees"). Whoever awards the stripe advances timeAnchorAt to
  // start the next interval; this function only ever answers "is the next
  // one due yet?".
  const monthsRequired = requirePositive(
    nextTarget === "STRIPE" ? input.monthsPerStripe : input.monthsForExam,
    nextTarget === "STRIPE" ? "monthsPerStripe" : "monthsForExam",
  );
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
  };
}

/**
 * Supply the resolved config/state for one student's track; get back the
 * next target and whether they're eligible now. Never mutates anything —
 * awarding (Phase 2c) is a separate, explicit step. Throws
 * InvalidPromotionConfigError for a missing/non-positive threshold the
 * active mode needs, and MissingTimeAnchorError for a TIME/HYBRID student
 * with no timeAnchorAt — never silently treats either as automatic
 * eligibility (spec: "Do not silently turn invalid requirements into
 * automatic eligibility").
 */
export function evaluatePromotion(input: EngineInput): EngineResult {
  const nextTarget = resolveNextTarget(input);
  if (nextTarget === "NONE") {
    return { nextTarget, remainingAttendance: null, dueDate: null, percent: null, isEligible: false };
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
      return { nextTarget, remainingAttendance: null, dueDate: null, percent: null, isEligible: false };
  }
}
