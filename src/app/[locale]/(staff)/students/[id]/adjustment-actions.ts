"use server";

import { z } from "zod";
import { DateTime } from "luxon";
import { prisma } from "@/lib/prisma";
import { isAcademyInTenantScope, resolveActionContext } from "@/lib/tenant/context";
import { getScopedDb } from "@/lib/tenant/scoped-client";
import { AttendanceSource, AttendanceType, Prisma, StudentStatus } from "@/generated/prisma/client";
import { attendanceDateFromZoned, ZONE } from "@/lib/scheduling/zone";
import { isDayContribution } from "@/lib/promotion/progress-days";
import { refreshPromotionPages } from "@/lib/promotion/refresh-pages";
import type { ActionState } from "@/lib/action-state";

/**
 * A coach records that a student trained on one Costa Rica calendar day
 * (docs/PROMOTION_PROGRESS_PROPOSAL.md). It is exactly ONE attendance day - never
 * a free-form number of classes, and never a negative correction: the academy
 * decided there is no head-start credit and no arbitrary progress credit, positive
 * or negative. It shares the daily limit with the kiosk and the portal: if the
 * student already has a qualifying attendance for that day, this one is recorded
 * in the history and adds nothing.
 *
 * Only the three known fields are read, and a posted `delta` is refused outright
 * rather than having its number silently ignored. It is NOT a blanket "no unknown
 * keys" rule: a real React form post also carries the framework's own
 * `$ACTION_REF_*` / `$ACTION_KEY` fields, and rejecting those made every genuine
 * submission fail (found in a real browser; unit calls never carry them).
 */
const adjustmentSchema = z.object({
  studentId: z.string().min(1),
  /** `YYYY-MM-DD`, the Costa Rica day being recorded. Omitted = today. */
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
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
 *
 * Returns `info` when the entry was recorded but added nothing to progress
 * (`alreadyCountedThatDay`, or `beforeLastPromotion` for a day that belongs to
 * the completed interval) so the coach is told, never left to assume it counted.
 */
export async function addAttendanceAdjustment(
  organizationId: string,
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const auth = await resolveActionContext(organizationId, ["ADMIN", "DIRECTOR", "INSTRUCTOR"]);
  if (!auth.ok) return { error: "notFound" };
  const context = auth.context;

  // No head-start credit, no free-form number: a client that still posts one is refused.
  if (formData.has("delta")) {
    return { error: "invalid", fieldErrors: { delta: ["notAccepted"] } };
  }
  const parsed = adjustmentSchema.safeParse({
    studentId: formData.get("studentId") ?? undefined,
    date: formData.get("date") || undefined,
    reason: formData.get("reason") ?? undefined,
  });

  if (!parsed.success) {
    return { error: "invalid", fieldErrors: parsed.error.flatten().fieldErrors };
  }

  const data = parsed.data;

  const student = await getScopedDb(context).student.findUnique({
    where: { id: data.studentId },
    select: { id: true, homeAcademyId: true, organizationId: true, status: true, progressBaselineAt: true },
  });

  if (!student || !isAcademyInTenantScope(context, student.homeAcademyId)) {
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
  const nowCr = DateTime.fromJSDate(now, { zone: "utc" }).setZone(ZONE);
  // The Costa Rica day being recorded; never a UTC date, never a day that has not happened.
  const day = data.date ? DateTime.fromISO(data.date, { zone: ZONE }) : nowCr;
  if (!day.isValid || day.startOf("day") > nowCr.startOf("day")) {
    return { error: "invalid", fieldErrors: { date: ["futureOrInvalid"] } };
  }
  // Attributed to the day being recorded: the moment for today's entry; the END of the day for an
  // earlier day (its real time is unknown). The end of the day, never an invented earlier hour, so a
  // late entry can add a day that had none but can never become that day's EARLIEST row and pull an
  // already-counted day out of the interval it was counted in. A day before the last promotion's day
  // still lands in the completed interval.
  const occurredAt = day.hasSame(nowCr, "day") ? now : day.set({ hour: 23, minute: 59, second: 59, millisecond: 0 }).toJSDate();

  const record = await prisma.$transaction(async (tx) => {
    const created = await tx.attendanceRecord.create({
      data: {
        studentId: student.id,
        // An adjustment isn't tied to a specific check-in location the way a
        // kiosk record is — it always belongs to the student's home academy.
        academyId: student.homeAcademyId,
        organizationId: student.organizationId,
        type: AttendanceType.ADJUSTMENT,
        delta: 1,
        reason: data.reason,
        source: AttendanceSource.STAFF,
        createdById: context.actorUserId,
        occurredAt,
        date: attendanceDateFromZoned(day),
      },
    });

    await tx.auditLog.create({
      data: {
        actorId: context.actorUserId,
        organizationId: context.organizationId,
        academyId: student.homeAcademyId,
        action: "attendance.adjustment",
        entityType: "AttendanceRecord",
        entityId: created.id,
        before: Prisma.DbNull,
        after: { delta: 1, reason: data.reason, day: day.toISODate() },
      },
    });
    return created;
  });

  // The student's page shows the progress this entry just changed (see refreshPromotionPages).
  await refreshPromotionPages(student.id);

  // Truthful feedback: was this the day's one contribution, and does it belong to the current interval?
  const contributes = await isDayContribution(prisma, {
    studentId: student.id,
    organizationId: student.organizationId,
    recordId: record.id,
  });
  if (!contributes) return { ok: true, info: "alreadyCountedThatDay" };
  if (occurredAt < student.progressBaselineAt) return { ok: true, info: "beforeLastPromotion" };
  return { ok: true };
}
