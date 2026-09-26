import { describe, expect, it } from "vitest";
import { dueDateFor, graceDeadlineFor } from "../../src/lib/dues/calendar";
import {
  amountDueMinor,
  feeAssessableFrom,
  lateFeeApplies,
  lateFeeToAssessMinor,
  orderOldestFirst,
  outstandingItems,
  settleReceipt,
  totalLateFeesMinor,
  type ObligationTerms,
} from "../../src/lib/dues/settlement";

/**
 * PR 1: fee and settlement arithmetic. PURE-FUNCTION guarantees only: given the same inputs these return the same outputs, never read a
 * clock, never touch storage. "A fee is charged once per obligation" here means the FUNCTION returns one fixed amount however many
 * times or however late it is asked; the guarantee that a second fee ROW cannot be written, and that two people cannot settle the same
 * obligation, is a database uniqueness and concurrency guarantee that belongs to the schema and ledger PRs.
 *
 * Amounts are integer minor units (USD cents). Alliance's current settings appear only as test data: USD 100 tuition, USD 20 fee, due
 * day 20, grace day 5 of the next month.
 */
const d = (year: number, month: number, day: number) => ({ year, month, day });

/** An obligation built the way a later PR will snapshot it: tuition, fee and dates fixed at creation. */
function obligation(id: string, coverage: { year: number; month: number }, over: Partial<ObligationTerms> = {}): ObligationTerms {
  return {
    id,
    coverage,
    currency: "USD",
    tuitionMinor: 10000,
    lateFeeMinor: 2000,
    graceDeadline: graceDeadlineFor(coverage, 5),
    ...over,
  };
}
const OCT = obligation("oct", { year: 2026, month: 10 }); // due Oct 20, grace through Nov 5
const NOV = obligation("nov", { year: 2026, month: 11 }); // due Nov 20, grace through Dec 5
const DEC = obligation("dec", { year: 2026, month: 12 }); // due Dec 20, grace through Jan 5 2027

describe("the late fee applies to a payment RECEIVED after the inclusive grace deadline", () => {
  it("Nov 5 is still on time, Nov 6 is late (October coverage)", () => {
    expect(lateFeeApplies(d(2026, 11, 5), OCT.graceDeadline)).toBe(false);
    expect(lateFeeApplies(d(2026, 11, 6), OCT.graceDeadline)).toBe(true);
    expect(lateFeeApplies(d(2026, 10, 1), OCT.graceDeadline)).toBe(false);
  });

  it("across the year boundary: December coverage is on time through Jan 5 2027", () => {
    expect(lateFeeApplies(d(2027, 1, 5), DEC.graceDeadline)).toBe(false);
    expect(lateFeeApplies(d(2027, 1, 6), DEC.graceDeadline)).toBe(true);
  });

  it("the amount due is USD 100 through the deadline and USD 120 after it (from the obligation's own snapshot)", () => {
    expect(amountDueMinor(OCT, d(2026, 11, 5))).toBe(10000);
    expect(amountDueMinor(OCT, d(2026, 11, 6))).toBe(12000);
    expect(amountDueMinor(OCT, d(2027, 3, 1))).toBe(12000); // still one fee, months later
  });

  it("the fee is assessable from the day after the deadline", () => {
    expect(feeAssessableFrom(OCT.graceDeadline)).toEqual(d(2026, 11, 6));
    expect(feeAssessableFrom(DEC.graceDeadline)).toEqual(d(2027, 1, 6));
    expect(feeAssessableFrom(d(2026, 2, 28))).toEqual(d(2026, 3, 1)); // month end
    expect(feeAssessableFrom(d(2028, 2, 28))).toEqual(d(2028, 2, 29)); // leap year
  });
});

describe("one late fee per monthly obligation, never repeated", () => {
  const unsettled = { ...OCT, settledOn: null };

  it("is nothing on or before the deadline, and one fixed fee from the next day on (not cumulative)", () => {
    expect(lateFeeToAssessMinor(unsettled, d(2026, 11, 5))).toBe(0);
    expect(lateFeeToAssessMinor(unsettled, d(2026, 11, 6))).toBe(2000);
    expect(lateFeeToAssessMinor(unsettled, d(2026, 11, 7))).toBe(2000);
    expect(lateFeeToAssessMinor(unsettled, d(2026, 12, 31))).toBe(2000);
    expect(lateFeeToAssessMinor(unsettled, d(2027, 6, 1))).toBe(2000);
  });

  it("is judged by the RECEIVED date of a full settlement: on time (even on the deadline) means no fee", () => {
    expect(lateFeeToAssessMinor({ ...OCT, settledOn: d(2026, 11, 5) }, d(2026, 11, 20))).toBe(0);
    expect(lateFeeToAssessMinor({ ...OCT, settledOn: d(2026, 10, 3) }, d(2026, 11, 20))).toBe(0);
  });

  it("a settlement received after the deadline does not erase the fee that was owed", () => {
    expect(lateFeeToAssessMinor({ ...OCT, settledOn: d(2026, 11, 8) }, d(2026, 11, 20))).toBe(2000);
  });

  it("two overdue monthly obligations produce USD 40 in fees (plus their tuition), not more, on any later day", () => {
    const list = [
      { ...OCT, settledOn: null },
      { ...NOV, settledOn: null },
    ];
    expect(totalLateFeesMinor(list, d(2026, 12, 5))).toBe(2000); // only October is past its deadline on Dec 5
    expect(totalLateFeesMinor(list, d(2026, 12, 6))).toBe(4000);
    expect(totalLateFeesMinor(list, d(2027, 2, 1))).toBe(4000);
  });

  it("rejects obligations in different currencies instead of adding USD cents to colones (no conversion)", () => {
    const usd = { ...OCT, settledOn: null };
    const crc = { ...obligation("nov-crc", { year: 2026, month: 11 }, { currency: "CRC", tuitionMinor: 50000, lateFeeMinor: 10000 }), settledOn: null };
    // both overdue on Dec 6: the old code returned 2000 + 10000 = 12000, a meaningless mixed number
    expect(() => totalLateFeesMinor([usd, crc], d(2026, 12, 6))).toThrow(RangeError);
    // a mixed list is rejected even when only one of them is overdue, and even when nothing is
    expect(() => totalLateFeesMinor([usd, crc], d(2026, 11, 6))).toThrow(RangeError);
    expect(() => totalLateFeesMinor([usd, crc], d(2026, 10, 1))).toThrow(RangeError);
  });

  it("sums obligations that all share one currency, whichever it is; grouping by currency is the caller's job", () => {
    const crcA = { ...obligation("a", { year: 2026, month: 10 }, { currency: "CRC", tuitionMinor: 50000, lateFeeMinor: 10000 }), settledOn: null };
    const crcB = { ...obligation("b", { year: 2026, month: 11 }, { currency: "CRC", tuitionMinor: 50000, lateFeeMinor: 10000 }), settledOn: null };
    expect(totalLateFeesMinor([crcA, crcB], d(2026, 12, 6))).toBe(20000);
    expect(totalLateFeesMinor([], d(2026, 12, 6))).toBe(0);
  });

  it("an on-time obligation among overdue ones adds no fee", () => {
    const list = [
      { ...OCT, settledOn: d(2026, 11, 1) },
      { ...NOV, settledOn: null },
    ];
    expect(totalLateFeesMinor(list, d(2026, 12, 6))).toBe(2000);
  });

  it("changed branch prices never reach an existing obligation: each keeps the terms it was created with", () => {
    const escazuOldPrice = obligation("escazu-oct", { year: 2026, month: 10 }, { tuitionMinor: 10000, lateFeeMinor: 2000 });
    const escazuNewPrice = obligation("escazu-dec", { year: 2026, month: 12 }, { tuitionMinor: 11000, lateFeeMinor: 2500 });
    const escalante = obligation("escalante-oct", { year: 2026, month: 10 }, { tuitionMinor: 9000, lateFeeMinor: 1500 });
    expect(amountDueMinor(escazuOldPrice, d(2026, 11, 6))).toBe(12000);
    expect(amountDueMinor(escazuNewPrice, d(2027, 1, 6))).toBe(13500);
    expect(amountDueMinor(escalante, d(2026, 11, 6))).toBe(10500);
    expect(lateFeeToAssessMinor({ ...escazuOldPrice, settledOn: null }, d(2027, 1, 6))).toBe(2000);
    expect(lateFeeToAssessMinor({ ...escazuNewPrice, settledOn: null }, d(2027, 1, 6))).toBe(2500);
  });
});

describe("settlement is oldest-first and whole-obligation only", () => {
  it("orders by coverage month across the year boundary, whatever order they arrive in", () => {
    const jan = obligation("jan", { year: 2027, month: 1 });
    expect(orderOldestFirst([jan, DEC, OCT, NOV]).map((o) => o.id)).toEqual(["oct", "nov", "dec", "jan"]);
  });

  it("does not mutate its input", () => {
    const input = [DEC, OCT];
    orderOldestFirst(input);
    expect(input.map((o) => o.id)).toEqual(["dec", "oct"]);
  });

  it("Dec 6: October USD 120, November USD 120, December USD 100; the selectable totals are 120, 240, 340", () => {
    const items = outstandingItems([DEC, OCT, NOV], d(2026, 12, 6));
    expect(items.map((i) => [i.id, i.amountMinor])).toEqual([["oct", 12000], ["nov", 12000], ["dec", 10000]]);
    const r = settleReceipt(items, 24000, "USD");
    expect(r).toEqual({ ok: true, settledIds: ["oct", "nov"], totalMinor: 24000 });
  });

  it("one USD 240 payment settles two overdue months together; USD 120 settles only the oldest", () => {
    const items = outstandingItems([OCT, NOV, DEC], d(2026, 12, 6));
    expect(settleReceipt(items, 12000, "USD")).toEqual({ ok: true, settledIds: ["oct"], totalMinor: 12000 });
    expect(settleReceipt(items, 34000, "USD")).toEqual({ ok: true, settledIds: ["oct", "nov", "dec"], totalMinor: 34000 });
  });

  it("refuses partial amounts and anything between or beyond totals, listing what would be accepted", () => {
    const items = outstandingItems([OCT, NOV, DEC], d(2026, 12, 6));
    for (const bad of [6000, 11999, 12001, 20000, 23000, 25000, 34001, 0]) {
      const r = settleReceipt(items, bad, "USD");
      expect(r.ok, `${bad} must be refused`).toBe(false);
      if (!r.ok) {
        expect(r.reason).toBe("NOT_A_SELECTABLE_TOTAL");
        expect(r.selectableTotalsMinor).toEqual([12000, 24000, 34000]);
      }
    }
  });

  it("the amount due depends on the received date: USD 100 on Nov 3, refused on Nov 8 because USD 120 is then due", () => {
    const early = outstandingItems([OCT], d(2026, 11, 3));
    const late = outstandingItems([OCT], d(2026, 11, 8));
    expect(settleReceipt(early, 10000, "USD").ok).toBe(true);
    expect(settleReceipt(late, 10000, "USD").ok).toBe(false);
    expect(settleReceipt(late, 12000, "USD")).toEqual({ ok: true, settledIds: ["oct"], totalMinor: 12000 });
  });

  it("an older unsettled obligation cannot be skipped: paying only November's amount is not a selectable total", () => {
    // October is on time on Nov 3 (100) and so is November (100): 100 settles October, never November alone.
    const items = outstandingItems([NOV, OCT], d(2026, 11, 3));
    const r = settleReceipt(items, 10000, "USD");
    expect(r).toEqual({ ok: true, settledIds: ["oct"], totalMinor: 10000 });
  });

  it("refuses a receipt in another currency (conversion is out of scope) and offers NO selectable totals", () => {
    // The obligations' totals are USD cents; presenting [10000] to a CRC payer would read as 10,000 colones.
    const items = outstandingItems([OCT], d(2026, 11, 3));
    const r = settleReceipt(items, 5000000, "CRC");
    expect(r).toEqual({ ok: false, reason: "CURRENCY_MISMATCH", selectableTotalsMinor: [] });
    // even when the number happens to equal a USD total, it is not accepted as a CRC receipt
    expect(settleReceipt(items, 10000, "CRC")).toEqual({ ok: false, reason: "CURRENCY_MISMATCH", selectableTotalsMinor: [] });
  });

  it("refuses obligations that mix currencies rather than adding them", () => {
    const items = outstandingItems([OCT, obligation("nov-crc", { year: 2026, month: 11 }, { currency: "CRC", tuitionMinor: 50000, lateFeeMinor: 10000 })], d(2026, 11, 3));
    expect(settleReceipt(items, 10000, "USD")).toMatchObject({ ok: false, reason: "CURRENCY_MISMATCH" });
  });

  it("is deterministic and side-effect free: the same call twice gives the same answer", () => {
    const items = outstandingItems([OCT, NOV], d(2026, 12, 6));
    expect(settleReceipt(items, 24000, "USD")).toEqual(settleReceipt(items, 24000, "USD"));
  });

  it("rejects amounts that are not positive whole minor units", () => {
    expect(() => outstandingItems([obligation("x", { year: 2026, month: 10 }, { tuitionMinor: 0 })], d(2026, 11, 3))).toThrow(RangeError);
    expect(() => outstandingItems([obligation("x", { year: 2026, month: 10 }, { tuitionMinor: 100.5 })], d(2026, 11, 3))).toThrow(RangeError);
    expect(() => settleReceipt([{ id: "a", currency: "USD", amountMinor: 100 }], -100, "USD")).toThrow(RangeError);
  });

  it("uses the dates a later PR will pass: due date and grace come from the calendar module", () => {
    expect(dueDateFor(OCT.coverage, 20)).toEqual(d(2026, 10, 20));
    expect(OCT.graceDeadline).toEqual(d(2026, 11, 5));
  });
});
