import { describe, expect, it } from "vitest";
import { DateTime } from "luxon";
import {
  evaluatePromotion,
  InvalidPromotionConfigError,
  MissingTimeAnchorError,
  type EngineInput,
} from "@/lib/promotion/engine";

const ZONE = "America/Costa_Rica";
const NOW = DateTime.fromISO("2026-06-15T12:00:00", { zone: ZONE });

/** Sensible non-terminal-rank defaults; each test overrides only what it's exercising. */
function baseInput(overrides: Partial<EngineInput> = {}): EngineInput {
  return {
    mode: "ATTENDANCE",
    currentStripes: 0,
    maxStripes: 4,
    isTerminal: false,
    hasNextRank: true,
    attendancesPerStripe: 30,
    attendancesForExam: 30,
    promotionRelevantAttendance: 0,
    monthsPerStripe: 2,
    monthsForExam: 2,
    timeAnchorAt: NOW,
    evaluationDate: NOW,
    ...overrides,
  };
}

describe("ATTENDANCE mode", () => {
  it("STRIPE target: below, at, and above the per-stripe threshold", () => {
    const below = evaluatePromotion(baseInput({ promotionRelevantAttendance: 29 }));
    expect(below).toMatchObject({ nextTarget: "STRIPE", remainingAttendance: 1, isEligible: false });

    const at = evaluatePromotion(baseInput({ promotionRelevantAttendance: 30 }));
    expect(at).toMatchObject({ nextTarget: "STRIPE", remainingAttendance: 0, isEligible: true, percent: 100 });

    const above = evaluatePromotion(baseInput({ promotionRelevantAttendance: 31 }));
    expect(above).toMatchObject({ nextTarget: "STRIPE", remainingAttendance: 0, isEligible: true });
  });

  it("BELT target: below, at, and above the exam threshold, once at maxStripes", () => {
    const input = { currentStripes: 4, maxStripes: 4, attendancesPerStripe: 30, attendancesForExam: 30 };
    // attendancesIntoCurrentStripeSpan = attendance - 4*30
    const below = evaluatePromotion(baseInput({ ...input, promotionRelevantAttendance: 149 }));
    expect(below).toMatchObject({ nextTarget: "BELT", remainingAttendance: 1, isEligible: false });

    const at = evaluatePromotion(baseInput({ ...input, promotionRelevantAttendance: 150 }));
    expect(at).toMatchObject({ nextTarget: "BELT", remainingAttendance: null, isEligible: true, percent: 100 });

    const above = evaluatePromotion(baseInput({ ...input, promotionRelevantAttendance: 151 }));
    expect(above).toMatchObject({ nextTarget: "BELT", remainingAttendance: null, isEligible: true });
  });

  it("negative attendance: percent clamps to 0, eligibility computed from the raw (negative) total", () => {
    const result = evaluatePromotion(baseInput({ promotionRelevantAttendance: -10 }));
    expect(result.percent).toBe(0);
    expect(result.isEligible).toBe(false);
    expect(result.remainingAttendance).toBe(40); // 30 - (-10)
  });

  it("throws InvalidPromotionConfigError when attendancesPerStripe is missing", () => {
    expect(() => evaluatePromotion(baseInput({ attendancesPerStripe: null }))).toThrow(InvalidPromotionConfigError);
  });

  it("throws InvalidPromotionConfigError when attendancesForExam is missing at the BELT boundary", () => {
    expect(() =>
      evaluatePromotion(baseInput({ currentStripes: 4, maxStripes: 4, attendancesForExam: null, promotionRelevantAttendance: 200 })),
    ).toThrow(InvalidPromotionConfigError);
  });
});

describe("TIME mode", () => {
  const anchor = DateTime.fromISO("2026-01-15T12:00:00", { zone: ZONE });

  it("STRIPE target: due date is anchor + monthsPerStripe calendar months, not a 30-day approximation", () => {
    const dueDate = anchor.plus({ months: 2 });
    const before = evaluatePromotion(
      baseInput({ mode: "TIME", timeAnchorAt: anchor, evaluationDate: dueDate.minus({ days: 1 }) }),
    );
    expect(before.isEligible).toBe(false);
    expect(before.dueDate?.toMillis()).toBe(dueDate.toMillis());

    const atDue = evaluatePromotion(baseInput({ mode: "TIME", timeAnchorAt: anchor, evaluationDate: dueDate }));
    expect(atDue.isEligible).toBe(true);
  });

  it("a delayed check (many months overdue) still reports a single-interval due date, not a scaled one — one-step-ahead only", () => {
    const wayLate = anchor.plus({ months: 8 });
    const result = evaluatePromotion(baseInput({ mode: "TIME", timeAnchorAt: anchor, evaluationDate: wayLate }));
    expect(result.dueDate?.toMillis()).toBe(anchor.plus({ months: 2 }).toMillis());
    expect(result.isEligible).toBe(true);
  });

  it("throws MissingTimeAnchorError when the student has no time anchor", () => {
    expect(() => evaluatePromotion(baseInput({ mode: "TIME", timeAnchorAt: null }))).toThrow(MissingTimeAnchorError);
  });

  it("throws InvalidPromotionConfigError when monthsPerStripe is missing", () => {
    expect(() => evaluatePromotion(baseInput({ mode: "TIME", monthsPerStripe: null }))).toThrow(
      InvalidPromotionConfigError,
    );
  });
});

describe("HYBRID mode", () => {
  const anchor = DateTime.fromISO("2026-01-15T12:00:00", { zone: ZONE });

  it("requires BOTH attendance and time conditions — either alone is not enough", () => {
    // Attendance satisfied, time not yet.
    const attendanceOnly = evaluatePromotion(
      baseInput({
        mode: "HYBRID",
        promotionRelevantAttendance: 30,
        timeAnchorAt: anchor,
        evaluationDate: anchor.plus({ days: 1 }),
      }),
    );
    expect(attendanceOnly.isEligible).toBe(false);

    // Both satisfied.
    const both = evaluatePromotion(
      baseInput({
        mode: "HYBRID",
        promotionRelevantAttendance: 30,
        timeAnchorAt: anchor,
        evaluationDate: anchor.plus({ months: 2 }),
      }),
    );
    expect(both.isEligible).toBe(true);
  });

  it("percent reflects the limiting (further-from-done) dimension", () => {
    const result = evaluatePromotion(
      baseInput({
        mode: "HYBRID",
        promotionRelevantAttendance: 15, // 50% of 30
        timeAnchorAt: anchor,
        evaluationDate: anchor.plus({ months: 2 }), // 100% of time
      }),
    );
    expect(result.percent).toBe(50);
  });
});

describe("MANUAL mode", () => {
  it("reports nextTarget for display but percent/remaining/dueDate are null and isEligible is always false", () => {
    const result = evaluatePromotion(baseInput({ mode: "MANUAL", promotionRelevantAttendance: 1000 }));
    expect(result.nextTarget).toBe("STRIPE");
    expect(result.percent).toBeNull();
    expect(result.remainingAttendance).toBeNull();
    expect(result.dueDate).toBeNull();
    expect(result.isEligible).toBe(false);
  });
});

describe("terminal rank semantics", () => {
  it("BUG FIX: a terminal rank below maxStripes still reports STRIPE (not frozen at NONE)", () => {
    const result = evaluatePromotion(
      baseInput({ isTerminal: true, hasNextRank: false, maxStripes: 6, currentStripes: 3, promotionRelevantAttendance: 0 }),
    );
    expect(result.nextTarget).toBe("STRIPE");
  });

  it("a terminal rank AT maxStripes reports NONE, never BELT", () => {
    const result = evaluatePromotion(
      baseInput({ isTerminal: true, hasNextRank: false, maxStripes: 6, currentStripes: 6, promotionRelevantAttendance: 10_000 }),
    );
    expect(result.nextTarget).toBe("NONE");
    expect(result.percent).toBeNull();
    expect(result.isEligible).toBe(false);
  });

  it("Alliance's real BLACK shape (maxStripes 0) is NONE immediately", () => {
    const result = evaluatePromotion(
      baseInput({ isTerminal: true, hasNextRank: false, maxStripes: 0, currentStripes: 0, attendancesPerStripe: null, attendancesForExam: null }),
    );
    expect(result.nextTarget).toBe("NONE");
  });

  it("a non-terminal rank with no next rank (defensive, invalid-config edge case) resolves to NONE rather than throwing", () => {
    const result = evaluatePromotion(baseInput({ currentStripes: 4, maxStripes: 4, hasNextRank: false }));
    expect(result.nextTarget).toBe("NONE");
  });
});
