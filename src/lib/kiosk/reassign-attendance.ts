import { prisma } from "@/lib/prisma";
import { getScopedDb } from "@/lib/tenant/scoped-client";
import type { AccessContext } from "@/lib/tenant/types";
import { attendanceDateDayOfWeek, attendanceDateFromZoned } from "@/lib/scheduling/zone";
import { openOccurrences } from "@/lib/scheduling/check-in-window";
import { isUniqueConstraintError } from "@/lib/prisma-errors";
import { AttendanceMatchSource, AttendanceType } from "@/generated/prisma/client";
import type { MatchedClass } from "./perform-check-in";

export type ReassignAttendanceResult =
  | { ok: true; matchedClass: MatchedClass }
  | { ok: false; error: "notFound" | "invalidRecord" | "invalidClass" | "classNotOpen" | "alreadyRecorded" };

interface ReassignOptionsBase {
  /**
   * Who to attribute the `AuditLog` row to. `null` for the kiosk's own
   * "not this class" correction when the student has no linked `User`
   * row — `AuditLog.actorId` is a required FK (prisma/schema.prisma), so
   * there is literally no id to write. The correction itself still happens
   * and is still visible: `matchSource: STUDENT_PICKED` on the row is its
   * own provenance, and the Kiosco page surfaces it. Every staff-initiated
   * call always has a real actor and always writes the audit row.
   */
  actorUserId: string | null;
  /**
   * The record must belong to this academy or the call reports `notFound`.
   * Required, not optional — MULTI_ACADEMY_AND_KIDS_BELTS.md 1f-1: an
   * optional cross-tenant guard is a landmine, not an invariant, since a
   * caller that simply forgets to pass it silently disables the entire
   * check. The kiosk passes the academy its device token was verified
   * against; the staff action passes the record's own (already scope-
   * checked) academy — so one academy's tablet, or one organization's staff,
   * can never rewrite another's attendance.
   */
  expectedAcademyId: string;
  /**
   * 1f-3: the authority this reassignment runs under, for `getScopedDb`'s
   * organization enforcement — additional, structural defense-in-depth on
   * top of `expectedAcademyId`'s academy-level check above. The kiosk route
   * passes its verified `KioskContext`; the staff action passes its own
   * already-resolved `TenantContext`.
   */
  context: AccessContext;
}

/**
 * Who is correcting decides whether the check-in window applies - and it is decided by the TYPE, so a student-facing
 * caller cannot forget it:
 *  - STUDENT_PICKED (the kiosk's own "not this class" correction): `requireOpenAt` is REQUIRED - the instant the
 *    attendance was recorded. The target class must be open at that instant (the same start -30 .. end +30 rule a
 *    check-in obeys), so a correction can never produce an attendance the check-in itself would have refused. The
 *    record moves to the target occurrence's own Costa Rica day.
 *  - STAFF_CORRECTED (a coach on the Kiosco page): no window - a coach records what actually happened.
 */
type ReassignOptions = ReassignOptionsBase &
  (
    | { matchSource: typeof AttendanceMatchSource.STUDENT_PICKED; requireOpenAt: Date }
    | { matchSource: typeof AttendanceMatchSource.STAFF_CORRECTED; requireOpenAt?: undefined }
  );

/**
 * Move one already-recorded attendance to a different class on the SAME day
 * at the SAME academy. Shared by the kiosk's on-the-spot student correction
 * and the staff `Cambiar` action on the Kiosco page (REDESIGN_BRIEF.md
 * Phase 9) — one Prisma write + AuditLog pair, not two copies of it.
 *
 * `occurredAt` and `date` are deliberately left untouched: the brief keeps the
 * raw instant of the original tap even after a correction, and `date` is the
 * ledger day both the unique constraint and every attendance query key on.
 *
 * No counters to adjust anywhere — every per-class count in this codebase is a
 * live aggregate over `AttendanceRecord`, so both classes' numbers move the
 * moment this commits.
 */
export async function reassignAttendance(
  attendanceRecordId: string,
  newClassSessionId: string,
  opts: ReassignOptions,
): Promise<ReassignAttendanceResult> {
  const db = getScopedDb(opts.context);

  const record = await db.attendanceRecord.findUnique({
    where: { id: attendanceRecordId },
    select: { id: true, academyId: true, date: true, classSessionId: true, matchSource: true, type: true, voidedAt: true },
  });

  // A voided entry is history: it is not moved between classes (and moving it would put a dead row on a class
  // occurrence a valid entry may legitimately hold).
  if (!record || record.voidedAt || record.academyId !== opts.expectedAcademyId) {
    return { ok: false, error: "notFound" };
  }

  // Only a physical check-in can be moved between classes. An ADJUSTMENT row
  // is a manual ledger correction that deliberately has no class (see
  // attendance-summary.ts) — attributing one to a real class would silently
  // turn a staff adjustment into an attendance for that class, and would put
  // its `delta` (which can be >1) under a `countsTowardPromotion` flag it was
  // never meant to obey. Not reachable from any UI today; guarded anyway
  // because this function takes a bare id from two different callers.
  if (record.type !== AttendanceType.CHECKIN) {
    return { ok: false, error: "invalidRecord" };
  }

  const target = await db.classSession.findUnique({
    where: { id: newClassSessionId },
    select: { id: true, academyId: true, dayOfWeek: true, startTime: true, durationMinutes: true, name: true, active: true },
  });

  // Independent rejections, none of them inferable from the client: a class at another academy or an inactive one; and
  //  - staff: one scheduled on a different weekday than the record's own ledger day (a coach moves an attendance WITHIN
  //    a day at ONE academy, never across either boundary);
  //  - student: one that was not OPEN at the instant the attendance was recorded (the check-in window rule), in which
  //    case the record follows the class's own occurrence day (a class running past midnight belongs to its own day).
  if (!target || !target.active || target.academyId !== record.academyId) {
    return { ok: false, error: "invalidClass" };
  }
  let newDate: Date | undefined;
  if (opts.requireOpenAt) {
    const open = openOccurrences([target], opts.requireOpenAt)[0];
    if (!open) return { ok: false, error: "classNotOpen" };
    const occurrenceDay = attendanceDateFromZoned(open.anchorDate);
    if (occurrenceDay.getTime() !== record.date.getTime()) newDate = occurrenceDay;
  } else if (target.dayOfWeek !== attendanceDateDayOfWeek(record.date)) {
    return { ok: false, error: "invalidClass" };
  }

  const isStaffCorrection = opts.matchSource === AttendanceMatchSource.STAFF_CORRECTED;
  const after = { classSessionId: target.id, matchSource: opts.matchSource, ...(newDate ? { date: newDate.toISOString().slice(0, 10) } : {}) };

  try {
    await prisma.$transaction(async (tx) => {
      await tx.attendanceRecord.update({
        where: { id: record.id, organizationId: opts.context.organizationId },
        data: {
          classSessionId: target.id,
          matchSource: opts.matchSource,
          ...(newDate ? { date: newDate } : {}),
          // Only the staff variant ever writes these two. Left `undefined`
          // (i.e. absent from the payload, so Prisma doesn't touch the
          // columns) on the student path rather than explicitly nulled: a row
          // a staff member already corrected must not lose WHO corrected it
          // just because the student then re-picked at the kiosk.
          ...(isStaffCorrection ? { correctedById: opts.actorUserId, correctedAt: new Date() } : {}),
        },
      });

      if (opts.actorUserId) {
        await tx.auditLog.create({
          data: {
            actorId: opts.actorUserId,
            organizationId: opts.context.organizationId,
            academyId: record.academyId,
            action: "attendance.reassign",
            entityType: "AttendanceRecord",
            entityId: record.id,
            before: { classSessionId: record.classSessionId, matchSource: record.matchSource, ...(newDate ? { date: record.date.toISOString().slice(0, 10) } : {}) },
            after,
          },
        });
      }
    });
  } catch (error) {
    // The student already has an attendance for the class being moved TO, on
    // this same ledger day — `@@unique([studentId, classSessionId, date])`.
    // A friendly "already recorded there", not a 500.
    if (isUniqueConstraintError(error)) {
      return { ok: false, error: "alreadyRecorded" };
    }
    throw error;
  }

  return {
    ok: true,
    matchedClass: {
      id: target.id,
      name: target.name,
      dayOfWeek: target.dayOfWeek,
      startTime: target.startTime,
    },
  };
}
