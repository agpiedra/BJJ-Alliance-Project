import { describe, expect, it } from "vitest";
import { visibleTapes, type TapeRank } from "@/lib/belt-display";

/**
 * MULTI_ACADEMY_AND_KIDS_BELTS.md's own worked-examples table (Phase 3,
 * "Belt rendering"), kids Grey: maxStripes 11, tapes [W,W,W,W,R,R,R,R,G,G,G],
 * 4 visible slots. Single-letter placeholder colors, exactly as the spec
 * table itself writes them — visibleTapes() is a pure rolling-window
 * derivation over whatever strings it's given, so the real hex palette
 * (white/red/yellow, per revision 21) is irrelevant to this test; what
 * matters is the row of colors and the window that slides over it.
 */
const GREY: TapeRank = {
  stripeColors: ["W", "W", "W", "W", "R", "R", "R", "R", "G", "G", "G"],
  maxStripes: 11,
  visibleStripeSlots: 4,
};

describe("visibleTapes — worked examples table (kids Grey, 11 degrees, 4 slots)", () => {
  it.each([
    [3, ["W", "W", "W"]],
    [4, ["W", "W", "W", "W"]],
    [5, ["W", "W", "W", "R"]],
    [6, ["W", "W", "R", "R"]],
    [8, ["R", "R", "R", "R"]],
    [9, ["R", "R", "R", "G"]],
    [11, ["R", "G", "G", "G"]],
  ])("degree %i reads as %j", (degrees, expected) => {
    expect(visibleTapes(GREY, degrees)).toEqual(expected);
  });
});

describe("visibleTapes — the 5-degree ranks (white, grey_white)", () => {
  const FIVE_DEGREE: TapeRank = { stripeColors: ["W", "W", "W", "W", "R"], maxStripes: 5, visibleStripeSlots: 4 };

  it("degree 4: bar full of white", () => {
    expect(visibleTapes(FIVE_DEGREE, 4)).toEqual(["W", "W", "W", "W"]);
  });

  it("degree 5: the first white is replaced by red, matching a real belt's 5th tape wrapped over the 1st", () => {
    expect(visibleTapes(FIVE_DEGREE, 5)).toEqual(["W", "W", "W", "R"]);
  });
});

describe("visibleTapes — defensive validation", () => {
  it("degree 0 draws nothing", () => {
    expect(visibleTapes(GREY, 0)).toEqual([]);
  });

  it("a negative degree draws nothing", () => {
    expect(visibleTapes(GREY, -3)).toEqual([]);
  });

  it("a non-integer degree draws nothing", () => {
    expect(visibleTapes(GREY, 2.5)).toEqual([]);
  });

  it("a degree above maxStripes clamps to the belt's last real degree, not out-of-range slots", () => {
    // 15 > maxStripes (11) — must read exactly like degree 11, never crash
    // or draw more than visibleStripeSlots.
    expect(visibleTapes(GREY, 15)).toEqual(["R", "G", "G", "G"]);
  });

  it.each([
    ["zero", 0],
    ["negative", -1],
    ["non-integer", 2.5],
  ])("a malformed visibleStripeSlots (%s) falls back to the default of 4", (_label, visibleStripeSlots) => {
    const malformed: TapeRank = { ...GREY, visibleStripeSlots };
    expect(visibleTapes(malformed, 11)).toEqual(["R", "G", "G", "G"]);
  });
});
