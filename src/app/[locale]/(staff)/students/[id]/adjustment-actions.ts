"use server";

import { z } from "zod";
import { DateTime } from "luxon";
import { prisma } from "@/lib/prisma";
import { isAcademyInTenantScope, resolveActionContext } from "@/lib/tenant/context";
import { getScopedDb } from "@/lib/tenant/scoped-client";
import { AttendanceSource, AttendanceType, Prisma, StudentStatus } from "@/generated/prisma/client";
import { attendanceDateFromZoned, ZONE } from "@/lib/scheduling/zone";
import { isDayContribution } from "@/lib/promotion/progress-days";
import { resolvePromotionConfigMap } from "@/lib/promotion/config";
import { getAtBeltSummary } from "@/lib/students/attendance-summary";
import { refreshPromotionPages } from "@/lib/promotion/refresh-pages";
import type { ActionState } from "@/lib/action-state";

/**
 * A coach records that a student trained on one Costa Rica calendar day
 * (docs/PROMOTION_PROGRESS_PROPOSAL.md). It is exactly ONE attendance day - never
 * a free-form number of classes, and never a negative correction: the academy
 * decided there is no head-start credit and no arbitrary progress credit, positive
 * or negative. Under PER_INTERVAL accounting it shares the daily limit with the kiosk
 * and the portal: if the student already has a qualifying attendance for that day, this
 * one is recorded in the history and adds nothing. A track still on the legacy CUMULATIVE
 * accounting has no daily limit, and its feedback says what that rule actually did.
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
 * Returns `info` when the entry was recorded but added nothing to progress, so the coach is told,
 * never left to assume it counted - and the message follows the student's OWN track accounting:
 *  - PER_INTERVAL: `alreadyCountedThatDay`, `beforeLastPromotion` (or `beforeTrackingStart` when the
 *    baseline is a system tracking start, not a promotion) for a day that belongs to the completed
 *    interval, or `promotionDayHistoryOnly` / `trackingStartDayHistoryOnly` for the day of
 *    a promotion or of the tracking start, whose class cannot be placed before or after the boundary;
 *  - CUMULATIVE (legacy): no daily limit and no history-only, so none of those; the only reason an
 *    entry adds nothing is a date before the belt was awarded (`beforeBeltDate`), measured by the
 *    same summary the pages read.
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
    select: { id: true, homeAcademyId: true, organizationId: true, status: true, track: true, progressBaselineAt: true, progressBaselineKind: true },
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
  // WHEN the entry is stamped decides which interval it belongs to (interval membership follows the day's
  // earliest qualifying row), and a coach only supplies a DAY. Two rules keep that honest:
  //  1. Never invent an after-award time. On the day of the last promotion (or, for a system tracking start, a
  //     past day equal to it) it cannot be known whether the class was before or after the baseline, so the
  //     entry is HISTORY ONLY: it is flagged `historyOnly` and never qualifies as a progress contribution. The
  //     flag is stored on the row rather than inferred from a timestamp placed relative to other rows, so it
  //     survives any later void or recomputation of those other rows (a timestamp rule cannot: "just after the
  //     earliest row" becomes the earliest row, or lands exactly on the boundary, the moment that row is voided).
  //     The instant is only for display and ordering; it is stamped just before the baseline.
  //  2. Any other day is unambiguous: after the promotion's day it is the new interval, before it the completed
  //     one, so the moment for today and midday for a past day are both safe.
  const baseline = student.progressBaselineAt;
  const baselineDay = DateTime.fromJSDate(baseline, { zone: "utc" }).setZone(ZONE);
  const isToday = day.hasSame(nowCr, "day");
  const isPromotionDay = student.progressBaselineKind === "AWARD" && day.hasSame(baselineDay, "day");
  // Everything above is PER_INTERVAL semantics (one contribution per day, boundaries at the baseline). A track still
  // on the legacy CUMULATIVE accounting has neither: every qualifying row counts since the belt date, with no daily
  // limit and no history-only concept, so it keeps the legacy stamping and its feedback reports what that rule
  // actually did with the entry (see the end of this function). Legacy counting is never changed to fit a message.
  const configByTrack = await resolvePromotionConfigMap(student.organizationId);
  const perInterval = configByTrack.get(student.track)?.accounting === "PER_INTERVAL";
  const historyOnly = perInterval && (isPromotionDay || (day.hasSame(baselineDay, "day") && !isToday));
  const occurredAt = historyOnly ? new Date(baseline.getTime() - 1) : isToday ? now : day.set({ hour: 12 }).toJSDate();
  // The legacy count BEFORE the entry, so the response can state its real effect afterwards.
  const legacyCountBefore =
    !perInterval && configByTrack.has(student.track)
      ? (await getAtBeltSummary(student.id, student.organizationId, configByTrack)).atBeltCount
      : null;

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
        historyOnly,
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
        after: { delta: 1, reason: data.reason, day: day.toISODate(), historyOnly },
      },
    });
    return created;
  });

  // The student's page shows the progress this entry just changed (see refreshPromotionPages).
  await refreshPromotionPages(student.id);

  // Legacy CUMULATIVE: no daily limit, no history-only. The entry counts unless it is dated before the belt was
  // awarded; report exactly that, measured through the same summary every page reads.
  if (!perInterval) {
    if (legacyCountBefore === null) return { ok: true };
    const after = await getAtBeltSummary(student.id, student.organizationId, configByTrack);
    return after.atBeltCount > legacyCountBefore ? { ok: true } : { ok: true, info: "beforeBeltDate" };
  }

  // PER_INTERVAL. Truthful feedback: history only (day of a promotion / tracking start), was this the day's one
  // contribution, and does it belong to the current interval?
  if (historyOnly) return { ok: true, info: isPromotionDay ? "promotionDayHistoryOnly" : "trackingStartDayHistoryOnly" };
  const contributes = await isDayContribution(prisma, {
    studentId: student.id,
    organizationId: student.organizationId,
    recordId: record.id,
  });
  if (!contributes) return { ok: true, info: "alreadyCountedThatDay" };
  if (occurredAt < student.progressBaselineAt) {
    // "Before the last promotion" is only true when the baseline IS a promotion; a system baseline is the start of
    // progress tracking (registration, or an activation), and no promotion is involved.
    return { ok: true, info: student.progressBaselineKind === "AWARD" ? "beforeLastPromotion" : "beforeTrackingStart" };
  }
  return { ok: true };
}
