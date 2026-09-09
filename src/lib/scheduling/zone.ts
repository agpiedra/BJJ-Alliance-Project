import { DateTime } from "luxon";

export const ZONE = "America/Costa_Rica";

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
 * day of the check-in instant: a ±30-minute window can straddle CR midnight, so
 * two check-ins to the SAME class occurrence would otherwise land on two
 * different `date` values and slip past the
 * `@@unique([studentId, classSessionId, date])` constraint — two ledger rows
 * for one class. Callers stamp from the occurrence's matched anchor day
 * instead (see `selectActiveSessionOccurrence`).
 */
export function attendanceDateFromZoned(zoned: DateTime): Date {
  return DateTime.utc(zoned.year, zoned.month, zoned.day).toJSDate();
}
