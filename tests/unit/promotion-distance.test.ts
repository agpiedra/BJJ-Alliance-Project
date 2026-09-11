import { describe, expect, it } from "vitest";
import { promotionDistance } from "@/lib/students/promotion-distance";

describe("promotionDistance", () => {
  it("is 0 when exam-eligible", () => {
    expect(promotionDistance({ examEligible: true, remainingToNextStripe: null })).toBe(0);
  });

  it("is 0 when stripe-eligible (remaining is exactly 0)", () => {
    expect(promotionDistance({ examEligible: false, remainingToNextStripe: 0 })).toBe(0);
  });

  it("is the raw remaining count otherwise", () => {
    expect(promotionDistance({ examEligible: false, remainingToNextStripe: 7 })).toBe(7);
  });

  it("sorts a belt with no computable further progress last", () => {
    expect(promotionDistance({ examEligible: false, remainingToNextStripe: null })).toBe(Infinity);
  });
});
