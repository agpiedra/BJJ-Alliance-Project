import { describe, expect, it } from "vitest";
import {
  MAX_SUPPORTED_MONTHS,
  currentMonthIn,
  currenciesCompatible,
  parseEffectiveMonth,
  parseMoney,
  parseWholeNumber,
  versionRevision,
} from "../../src/lib/dues/config-input";

/**
 * Owner-configuration input rules (PR 3). Pure functions: exact string parsing for money (no floating point, no rounding), whole-number
 * ranges taken from what the schema and calendar actually support, effective months judged in the BRANCH's timezone, and the
 * revision token used to detect stale edits.
 */
describe("parseMoney: exact decimal strings, never rounded", () => {
  it.each([
    ["45", "45.00"],
    ["45.5", "45.50"],
    ["45.50", "45.50"],
    ["0.07", "0.07"],
    ["0", "0.00"],
    ["99999999.99", "99999999.99"],
    ["12345678", "12345678.00"],
  ])("accepts %s as %s when zero is allowed", (raw, canonical) => {
    expect(parseMoney(raw, { allowZero: true })).toEqual({ ok: true, value: canonical });
  });

  it.each(["1.005", "0.001", "45.999", "1e2", "1E2", "-1", "+1", " 5", "5 ", "1,5", "1,000.00", "1.000,50", ".5", "5.", "", "abc", "0x10", "١٢", "1..2", "01", "00.50", "100000000.00", "123456789"])(
    "rejects %j (more than two decimals, exponent, sign, spaces, separators, leading zero, or out of range)",
    (raw) => {
      expect(parseMoney(raw, { allowZero: true }).ok).toBe(false);
    },
  );

  it("never rounds: 1.005 is refused, not stored as 1.00 or 1.01", () => {
    expect(parseMoney("1.005", { allowZero: false })).toEqual({ ok: false });
  });

  it("a price must be greater than zero; a fee may be zero", () => {
    expect(parseMoney("0", { allowZero: false }).ok).toBe(false);
    expect(parseMoney("0.00", { allowZero: false }).ok).toBe(false);
    expect(parseMoney("0.01", { allowZero: false }).ok).toBe(true);
    expect(parseMoney("0.00", { allowZero: true }).ok).toBe(true);
  });

  it("rejects missing input", () => {
    expect(parseMoney(undefined, { allowZero: true }).ok).toBe(false);
    expect(parseMoney(null, { allowZero: true }).ok).toBe(false);
  });

  it("the largest accepted value equals the column's own maximum, Decimal(10, 2)", () => {
    expect(parseMoney("99999999.99", { allowZero: false }).ok).toBe(true);
    expect(parseMoney("100000000.00", { allowZero: false }).ok).toBe(false);
  });
});

describe("parseWholeNumber: digit strings within a supported range", () => {
  it("accepts numbers in range and returns exact integers", () => {
    expect(parseWholeNumber("1", 1, 31)).toEqual({ ok: true, value: 1 });
    expect(parseWholeNumber("31", 1, 31)).toEqual({ ok: true, value: 31 });
    expect(parseWholeNumber("1212", 1, MAX_SUPPORTED_MONTHS)).toEqual({ ok: true, value: 1212 });
  });

  it.each(["0", "32", "-1", "1.5", "1e1", " 3", "3 ", "03", "", "abc", "1,5", "99999999999999999999"])("rejects %j for 1 to 31", (raw) => {
    expect(parseWholeNumber(raw, 1, 31).ok).toBe(false);
  });

  it("the supported month count is the supported calendar span (years 2000 to 2100), not an invented business limit", () => {
    expect(MAX_SUPPORTED_MONTHS).toBe((2100 - 2000 + 1) * 12);
    expect(MAX_SUPPORTED_MONTHS).toBe(1212);
    expect(parseWholeNumber("1213", 1, MAX_SUPPORTED_MONTHS).ok).toBe(false);
    // 120 months (ten years) is NOT a limit
    expect(parseWholeNumber("120", 1, MAX_SUPPORTED_MONTHS).ok).toBe(true);
    expect(parseWholeNumber("121", 1, MAX_SUPPORTED_MONTHS).ok).toBe(true);
  });
});

describe("parseEffectiveMonth", () => {
  it("accepts a real month in the supported years", () => {
    expect(parseEffectiveMonth("2027", "3")).toEqual({ ok: true, value: { year: 2027, month: 3 } });
    expect(parseEffectiveMonth("2000", "1").ok).toBe(true);
    expect(parseEffectiveMonth("2100", "12").ok).toBe(true);
  });

  it.each([["1999", "1"], ["2101", "1"], ["27", "3"], ["2027", "0"], ["2027", "13"], ["2027", "1.5"], ["20270", "1"], ["", "1"], ["2027", ""], ["abcd", "1"]])(
    "rejects year %j month %j",
    (year, month) => {
      expect(parseEffectiveMonth(year, month).ok).toBe(false);
    },
  );
});

describe("currentMonthIn: the branch's own calendar month", () => {
  it("uses the branch timezone, not the server's or UTC", () => {
    // 2026-10-01 03:00 UTC is still Sep 30 in Costa Rica (UTC-6) but already Oct 1 in Auckland (UTC+13)
    const instant = new Date("2026-10-01T03:00:00Z");
    expect(currentMonthIn("America/Costa_Rica", instant)).toEqual({ year: 2026, month: 9 });
    expect(currentMonthIn("Pacific/Auckland", instant)).toEqual({ year: 2026, month: 10 });
  });

  it("crosses the year boundary correctly", () => {
    expect(currentMonthIn("America/Costa_Rica", new Date("2027-01-01T05:59:00Z"))).toEqual({ year: 2026, month: 12 });
    expect(currentMonthIn("America/Costa_Rica", new Date("2027-01-01T06:00:00Z"))).toEqual({ year: 2027, month: 1 });
  });

  it("rejects an unknown timezone rather than guessing one", () => {
    expect(() => currentMonthIn("Not/AZone", new Date())).toThrow();
  });
});

describe("versionRevision: the stale-edit token", () => {
  it("is the same for the same values, in any key order, and differs when any value differs", () => {
    const a = versionRevision({ price: "45.00", currency: "USD", months: 1 });
    expect(versionRevision({ months: 1, currency: "USD", price: "45.00" })).toBe(a);
    expect(versionRevision({ price: "45.01", currency: "USD", months: 1 })).not.toBe(a);
    expect(versionRevision({ price: "45.00", currency: "CRC", months: 1 })).not.toBe(a);
    expect(versionRevision({ price: "45.00", currency: "USD", months: 3 })).not.toBe(a);
  });

  it("distinguishes null from a value and a number from its string", () => {
    expect(versionRevision({ limit: null })).not.toBe(versionRevision({ limit: 0 }));
    expect(versionRevision({ n: 1 })).not.toBe(versionRevision({ n: "1" }));
  });
});

describe("currenciesCompatible: one currency across a branch's dues configuration (no conversion)", () => {
  it("accepts the first currency, and the same one again", () => {
    expect(currenciesCompatible([], "USD")).toBe(true);
    expect(currenciesCompatible(["USD", "USD"], "USD")).toBe(true);
  });

  it("refuses a different currency, and refuses an already-mixed history", () => {
    expect(currenciesCompatible(["USD"], "CRC")).toBe(false);
    expect(currenciesCompatible(["USD", "CRC"], "USD")).toBe(false);
  });
});
