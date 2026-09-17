import "dotenv/config";
import { describe, expect, it } from "vitest";
import { resolveDefaultTrackChangeRankId } from "../../src/lib/promotion/track-change";

const ADULT_RANKS = [
  { id: "adult-white", code: "WHITE" },
  { id: "adult-blue", code: "BLUE" },
  { id: "adult-purple", code: "PURPLE" },
];

describe("resolveDefaultTrackChangeRankId", () => {
  it("preselects adult BLUE for a KIDS student at exactly green_black", () => {
    expect(resolveDefaultTrackChangeRankId("KIDS", "green_black", ADULT_RANKS)).toBe("adult-blue");
  });

  it("preselects nothing for a KIDS student at orange — any other kids rank forces an explicit choice", () => {
    expect(resolveDefaultTrackChangeRankId("KIDS", "orange", ADULT_RANKS)).toBeNull();
  });

  it("preselects nothing for an ADULT->KIDS change, regardless of current rank", () => {
    expect(resolveDefaultTrackChangeRankId("ADULT", "BLUE", ADULT_RANKS)).toBeNull();
  });

  it("preselects nothing if the destination options don't even include BLUE (defensive)", () => {
    expect(resolveDefaultTrackChangeRankId("KIDS", "green_black", [{ id: "x", code: "WHITE" }])).toBeNull();
  });
});
