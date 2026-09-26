import { DateTime } from "luxon";

/**
 * Pure calendar rules for student dues. Plain `{year, month, day}` parts, like `currentCrDateParts()` and `period-window.ts`: no zone,
 * no clock and no storage in this module. The CALLER resolves "today" or a received date as the branch's local calendar date; every
 * due day and grace day here is a setting passed in, never a constant (Alliance's 20th and 5th are only test data).
 */
export interface YearMonth {
  year: number;
  /** 1 to 12. */
  month: number;
}

export interface CalendarDate extends YearMonth {
  day: number;
}

export function assertYearMonth(m: YearMonth): void {
  if (!Number.isInteger(m.year) || !Number.isInteger(m.month) || m.month < 1 || m.month > 12) {
    throw new RangeError(`Not a calendar month: ${m.year}-${m.month}`);
  }
}

/** A configured day of the month (a due day or a grace day): 1 to 31, clamped later to short months. */
function assertDaySetting(day: number, label: string): void {
  if (!Number.isInteger(day) || day < 1 || day > 31) throw new RangeError(`${label} must be a whole day from 1 to 31, got ${day}`);
}

export function daysInMonth(m: YearMonth): number {
  assertYearMonth(m);
  return DateTime.utc(m.year, m.month).daysInMonth as number;
}

export function compareYearMonth(a: YearMonth, b: YearMonth): number {
  return a.year - b.year || a.month - b.month;
}

export function compareDates(a: CalendarDate, b: CalendarDate): number {
  return compareYearMonth(a, b) || a.day - b.day;
}

export function addMonths(m: YearMonth, months: number): YearMonth {
  assertYearMonth(m);
  if (!Number.isInteger(months)) throw new RangeError(`Months to add must be a whole number, got ${months}`);
  const index = m.year * 12 + (m.month - 1) + months;
  const year = Math.floor(index / 12);
  return { year, month: index - year * 12 + 1 };
}

/** The calendar day after `date` (month ends and leap years handled by luxon). */
export function nextDay(date: CalendarDate): CalendarDate {
  const next = DateTime.utc(date.year, date.month, date.day).plus({ days: 1 });
  return { year: next.year, month: next.month, day: next.day };
}

function assertDate(date: CalendarDate): void {
  assertYearMonth(date);
  if (!Number.isInteger(date.day) || date.day < 1 || date.day > daysInMonth(date)) {
    throw new RangeError(`Not a calendar date: ${date.year}-${date.month}-${date.day}`);
  }
}

/** The due date of a coverage month: the branch's due day, clamped to the month's last day (Feb, 30-day months). */
export function dueDateFor(coverage: YearMonth, dueDay: number): CalendarDate {
  assertYearMonth(coverage);
  assertDaySetting(dueDay, "The due day");
  return { year: coverage.year, month: coverage.month, day: Math.min(dueDay, daysInMonth(coverage)) };
}

/**
 * The grace deadline of a coverage month, INCLUSIVE: `graceDay` of the FOLLOWING month (the confirmed rule), clamped to that month's
 * last day. A payment received on this date is still on time; the late fee applies from the next day.
 */
export function graceDeadlineFor(coverage: YearMonth, graceDay: number): CalendarDate {
  assertYearMonth(coverage);
  assertDaySetting(graceDay, "The grace day");
  const next = addMonths(coverage, 1);
  return { ...next, day: Math.min(graceDay, daysInMonth(next)) };
}

/**
 * Signup versus recurring-charge timing. A signup charge always applies at enrollment. A student enrolling BEFORE the (clamped) due date
 * of the enrollment month also gets that month's recurring charge, due on that date; one enrolling on or after it gets none for that
 * month, and the next recurring charge is due on the following month's due date. Sep 12 -> September due Sep 20; Sep 20 or Sep 25 ->
 * next due Oct 20 (due day 20).
 */
export function enrollmentTiming(
  enrolledOn: CalendarDate,
  dueDay: number,
): { firstMonthlyCoverage: YearMonth | null; firstRecurringDue: CalendarDate } {
  assertDate(enrolledOn);
  const due = dueDateFor(enrolledOn, dueDay);
  if (compareDates(enrolledOn, due) < 0) {
    return { firstMonthlyCoverage: { year: enrolledOn.year, month: enrolledOn.month }, firstRecurringDue: due };
  }
  return { firstMonthlyCoverage: null, firstRecurringDue: dueDateFor(addMonths(enrolledOn, 1), dueDay) };
}
