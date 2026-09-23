import { DateTime } from "luxon";
import { prisma } from "@/lib/prisma";
import { branchScopeWhere } from "@/lib/tenant/context";
import { getScopedDb } from "@/lib/tenant/scoped-client";
import type { AccessContext, TenantContext } from "@/lib/tenant/types";
import { ZONE } from "@/lib/scheduling/zone";
import type { Prisma } from "@/generated/prisma/client";
import type { AnalyticsFilters } from "@/lib/analytics/filters";

/**
 * A system job (e.g. the weekly-digest cron) is inherently trusted — it has
 * no per-user role to gate on, and is never subject to the same staff-role
 * restriction a real user session is. A kiosk is the opposite: it has no
 * business calling staff analytics at all, so it is always FORBIDDEN here,
 * never treated like a trusted system caller.
 */
function requireDirectorRole(context: AccessContext): void {
  if (context.kind === "system-job") return;
  if (context.kind === "kiosk") {
    throw new Error("FORBIDDEN");
  }
  if (context.organizationRole !== "ADMIN" && context.organizationRole !== "DIRECTOR") {
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

/**
 * MULTI_ACADEMY_AND_KIDS_BELTS.md Phase 3d follow-up: a student onboarded
 * with a PromotionCredit and zero real attendance is NOT the same signal as
 * a student with zero attendance FOREVER (the `null` -> bucket "90" case
 * above, which stays exactly as-is for everyone else) — they simply haven't
 * had a chance to attend yet. Bulk-onboarding Alliance's existing roster
 * would otherwise trip every one of those students into the worst bucket on
 * day one.
 *
 * The fix reuses `classifyRetentionBucket`'s own 30/60/90 thresholds rather
 * than inventing a separate "grace period" constant: for a CREDITED student
 * with no real attendance, the "since" clock starts at `joinedAt` instead of
 * never starting at all. Fewer than 30 days since joining is `null` — not a
 * concern, exactly like a recently-active student — and 30+ escalates
 * through the same buckets a genuine lapse would, rather than jumping
 * straight to "90" the instant the grace period ends. `joinedAt` (not
 * `beltAwardedAt`, which a director can backdate arbitrarily) is the anchor:
 * it is specifically "when this student joined THIS academy," the actual
 * date a genuine opportunity to attend began.
 *
 * An uncredited student's true "never attended" is untouched: this only
 * changes the never-attended case for students Phase 3d actually affects.
 */
export function resolveRetentionDaysSince(
  lastAttendanceAt: Date | null,
  hasOnboardingCredit: boolean,
  joinedAt: Date,
  asOf: DateTime,
): number | null {
  if (lastAttendanceAt !== null) {
    return Math.floor(asOf.diff(DateTime.fromJSDate(lastAttendanceAt, { zone: ZONE }), "days").days);
  }
  if (hasOnboardingCredit) {
    return Math.floor(asOf.diff(DateTime.fromJSDate(joinedAt, { zone: ZONE }), "days").days);
  }
  return null;
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
 * scopes Student (`branchScopeWhere` translated to `homeAcademyId` AND
 * `filters.academyId` when set, never spread into one object literal;
 * organization scope itself comes from `getScopedDb`, unconditionally).
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
  context: AccessContext,
  filters: AnalyticsFilters,
): Promise<RetentionEntry[]> {
  requireDirectorRole(context);

  const branchScope = branchScopeWhere(context);
  const conditions: Prisma.StudentWhereInput[] = [{ status: "ACTIVE" }];
  if (branchScope.academyId) {
    conditions.push({ homeAcademyId: branchScope.academyId });
  }
  if (filters.academyId) {
    conditions.push({ homeAcademyId: filters.academyId });
  }

  const students = await getScopedDb(context).student.findMany({
    where: { AND: conditions },
    select: { id: true, firstName: true, lastName: true, phone: true, joinedAt: true },
  });
  if (students.length === 0) return [];

  const studentIds = students.map((student) => student.id);
  const [lastAttendances, credits] = await Promise.all([
    prisma.attendanceRecord.groupBy({
      by: ["studentId"],
      where: {
        studentId: { in: studentIds },
        organizationId: context.organizationId,
        type: "CHECKIN",
        voidedAt: null,
        occurredAt: { lte: filters.to.toJSDate() },
      },
      _max: { occurredAt: true },
    }),
    // Existence only (Phase 3d follow-up) — presence of ANY PromotionCredit
    // row, regardless of its net sign or which belt period it anchors to, is
    // what marks this as a bulk/historical-onboarded student rather than a
    // pure walk-in beginner. See resolveRetentionDaysSince's own doc comment
    // for why that's the right bar, not "still counts toward the current
    // belt."
    prisma.promotionCredit.findMany({
      where: { studentId: { in: studentIds }, organizationId: context.organizationId },
      select: { studentId: true },
      distinct: ["studentId"],
    }),
  ]);
  const lastSeenByStudentId = new Map(lastAttendances.map((a) => [a.studentId, a._max.occurredAt]));
  const creditedStudentIds = new Set(credits.map((c) => c.studentId));

  const entries: RetentionEntry[] = [];
  for (const student of students) {
    const lastSeenAt = lastSeenByStudentId.get(student.id) ?? null;
    const daysSince = resolveRetentionDaysSince(
      lastSeenAt,
      creditedStudentIds.has(student.id),
      student.joinedAt,
      filters.to,
    );
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
 * needed), so `branchScopeWhere(context)` is pushed directly as its own AND
 * condition alongside `filters.academyId` when set (organization scope
 * itself comes from `getScopedDb`, unconditionally).
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
  context: TenantContext,
  filters: AnalyticsFilters,
): Promise<Array<{ weekStart: string; count: number }>> {
  requireDirectorRole(context);

  const conditions: Prisma.AttendanceRecordWhereInput[] = [
    branchScopeWhere(context),
    { type: "CHECKIN" },
    { voidedAt: null },
    { occurredAt: { gte: filters.from.toJSDate(), lte: filters.to.toJSDate() } },
  ];
  if (filters.academyId) {
    conditions.push({ academyId: filters.academyId });
  }

  const attendances = await getScopedDb(context).attendanceRecord.findMany({
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
