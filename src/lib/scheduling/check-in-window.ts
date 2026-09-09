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
  /**
   * NOT part of the check-in window any more (spec §5's window is literally
   * "30 minutes before to 30 minutes after the START"). Kept on the shape so
   * real `ClassSession` rows and existing call sites still satisfy it.
   */
  durationMinutes?: number;
}

/**
 * The check-in window for one occurrence of a class session, anchored to
 * the CR calendar date the session actually falls on relative to
 * `referenceDate`. Returns UTC instants (real Date objects), so callers can
 * compare directly against `new Date()`.
 *
 * The window is `start - 30min .. start + 30min` — it deliberately does NOT
 * extend by the class duration. An earlier implementation used
 * `start - 30 .. start + duration + 30`, which for an ordinary 60-minute
 * class produced a 2.5-hour window; with back-to-back hourly classes (which
 * the seeded Escazú schedule genuinely has) that made adjacent classes'
 * windows overlap by a full hour, so the same tap could be attributed to
 * either class. Spec §5's literal wording is the narrower window, and it
 * makes adjacent hourly classes merely touch at their boundary instead.
 */
export function getCheckInWindow(session: SessionTiming, referenceDate: Date): { start: Date; end: Date } {
  const sessionStart = startOfOccurrence(session, DateTime.fromJSDate(referenceDate, { zone: "utc" }).setZone(ZONE));

  return {
    start: sessionStart.minus({ minutes: WINDOW_MINUTES }).toJSDate(),
    end: sessionStart.plus({ minutes: WINDOW_MINUTES }).toJSDate(),
  };
}

/** The session's scheduled start, as a CR-zoned instant on `anchorDay`'s calendar date. */
function startOfOccurrence(session: SessionTiming, anchorDay: DateTime): DateTime {
  const [hour, minute] = session.startTime.split(":").map(Number);
  return anchorDay.set({ hour, minute, second: 0, millisecond: 0 });
}

/**
 * One occurrence of a session whose check-in window contains a given instant.
 *
 * `anchorDate` is the CR calendar day the matched occurrence belongs to — NOT
 * necessarily the CR calendar day of `now`, since a ±30-minute window can
 * cross local midnight. Callers that bucket attendance by day must stamp from
 * this, not from the wall-clock instant (see `performCheckIn`).
 */
export interface SessionOccurrence<T extends SessionTiming> {
  session: T;
  /** CR-zoned start-of-day for the occurrence's calendar date. */
  anchorDate: DateTime;
  /** The occurrence's scheduled start instant, CR-zoned. */
  startsAt: DateTime;
}

/**
 * Every anchor day (yesterday / today / tomorrow in CR time, relative to
 * `now`) whose occurrence of `session` both matches `session.dayOfWeek` and
 * whose ±30-minute window contains `now`.
 *
 * The three-candidate loop exists because a session's window can legitimately
 * extend into an adjacent calendar day (a 23:50 start, or a 00:05 start), so
 * checking `now`'s own CR weekday against `session.dayOfWeek` would silently
 * reject legitimate check-ins on either side of midnight.
 *
 * At most one candidate can ever match — the three candidate days have three
 * distinct weekdays, and only one can equal `session.dayOfWeek` — so this
 * returns the single match or `null`.
 */
function matchOccurrence<T extends SessionTiming>(session: T, now: Date): SessionOccurrence<T> | null {
  const nowInZone = DateTime.fromJSDate(now, { zone: "utc" }).setZone(ZONE);

  for (const dayOffset of [-1, 0, 1]) {
    const candidateDay = nowInZone.plus({ days: dayOffset });
    if (DAY_INDEX[session.dayOfWeek] !== candidateDay.weekday) continue;

    const startsAt = startOfOccurrence(session, candidateDay);
    const start = startsAt.minus({ minutes: WINDOW_MINUTES }).toJSDate();
    const end = startsAt.plus({ minutes: WINDOW_MINUTES }).toJSDate();
    if (now >= start && now <= end) {
      return { session, anchorDate: candidateDay.startOf("day"), startsAt };
    }
  }

  return null;
}

/**
 * True if `now` falls within this session's check-in window, on whichever
 * adjacent calendar day the window actually spans.
 */
export function isWithinCheckInWindow(session: SessionTiming, now: Date): boolean {
  return matchOccurrence(session, now) !== null;
}

/**
 * Pick the ONE session occurrence a check-in at `now` belongs to, out of a
 * list of candidate sessions.
 *
 * Overlapping windows are still possible even with the narrowed ±30-minute
 * window: adjacent hourly classes touch exactly at their shared boundary
 * instant, and Task 9's admin schedule editor can create genuinely
 * overlapping sessions on purpose or by mistake. Picking "whichever row
 * Postgres happened to return first" would non-deterministically attribute
 * the same tap to different classes across identical requests — including
 * flipping whether it counts toward promotion at all.
 *
 * Deterministic selection rules, applied in order:
 *   1. The occurrence whose scheduled start is CLOSEST in absolute time to
 *      `now` wins (you are checking in to the class you are nearest to).
 *   2. Tie (e.g. exactly on the boundary between two back-to-back classes):
 *      the EARLIER scheduled start wins — at that instant the earlier class
 *      is already under way, whereas the later one has not begun.
 *   3. Still tied (two sessions scheduled at the identical time — the unique
 *      constraint only blocks an exact day/time/NAME collision, so this is
 *      reachable): the lexicographically smallest `id` wins. Arbitrary, but
 *      total and stable, which is the whole point.
 */
export function selectActiveSessionOccurrence<T extends SessionTiming & { id: string }>(
  sessions: T[],
  now: Date,
): SessionOccurrence<T> | null {
  const matches = sessions
    .map((session) => matchOccurrence(session, now))
    .filter((match): match is SessionOccurrence<T> => match !== null);

  if (matches.length === 0) return null;

  return matches.reduce((best, candidate) => {
    const bestDistance = Math.abs(best.startsAt.toMillis() - now.getTime());
    const candidateDistance = Math.abs(candidate.startsAt.toMillis() - now.getTime());
    if (candidateDistance !== bestDistance) {
      return candidateDistance < bestDistance ? candidate : best;
    }

    const bestStart = best.startsAt.toMillis();
    const candidateStart = candidate.startsAt.toMillis();
    if (candidateStart !== bestStart) {
      return candidateStart < bestStart ? candidate : best;
    }

    return candidate.session.id < best.session.id ? candidate : best;
  });
}
