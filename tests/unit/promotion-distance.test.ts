import { describe, expect, it } from "vitest";
import { promotionDistance, compareByPromotion } from "@/lib/students/promotion-distance";

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

describe("compareByPromotion", () => {
  it("does not produce NaN when both rows have Infinity distance (two no-progress students)", () => {
    const a = { distance: Infinity, lastName: "Zamora", firstName: "Ana" };
    const b = { distance: Infinity, lastName: "Alvarado", firstName: "Beto" };
    const result = compareByPromotion(a, b);
    expect(Number.isNaN(result)).toBe(false);
    // Falls through to the lastName tie-break: "Alvarado" < "Zamora".
    expect(result).toBeGreaterThan(0);
  });

  it("sorts an eligible-now student (distance 0) ahead of one with remaining progress", () => {
    const eligible = { distance: 0, lastName: "Zamora", firstName: "Ana" };
    const inProgress = { distance: 1, lastName: "Alvarado", firstName: "Beto" };
    expect(compareByPromotion(eligible, inProgress)).toBeLessThan(0);
  });

  it("breaks an equal-distance tie by lastName, then firstName", () => {
    const a = { distance: 5, lastName: "Chaves", firstName: "Ana" };
    const b = { distance: 5, lastName: "Chaves", firstName: "Beto" };
    expect(compareByPromotion(a, b)).toBeLessThan(0);
  });
});
