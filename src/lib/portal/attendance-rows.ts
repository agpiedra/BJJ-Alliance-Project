import type { AttendanceEntryKind, AttendanceHistoryEntry } from "@/lib/students/attendance-history";

/** Entries per page of the portal's attendance history (the first render and every "show older" request). */
export const ATTENDANCE_PAGE_SIZE = 25;

/**
 * One history entry, ready to render on the client with no further formatting: the timestamp is already shown in
 * the academy's wall clock (America/Costa_Rica, never the browser's or the server's zone) and the machine-readable
 * instant travels along for the `<time>` element.
 */
export interface AttendanceRow {
  id: string;
  /** The exact instant, ISO 8601, for `<time dateTime>`. */
  iso: string;
  /** e.g. "01/05/2026, 18:30" (en) / "05/01/2026, 18:30" (es), Costa Rica time. */
  whenLabel: string;
  kind: AttendanceEntryKind;
  className: string | null;
  reason: string | null;
  delta: number;
}

export function toAttendanceRow(entry: AttendanceHistoryEntry, locale: string): AttendanceRow {
  const whenLabel = new Intl.DateTimeFormat(locale === "es" ? "es-CR" : "en-US", {
    timeZone: "America/Costa_Rica",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(entry.date);
  return {
    id: entry.id,
    iso: entry.date.toISOString(),
    whenLabel,
    kind: entry.kind,
    className: entry.className,
    reason: entry.reason,
    delta: entry.delta,
  };
}
