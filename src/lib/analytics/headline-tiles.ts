import { DateTime } from "luxon";
import { prisma } from "@/lib/prisma";
import { academyScopeWhere, type StaffSession } from "@/lib/auth/session";
import { currentCrDateParts, getCurrentPaymentPeriod } from "@/lib/payments/get-current-period";
import type { Prisma } from "@/generated/prisma/client";
import type { AnalyticsFilters } from "@/lib/analytics/filters";

export interface DateRange {
  from: DateTime;
  to: DateTime;
}

export interface HeadlineTiles {
  enrolled: number;
  active: number;
  inactive: number;
  newThisMonth: number;
  lost: number;
  totalAttendances: number;
  avgAttendancesPerActive: number;
  paymentHealthPercent: number;
}

/** Is `date` inside `range`, inclusive of both endpoints? */
export function isWithinRange(date: DateTime, range: DateRange): boolean {
  return date >= range.from && date <= range.to;
}

/**
 * A student counts as "active" for a range if any of their attendance dates
 * falls inside it.
 */
export function hasAttendanceInRange(attendanceDates: DateTime[], range: DateRange): boolean {
  return attendanceDates.some((date) => isWithinRange(date, range));
}

/** A student counts as newly enrolled for a range if they joined inside it. */
export function isNewInRange(joinedAt: DateTime, range: DateRange): boolean {
  return isWithinRange(joinedAt, range);
}

/**
 * The same-length period immediately preceding `range` — e.g. for a 30-day
 * range, the 30 days before it. Used to classify a student as "lost"
 * without hardcoding a second range shape independent of whatever range the
 * director actually picked.
 */
export function previousEquivalentRange(range: DateRange): DateRange {
  const durationMs = range.to.diff(range.from).as("milliseconds");
  return { from: range.from.minus({ milliseconds: durationMs }), to: range.from };
}

/**
 * A student is "lost" if they attended at least once in the period
 * immediately before `range` but not at all during `range` itself.
 */
export function wasLost(attendanceDates: DateTime[], range: DateRange): boolean {
  const previous = previousEquivalentRange(range);
  return hasAttendanceInRange(attendanceDates, previous) && !hasAttendanceInRange(attendanceDates, range);
}

/**
 * Director/admin analytics headline tiles (Phase 7 spec §4). ADMIN/DIRECTOR
 * only — self-enforced right here, the same discipline
 * `listOverdueStudents`/`listApproachingStudents` already apply: a caller
 * that invokes this directly with a forged INSTRUCTOR session is rejected,
 * never left to the page to hide a result it would otherwise discard.
 *
 * Scoped to enrolled (`status: "ACTIVE"`) students, combining BOTH
 * `academyScopeWhere(session)` (translated to `homeAcademyId` — the same
 * translation Phase 2/4/6 already established, since `academyScopeWhere`
 * returns a fragment keyed `academyId` but Student's tenancy column is
 * `homeAcademyId`) AND `filters.academyId` when set. The session's own scope
 * is applied independently of `filters.academyId` — never trusted alone —
 * so a DIRECTOR session passed a filter naming a DIFFERENT academy (e.g. a
 * hand-built `AnalyticsFilters` that bypassed `resolveAnalyticsFilters`)
 * still only ever sees their own academy.
 *
 * "Active"/"new"/"lost" are computed against `filters.from`/`filters.to` —
 * whatever range the director selected, not a second hardcoded window.
 * `paymentHealthPercent` is the one exception (this phase's ruling): it
 * always reflects the CURRENT calendar month regardless of the selected
 * range, reusing `getCurrentPaymentPeriod`'s existing per-student period
 * resolution rather than a second, drifting implementation.
 *
 * Only `type: "CHECKIN"` attendance rows count toward the attendance-based
 * tiles — a manual `ADJUSTMENT` correction (which can carry a negative
 * delta) is not a physical attendance fact, the same distinction
 * `attendance-summary.ts`'s `PROMOTION_RELEVANT` draws for belt progress,
 * applied here to "did this student show up" instead.
 */
export async function getHeadlineTiles(
  session: StaffSession,
  filters: AnalyticsFilters,
): Promise<HeadlineTiles> {
  if (session.role !== "ADMIN" && session.role !== "DIRECTOR") {
    throw new Error("FORBIDDEN");
  }

  const scope = academyScopeWhere(session);
  const conditions: Prisma.StudentWhereInput[] = [{ status: "ACTIVE" }];
  if (scope.academyId) {
    conditions.push({ homeAcademyId: scope.academyId });
  }
  if (filters.academyId) {
    conditions.push({ homeAcademyId: filters.academyId });
  }

  const students = await prisma.student.findMany({
    where: { AND: conditions },
    select: { id: true, joinedAt: true },
  });

  const range: DateRange = { from: filters.from, to: filters.to };
  const previous = previousEquivalentRange(range);

  const studentIds = students.map((student) => student.id);
  const attendances =
    studentIds.length === 0
      ? []
      : await prisma.attendanceRecord.findMany({
          where: {
            studentId: { in: studentIds },
            type: "CHECKIN",
            occurredAt: { gte: previous.from.toJSDate(), lte: range.to.toJSDate() },
          },
          select: { studentId: true, occurredAt: true },
        });

  const attendanceDatesByStudentId = new Map<string, DateTime[]>();
  for (const record of attendances) {
    const dates = attendanceDatesByStudentId.get(record.studentId) ?? [];
    dates.push(DateTime.fromJSDate(record.occurredAt));
    attendanceDatesByStudentId.set(record.studentId, dates);
  }

  let active = 0;
  let newThisMonth = 0;
  let lost = 0;
  let totalAttendances = 0;

  for (const student of students) {
    const dates = attendanceDatesByStudentId.get(student.id) ?? [];
    const joinedAt = DateTime.fromJSDate(student.joinedAt);

    if (hasAttendanceInRange(dates, range)) active++;
    if (isNewInRange(joinedAt, range)) newThisMonth++;
    if (wasLost(dates, range)) lost++;
    totalAttendances += dates.filter((date) => isWithinRange(date, range)).length;
  }

  const enrolled = students.length;
  const inactive = enrolled - active;
  const avgAttendancesPerActive = active > 0 ? totalAttendances / active : 0;

  const today = currentCrDateParts();
  const healthResults = await Promise.all(
    students.map(async (student) => {
      const period = await getCurrentPaymentPeriod(student.id, today);
      return period !== null && (period.status === "PAID" || period.status === "PROMO");
    }),
  );
  const healthy = healthResults.filter(Boolean).length;
  const paymentHealthPercent = enrolled > 0 ? Math.round((healthy / enrolled) * 100) : 0;

  return {
    enrolled,
    active,
    inactive,
    newThisMonth,
    lost,
    totalAttendances,
    avgAttendancesPerActive,
    paymentHealthPercent,
  };
}
