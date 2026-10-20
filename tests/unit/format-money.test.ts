import { describe, expect, it } from "vitest";
import { CURRENCIES, currencySymbol, formatExactMoney, formatMoney } from "../../src/lib/payments/format-money";
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

describe("formatExactMoney (stage 8d readiness screen: exact decimal strings, never a JavaScript number)", () => {
  it("dollars always show two decimals; colones omit zero cents but keep nonzero cents exactly", () => {
    expect(formatExactMoney("45.00", "USD", "en")).toBe("$ 45.00");
    expect(formatExactMoney("1234.50", "USD", "en")).toBe("$ 1,234.50");
    expect(formatExactMoney("22500.00", "CRC", "en")).toBe("₡ 22,500");
    expect(formatExactMoney("25000.50", "CRC", "en")).toBe("₡ 25,000.50"); // formatMoney would round this away
    expect(formatExactMoney("0.01", "CRC", "en")).toBe("₡ 0.01");
  });

  it("matches formatMoney exactly wherever formatMoney is exact (whole colones, any dollars)", () => {
    for (const [amount, currency] of [["22500.00", "CRC"], ["1234.50", "USD"], ["0.00", "USD"], ["99999999.99", "USD"]] as const) {
      for (const locale of ["en", "es"]) expect(formatExactMoney(amount, currency, locale)).toBe(formatMoney(Number(amount), currency, locale));
    }
  });

  it("uses the locale's own separators in Spanish", () => {
    expect(formatExactMoney("25000.50", "CRC", "es")).toMatch(/^₡ 25\D000,50$/);
    expect(formatExactMoney("1234.50", "USD", "es")).toMatch(/^\$ 1\D234,50$/);
  });

  it("totals above one column's limit and above 2^53 minor units stay exact to the cent", () => {
    expect(formatExactMoney("199999999.98", "USD", "en")).toBe("$ 199,999,999.98");
    expect(formatExactMoney("100000000.03", "CRC", "en")).toBe("₡ 100,000,000.03");
    expect(formatExactMoney("90071992547409.93", "USD", "en")).toBe("$ 90,071,992,547,409.93"); // a Number would lose the cents
  });

  it("refuses anything that is not a canonical two-decimal amount, rather than guessing", () => {
    for (const bad of ["45", "45.5", "-1.00", "1e3", "1,000.00", " 1.00", ""]) {
      expect(() => formatExactMoney(bad, "USD", "en"), bad).toThrow(RangeError);
    }
  });
});
