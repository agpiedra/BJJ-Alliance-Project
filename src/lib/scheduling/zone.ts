import { DateTime } from "luxon";
import type { DayOfWeek } from "@/generated/prisma/client";

export const ZONE = "America/Costa_Rica";

/**
 * luxon `DateTime.weekday` (1 = Monday .. 7 = Sunday) -> the `DayOfWeek` enum
 * member. Type-only import above plus string literals here on purpose: this
 * module is also imported by the "use client" kiosk, and a VALUE import of
 * `@/generated/prisma/client` would drag Prisma's Node-only runtime into the
 * browser bundle (the same leak admin/schedule/calendar-helpers.ts documents).
 *
 * `src/lib/scheduling/check-in-window.ts` has its own private copy of this map.
 * That file is deliberately frozen (see its doc comments) and its copy is not
 * exported, so this is the shared one for everything outside it — not a second
 * timezone source of truth, just the weekday lookup, living next to `ZONE`.
 */
const DAY_OF_WEEK_BY_WEEKDAY: Record<number, DayOfWeek> = {
  1: "MONDAY",
  2: "TUESDAY",
  3: "WEDNESDAY",
  4: "THURSDAY",
  5: "FRIDAY",
  6: "SATURDAY",
  7: "SUNDAY",
};

/** The America/Costa_Rica weekday a real instant falls on. */
export function crDayOfWeek(instant: Date): DayOfWeek {
  return DAY_OF_WEEK_BY_WEEKDAY[DateTime.fromJSDate(instant, { zone: "utc" }).setZone(ZONE).weekday];
}

/**
 * The weekday of an `AttendanceRecord.date` value.
 *
 * Read in UTC, NOT shifted into `ZONE`: a `@db.Date` column comes back as
 * UTC midnight of the CR calendar day it already represents (that's exactly
 * what `attendanceDateFromZoned` writes), so converting it to CR time would
 * roll it back to 18:00 of the PREVIOUS day and report the wrong weekday.
 */
export function attendanceDateDayOfWeek(attendanceDate: Date): DayOfWeek {
  return DAY_OF_WEEK_BY_WEEKDAY[DateTime.fromJSDate(attendanceDate, { zone: "utc" }).weekday];
}

/**
 * Converts a UTC instant into the America/Costa_Rica calendar date it falls
 * on, returned as a UTC-midnight Date (the shape Prisma's `@db.Date` column
 * expects). NEVER use `occurredAt.toISOString().slice(0, 10)` for this —
 * most evening classes (18:00+ CR) fall on the next UTC calendar day, so a
 * naive slice silently produces the wrong date for the majority of
 * check-ins. See prisma/schema.prisma's comment on AttendanceRecord.date.
 */
export function toAttendanceDate(occurredAt: Date): Date {
  return attendanceDateFromZoned(DateTime.fromJSDate(occurredAt, { zone: "utc" }).setZone(ZONE));
}

/**
 * The same `@db.Date`-shaped UTC-midnight Date, but derived from an
 * already-CR-zoned `DateTime` instead of a raw instant.
 *
 * Needed because a class occurrence's ledger day is NOT always the CR calendar
 * day of the check-in instant: a class window can straddle CR midnight, so
 * two check-ins to the SAME class occurrence would otherwise land on two
 * different `date` values and slip past the
 * `@@unique([studentId, classSessionId, date])` constraint — two ledger rows
 * for one class. Callers stamp from the occurrence's matched anchor day
 * instead (see `selectActiveSessionOccurrence`).
 */
export function attendanceDateFromZoned(zoned: DateTime): Date {
  return DateTime.utc(zoned.year, zoned.month, zoned.day).toJSDate();
}
