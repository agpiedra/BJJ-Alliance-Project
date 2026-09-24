import { DateTime } from "luxon";
import { prisma } from "@/lib/prisma";
import { ZONE, attendanceDateDayOfWeek, attendanceDateFromZoned } from "@/lib/scheduling/zone";
import { AttendanceType, QueuedCheckInStatus } from "@/generated/prisma/client";

/**
 * Plain functions, NOT "use server" actions — same reasoning (and the same two
 * halves of it) as `admin/schedule/queries.ts`' own doc comment: a file-level
 * "use server" directive would make every export independently invocable by
 * its action id from any browser, and this module imports Prisma, which must
 * never be pulled into a Client Component's bundle.
 *
 * Unlike that file, these DO read per-student data, so every caller must gate
 * itself first — `page.tsx` does, via `requireStaffSession(["ADMIN",
 * "DIRECTOR"])` plus its own academy scoping.
 */

/** Today's CR calendar date, in the `@db.Date` shape `AttendanceRecord.date` uses. */
export function crToday(now: Date = new Date()): Date {
  return attendanceDateFromZoned(DateTime.fromJSDate(now, { zone: "utc" }).setZone(ZONE));
}

/**
 * Today's kiosk/portal check-ins at one academy, most recent first.
 *
 * Keyed on the ledger `date`, not an `occurredAt` range: `date` is already the
 * occurrence's own CR calendar day (see `perform-check-in.ts`), so a check-in
 * made at 23:50 CR for a class that straddles midnight stays on its class's
 * day here too, instead of jumping a row into tomorrow's table.
 */
export async function listTodaysCheckIns(organizationId: string, academyId: string, today: Date = crToday()) {
  return prisma.attendanceRecord.findMany({
    where: { organizationId, academyId, type: AttendanceType.CHECKIN, date: today, voidedAt: null },
    orderBy: { occurredAt: "desc" },
    select: {
      id: true,
      occurredAt: true,
      date: true,
      matchSource: true,
      student: { select: { firstName: true, lastName: true } },
      classSession: { select: { id: true, name: true, startTime: true } },
    },
  });
}

/** That academy's active classes on the weekday `date` falls on — the options
 * a `Cambiar` action may move a check-in to. */
export async function listReassignableSessions(organizationId: string, academyId: string, date: Date) {
  return prisma.classSession.findMany({
    where: { organizationId, academyId, active: true, dayOfWeek: attendanceDateDayOfWeek(date) },
    orderBy: { startTime: "asc" },
    select: { id: true, name: true, startTime: true },
  });
}

/**
 * Queued (offline) check-ins at one academy that could not be attributed to a class and are waiting for a coach: what the
 * tablet CLAIMED (kept exactly as received, never a ledger day), oldest first. They are evidence, not attendances.
 */
export async function listPendingQueuedCheckIns(organizationId: string, academyId: string) {
  return prisma.queuedCheckIn.findMany({
    where: { organizationId, academyId, status: QueuedCheckInStatus.PENDING },
    orderBy: [{ receivedAt: "asc" }, { id: "asc" }],
    select: {
      id: true,
      receivedAt: true,
      claimedAt: true,
      claimedAtRaw: true,
      claimedAtVerified: true,
      claimedClassSessionId: true,
      reason: true,
      student: { select: { firstName: true, lastName: true } },
    },
  });
}

/** Every class of the academy (active ones are the options a queued check-in can be recorded against). */
export async function listAcademyClasses(organizationId: string, academyId: string) {
  return prisma.classSession.findMany({
    where: { organizationId, academyId },
    orderBy: [{ dayOfWeek: "asc" }, { startTime: "asc" }],
    select: { id: true, name: true, startTime: true, dayOfWeek: true, active: true },
  });
}
