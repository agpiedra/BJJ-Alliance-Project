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
 * True if `now` falls within this session's check-in window. A session's
 * ±30-minute window can cross CR midnight (e.g. a 22:30 start with a long
 * duration, or a start in the first ~29 minutes after midnight), so we
 * can't just check whether `now`'s own CR calendar day matches
 * `session.dayOfWeek` — the window that actually contains `now` might be
 * anchored to the day before or after. Instead, try anchoring the window
 * to yesterday/today/tomorrow (in CR time) relative to `now`, and accept
 * whichever anchor both matches `session.dayOfWeek` and actually contains
 * `now`.
 */
export function isWithinCheckInWindow(session: SessionTiming, now: Date): boolean {
  const nowInZone = DateTime.fromJSDate(now, { zone: "utc" }).setZone(ZONE);

  for (const dayOffset of [-1, 0, 1]) {
    const candidateDay = nowInZone.plus({ days: dayOffset });
    if (DAY_INDEX[session.dayOfWeek] !== candidateDay.weekday) continue;

    const window = getCheckInWindow(session, candidateDay.toJSDate());
    if (now >= window.start && now <= window.end) {
      return true;
    }
  }

  return false;
}
