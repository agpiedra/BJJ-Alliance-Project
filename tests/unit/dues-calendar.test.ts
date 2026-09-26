import { describe, expect, it } from "vitest";
import {
  addMonths,
  compareDates,
  compareYearMonth,
  daysInMonth,
  dueDateFor,
  enrollmentTiming,
  graceDeadlineFor,
} from "../../src/lib/dues/calendar";

/**
 * PR 1 of the student-dues work: pure calendar rules only. Everything here is a PURE-FUNCTION guarantee (same inputs, same output, no
 * clock, no database). Nothing in this file says anything about concurrency or uniqueness in storage; those belong to later PRs.
 *
 * The confirmed Alliance rules exercised (as settings passed in, never constants in the code under test): the due day is the 20th, the
 * grace deadline is the 5th of the FOLLOWING month INCLUSIVE, and a student joining before the due day gets that month's recurring
 * payment while one joining on or after it gets the next month's.
 */
const d = (year: number, month: number, day: number) => ({ year, month, day });

describe("daysInMonth (leap years and month lengths)", () => {
  it.each([
    [2026, 1, 31], [2026, 2, 28], [2028, 2, 29], [2100, 2, 28], [2000, 2, 29], [2026, 4, 30], [2026, 12, 31],
  ])("%i-%i has %i days", (year, month, days) => {
    expect(daysInMonth({ year, month })).toBe(days);
  });
});

describe("addMonths and compareYearMonth", () => {
  it("crosses the year boundary in both directions", () => {
    expect(addMonths({ year: 2026, month: 11 }, 3)).toEqual({ year: 2027, month: 2 });
    expect(addMonths({ year: 2026, month: 1 }, -1)).toEqual({ year: 2025, month: 12 });
    expect(addMonths({ year: 2026, month: 12 }, 1)).toEqual({ year: 2027, month: 1 });
    expect(addMonths({ year: 2026, month: 5 }, 0)).toEqual({ year: 2026, month: 5 });
    expect(addMonths({ year: 2026, month: 5 }, 24)).toEqual({ year: 2028, month: 5 });
  });

  it("orders months across years", () => {
    expect(compareYearMonth({ year: 2026, month: 12 }, { year: 2027, month: 1 })).toBeLessThan(0);
    expect(compareYearMonth({ year: 2027, month: 1 }, { year: 2026, month: 12 })).toBeGreaterThan(0);
    expect(compareYearMonth({ year: 2026, month: 3 }, { year: 2026, month: 3 })).toBe(0);
  });
});

describe("dueDateFor: the branch's due day, clamped to short months", () => {
  it("is the configured day (Alliance: the 20th)", () => {
    expect(dueDateFor({ year: 2026, month: 9 }, 20)).toEqual(d(2026, 9, 20));
  });

  it.each([
    [{ year: 2026, month: 2 }, 31, d(2026, 2, 28)],
    [{ year: 2028, month: 2 }, 31, d(2028, 2, 29)], // leap year
    [{ year: 2028, month: 2 }, 30, d(2028, 2, 29)],
    [{ year: 2026, month: 4 }, 31, d(2026, 4, 30)],
    [{ year: 2026, month: 1 }, 31, d(2026, 1, 31)],
    [{ year: 2100, month: 2 }, 29, d(2100, 2, 28)], // 2100 is not a leap year
  ])("clamps %j with due day %i to %j", (month, dueDay, expected) => {
    expect(dueDateFor(month, dueDay)).toEqual(expected);
  });

  it("rejects settings that are not a real day or month", () => {
    expect(() => dueDateFor({ year: 2026, month: 9 }, 0)).toThrow(RangeError);
    expect(() => dueDateFor({ year: 2026, month: 9 }, 32)).toThrow(RangeError);
    expect(() => dueDateFor({ year: 2026, month: 9 }, 20.5)).toThrow(RangeError);
    expect(() => dueDateFor({ year: 2026, month: 13 }, 20)).toThrow(RangeError);
    expect(() => dueDateFor({ year: 2026, month: 0 }, 20)).toThrow(RangeError);
  });
});

describe("graceDeadlineFor: a day of the FOLLOWING month, inclusive", () => {
  it("is the 5th of the next month (the confirmed Alliance rule): Sep coverage -> Oct 5", () => {
    expect(graceDeadlineFor({ year: 2026, month: 9 }, 5)).toEqual(d(2026, 10, 5));
  });

  it("crosses the year boundary: Dec 2026 coverage -> Jan 5 2027", () => {
    expect(graceDeadlineFor({ year: 2026, month: 12 }, 5)).toEqual(d(2027, 1, 5));
  });

  it("is a branch setting, not a constant: another branch's grace day of 10", () => {
    expect(graceDeadlineFor({ year: 2026, month: 9 }, 10)).toEqual(d(2026, 10, 10));
  });

  it("clamps to the next month's last day (leap and non-leap February)", () => {
    expect(graceDeadlineFor({ year: 2028, month: 1 }, 31)).toEqual(d(2028, 2, 29));
    expect(graceDeadlineFor({ year: 2026, month: 1 }, 31)).toEqual(d(2026, 2, 28));
  });

  it("always falls after the due date of the same coverage month", () => {
    for (let month = 1; month <= 12; month++) {
      const coverage = { year: 2026, month };
      expect(compareDates(dueDateFor(coverage, 31), graceDeadlineFor(coverage, 1))).toBeLessThan(0);
    }
  });

  it("rejects an impossible grace day", () => {
    expect(() => graceDeadlineFor({ year: 2026, month: 9 }, 0)).toThrow(RangeError);
    expect(() => graceDeadlineFor({ year: 2026, month: 9 }, 32)).toThrow(RangeError);
  });
});

describe("compareDates", () => {
  it("orders across months and years", () => {
    expect(compareDates(d(2026, 11, 5), d(2026, 11, 6))).toBeLessThan(0);
    expect(compareDates(d(2027, 1, 1), d(2026, 12, 31))).toBeGreaterThan(0);
    expect(compareDates(d(2026, 11, 5), d(2026, 11, 5))).toBe(0);
  });
});

describe("enrollmentTiming: signup versus recurring-charge timing (confirmed Sep 12, Sep 20, Sep 25)", () => {
  const dueDay = 20;

  it("joining Sep 12 (before the due day): a recurring charge for September, due Sep 20", () => {
    expect(enrollmentTiming(d(2026, 9, 12), dueDay)).toEqual({ firstMonthlyCoverage: { year: 2026, month: 9 }, firstRecurringDue: d(2026, 9, 20) });
  });

  it("joining Sep 20 (ON the due day): no September recurring charge, next due Oct 20", () => {
    expect(enrollmentTiming(d(2026, 9, 20), dueDay)).toEqual({ firstMonthlyCoverage: null, firstRecurringDue: d(2026, 10, 20) });
  });

  it("joining Sep 25 (after the due day): next due Oct 20", () => {
    expect(enrollmentTiming(d(2026, 9, 25), dueDay)).toEqual({ firstMonthlyCoverage: null, firstRecurringDue: d(2026, 10, 20) });
  });

  it("joining Sep 19 is the last day that still gets September's recurring charge", () => {
    expect(enrollmentTiming(d(2026, 9, 19), dueDay).firstMonthlyCoverage).toEqual({ year: 2026, month: 9 });
  });

  it("joining on the last day of a month, and across the year boundary", () => {
    expect(enrollmentTiming(d(2026, 10, 31), dueDay)).toEqual({ firstMonthlyCoverage: null, firstRecurringDue: d(2026, 11, 20) });
    expect(enrollmentTiming(d(2026, 12, 25), dueDay)).toEqual({ firstMonthlyCoverage: null, firstRecurringDue: d(2027, 1, 20) });
    expect(enrollmentTiming(d(2026, 12, 19), dueDay)).toEqual({ firstMonthlyCoverage: { year: 2026, month: 12 }, firstRecurringDue: d(2026, 12, 20) });
  });

  it("uses the branch's due day, not 20: due day 5, joining Sep 4 vs Sep 5", () => {
    expect(enrollmentTiming(d(2026, 9, 4), 5).firstMonthlyCoverage).toEqual({ year: 2026, month: 9 });
    expect(enrollmentTiming(d(2026, 9, 5), 5)).toEqual({ firstMonthlyCoverage: null, firstRecurringDue: d(2026, 10, 5) });
  });

  it("compares against the CLAMPED due date in a short month (leap-year Feb, due day 30)", () => {
    // Feb 2028 has 29 days, so the due date is Feb 29: joining Feb 28 is before it, joining Feb 29 is on it.
    expect(enrollmentTiming(d(2028, 2, 28), 30)).toEqual({ firstMonthlyCoverage: { year: 2028, month: 2 }, firstRecurringDue: d(2028, 2, 29) });
    expect(enrollmentTiming(d(2028, 2, 29), 30)).toEqual({ firstMonthlyCoverage: null, firstRecurringDue: d(2028, 3, 30) });
  });

  it("rejects a date that does not exist", () => {
    expect(() => enrollmentTiming(d(2026, 2, 29), dueDay)).toThrow(RangeError);
  });
});
