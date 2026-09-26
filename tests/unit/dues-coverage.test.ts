import { describe, expect, it } from "vitest";
import {
  findOverlap,
  firstUncoveredMonth,
  monthsToCreate,
  planPackage,
  planPrepaidMonths,
  priceFor,
  type PriceVersion,
} from "../../src/lib/dues/coverage";
import { outstandingItems, settleReceipt } from "../../src/lib/dues/settlement";
import { graceDeadlineFor } from "../../src/lib/dues/calendar";

/**
 * PR 1: coverage, prepayment and package arithmetic. PURE-FUNCTION guarantees only. "Duplicate-charge prevention" here means: given the
 * set of months already covered, these functions never PROPOSE a month that is in it, and they reject a whole proposal that touches one.
 * They cannot stop two concurrent requests that both read the same "already covered" set; that needs the unique coverage rows and
 * transactions of the schema and ledger PRs, and is deliberately not claimed here.
 *
 * The caller passes `from`, the earliest month it considers (normally the current billing month), and `covered`, every month that
 * already has an obligation or paid coverage (settled or not), so "after existing obligations are accounted for" is the caller's input.
 */
const m = (year: number, month: number) => ({ year, month });
const USD = "USD" as const;

describe("firstUncoveredMonth (a package or prepayment starts here; no gaps)", () => {
  it("is `from` when nothing is covered", () => {
    expect(firstUncoveredMonth([], m(2026, 10))).toEqual(m(2026, 10));
  });

  it("skips consecutive covered months: Oct and Nov covered -> Dec", () => {
    expect(firstUncoveredMonth([m(2026, 10), m(2026, 11)], m(2026, 10))).toEqual(m(2026, 12));
  });

  it("finds the FIRST uncovered month, not the one after the last covered: Oct and Dec covered -> Nov", () => {
    expect(firstUncoveredMonth([m(2026, 10), m(2026, 12)], m(2026, 10))).toEqual(m(2026, 11));
  });

  it("crosses the year boundary", () => {
    expect(firstUncoveredMonth([m(2026, 12)], m(2026, 12))).toEqual(m(2027, 1));
    expect(firstUncoveredMonth([m(2026, 11), m(2026, 12), m(2027, 1)], m(2026, 11))).toEqual(m(2027, 2));
  });

  it("ignores covered months before `from`", () => {
    expect(firstUncoveredMonth([m(2026, 3), m(2026, 4)], m(2026, 10))).toEqual(m(2026, 10));
  });

  it("is independent of the order of the covered list", () => {
    expect(firstUncoveredMonth([m(2026, 11), m(2026, 10)], m(2026, 10))).toEqual(m(2026, 12));
  });
});

describe("findOverlap and monthsToCreate (no duplicate or overlapping charges at the calculation level)", () => {
  it("reports exactly the proposed months that are already covered", () => {
    expect(findOverlap([m(2026, 10), m(2027, 1)], [m(2026, 11), m(2026, 12), m(2027, 1)])).toEqual([m(2027, 1)]);
    expect(findOverlap([m(2026, 10)], [m(2026, 11)])).toEqual([]);
  });

  it("proposes only uncovered months, so running the monthly plan twice never charges a month twice", () => {
    const first = monthsToCreate([m(2026, 10), m(2026, 11), m(2026, 12)], [m(2026, 11)]);
    expect(first).toEqual([m(2026, 10), m(2026, 12)]);
    const second = monthsToCreate([m(2026, 10), m(2026, 11), m(2026, 12)], [m(2026, 11), ...first]);
    expect(second).toEqual([]);
  });

  it("a prepaid month makes the monthly plan skip it (the job never re-charges a prepaid month)", () => {
    const prepaid = planPrepaidMonths({ covered: [m(2026, 10)], from: m(2026, 10), count: 1, versions: [{ effectiveFrom: m(2026, 1), amountMinor: 10000 }] });
    expect(prepaid).toMatchObject({ ok: true, months: [{ month: m(2026, 11), amountMinor: 10000 }] });
    expect(monthsToCreate([m(2026, 11)], [m(2026, 10), m(2026, 11)])).toEqual([]);
  });
});

describe("priceFor: the price version effective for a given month", () => {
  const versions: PriceVersion[] = [
    { effectiveFrom: m(2026, 12), amountMinor: 11000 },
    { effectiveFrom: m(2026, 1), amountMinor: 10000 },
  ]; // deliberately unsorted

  it("uses the latest version whose effective month is on or before the month", () => {
    expect(priceFor(m(2026, 1), versions)).toBe(10000);
    expect(priceFor(m(2026, 11), versions)).toBe(10000);
    expect(priceFor(m(2026, 12), versions)).toBe(11000);
    expect(priceFor(m(2027, 6), versions)).toBe(11000);
  });

  it("has no price before the first version (never guesses one)", () => {
    expect(priceFor(m(2025, 12), versions)).toBeNull();
    expect(priceFor(m(2026, 1), [])).toBeNull();
  });

  it("rejects two versions effective the same month, and non-positive or fractional prices", () => {
    expect(() => priceFor(m(2026, 5), [{ effectiveFrom: m(2026, 1), amountMinor: 1 }, { effectiveFrom: m(2026, 1), amountMinor: 2 }])).toThrow(RangeError);
    expect(() => priceFor(m(2026, 5), [{ effectiveFrom: m(2026, 1), amountMinor: 0 }])).toThrow(RangeError);
    expect(() => priceFor(m(2026, 5), [{ effectiveFrom: m(2026, 1), amountMinor: 10.5 }])).toThrow(RangeError);
  });

  it("two branches keep independent price histories", () => {
    const escazu: PriceVersion[] = [{ effectiveFrom: m(2026, 1), amountMinor: 10000 }, { effectiveFrom: m(2026, 12), amountMinor: 11000 }];
    const escalante: PriceVersion[] = [{ effectiveFrom: m(2026, 1), amountMinor: 10000 }];
    expect(priceFor(m(2027, 1), escazu)).toBe(11000);
    expect(priceFor(m(2027, 1), escalante)).toBe(10000);
  });
});

describe("planPrepaidMonths: consecutive months, each priced from ITS OWN effective price version", () => {
  const versions: PriceVersion[] = [{ effectiveFrom: m(2026, 1), amountMinor: 10000 }, { effectiveFrom: m(2026, 12), amountMinor: 11000 }];

  it("Oct covered, prepaying three months: Nov 100, Dec 110, Jan 110 (the price effective for each month)", () => {
    const r = planPrepaidMonths({ covered: [m(2026, 10)], from: m(2026, 10), count: 3, versions });
    expect(r).toEqual({
      ok: true,
      months: [
        { month: m(2026, 11), amountMinor: 10000 },
        { month: m(2026, 12), amountMinor: 11000 },
        { month: m(2027, 1), amountMinor: 11000 },
      ],
      totalMinor: 32000,
    });
  });

  it("starts at the first uncovered month and stays consecutive (no gaps)", () => {
    const r = planPrepaidMonths({ covered: [m(2026, 10), m(2026, 11)], from: m(2026, 10), count: 2, versions });
    expect(r).toMatchObject({ ok: true });
    if (r.ok) expect(r.months.map((x) => x.month)).toEqual([m(2026, 12), m(2027, 1)]);
  });

  it("rejects the WHOLE proposal when any month in the run is already covered (overlap), planning nothing", () => {
    const r = planPrepaidMonths({ covered: [m(2026, 10), m(2027, 1)], from: m(2026, 10), count: 3, versions });
    expect(r).toEqual({ ok: false, reason: "OVERLAP", overlapping: [m(2027, 1)] });
  });

  it("refuses when a month has no price version, naming it, rather than guessing a price", () => {
    const r = planPrepaidMonths({ covered: [], from: m(2026, 10), count: 2, versions: [{ effectiveFrom: m(2026, 12), amountMinor: 11000 }] });
    expect(r).toEqual({ ok: false, reason: "NO_PRICE_VERSION", month: m(2026, 10) });
  });

  it("rejects a count that is not a positive whole number", () => {
    expect(() => planPrepaidMonths({ covered: [], from: m(2026, 10), count: 0, versions })).toThrow(RangeError);
    expect(() => planPrepaidMonths({ covered: [], from: m(2026, 10), count: 1.5, versions })).toThrow(RangeError);
  });

  it("feeds the settlement totals: outstanding October plus two prepaid months are selectable totals in order", () => {
    const oct = { id: "oct", coverage: m(2026, 10), currency: USD, tuitionMinor: 10000, lateFeeMinor: 2000, graceDeadline: graceDeadlineFor(m(2026, 10), 5) };
    const prepaid = planPrepaidMonths({ covered: [m(2026, 10)], from: m(2026, 10), count: 2, versions });
    expect(prepaid.ok).toBe(true);
    if (!prepaid.ok) return;
    const items = [
      ...outstandingItems([oct], { year: 2026, month: 10, day: 12 }),
      ...prepaid.months.map((p) => ({ id: `prepaid-${p.month.year}-${p.month.month}`, currency: USD, amountMinor: p.amountMinor })),
    ];
    expect(settleReceipt(items, 10000, USD)).toMatchObject({ ok: true, settledIds: ["oct"] });
    expect(settleReceipt(items, 20000, USD)).toMatchObject({ ok: true, settledIds: ["oct", "prepaid-2026-11"] });
    expect(settleReceipt(items, 31000, USD)).toMatchObject({ ok: true, settledIds: ["oct", "prepaid-2026-11", "prepaid-2026-12"] });
    // Paying only the prepaid months while October is outstanding is not a prefix, so it is refused: oldest first.
    expect(settleReceipt(items, 21000, USD).ok).toBe(false);
  });
});

describe("planPackage: consecutive months from the first uncovered month, at the QUOTED price", () => {
  it("October already covered: a three-month package covers Nov, Dec, Jan at the quoted USD 270 (illustrative)", () => {
    const r = planPackage({ covered: [m(2026, 10)], from: m(2026, 10), months: 3, quotedAmountMinor: 27000 });
    expect(r).toEqual({ ok: true, coverage: [m(2026, 11), m(2026, 12), m(2027, 1)], amountMinor: 27000 });
  });

  it("nothing covered yet: the package starts at `from`", () => {
    const r = planPackage({ covered: [], from: m(2026, 10), months: 3, quotedAmountMinor: 27000 });
    expect(r).toMatchObject({ ok: true, coverage: [m(2026, 10), m(2026, 11), m(2026, 12)] });
  });

  it("the amount is exactly the quote, whatever any later price change does (the quote is the only price input)", () => {
    expect(planPackage({ covered: [], from: m(2026, 10), months: 3, quotedAmountMinor: 27000 })).toMatchObject({ amountMinor: 27000 });
    expect(planPackage({ covered: [], from: m(2026, 10), months: 3, quotedAmountMinor: 30000 })).toMatchObject({ amountMinor: 30000 });
  });

  it("never overlaps existing coverage: a later covered month inside the run rejects the whole package", () => {
    const r = planPackage({ covered: [m(2026, 10), m(2027, 1)], from: m(2026, 10), months: 3, quotedAmountMinor: 27000 });
    expect(r).toEqual({ ok: false, reason: "OVERLAP", overlapping: [m(2027, 1)] });
  });

  it("crosses the year boundary and leap-year February months", () => {
    const r = planPackage({ covered: [m(2027, 12)], from: m(2027, 12), months: 3, quotedAmountMinor: 27000 });
    expect(r).toMatchObject({ ok: true, coverage: [m(2028, 1), m(2028, 2), m(2028, 3)] });
  });

  it("rejects a package with no months or a quote that is not a positive whole amount", () => {
    expect(() => planPackage({ covered: [], from: m(2026, 10), months: 0, quotedAmountMinor: 27000 })).toThrow(RangeError);
    expect(() => planPackage({ covered: [], from: m(2026, 10), months: 3, quotedAmountMinor: 0 })).toThrow(RangeError);
    expect(() => planPackage({ covered: [], from: m(2026, 10), months: 3, quotedAmountMinor: 270.5 })).toThrow(RangeError);
  });

  it("does not mutate its inputs", () => {
    const covered = [m(2026, 10)];
    planPackage({ covered, from: m(2026, 10), months: 3, quotedAmountMinor: 27000 });
    expect(covered).toEqual([m(2026, 10)]);
  });
});
