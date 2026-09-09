"use server";

import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { isAcademyInScope, requireStaffSession } from "@/lib/auth/session";
import { AttendanceSource, AttendanceType, Prisma } from "@/generated/prisma/client";
import { toAttendanceDate } from "@/lib/scheduling/zone";
import type { ActionState } from "@/lib/action-state";

const adjustmentSchema = z.object({
  studentId: z.string().min(1),
  delta: z.coerce.number().int().refine((n) => n !== 0),
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
    select: { id: true, homeAcademyId: true },
  });

  if (!student || !isAcademyInScope(session, student.homeAcademyId)) {
    return { error: "notFound" };
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
