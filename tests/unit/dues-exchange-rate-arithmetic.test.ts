import { describe, expect, it } from "vitest";
import { convertCrcToUsdMinor, convertUsdToCrcMinor, detectAmbiguousRoundedTotals } from "../../src/lib/dues/ledger/exchange-rate-arithmetic";

/**
 * Currency-conversion brief §3: exact BigInt rational arithmetic, no floating point anywhere. Rate units are CRC per 1
 * USD throughout. "To CRC" multiplies; "to USD" divides — the same SELL rate either direction (policy 5). Rounding is
 * always exactly ONE step, at the target currency's own natural precision (nearest whole colón / nearest cent), halfway
 * rounds up (policy 1/3), zero tolerance (policy 2) — enforced by the caller comparing the exact integer result, not by
 * anything in these functions themselves.
 */
describe("convertUsdToCrcMinor: the brief's own worked examples, recalculated exactly", () => {
  it("USD 100.00 x 505.37 = 50,537.00 CRC exactly (a round total needs no rounding)", () => {
    expect(convertUsdToCrcMinor(10000, "505.37")).toBe(5053700);
  });

  it("USD 96.43 x 505.37 = 48,732.8291 CRC raw -> 48,733 CRC (nearest whole colón)", () => {
    expect(convertUsdToCrcMinor(9643, "505.37")).toBe(4873300);
  });

  it("rounds DOWN when the raw fraction of a colón is under half", () => {
    // 10 USD x 1.001 = 10.01 CRC exactly -> no rounding needed at all (already a whole-colón multiple's neighbor by design);
    // pick a case with a genuine sub-half fraction instead: 1 USD x 1.004 = 1.004 CRC -> 100.4 minor units -> rounds to 100 (1.00 colón).
    expect(convertUsdToCrcMinor(100, "1.004")).toBe(100);
  });

  it("rounds UP when the raw fraction of a colón is over half", () => {
    // 1 USD x 1.006 = 1.006 CRC -> 100.6 minor units -> rounds to 101 (1.01 colón is wrong; nearest WHOLE colón means nearest
    // multiple of 100 minor units: 100.6 is closer to 100 than 200, so it rounds to 100, not 101). Use a case that actually
    // straddles a whole-colón boundary: 1 USD x 1.996 = 1.996 CRC -> 199.6 minor units -> nearest 100-multiple is 200.
    expect(convertUsdToCrcMinor(100, "1.996")).toBe(200);
  });

  it("an exact halfway tie rounds UP (policy 1, approved)", () => {
    // USD 1.00 x 1.5 = 1.50 CRC -> 150 minor units, exactly halfway between 100 (1 colón) and 200 (2 colones) -> rounds to 200.
    expect(convertUsdToCrcMinor(100, "1.5")).toBe(200);
  });

  it("throws for a negative or non-integer usdMinor, or a non-positive/malformed rate", () => {
    expect(() => convertUsdToCrcMinor(-1, "505.37")).toThrow(RangeError);
    expect(() => convertUsdToCrcMinor(1.5, "505.37")).toThrow(RangeError);
    expect(() => convertUsdToCrcMinor(100, "0")).toThrow(RangeError);
    expect(() => convertUsdToCrcMinor(100, "-1")).toThrow(RangeError);
    expect(() => convertUsdToCrcMinor(100, "abc")).toThrow(RangeError);
    expect(() => convertUsdToCrcMinor(100, "1.00e2")).toThrow(RangeError);
  });
});

describe("convertCrcToUsdMinor: reverse direction (policy 5, confirmed needed), same SELL rate, divides", () => {
  it("CRC 50,000.00 / 505.37 = 98.937... USD raw -> USD 98.94 (nearest cent)", () => {
    expect(convertCrcToUsdMinor(5000000, "505.37")).toBe(9894);
  });

  it("an exact halfway tie rounds UP (policy 3, approved)", () => {
    // CRC 0.01 / 2 = 0.005 USD -> 0.5 minor units, exactly halfway between 0 and 1 cent -> rounds to 1.
    expect(convertCrcToUsdMinor(1, "2")).toBe(1);
  });

  it("a round total needs no rounding", () => {
    expect(convertCrcToUsdMinor(20000, "2")).toBe(10000); // CRC 200.00 / 2 = USD 100.00 exactly
  });

  it("throws for a negative or non-integer crcMinor, or a non-positive/malformed rate", () => {
    expect(() => convertCrcToUsdMinor(-1, "505.37")).toThrow(RangeError);
    expect(() => convertCrcToUsdMinor(1.5, "505.37")).toThrow(RangeError);
    expect(() => convertCrcToUsdMinor(100, "0")).toThrow(RangeError);
  });
});

describe("detectAmbiguousRoundedTotals: a rounding collision between distinct candidates must be detected, never guessed", () => {
  it("reports no ambiguity when every candidate rounds to a distinct required total", () => {
    const { totals, ambiguousRequiredMinors } = detectAmbiguousRoundedTotals([10000, 20000, 30000], "505.37", "toCrc");
    expect(totals).toEqual([
      { sourceMinor: 10000, requiredMinor: 5053700 },
      { sourceMinor: 20000, requiredMinor: 10107400 },
      { sourceMinor: 30000, requiredMinor: 15161100 },
    ]);
    expect(ambiguousRequiredMinors).toEqual([]);
  });

  it("detects two distinct candidates that round to the SAME required CRC total", () => {
    // At rate 1.00, both 100 and 100 minor units would trivially collide with themselves — construct a genuine case with a
    // rate whose rounding compresses two DIFFERENT USD totals onto the same whole-colón figure. Rate "1.001": USD 1.00 (100
    // minor) -> raw 100.1 -> rounds to 100. USD 1.02 (102 minor) -> raw 102.1020 -> rounds to 100 also (nearest 100-multiple
    // of 102.102 is 100, since 102.102 is closer to 100 than 200). Both round to the same 100 CRC minor units.
    const { ambiguousRequiredMinors, totals } = detectAmbiguousRoundedTotals([100, 102], "1.001", "toCrc");
    expect(totals.map((t) => t.requiredMinor)).toEqual([100, 100]);
    expect(ambiguousRequiredMinors).toEqual([100]);
  });

  it("detects a collision in the toUsd direction too", () => {
    const { ambiguousRequiredMinors } = detectAmbiguousRoundedTotals([100, 101], "100", "toUsd"); // both round to USD 0.01/... check below
    // CRC 1.00 (100 minor) / 100 = 0.01 USD exactly -> 1 minor unit. CRC 1.01 (101 minor) / 100 = 0.0101 -> raw 1.01 minor
    // units -> rounds to nearest cent: 1. Both collide at requiredMinor 1.
    expect(ambiguousRequiredMinors).toEqual([1]);
  });
});
