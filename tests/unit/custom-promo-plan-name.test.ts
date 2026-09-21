import { describe, expect, it } from "vitest";
import {
  CUSTOM_PROMO_PLAN_NAMES,
  customPromoPlanNameFor,
  isCustomPromoPlanName,
} from "../../src/lib/payments/custom-promo-plan-name";
import { productionSourceFiles } from "../helpers/source-files";

describe("the system promo plan's name follows the organization's language", () => {
  it("is Spanish for es and English for en — an English academy must not see a Spanish system plan", () => {
    expect(customPromoPlanNameFor("es")).toBe("Promoción personalizada");
    expect(customPromoPlanNameFor("en")).toBe("Custom promotion");
  });

  it("falls back to Spanish for an unknown locale, the platform's own default (same as the default monthly plan)", () => {
    expect(customPromoPlanNameFor("fr")).toBe("Promoción personalizada");
  });

  it("recognises the plan under EVERY language's name — rows created before the name followed the language keep working", () => {
    expect(isCustomPromoPlanName("Promoción personalizada")).toBe(true);
    expect(isCustomPromoPlanName("Custom promotion")).toBe(true);
    expect(isCustomPromoPlanName("Monthly")).toBe(false);
    expect(isCustomPromoPlanName(undefined)).toBe(false);
    expect([...CUSTOM_PROMO_PLAN_NAMES]).toEqual(expect.arrayContaining(["Promoción personalizada", "Custom promotion"]));
  });
});

/**
 * Every "is this the promo plan?" decision must go through `isCustomPromoPlanName`
 * — a hand-typed name compares against ONE language and silently misses the
 * other, which is exactly the bug this file's rename fixed. Only the module that
 * defines the names may contain them.
 */
const NAME_LITERAL = /["'`](Promoción personalizada|Custom promotion)["'`]/;

export function hardCodesPromoPlanName(text: string): boolean {
  return NAME_LITERAL.test(text);
}

describe("no production code hard-codes the promo plan's name", () => {
  it("REQUIRED: only custom-promo-plan-name.ts contains the literal names", () => {
    const offenders = productionSourceFiles()
      .filter(({ file }) => !file.replace(/\\/g, "/").endsWith("src/lib/payments/custom-promo-plan-name.ts"))
      .filter(({ text }) => hardCodesPromoPlanName(text))
      .map(({ file }) => file);

    expect(offenders, "use isCustomPromoPlanName() / customPromoPlanNameFor() instead of a literal").toEqual([]);
  });

  describe("the scanner can actually flag a literal (positive controls)", () => {
    it("flags either language's name in quotes", () => {
      expect(hardCodesPromoPlanName('plan.name === "Promoción personalizada"')).toBe(true);
      expect(hardCodesPromoPlanName("name: 'Custom promotion'")).toBe(true);
    });

    it("does not flag the helper call or an unrelated string", () => {
      expect(hardCodesPromoPlanName("isCustomPromoPlanName(plan.name)")).toBe(false);
      expect(hardCodesPromoPlanName('"Monthly"')).toBe(false);
    });
  });
});
