/**
 * REDESIGN_BRIEF.md Phase 5 "WeekCalendar" row-placement math, split out of
 * week-calendar.tsx specifically because that file is "use client". Once a
 * module has "use client", EVERY export becomes an opaque client reference
 * when imported elsewhere — calling one as a plain function during SSR
 * throws "Attempted to call rowFor() from the server but rowFor is on the
 * client." That is exactly what src/app/[locale]/portal/page.tsx (a Server
 * Component) hit calling `rowFor` imported from week-calendar.tsx: a real
 * 500 on every student portal load, invisible to all 445 previously-green
 * tests because none of them render a page through Next's real SSR
 * pipeline — only tests/smoke/page-routes.test.ts, which drives a real
 * server, ever caught it. Pure arithmetic never needed a client boundary in
 * the first place; this file has none, so both the client `WeekCalendar`
 * component and any server page can import it directly.
 */
export const CALENDAR_START_HOUR = 6;
export const CALENDAR_END_HOUR = 20; // exclusive — last half-hour track ends at 20:00

/**
 * The brief's own formula: grid row 2 is 06:00, each hour is 2 half-hour
 * tracks. Exported so the row-placement math has a direct unit test.
 */
export function rowFor(hour: number, minute: number): number {
  return 2 + (hour - CALENDAR_START_HOUR) * 2 + (minute === 30 ? 1 : 0);
}
