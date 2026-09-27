import { describe, expect, it } from "vitest";
import { Prisma } from "../../src/generated/prisma/client";
import { MAX_MINOR_UNITS, columnToMinor, decimalToMinor, minorToDecimal } from "../../src/lib/dues/ledger/minor-units";

/**
 * Exact conversion between the two-decimal money strings the database stores (Decimal(10, 2), for USD and CRC alike) and the integer
 * minor units the calculation library uses. No floating point, no rounding, no silent repair: anything that is not exactly a canonical
 * amount is refused.
 */
describe("decimalToMinor: canonical two-decimal strings only", () => {
  it.each([
    ["0.00", 0],
    ["0.01", 1],
    ["1.15", 115], // 1.15 * 100 is 114.99999999999999 in floating point
    ["4.35", 435], // 4.35 * 100 is 434.99999999999994
    ["20.00", 2000],
    ["100.00", 10000],
    ["25000.50", 2500050],
    ["99999999.99", 9_999_999_999],
  ])("%s is %i minor units", (text, minor) => {
    expect(decimalToMinor(text)).toBe(minor);
  });

  it.each(["1", "1.5", "1.005", "1.155", "-1.00", "+1.00", "1e2", "1,00", " 1.00", "1.00 ", ".50", "1.", "", "abc", "100000000.00", "01.00", "0x1.00"])(
    "refuses %j (not a canonical two-decimal amount, or out of range)",
    (text) => {
      expect(() => decimalToMinor(text)).toThrow(RangeError);
    },
  );

  it("is exact for every cent from 0.00 to 3,000.00 (a float multiplication would drift on many of them)", () => {
    for (let minor = 0; minor <= 300_000; minor++) {
      const text = minorToDecimal(minor);
      expect(decimalToMinor(text)).toBe(minor);
    }
  });
});

describe("minorToDecimal", () => {
  it.each([
    [0, "0.00"],
    [1, "0.01"],
    [10, "0.10"],
    [115, "1.15"],
    [10000, "100.00"],
    [2500050, "25000.50"],
    [MAX_MINOR_UNITS, "99999999.99"],
  ])("%i minor units is %s", (minor, text) => {
    expect(minorToDecimal(minor)).toBe(text);
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, MAX_MINOR_UNITS + 1])("refuses %s", (minor) => {
    expect(() => minorToDecimal(minor)).toThrow(RangeError);
  });

  it("round-trips the boundaries", () => {
    for (const minor of [0, 1, 99, 100, 101, 999_999, 1_000_000, MAX_MINOR_UNITS - 1, MAX_MINOR_UNITS]) {
      expect(decimalToMinor(minorToDecimal(minor))).toBe(minor);
    }
  });
});

describe("columnToMinor: a Decimal read from a Decimal(10, 2) column", () => {
  it("converts exactly", () => {
    expect(columnToMinor(new Prisma.Decimal("1.15"))).toBe(115);
    expect(columnToMinor(new Prisma.Decimal("25000.5"))).toBe(2500050);
    expect(columnToMinor(new Prisma.Decimal("100"))).toBe(10000);
  });

  it("refuses a value with more than two decimals instead of rounding it", () => {
    expect(() => columnToMinor(new Prisma.Decimal("1.005"))).toThrow(RangeError);
    expect(() => columnToMinor(new Prisma.Decimal("0.001"))).toThrow(RangeError);
  });

  it("refuses a negative or out-of-range value", () => {
    expect(() => columnToMinor(new Prisma.Decimal("-0.01"))).toThrow(RangeError);
    expect(() => columnToMinor(new Prisma.Decimal("100000000.00"))).toThrow(RangeError);
  });
});
