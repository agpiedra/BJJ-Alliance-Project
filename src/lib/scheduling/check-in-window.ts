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
   * The class's own configured duration. REQUIRED: it is part of the check-in window (`closesAt` is the scheduled end
   * plus 30 minutes), so a call site that forgot it must fail to compile rather than silently get a wrong window. The
   * schedule editor caps it at 600 minutes, so a window (at most 30 + 600 + 30 minutes) never reaches past the day
   * before or after the occurrence's own day, which is why the +/-1 day candidate loops below are sufficient.
   */
  durationMinutes: number;
}

/**
 * The check-in window for one occurrence of a class session, anchored to
 * the CR calendar date the session actually falls on relative to
 * `referenceDate`. Returns UTC instants (real Date objects), so callers can
 * compare directly against `new Date()`. See `occurrenceWindow` for the rule.
 */
export function getCheckInWindow(session: SessionTiming, referenceDate: Date): { start: Date; end: Date } {
  const sessionStart = startOfOccurrence(session, DateTime.fromJSDate(referenceDate, { zone: "utc" }).setZone(ZONE));

  const { opensAt, closesAt } = occurrenceWindow(sessionStart, session.durationMinutes);
  return { start: opensAt, end: closesAt };
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
 * necessarily the CR calendar day of `now`, since a window can cross local
 * midnight (either end). Callers that bucket attendance by day must stamp from
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
 * The ONE definition of when a class occurrence is open for check-in (confirmed by the academy owner, for EVERY
 * class): `opensAt` = scheduled start - 30 minutes; `closesAt` = scheduled start + the class's OWN configured
 * duration + 30 minutes; inclusive at both ends. An 18:00-19:00 class is open 17:30-19:30, a 19:00-20:30 class
 * 18:30-21:00, an 18:30-19:30 class 18:00-20:00. There is no shared evening window and no fixed cutoff. Automatic
 * matching, the validation of an explicitly selected class and the portal's list of today's classes (and the moment
 * the portal refreshes itself) ALL read this function, so what the screen calls "open" is exactly what the server
 * accepts. Windows of neighbouring classes overlap by design; see `selectActiveSessionOccurrence` for how an
 * automatic match is chosen and `performCheckIn` for why an explicit selection always wins.
 */
export function occurrenceWindow(startsAt: DateTime, durationMinutes: number): { opensAt: Date; closesAt: Date } {
  return {
    opensAt: startsAt.minus({ minutes: WINDOW_MINUTES }).toJSDate(),
    closesAt: startsAt.plus({ minutes: durationMinutes + WINDOW_MINUTES }).toJSDate(),
  };
}

/** The occurrence of `session` on the CR calendar day of `anchorDay` (any time of that day): its start instant, CR-zoned. */
export function occurrenceStart(session: SessionTiming, anchorDay: DateTime): DateTime {
  return startOfOccurrence(session, anchorDay);
}

/** True when `instant` is inside the (inclusive) window `[opensAt, closesAt]`. */
export function isInsideWindow(window: { opensAt: Date; closesAt: Date }, instant: Date): boolean {
  return instant >= window.opensAt && instant <= window.closesAt;
}

/**
 * Every anchor day (yesterday / today / tomorrow in CR time, relative to
 * `now`) whose occurrence of `session` both matches `session.dayOfWeek` and
 * whose check-in window contains `now`.
 *
 * The three-candidate loop exists because a session's window can legitimately
 * extend into an adjacent calendar day (a 23:50 start, a class that runs past
 * midnight, or a 00:05 start whose window opens the evening before), so
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
    if (isInsideWindow(occurrenceWindow(startsAt, session.durationMinutes), now)) {
      return { session, anchorDate: candidateDay.startOf("day"), startsAt };
    }
  }

  return null;
}

/**
 * The occurrence of `session` whose window contains `now`, or null when the class is not open right now. The
 * validation of an EXPLICITLY selected class uses this (no nearest-time ranking: the class is either open or not).
 */
export function openOccurrence<T extends SessionTiming>(session: T, now: Date): SessionOccurrence<T> | null {
  return matchOccurrence(session, now);
}

/** An occurrence together with its (inclusive) check-in window. */
export interface WindowedOccurrence<T extends SessionTiming> extends SessionOccurrence<T> {
  opensAt: Date;
  closesAt: Date;
}

/**
 * The occurrences of `session` that belong on "today's classes" at `now`: the one on today's CR calendar date,
 * whether or not its window is open, plus - because a window can straddle CR midnight - the occurrence on an
 * adjacent day whose window is open RIGHT NOW (a 00:10 class is open from 23:40 the evening before). Days and
 * boundaries are explicit America/Costa_Rica, never the server's local calendar. At most one element: the three
 * candidate days have three distinct weekdays.
 */
export function occurrencesForToday<T extends SessionTiming>(session: T, now: Date): WindowedOccurrence<T>[] {
  const nowInZone = DateTime.fromJSDate(now, { zone: "utc" }).setZone(ZONE);
  const found: WindowedOccurrence<T>[] = [];
  for (const dayOffset of [-1, 0, 1]) {
    const candidateDay = nowInZone.plus({ days: dayOffset });
    if (DAY_INDEX[session.dayOfWeek] !== candidateDay.weekday) continue;
    const startsAt = startOfOccurrence(session, candidateDay);
    const window = occurrenceWindow(startsAt, session.durationMinutes);
    if (dayOffset === 0 || isInsideWindow(window, now)) {
      found.push({ session, anchorDate: candidateDay.startOf("day"), startsAt, ...window });
    }
  }
  return found;
}

/**
 * The next instant, strictly after `now`, at which what a student sees in today's class list can change:
 *  - a window OPENING (`start - 30 min`), including a class on the adjacent day whose window opens tonight;
 *  - a window CLOSING - the first instant AFTER its inclusive end (`start + duration + 30 min + 1 ms`, each class
 *    with its own duration), including yesterday's class that is still open after midnight;
 *  - the Costa Rica calendar day rolling over (the list of "today's" classes changes at 00:00 CR).
 * Every boundary is computed with the same `occurrenceWindow` and explicit America/Costa_Rica day arithmetic as the
 * rest of this module, never the server's or the browser's calendar. The portal hands this instant to the page so it
 * can refresh itself exactly when a row would change (see `TodaysClassesCard`); it is a scheduling hint, never an
 * authority - the server re-validates every check-in.
 */
export function nextBoundaryAfter(sessions: SessionTiming[], now: Date): Date {
  const nowInZone = DateTime.fromJSDate(now, { zone: "utc" }).setZone(ZONE);
  let next = nowInZone.plus({ days: 1 }).startOf("day").toMillis();

  for (const session of sessions) {
    for (const dayOffset of [-1, 0, 1]) {
      const candidateDay = nowInZone.plus({ days: dayOffset });
      if (DAY_INDEX[session.dayOfWeek] !== candidateDay.weekday) continue;
      const { opensAt, closesAt } = occurrenceWindow(startOfOccurrence(session, candidateDay), session.durationMinutes);
      for (const boundary of [opensAt.getTime(), closesAt.getTime() + 1]) {
        if (boundary > now.getTime() && boundary < next) next = boundary;
      }
    }
  }
  return new Date(next);
}

/**
 * True if `now` falls within this session's check-in window, on whichever
 * adjacent calendar day the window actually spans.
 */
export function isWithinCheckInWindow(session: SessionTiming, now: Date): boolean {
  return matchOccurrence(session, now) !== null;
}

/**
 * Every occurrence, across `sessions`, whose check-in window contains `instant` - the classes a student could be
 * checking in to right now.
 *
 * Overlaps are EXPECTED (owner-confirmed window: start - 30 .. end + 30, so back-to-back hourly classes overlap for an
 * hour), and this function never chooses between them: the caller decides. The kiosk checks in automatically only when
 * exactly ONE class is open and otherwise asks the student which class they attended BEFORE anything is written;
 * a valid explicit selection always wins (see `performCheckIn`). The order is stable and total - scheduled start, then
 * id - so a picker shows the same list in the same order on every request and in either input order.
 */
export function openOccurrences<T extends SessionTiming & { id: string }>(sessions: T[], instant: Date): SessionOccurrence<T>[] {
  return sessions
    .map((session) => matchOccurrence(session, instant))
    .filter((match): match is SessionOccurrence<T> => match !== null)
    .sort((a, b) => a.startsAt.toMillis() - b.startsAt.toMillis() || (a.session.id < b.session.id ? -1 : a.session.id > b.session.id ? 1 : 0));
}
