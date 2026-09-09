"use server";

import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { isAcademyInScope, requireStaffSession } from "@/lib/auth/session";
import { AttendanceSource, AttendanceType, Prisma, StudentStatus } from "@/generated/prisma/client";
import { toAttendanceDate } from "@/lib/scheduling/zone";
import type { ActionState } from "@/lib/action-state";

/**
 * ±1000 is a deliberately generous ceiling for a MANUAL attendance
 * correction: the largest legitimate one imaginable is backfilling a belt's
 * worth of classes (a Brown belt's exam threshold is 425 total), so 1000
 * leaves ample headroom while keeping the value far inside Postgres `int4`.
 * Without a bound an out-of-int4 value reached Prisma and threw an
 * unhandled PrismaClientValidationError (a 500) instead of a graceful
 * `{ error: "invalid", fieldErrors }`.
 */
const DELTA_LIMIT = 1000;

const adjustmentSchema = z.object({
  studentId: z.string().min(1),
  delta: z.coerce
    .number()
    .int()
    .min(-DELTA_LIMIT)
    .max(DELTA_LIMIT)
    .refine((n) => n !== 0),
  reason: z.string().min(1),
});

/**
 * ADMIN/DIRECTOR/INSTRUCTOR — wider than `updateStudent`/`archiveStudent`
 * (ADMIN/DIRECTOR only) per spec §3's explicit grant of attendance
 * marking/correction to INSTRUCTOR too.
 *
 * Same independent re-fetch-and-check-scope discipline as every other write
 * in this file's sibling `actions.ts`: `studentId` is a client-submitted
 * hidden field, so the student's real `homeAcademyId` is re-read from the DB
 * and re-checked against the session before anything is written — the
 * `AttendanceRecord.academyId` below is that freshly-read value, never a
 * client-submitted one.
 *
 * Unlike `updateStudent`/`archiveStudent`/`approveStudent`/
 * `regenerateStudentCode` (all `UPDATE`s guarded by a scoped `updateMany` +
 * row-count check, since a race could move/delete the row between the scope
 * check and the write), this is a plain `INSERT` — there is no row to lose
 * a race against. Verifying scope once, before the transaction, and then
 * inserting with that verified `homeAcademyId` is the entire scoping
 * contract for a `create`.
 *
 * The `AttendanceRecord` and its `AuditLog` row are written in the SAME
 * transaction so one can never exist without the other, matching every
 * other write in this app.
 */
export async function addAttendanceAdjustment(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const session = await requireStaffSession(["ADMIN", "DIRECTOR", "INSTRUCTOR"]);

  const parsed = adjustmentSchema.safeParse(Object.fromEntries(formData.entries()));

  if (!parsed.success) {
    return { error: "invalid", fieldErrors: parsed.error.flatten().fieldErrors };
  }

  const data = parsed.data;

  const student = await prisma.student.findUnique({
    where: { id: data.studentId },
    select: { id: true, homeAcademyId: true, status: true },
  });

  if (!student || !isAcademyInScope(session, student.homeAcademyId)) {
    return { error: "notFound" };
  }

  // An archived student is out of the academy — no new attendance or ledger
  // activity should accrue to them. Reported distinctly from `notFound`
  // (which is also the out-of-scope answer) because this one is a real,
  // actionable state a staff member can see on the same page: the student
  // exists and is visible, the action is simply not allowed for them.
  if (student.status === StudentStatus.ARCHIVED) {
    return { error: "archived" };
  }

  const now = new Date();

  await prisma.$transaction(async (tx) => {
    const record = await tx.attendanceRecord.create({
      data: {
        studentId: student.id,
        // An adjustment isn't tied to a specific check-in location the way a
        // kiosk record is — it always belongs to the student's home academy.
        academyId: student.homeAcademyId,
        type: AttendanceType.ADJUSTMENT,
        delta: data.delta,
        reason: data.reason,
        source: AttendanceSource.STAFF,
        createdById: session.userId,
        occurredAt: now,
        date: toAttendanceDate(now),
      },
    });

    await tx.auditLog.create({
      data: {
        actorId: session.userId,
        academyId: student.homeAcademyId,
        action: "attendance.adjustment",
        entityType: "AttendanceRecord",
        entityId: record.id,
        before: Prisma.DbNull,
        after: { delta: data.delta, reason: data.reason },
      },
    });
  });

  return { ok: true };
}
