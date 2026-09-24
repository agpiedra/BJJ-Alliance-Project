import { DateTime } from "luxon";
import { prisma } from "@/lib/prisma";
import { getScopedDb } from "@/lib/tenant/scoped-client";
import type { AccessContext } from "@/lib/tenant/types";
import { ZONE, attendanceDateDayOfWeek, attendanceDateFromZoned } from "@/lib/scheduling/zone";
import { isInsideWindow, occurrenceStart, occurrenceWindow } from "@/lib/scheduling/check-in-window";
import { isUniqueConstraintError } from "@/lib/prisma-errors";
import { AttendanceMatchSource, AttendanceSource, AttendanceType, QueuedCheckInStatus } from "@/generated/prisma/client";

/**
 * Staff resolution of queued (offline) kiosk check-ins that were kept as UNTRUSTED EVIDENCE (`QueuedCheckIn`; see
 * `performCheckIn`'s `replay`). Evidence is not an attendance: it has no day and counts for nothing. A coach either
 * records a real attendance for it ON THE ORIGINAL DAY (a human decision about a class of that day), or sets it aside with
 * a reason. The evidence row is never deleted or edited apart from its status and who/when/why.
 */

export type ResolveQueuedCheckInResult =
  | { ok: true; attendanceRecordId: string }
  | { ok: false; error: "notFound" | "notPending" | "invalidDate" | "invalidTime" | "invalidClass" | "classNotOnThatDay" | "timeOutsideClass" | "futureTime" | "alreadyRecorded" };

export type DismissQueuedCheckInResult =
  | { ok: true }
  | { ok: false; error: "notFound" | "notPending" | "reasonRequired" };

const TIME_OF_DAY = /^([01]\d|2[0-3]):([0-5]\d)$/;

/**
 * Record queued evidence as a real attendance for `classSessionId`. Two different things are chosen, and they are not the
 * same day:
 *  - `date` (`yyyy-MM-dd`, Costa Rica) is the class OCCURRENCE's day - the attendance's ledger `date`. The class must be an
 *    active class of the evidence's own academy scheduled on that weekday.
 *  - `time` (`HH:mm`, Costa Rica) is the TAP's time, the instant the coach is CONFIRMING (the form pre-fills what the tablet
 *    claimed, when it could be read). It is required: nothing is ever derived from the class start, because a made-up
 *    instant can fall on the other side of a promotion and change what counts for the new interval. The tap's calendar
 *    day may differ from the occurrence's (Monday 23:50 for Tuesday's 00:10 class), so its date is whichever of the day
 *    before / the class's day / the day after puts it inside that occurrence's check-in window (a window is far shorter
 *    than a day, so at most one does); a time that fits none is `timeOutsideClass`.
 *
 * The FINAL instant is what is validated: inside the window, and not in the future (`futureTime`; the evidence stays PENDING
 * and can be recorded once that time has passed). When the confirmed time is the very minute of the tablet's claim, the
 * claimed instant is kept exactly (seconds included, `instantSource: CLAIMED`); otherwise the coach's own time is recorded
 * (`STAFF_ENTERED`). The original claim always stays on the evidence row and in the audit entry.
 *
 * The attendance is stamped `STAFF_CORRECTED` (a person decided it), `source: KIOSK` (where the tap happened), with the
 * coach as author. The evidence is claimed and linked in the SAME transaction (a second resolver, or a second click, gets
 * `notPending` and writes nothing), and a student who already has an attendance in that class that day gets
 * `alreadyRecorded` with everything rolled back.
 */
export async function resolveQueuedCheckIn(
  queuedCheckInId: string,
  opts: { classSessionId: string; date: string; time: string; actorUserId: string; context: AccessContext; now?: Date },
): Promise<ResolveQueuedCheckInResult> {
  const db = getScopedDb(opts.context);
  const kept = await db.queuedCheckIn.findUnique({
    where: { id: queuedCheckInId },
    select: { id: true, academyId: true, studentId: true, status: true, claimedAt: true, claimedAtRaw: true, claimedAtVerified: true, claimedClassSessionId: true },
  });
  if (!kept) return { ok: false, error: "notFound" };
  if (kept.status !== QueuedCheckInStatus.PENDING) return { ok: false, error: "notPending" };

  const day = DateTime.fromFormat(opts.date, "yyyy-MM-dd", { zone: ZONE });
  if (!day.isValid) return { ok: false, error: "invalidDate" };
  const time = TIME_OF_DAY.exec(opts.time.trim());
  if (!time) return { ok: false, error: "invalidTime" };
  const now = opts.now ?? new Date();

  const session = await db.classSession.findUnique({
    where: { id: opts.classSessionId },
    select: { id: true, academyId: true, dayOfWeek: true, startTime: true, durationMinutes: true, active: true },
  });
  if (!session || !session.active || session.academyId !== kept.academyId) return { ok: false, error: "invalidClass" };

  const ledgerDay = attendanceDateFromZoned(day.startOf("day"));
  if (session.dayOfWeek !== attendanceDateDayOfWeek(ledgerDay)) return { ok: false, error: "classNotOnThatDay" };

  const window = occurrenceWindow(occurrenceStart(session, day), session.durationMinutes);
  const tapAt = [-1, 0, 1]
    .map((offset) => day.plus({ days: offset }).set({ hour: Number(time[1]), minute: Number(time[2]), second: 0, millisecond: 0 }).toJSDate())
    .find((candidate) => isInsideWindow(window, candidate));
  if (!tapAt) return { ok: false, error: "timeOutsideClass" };
  // The tablet's claim is kept to the second when it is the very minute the coach confirms; anything else is the coach's own time.
  const claimedIsConfirmed = kept.claimedAt !== null && kept.claimedAt.getTime() >= tapAt.getTime() && kept.claimedAt.getTime() < tapAt.getTime() + 60_000;
  const occurredAt = claimedIsConfirmed && kept.claimedAt ? kept.claimedAt : tapAt;
  const instantSource = claimedIsConfirmed ? "CLAIMED" : "STAFF_ENTERED";
  // The candidate above was checked at minute precision; the claim keeps its seconds and milliseconds, so the instant that is
  // actually recorded is checked on its own (a claim 1 ms after closesAt is refused even when its HH:mm is inside).
  if (!isInsideWindow(window, occurredAt)) return { ok: false, error: "timeOutsideClass" };
  if (occurredAt > now) return { ok: false, error: "futureTime" };

  try {
    return await prisma.$transaction(async (tx) => {
      // Claim the evidence first: only one caller can move it out of PENDING.
      const claimed = await tx.queuedCheckIn.updateMany({
        where: { id: kept.id, organizationId: opts.context.organizationId, status: QueuedCheckInStatus.PENDING },
        data: { status: QueuedCheckInStatus.RESOLVED, resolvedById: opts.actorUserId, resolvedAt: now },
      });
      if (claimed.count !== 1) return { ok: false as const, error: "notPending" as const };

      const attendance = await tx.attendanceRecord.create({
        data: {
          studentId: kept.studentId,
          academyId: kept.academyId,
          organizationId: opts.context.organizationId,
          classSessionId: session.id,
          occurredAt,
          date: ledgerDay,
          type: AttendanceType.CHECKIN,
          delta: 1,
          source: AttendanceSource.KIOSK,
          matchSource: AttendanceMatchSource.STAFF_CORRECTED,
          createdById: opts.actorUserId,
          correctedById: opts.actorUserId,
          correctedAt: now,
        },
        select: { id: true },
      });
      await tx.queuedCheckIn.update({ where: { id: kept.id, organizationId: opts.context.organizationId }, data: { resolvedAttendanceId: attendance.id } });
      await tx.auditLog.create({
        data: {
          actorId: opts.actorUserId,
          organizationId: opts.context.organizationId,
          academyId: kept.academyId,
          action: "queued_checkin.resolve",
          entityType: "QueuedCheckIn",
          entityId: kept.id,
          before: { status: "PENDING", claimedAtRaw: kept.claimedAtRaw, claimedAtVerified: kept.claimedAtVerified, claimedClassSessionId: kept.claimedClassSessionId },
          after: { status: "RESOLVED", attendanceRecordId: attendance.id, classSessionId: session.id, date: opts.date, confirmedTime: `${time[1]}:${time[2]}`, instantSource, occurredAt: occurredAt.toISOString() },
        },
      });
      return { ok: true as const, attendanceRecordId: attendance.id };
    });
  } catch (error) {
    // The student already has a valid attendance in that class on that day: the whole transaction rolled back, so the
    // evidence is still PENDING for the coach to record against another class or to dismiss.
    if (isUniqueConstraintError(error)) return { ok: false, error: "alreadyRecorded" };
    throw error;
  }
}

/** Set evidence aside with a reason (3-500 characters). It stays in the database, marked with who, when and why. */
export async function dismissQueuedCheckIn(
  queuedCheckInId: string,
  opts: { reason: string; actorUserId: string; context: AccessContext; now?: Date },
): Promise<DismissQueuedCheckInResult> {
  const reason = opts.reason.trim();
  if (reason.length < 3 || reason.length > 500) return { ok: false, error: "reasonRequired" };

  const db = getScopedDb(opts.context);
  const kept = await db.queuedCheckIn.findUnique({ where: { id: queuedCheckInId }, select: { id: true, academyId: true, status: true, claimedAtRaw: true } });
  if (!kept) return { ok: false, error: "notFound" };
  if (kept.status !== QueuedCheckInStatus.PENDING) return { ok: false, error: "notPending" };

  return prisma.$transaction(async (tx) => {
    const claimed = await tx.queuedCheckIn.updateMany({
      where: { id: kept.id, organizationId: opts.context.organizationId, status: QueuedCheckInStatus.PENDING },
      data: { status: QueuedCheckInStatus.DISMISSED, dismissReason: reason, resolvedById: opts.actorUserId, resolvedAt: opts.now ?? new Date() },
    });
    if (claimed.count !== 1) return { ok: false as const, error: "notPending" as const };
    await tx.auditLog.create({
      data: {
        actorId: opts.actorUserId,
        organizationId: opts.context.organizationId,
        academyId: kept.academyId,
        action: "queued_checkin.dismiss",
        entityType: "QueuedCheckIn",
        entityId: kept.id,
        before: { status: "PENDING", claimedAtRaw: kept.claimedAtRaw },
        after: { status: "DISMISSED", reason },
      },
    });
    return { ok: true as const };
  });
}
