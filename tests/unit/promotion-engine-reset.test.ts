import { describe, expect, it } from "vitest";
import { DateTime } from "luxon";
import { evaluatePromotion, type EngineInput } from "@/lib/promotion/engine";

/**
 * docs/PROMOTION_PROGRESS_PROPOSAL.md: the academy's decided accounting.
 * Under PER_INTERVAL the count handed to the engine is ALREADY "qualifying days
 * since the last award" (the database query owns the interval), so the engine's
 * only job is threshold arithmetic with no per-stripe multiplication - progress
 * resets at every award, for stripes/degrees AND belts, adults AND kids.
 *
 * The attendance examples here (30 per stripe, 10 for kids) describe attendance
 * ranks. Black belt is time-based and is exercised separately below - nothing in
 * the attendance describe blocks describes it.
 */

const ZONE = "America/Costa_Rica";
const NOW = DateTime.fromISO("2026-06-15T12:00:00", { zone: ZONE });

function attendanceInput(overrides: Partial<EngineInput> = {}): EngineInput {
  return {
    mode: "ATTENDANCE",
    accounting: "PER_INTERVAL",
    currentStripes: 0,
    maxStripes: 4,
    isTerminal: false,
    hasNextRank: true,
    attendancesPerStripe: 30,
    attendancesForExam: 30,
    promotionRelevantAttendance: 0,
    monthsPerStripe: null,
    monthsForExam: null,
    timeAnchorAt: null,
    evaluationDate: NOW,
    ...overrides,
  };
}

describe("PER_INTERVAL attendance accounting", () => {
  it("a stripe needs exactly the per-stripe threshold, whatever stripe the student holds", () => {
    for (const currentStripes of [0, 1, 2, 3]) {
      const below = evaluatePromotion(attendanceInput({ currentStripes, promotionRelevantAttendance: 29 }));
      expect(below).toMatchObject({ nextTarget: "STRIPE", target: 30, remainingAttendance: 1, isEligible: false });

      const at = evaluatePromotion(attendanceInput({ currentStripes, promotionRelevantAttendance: 30 }));
      expect(at).toMatchObject({ nextTarget: "STRIPE", target: 30, remainingAttendance: 0, isEligible: true, percent: 100 });
    }
  });

  it("a 3-stripe imported white belt with 0 days starts at 0 of 30, not 0 of 120", () => {
    const result = evaluatePromotion(attendanceInput({ currentStripes: 3, promotionRelevantAttendance: 0 }));
    expect(result).toMatchObject({ target: 30, remainingAttendance: 30, percent: 0, isEligible: false });
  });

  it("the first qualifying day counts as 1", () => {
    const result = evaluatePromotion(attendanceInput({ promotionRelevantAttendance: 1 }));
    expect(result).toMatchObject({ target: 30, remainingAttendance: 29, isEligible: false });
  });

  it("the belt target after the last stripe needs the exam interval on its own, not stripes x threshold", () => {
    const input = { currentStripes: 4, attendancesPerStripe: 30, attendancesForExam: 30 };
    const below = evaluatePromotion(attendanceInput({ ...input, promotionRelevantAttendance: 29 }));
    expect(below).toMatchObject({ nextTarget: "BELT", target: 30, remainingAttendance: 1, isEligible: false });

    const at = evaluatePromotion(attendanceInput({ ...input, promotionRelevantAttendance: 30 }));
    expect(at).toMatchObject({ nextTarget: "BELT", target: 30, isEligible: true, percent: 100 });
  });

  it("eligible state: remaining is 0 (never null or negative) and percent is capped at 100 while the count keeps growing", () => {
    for (const nextTarget of [
      { currentStripes: 0 }, // stripe
      { currentStripes: 4 }, // belt
    ]) {
      const result = evaluatePromotion(attendanceInput({ ...nextTarget, promotionRelevantAttendance: 42 }));
      expect(result.isEligible).toBe(true);
      expect(result.remainingAttendance).toBe(0);
      expect(result.percent).toBe(100);
      expect(result.target).toBe(30);
    }
  });

  it("adult thresholds differ per belt and kids use 10 - all reset the same way", () => {
    const blue = evaluatePromotion(attendanceInput({ attendancesPerStripe: 65, attendancesForExam: 65, promotionRelevantAttendance: 64 }));
    expect(blue).toMatchObject({ target: 65, remainingAttendance: 1, isEligible: false });
    const kids = evaluatePromotion(
      attendanceInput({ attendancesPerStripe: 10, attendancesForExam: 10, currentStripes: 7, maxStripes: 11, promotionRelevantAttendance: 10 }),
    );
    expect(kids).toMatchObject({ nextTarget: "STRIPE", target: 10, remainingAttendance: 0, isEligible: true });
  });

  it("the final rank with no next rank is NONE, not a target", () => {
    const result = evaluatePromotion(attendanceInput({ currentStripes: 4, isTerminal: true, hasNextRank: false }));
    expect(result).toMatchObject({ nextTarget: "NONE", target: null, isEligible: false });
  });

  it("CUMULATIVE (the pre-activation rule) is unchanged and reports its own cumulative target", () => {
    const result = evaluatePromotion(attendanceInput({ accounting: "CUMULATIVE", currentStripes: 3, promotionRelevantAttendance: 30 }));
    expect(result).toMatchObject({ nextTarget: "STRIPE", target: 120, remainingAttendance: 90, isEligible: false });
  });
});

describe("black belt: time-based degrees with a different interval per degree", () => {
  // black -> 1: 36, 1 -> 2: 36, 2 -> 3: 36, 3 -> 4: 60, 4 -> 5: 60, 5 -> 6: 60. Degrees 7+ are NOT configured.
  const INTERVALS = [36, 36, 36, 60, 60, 60];
  const ANCHOR = DateTime.fromISO("2020-01-31T08:00:00", { zone: ZONE });

  function blackInput(overrides: Partial<EngineInput> = {}): EngineInput {
    return {
      mode: "TIME",
      accounting: "PER_INTERVAL",
      currentStripes: 0,
      maxStripes: 6,
      isTerminal: true,
      hasNextRank: false,
      attendancesPerStripe: null,
      attendancesForExam: null,
      promotionRelevantAttendance: 250, // a large attendance count must never influence a time-based degree
      monthsPerStripe: null,
      monthsForExam: null,
      stripeIntervalMonths: INTERVALS,
      timeAnchorAt: ANCHOR,
      evaluationDate: ANCHOR.plus({ months: 1 }),
      ...overrides,
    };
  }

  it("each degree uses its own interval: 36, 36, 36, 60, 60, 60 months", () => {
    INTERVALS.forEach((months, currentStripes) => {
      const notYet = evaluatePromotion(blackInput({ currentStripes, evaluationDate: ANCHOR.plus({ months }).minus({ days: 1 }) }));
      expect(notYet).toMatchObject({ nextTarget: "STRIPE", isEligible: false });
      expect(notYet.dueDate?.toMillis()).toBe(ANCHOR.plus({ months }).toMillis());

      const due = evaluatePromotion(blackInput({ currentStripes, evaluationDate: ANCHOR.plus({ months }) }));
      expect(due).toMatchObject({ nextTarget: "STRIPE", isEligible: true });
    });
  });

  it("degree 3 -> 4 needs 60 months, not 36: the interval follows the CURRENT degree", () => {
    const at36 = evaluatePromotion(blackInput({ currentStripes: 3, evaluationDate: ANCHOR.plus({ months: 36 }) }));
    expect(at36.isEligible).toBe(false);
    const at60 = evaluatePromotion(blackInput({ currentStripes: 3, evaluationDate: ANCHOR.plus({ months: 60 }) }));
    expect(at60.isEligible).toBe(true);
  });

  it("reports no attendance target or remaining count, and never uses attendance to decide", () => {
    const result = evaluatePromotion(blackInput({ promotionRelevantAttendance: 9999 }));
    expect(result).toMatchObject({ target: null, remainingAttendance: null, isEligible: false });
  });

  it("month ends clamp (January 31 plus one month is February 28/29), never overflow into March", () => {
    const result = evaluatePromotion(
      blackInput({ stripeIntervalMonths: [1], timeAnchorAt: DateTime.fromISO("2021-01-31T08:00:00", { zone: ZONE }) }),
    );
    expect(result.dueDate?.toISODate()).toBe("2021-02-28");
  });

  it("an unknown last-award date yields no due date and is never eligible - and does not throw", () => {
    const result = evaluatePromotion(blackInput({ timeAnchorAt: null }));
    expect(result).toMatchObject({ nextTarget: "STRIPE", dueDate: null, isEligible: false, timeAnchorMissing: true, percent: null });
  });

  it("degrees beyond the configured intervals are NOT CONFIGURED - not eligible, not impossible, not an error", () => {
    // maxStripes allows up to 9 degrees but only 6 intervals are configured.
    const result = evaluatePromotion(blackInput({ maxStripes: 9, currentStripes: 6 }));
    expect(result).toMatchObject({ nextTarget: "STRIPE", notConfigured: true, isEligible: false, dueDate: null });
  });

  it("at the highest degree the rank has, the target is NONE", () => {
    const result = evaluatePromotion(blackInput({ maxStripes: 6, currentStripes: 6 }));
    expect(result).toMatchObject({ nextTarget: "NONE", isEligible: false });
  });
});
