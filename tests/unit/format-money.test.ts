import { describe, expect, it } from "vitest";
import { CURRENCIES, currencySymbol, formatMoney } from "../../src/lib/payments/format-money";
import { ALL_DEFAULT_PLAN_NAMES, defaultPlanNameFor } from "../../src/lib/payments/default-plan-name";

describe("formatMoney", () => {
  it("formats colones as whole numbers with a ₡ prefix, as the app always has", () => {
    expect(formatMoney(22500, "CRC", "es")).toMatch(/^₡ 22\D500$/); // es-CR groups with a locale-specific space
    expect(formatMoney(22500, "CRC", "en")).toBe("₡ 22,500");
  });

  it("never shows fractional colones, even for a fractional input", () => {
    expect(formatMoney(22500.4, "CRC", "en")).toBe("₡ 22,500");
  });

  it("formats dollars with cents and a $ prefix", () => {
    expect(formatMoney(45, "USD", "en")).toBe("$ 45.00");
    expect(formatMoney(1234.5, "USD", "en")).toBe("$ 1,234.50");
  });

  it("formats the same number differently per currency — a bare 45 is not a currency", () => {
    expect(formatMoney(45, "CRC", "en")).not.toBe(formatMoney(45, "USD", "en"));
  });

  it("has a symbol and a formatting rule for every currency in the list", () => {
    for (const currency of CURRENCIES) {
      expect(currencySymbol(currency), currency).toMatch(/\S/);
      expect(formatMoney(1, currency, "en")).toContain(currencySymbol(currency));
    }
  });
});

describe("the default monthly plan's name follows the organization's language", () => {
  it("is Spanish for es and English for en — an English academy must not start with a Spanish plan", () => {
    expect(defaultPlanNameFor("es")).toBe("Mensualidad");
    expect(defaultPlanNameFor("en")).toBe("Monthly");
  });

  it("falls back to Spanish for an unknown locale, the platform's own default", () => {
    expect(defaultPlanNameFor("fr")).toBe("Mensualidad");
  });

  it("recognises the ordinary monthly plan in either language (the quick 'mark paid' fallback)", () => {
    expect(ALL_DEFAULT_PLAN_NAMES).toEqual(expect.arrayContaining(["Mensualidad", "Monthly"]));
  });
});
