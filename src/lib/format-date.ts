/**
 * A TIMESTAMP field (e.g. `Student.joinedAt`, `Promotion.awardedAt`) — must
 * be rendered in the academy's wall clock, never
 * `toISOString().slice(0, 10)`. Costa Rica is UTC-6 with no DST, so a student
 * who joined (or checked in) at 19:00 CR has a UTC timestamp already on the
 * NEXT calendar day; a naive slice displays that date a day late. Same bug
 * class Phase 1's schema comment on `AttendanceRecord.date` warns about.
 *
 * Extracted verbatim (byte-for-byte logic, not rewritten) from a private
 * function of the same name that previously lived only in
 * `src/app/[locale]/(staff)/students/[id]/page.tsx` — Phase 5 Task 2's student
 * portal page needs the exact same behavior for its own attendance/promotion
 * history rendering, so this was pulled into a shared module rather than
 * duplicated a second time. `(staff)/students/[id]/page.tsx` now imports it from
 * here too.
 */
export function formatTimestampInAcademyZone(date: Date | null, locale: string): string | null {
  if (!date) return null;
  return new Intl.DateTimeFormat(locale === "es" ? "es-CR" : "en-US", {
    timeZone: "America/Costa_Rica",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}
