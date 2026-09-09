import { describe, expect, it } from "vitest";
import {
  computeBeltProgress,
  classifyEligibility,
  resolvePromotionTarget,
  nextBelt,
  BELT_ORDER,
} from "@/lib/students/eligibility";

const WHITE_REQ = { attendancesPerStripe: 30, maxStripes: 4, attendancesForExam: 30 };
const BLACK_REQ = { attendancesPerStripe: 0, maxStripes: 0, attendancesForExam: 0 };

describe("computeBeltProgress", () => {
  it("one attendance below the first stripe threshold", () => {
    const p = computeBeltProgress(29, 0, WHITE_REQ);
    expect(p.remainingToNextStripe).toBe(1);
    expect(p.examEligible).toBe(false);
  });

  it("exact threshold for the first stripe", () => {
    const p = computeBeltProgress(30, 0, WHITE_REQ);
    expect(p.remainingToNextStripe).toBe(0);
    expect(p.examEligible).toBe(false);
  });

  it("one attendance above the first stripe threshold", () => {
    const p = computeBeltProgress(31, 0, WHITE_REQ);
    expect(p.remainingToNextStripe).toBe(0);
  });

  it("4th stripe boundary: exact threshold for the 4th stripe", () => {
    const p = computeBeltProgress(120, 3, WHITE_REQ);
    expect(p.remainingToNextStripe).toBe(0);
    expect(p.examEligible).toBe(false);
  });

  it("at max stripes, one attendance below the exam threshold", () => {
    const p = computeBeltProgress(149, 4, WHITE_REQ);
    expect(p.examEligible).toBe(false);
    expect(p.remainingToNextStripe).toBe(1);
  });

  it("at max stripes, exact exam threshold", () => {
    const p = computeBeltProgress(150, 4, WHITE_REQ);
    expect(p.examEligible).toBe(true);
    expect(p.remainingToNextStripe).toBeNull();
  });

  it("at max stripes, above the exam threshold", () => {
    const p = computeBeltProgress(160, 4, WHITE_REQ);
    expect(p.examEligible).toBe(true);
  });

  it("Black belt: terminal, no stripe/exam signal ever, regardless of count", () => {
    const p = computeBeltProgress(99999, 0, BLACK_REQ);
    expect(p.remainingToNextStripe).toBeNull();
    expect(p.examEligible).toBe(false);
    expect(p.nextStripeAt).toBeNull();
  });
});

describe("classifyEligibility", () => {
  it("returns stripe-eligible exactly at a stripe threshold", () => {
    const progress = computeBeltProgress(30, 0, WHITE_REQ);
    expect(classifyEligibility(progress, 0, WHITE_REQ)).toBe("stripe-eligible");
  });

  it("returns exam-eligible exactly at the exam threshold", () => {
    const progress = computeBeltProgress(150, 4, WHITE_REQ);
    expect(classifyEligibility(progress, 4, WHITE_REQ)).toBe("exam-eligible");
  });

  it("returns approaching within the default 5-attendance window, not eligible", () => {
    const progress = computeBeltProgress(26, 0, WHITE_REQ); // 4 remaining
    expect(classifyEligibility(progress, 0, WHITE_REQ)).toBe("approaching");
  });

  it("returns none when far from any threshold", () => {
    const progress = computeBeltProgress(10, 0, WHITE_REQ); // 20 remaining
    expect(classifyEligibility(progress, 0, WHITE_REQ)).toBe("none");
  });

  it("a negative adjustment dropping a student back below an already-crossed threshold reverts to none/approaching", () => {
    // Student was at 30 (stripe-eligible); a -3 adjustment drops atBeltCount to 27.
    const progress = computeBeltProgress(27, 0, WHITE_REQ); // 3 remaining
    expect(classifyEligibility(progress, 0, WHITE_REQ)).toBe("approaching");
  });

  it("Black belt never classifies as eligible or approaching, however high the count", () => {
    const progress = computeBeltProgress(99999, 0, BLACK_REQ);
    expect(classifyEligibility(progress, 0, BLACK_REQ)).toBe("none");
  });
});

describe("nextBelt / BELT_ORDER", () => {
  it("advances through the real order", () => {
    expect(nextBelt("WHITE")).toBe("BLUE");
    expect(nextBelt("BROWN")).toBe("BLACK");
  });

  it("Black has no next belt", () => {
    expect(nextBelt("BLACK")).toBeNull();
  });

  it("BELT_ORDER matches the spec's exact sequence", () => {
    expect(BELT_ORDER).toEqual(["WHITE", "BLUE", "PURPLE", "BROWN", "BLACK"]);
  });
});

describe("resolvePromotionTarget", () => {
  it("stripe-eligible resolves to a same-belt stripe increment", () => {
    const target = resolvePromotionTarget("stripe-eligible", "WHITE", 1);
    expect(target).toEqual({ fromBelt: "WHITE", fromStripes: 1, toBelt: "WHITE", toStripes: 2, kind: "stripe" });
  });

  it("exam-eligible resolves to the next belt at 0 stripes", () => {
    const target = resolvePromotionTarget("exam-eligible", "WHITE", 4);
    expect(target).toEqual({ fromBelt: "WHITE", fromStripes: 4, toBelt: "BLUE", toStripes: 0, kind: "belt" });
  });

  it("approaching resolves to null — not actually confirmable yet", () => {
    expect(resolvePromotionTarget("approaching", "WHITE", 0)).toBeNull();
  });

  it("none resolves to null", () => {
    expect(resolvePromotionTarget("none", "WHITE", 0)).toBeNull();
  });
});
