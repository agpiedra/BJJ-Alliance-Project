import { DateTime } from "luxon";
import { attendanceDateFromZoned, ZONE } from "@/lib/scheduling/zone";
import { isInsideWindow, nextBoundaryAfter, occurrencesForToday } from "@/lib/scheduling/check-in-window";
import { getScopedDb } from "@/lib/tenant/scoped-client";
import { AttendanceType, type ClassType } from "@/generated/prisma/client";
import type { AccessContext } from "@/lib/tenant/types";

/**
 * The honest state of one class for one student, right now:
 *  - checked_in: the student already has a valid check-in for THIS occurrence (a voided one does not count).
 *  - open: the class window contains now (start -30 minutes to end +30 minutes, inclusive, using that class's own
 *    duration; windows of neighbouring classes overlap, so several rows can be open at once) - exactly what
 *    `performCheckIn` accepts for an explicit selection under the portal's OPEN_ONLY policy.
 *  - not_open_yet: it opens later today; `opensAt` is the CR wall-clock time (`HH:mm`).
 *  - closed: its window has ended.
 */
export type ClassRowState =
  | { kind: "checked_in" }
  | { kind: "open" }
  | { kind: "not_open_yet"; opensAt: string }
  | { kind: "closed" };

export interface TodaysClass {
  id: string;
  name: string;
  /** The class's real modality (Gi, No-Gi, Striking, Kids, Open Mat, Competition) - never relabelled. */
  type: ClassType;
  /** `HH:mm`, CR wall clock. */
  startTime: string;
  endTime: string;
  /** False for a class that is recorded but does not count toward promotion (the row says so). */
  countsTowardPromotion: boolean;
  state: ClassRowState;
}

export interface TodaysClassesView {
  classes: TodaysClass[];
  /**
   * The next instant (ISO 8601), strictly after `serverNow`, at which anything in `classes` can change: a window
   * opening, a window closing, or the Costa Rica day rolling over. The page refreshes itself at this instant so a
   * tab left open never shows a stale state. It is a scheduling hint only - every check-in is re-validated by the
   * server, so a stale or wrong hint can delay a refresh but can never let anything through.
   */
  nextChangeAt: string;
  /** The server's clock (ISO 8601) that produced `classes`; the client measures its own clock skew against it. */
  serverNow: string;
}

/**
 * Today's classes for the student's own academy, in start order, each with its honest state. "Today" and every
 * boundary are Costa Rica (Luxon with an explicit zone, never the server's local calendar): the list holds the
 * classes scheduled on today's CR date plus any occurrence whose window is open right now across midnight.
 * Scoped to the caller's organization by the tenant guard AND to the given academy; inactive classes are omitted.
 * An empty list means the academy has no classes today (the page says so).
 */
export async function listTodaysClasses(params: {
  context: AccessContext;
  academyId: string;
  studentId: string;
  now?: Date;
}): Promise<TodaysClassesView> {
  const now = params.now ?? new Date();
  const db = getScopedDb(params.context);

  const sessions = await db.classSession.findMany({ where: { academyId: params.academyId, active: true } });
  const stamp = { nextChangeAt: nextBoundaryAfter(sessions, now).toISOString(), serverNow: now.toISOString() };
  const occurrences = sessions.flatMap((session) => occurrencesForToday(session, now));
  if (occurrences.length === 0) return { classes: [], ...stamp };

  // Valid (not voided) check-ins of THIS student to these classes on the occurrence's own date.
  const checkIns = await db.attendanceRecord.findMany({
    where: {
      studentId: params.studentId,
      type: AttendanceType.CHECKIN,
      voidedAt: null,
      classSessionId: { in: occurrences.map((o) => o.session.id) },
      date: { in: occurrences.map((o) => attendanceDateFromZoned(o.anchorDate)) },
    },
    select: { classSessionId: true, date: true },
  });
  const checkedIn = new Set(checkIns.map((row) => `${row.classSessionId}|${row.date.toISOString().slice(0, 10)}`));

  const classes = occurrences
    .sort((a, b) => a.startsAt.toMillis() - b.startsAt.toMillis() || a.session.id.localeCompare(b.session.id))
    .map((o): TodaysClass => {
      const key = `${o.session.id}|${attendanceDateFromZoned(o.anchorDate).toISOString().slice(0, 10)}`;
      const state: ClassRowState = checkedIn.has(key)
        ? { kind: "checked_in" }
        : isInsideWindow(o, now)
          ? { kind: "open" }
          : now < o.opensAt
            ? { kind: "not_open_yet", opensAt: DateTime.fromJSDate(o.opensAt, { zone: ZONE }).toFormat("HH:mm") }
            : { kind: "closed" };
      return {
        id: o.session.id,
        name: o.session.name,
        type: o.session.type,
        startTime: o.session.startTime,
        endTime: o.startsAt.plus({ minutes: o.session.durationMinutes }).toFormat("HH:mm"),
        countsTowardPromotion: o.session.countsTowardPromotion,
        state,
      };
    });
  return { classes, ...stamp };
}
