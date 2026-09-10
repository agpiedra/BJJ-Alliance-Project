import { DateTime } from "luxon";
import { prisma } from "@/lib/prisma";
import { academyScopeWhere, type StaffSession } from "@/lib/auth/session";
import { ZONE } from "@/lib/scheduling/zone";
import type { Prisma } from "@/generated/prisma/client";
import type { AnalyticsFilters } from "@/lib/analytics/filters";

function requireDirectorRole(session: StaffSession): void {
  if (session.role !== "ADMIN" && session.role !== "DIRECTOR") {
    throw new Error("FORBIDDEN");
  }
}

/**
 * Classifies retention risk from how many days have passed since a
 * student's last `CHECKIN`, as of the report's reference date
 * (`getRetentionList` passes `filters.to`). Pure.
 *
 * Buckets are closed-open on the low end — `"30"` means "30 to 59 days
 * quiet", `"60"` means "60 to 89", `"90"` means "90+" — so a value sitting
 * exactly ON a boundary (30/60/90) falls into the bucket that boundary
 * NAMES, not the one below it. Fewer than 30 days is `null`: not a
 * retention concern at all.
 *
 * `null` (never attended, ever — no `AttendanceRecord` exists) buckets into
 * `"90"`, the worst tier: a student with zero attendance history is at
 * least as much of a retention concern as one who simply stopped showing up
 * 90+ days ago, never a lesser one.
 */
export function classifyRetentionBucket(daysSinceLastAttendance: number | null): "30" | "60" | "90" | null {
  if (daysSinceLastAttendance === null) return "90";
  if (daysSinceLastAttendance < 30) return null;
  if (daysSinceLastAttendance < 60) return "30";
  if (daysSinceLastAttendance < 90) return "60";
  return "90";
}

export interface RetentionEntry {
  studentId: string;
  name: string;
  phone: string;
  lastSeenAt: Date | null;
  bucket: "30" | "60" | "90";
}

const BUCKET_RANK: Record<"30" | "60" | "90", number> = { "90": 0, "60": 1, "30": 2 };

/**
 * Director/admin retention list (Phase 7 §4 Task 5) — ADMIN/DIRECTOR only,
 * self-enforced. Only `ACTIVE` students are retention concerns: a `PENDING`
 * student never joined and an `ARCHIVED` one has already left, so neither is
 * "at risk of leaving" — scoped the same AND-array way `getHeadlineTiles`
 * scopes Student (`academyScopeWhere` translated to `homeAcademyId` AND
 * `filters.academyId` when set, never spread into one object literal).
 *
 * "Last seen" is the most recent `CHECKIN` `AttendanceRecord.occurredAt` for
 * the student, considering ALL history up to `filters.to` — never bounded by
 * `filters.from`, so a student who last attended long before the selected
 * range started is correctly "long overdue", never misread as "never
 * attended" just because their real last visit falls outside the window.
 * `filters.to` doubles as the "as of" reference date for the days-since
 * computation, so this list reflects retention risk as of the end of
 * whatever range the director selected — the same role `today` plays in
 * `getProgressionPlanningList`, expressed through the filter this function's
 * fixed signature is given instead of a separate injectable parameter.
 *
 * A student whose bucket comes back `null` (attended within the last 30
 * days as of `filters.to`) is dropped — this list only ever surfaces actual
 * retention concerns, never the whole active roster.
 *
 * Sorted worst-first (bucket `"90"` before `"60"` before `"30"`, then oldest
 * `lastSeenAt` first within a bucket — "never attended" sorts first of all)
 * since the director opening this list should see the most urgent outreach
 * targets at the top, not alphabetical order.
 */
export async function getRetentionList(
  session: StaffSession,
  filters: AnalyticsFilters,
): Promise<RetentionEntry[]> {
  requireDirectorRole(session);

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
    select: { id: true, firstName: true, lastName: true, phone: true },
  });
  if (students.length === 0) return [];

  const studentIds = students.map((student) => student.id);
  const lastAttendances = await prisma.attendanceRecord.groupBy({
    by: ["studentId"],
    where: {
      studentId: { in: studentIds },
      type: "CHECKIN",
      occurredAt: { lte: filters.to.toJSDate() },
    },
    _max: { occurredAt: true },
  });
  const lastSeenByStudentId = new Map(lastAttendances.map((a) => [a.studentId, a._max.occurredAt]));

  const entries: RetentionEntry[] = [];
  for (const student of students) {
    const lastSeenAt = lastSeenByStudentId.get(student.id) ?? null;
    const daysSince =
      lastSeenAt === null
        ? null
        : Math.floor(filters.to.diff(DateTime.fromJSDate(lastSeenAt, { zone: ZONE }), "days").days);
    const bucket = classifyRetentionBucket(daysSince);
    if (bucket === null) continue;

    entries.push({
      studentId: student.id,
      name: `${student.firstName} ${student.lastName}`,
      phone: student.phone,
      lastSeenAt,
      bucket,
    });
  }

  return entries.sort((a, b) => {
    if (BUCKET_RANK[a.bucket] !== BUCKET_RANK[b.bucket]) return BUCKET_RANK[a.bucket] - BUCKET_RANK[b.bucket];
    const aTime = a.lastSeenAt?.getTime() ?? -Infinity;
    const bTime = b.lastSeenAt?.getTime() ?? -Infinity;
    return aTime - bTime;
  });
}

/**
 * Director/admin weekly-attendance-trend line (Phase 7 §4 Task 5) — ADMIN/
 * DIRECTOR only, self-enforced. Scoped the same AND-array way
 * `getPromotionsInRange` scopes `Promotion`: `AttendanceRecord.academyId` is
 * already the right tenancy column (no `homeAcademyId`-style translation
 * needed), so `academyScopeWhere(session)` is pushed directly as its own AND
 * condition alongside `filters.academyId` when set.
 *
 * Buckets every `CHECKIN` in `[filters.from, filters.to]` into the
 * `America/Costa_Rica` ISO week (Monday-start) its `occurredAt` falls in —
 * via `DateTime.fromJSDate(occurredAt, { zone: ZONE })`, the same
 * zone-attachment convention `progression.ts` already uses for
 * `beltAwardedAt`. This is deliberately NOT naive UTC week math: this app
 * has a documented bug history (see `AttendanceRecord.date`'s schema
 * comment) from exactly that mistake — most evening classes (18:00+ CR) fall
 * on the next UTC calendar day, which would silently push them into the
 * wrong week.
 *
 * Every week in the range is returned, including a week with zero
 * attendances — the same "surface the empty slot, don't filter it away"
 * posture `getClassPopularity`/`getBeltDistribution` already take, and the
 * only way a `LineChart` reads as a continuous trend rather than a set of
 * disconnected points with gapped, misleading x-spacing.
 */
export async function getWeeklyAttendanceTrend(
  session: StaffSession,
  filters: AnalyticsFilters,
): Promise<Array<{ weekStart: string; count: number }>> {
  requireDirectorRole(session);

  const conditions: Prisma.AttendanceRecordWhereInput[] = [
    academyScopeWhere(session),
    { type: "CHECKIN" },
    { occurredAt: { gte: filters.from.toJSDate(), lte: filters.to.toJSDate() } },
  ];
  if (filters.academyId) {
    conditions.push({ academyId: filters.academyId });
  }

  const attendances = await prisma.attendanceRecord.findMany({
    where: { AND: conditions },
    select: { occurredAt: true },
  });

  const countByWeekStart = new Map<string, number>();
  for (const record of attendances) {
    const weekStart = DateTime.fromJSDate(record.occurredAt, { zone: ZONE }).startOf("week").toISODate()!;
    countByWeekStart.set(weekStart, (countByWeekStart.get(weekStart) ?? 0) + 1);
  }

  const firstWeek = filters.from.startOf("week");
  const lastWeek = filters.to.startOf("week");
  const weeks: string[] = [];
  for (let week = firstWeek; week <= lastWeek; week = week.plus({ weeks: 1 })) {
    weeks.push(week.toISODate()!);
  }

  return weeks.map((weekStart) => ({ weekStart, count: countByWeekStart.get(weekStart) ?? 0 }));
}
