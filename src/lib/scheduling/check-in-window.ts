import { DateTime } from "luxon";
import { ZONE } from "./zone";
import type { DayOfWeek } from "@/generated/prisma/client";

const WINDOW_MINUTES = 30;

const DAY_INDEX: Record<DayOfWeek, number> = {
  MONDAY: 1,
  TUESDAY: 2,
  WEDNESDAY: 3,
  THURSDAY: 4,
  FRIDAY: 5,
  SATURDAY: 6,
  SUNDAY: 7,
};

interface SessionTiming {
  dayOfWeek: DayOfWeek;
  startTime: string; // "HH:mm", 24h, CR wall-clock
  durationMinutes: number;
}

/**
 * The check-in window for one occurrence of a class session, anchored to
 * the CR calendar date the session actually falls on relative to
 * `referenceDate`. Returns UTC instants (real Date objects), so callers can
 * compare directly against `new Date()`.
 */
export function getCheckInWindow(session: SessionTiming, referenceDate: Date): { start: Date; end: Date } {
  const [hour, minute] = session.startTime.split(":").map(Number);
  const refInZone = DateTime.fromJSDate(referenceDate, { zone: "utc" }).setZone(ZONE);

  const sessionStart = refInZone.set({
    hour,
    minute,
    second: 0,
    millisecond: 0,
  });

  return {
    start: sessionStart.minus({ minutes: WINDOW_MINUTES }).toJSDate(),
    end: sessionStart.plus({ minutes: session.durationMinutes + WINDOW_MINUTES }).toJSDate(),
  };
}

/**
 * True if `now` falls within this session's check-in window, given that
 * `now`'s CR calendar day matches the session's scheduled day of week.
 * Callers should already have filtered sessions to today's dayOfWeek before
 * calling this (see Task 5's `findActiveClassSession`).
 */
export function isWithinCheckInWindow(session: SessionTiming, now: Date): boolean {
  const nowInZone = DateTime.fromJSDate(now, { zone: "utc" }).setZone(ZONE);
  if (DAY_INDEX[session.dayOfWeek] !== nowInZone.weekday) return false;

  const window = getCheckInWindow(session, now);
  return now >= window.start && now <= window.end;
}
