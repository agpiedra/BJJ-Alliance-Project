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
  const crDate = DateTime.fromJSDate(occurredAt, { zone: "utc" }).setZone(ZONE);
  return DateTime.utc(crDate.year, crDate.month, crDate.day).toJSDate();
}
