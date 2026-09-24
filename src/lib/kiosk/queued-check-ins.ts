import { DateTime } from "luxon";
import { prisma } from "@/lib/prisma";
import { getScopedDb } from "@/lib/tenant/scoped-client";
import type { AccessContext } from "@/lib/tenant/types";
import { ZONE, attendanceDateDayOfWeek, attendanceDateFromZoned } from "@/lib/scheduling/zone";
import { occurrenceStart } from "@/lib/scheduling/check-in-window";
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
  | { ok: false; error: "notFound" | "notPending" | "invalidDate" | "futureDate" | "invalidClass" | "classNotOnThatDay" | "alreadyRecorded" };

export type DismissQueuedCheckInResult =
  | { ok: true }
  | { ok: false; error: "notFound" | "notPending" | "reasonRequired" };

/** Costa Rica's calendar day of an instant, as a CR-zoned start-of-day. */
function crDay(instant: Date): DateTime {
  return DateTime.fromJSDate(instant, { zone: "utc" }).setZone(ZONE).startOf("day");
}

/**
 * Record queued evidence as a real attendance on `date` (`yyyy-MM-dd`, a Costa Rica calendar day chosen by the coach) for
 * `classSessionId`. The class must be an active class of the evidence's own academy scheduled on that weekday, and the day
 * cannot be in the future. The attendance is stamped `STAFF_CORRECTED` (a person decided it), `source: KIOSK` (where the
 * tap happened), with the coach as author. Its `occurredAt` is the device's claimed instant when that instant falls on the
 * chosen day (the raw instant of the tap survives), otherwise the class's own scheduled start on that day - never the
 * replay time. The evidence is claimed and linked in the SAME transaction (a second resolver, or a second click, gets
 * `notPending` and writes nothing), and a student who already has an attendance in that class that day gets
 * `alreadyRecorded` with everything rolled back.
 */
export async function resolveQueuedCheckIn(
  queuedCheckInId: string,
  opts: { classSessionId: string; date: string; actorUserId: string; context: AccessContext; now?: Date },
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
  const now = opts.now ?? new Date();
  if (day.startOf("day") > crDay(now)) return { ok: false, error: "futureDate" };

  const session = await db.classSession.findUnique({
    where: { id: opts.classSessionId },
    select: { id: true, academyId: true, dayOfWeek: true, startTime: true, durationMinutes: true, active: true },
  });
  if (!session || !session.active || session.academyId !== kept.academyId) return { ok: false, error: "invalidClass" };

  const ledgerDay = attendanceDateFromZoned(day.startOf("day"));
  if (session.dayOfWeek !== attendanceDateDayOfWeek(ledgerDay)) return { ok: false, error: "classNotOnThatDay" };

  const claimedOnThatDay = kept.claimedAt !== null && attendanceDateFromZoned(crDay(kept.claimedAt)).getTime() === ledgerDay.getTime();
  const occurredAt = claimedOnThatDay && kept.claimedAt ? kept.claimedAt : occurrenceStart(session, day).toJSDate();

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
          after: { status: "RESOLVED", attendanceRecordId: attendance.id, classSessionId: session.id, date: opts.date, occurredAt: occurredAt.toISOString() },
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
