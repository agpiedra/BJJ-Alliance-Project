import { DateTime } from "luxon";
// Deliberately the "browser" enum module, not "@/generated/prisma/client":
// this file is imported by both the server page.tsx AND the "use client"
// schedule-calendar-view.tsx (same reasoning as create-class-session-form.tsx
// / edit-class-session-form.tsx). Pulling in the "client" module here dragged
// Prisma's Node-only runtime (node:crypto, node:fs, ...) into the browser
// bundle and broke `next build` — these enums are plain string objects, so
// the browser module (which doesn't bundle the runtime) is the correct one
// for a file with client importers.
import { ClassType, DayOfWeek } from "@/generated/prisma/browser";

/**
 * REDESIGN_BRIEF.md Phase 5: the week calendar's 7 columns run Sunday ->
 * Saturday — the OPPOSITE order from this directory's `queries.ts` own
 * `DAY_ORDER` (Monday-first, used only for the Lista table's natural weekday
 * sort). Two separate maps on purpose: conflating them would break either
 * the Lista sort or the calendar's column order.
 */
export const SUNDAY_FIRST_DAYS: DayOfWeek[] = [
  DayOfWeek.SUNDAY,
  DayOfWeek.MONDAY,
  DayOfWeek.TUESDAY,
  DayOfWeek.WEDNESDAY,
  DayOfWeek.THURSDAY,
  DayOfWeek.FRIDAY,
  DayOfWeek.SATURDAY,
];

/** luxon `DateTime.weekday` is 1 (Monday) .. 7 (Sunday) — this is the lookup
 * from that value to the matching `DayOfWeek` enum member, used to figure
 * out which calendar column "today" (or any navigated date) lands in. */
export const DAY_OF_WEEK_BY_LUXON_WEEKDAY: Record<number, DayOfWeek> = {
  1: DayOfWeek.MONDAY,
  2: DayOfWeek.TUESDAY,
  3: DayOfWeek.WEDNESDAY,
  4: DayOfWeek.THURSDAY,
  5: DayOfWeek.FRIDAY,
  6: DayOfWeek.SATURDAY,
  7: DayOfWeek.SUNDAY,
};

// ClassSession.type -> the Phase 1 `class-*` token utility class. One entry
// per ClassType enum member (verified complete against prisma/schema.prisma).
export const CLASS_TYPE_COLOR_CLASS: Record<ClassType, string> = {
  GI: "bg-class-gi",
  NO_GI: "bg-class-nogi",
  COMPETITION: "bg-class-comp",
  STRIKING: "bg-class-strike",
  KIDS: "bg-class-kids",
  OPEN_MAT: "bg-class-open",
};

// Legend order, matches design/alliance-mock.html's Horario legend row.
export const CLASS_TYPE_LEGEND_ORDER: ClassType[] = [
  ClassType.GI,
  ClassType.NO_GI,
  ClassType.COMPETITION,
  ClassType.STRIKING,
  ClassType.KIDS,
  ClassType.OPEN_MAT,
];

/** The Sunday on or before `date` — luxon's own `startOf("week")` is
 * Monday-first (ISO), so the calendar's Sunday-first week needs its own
 * rollback: `weekday` is 1 (Monday) .. 7 (Sunday), and `% 7` maps Sunday to
 * 0 (no rollback) and every other day to how far past Sunday it sits. */
export function startOfSundayWeek(date: DateTime): DateTime {
  return date.minus({ days: date.weekday % 7 });
}

/**
 * Wall-clock end time from a "HH:mm" start + a duration in minutes. This is
 * pure clock arithmetic with no timezone conversion (`startTime` /
 * `durationMinutes` are wall-clock values, not instants) — a plain
 * (unzoned) luxon DateTime is the right tool, not `ZONE`-based instant math
 * from src/lib/scheduling/zone.ts.
 */
export function addMinutesToClockTime(
  startTime: string,
  durationMinutes: number,
): { hour: number; minute: number; label: string } {
  const [hour, minute] = startTime.split(":").map(Number);
  const end = DateTime.fromObject({ hour, minute }).plus({ minutes: durationMinutes });
  return { hour: end.hour, minute: end.minute, label: end.toFormat("HH:mm") };
}
