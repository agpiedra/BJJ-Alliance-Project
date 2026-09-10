import { DateTime } from "luxon";
import { prisma } from "@/lib/prisma";
import { academyScopeWhere, type StaffSession } from "@/lib/auth/session";
import { listApproachingStudents, type PromotionCandidate } from "@/lib/students/promotion-queue";
import { ZONE } from "@/lib/scheduling/zone";
import type { Belt, Prisma } from "@/generated/prisma/client";
import type { AnalyticsFilters } from "@/lib/analytics/filters";

/**
 * How far back "recent" looks when computing a candidate's attendance rate
 * for `projectThresholdDate` — spec's own number (Phase 7 §4 Task 3).
 */
const RECENT_WINDOW_DAYS = 60;

function requireDirectorRole(session: StaffSession): void {
  if (session.role !== "ADMIN" && session.role !== "DIRECTOR") {
    throw new Error("FORBIDDEN");
  }
}

/**
 * Projects the calendar date a student will cross their next stripe/exam
 * threshold, given how many attendances remain and how fast they've recently
 * been showing up. Pure — no DB access, no wall-clock read (`today` is
 * always caller-supplied, same split as `resolveAnalyticsFilters`).
 *
 * Returns `null` for either "nothing left to project toward"
 * (`remainingToNextStripe: null` — this plan's ruling for exam-eligible
 * candidates, who already belong in the promotion queue, not a projection)
 * or "no way to project" (a zero, negative, or otherwise non-positive rate —
 * there's no future date a rate of 0/week ever reaches).
 */
export function projectThresholdDate(
  remainingToNextStripe: number | null,
  recentAttendancesPerWeek: number,
  today: DateTime,
): DateTime | null {
  if (remainingToNextStripe === null) return null;
  if (!(recentAttendancesPerWeek > 0)) return null;

  const weeksNeeded = remainingToNextStripe / recentAttendancesPerWeek;
  return today.plus({ weeks: weeksNeeded });
}

export interface ProgressionPlanningRow {
  studentId: string;
  firstName: string;
  lastName: string;
  homeAcademyName: string;
  currentBelt: Belt;
  currentStripes: number;
  atBeltCount: number;
  remainingToNextStripe: number | null;
  recentAttendancesPerWeek: number;
  projectedDate: DateTime | null;
}

/**
 * Computes how many `CHECKIN` attendances `candidate` has logged since
 * `windowStart(candidate)` — the later of `today - RECENT_WINDOW_DAYS` and
 * their own `beltAwardedAt` (a student who just got their belt days ago has
 * no 60-day history to rate them against; their whole tenure at this belt IS
 * the window) — expressed as a per-week rate.
 *
 * A single broad query (last `RECENT_WINDOW_DAYS` days, every candidate)
 * rather than one query per student — `beltAwardedAt` only ever NARROWS the
 * window from that shared upper bound, never widens it, so filtering the
 * shared result set per student in memory is equivalent to, and cheaper
 * than, a per-student query with its own date bound.
 */
async function computeRecentAttendanceRates(
  candidateIds: string[],
  beltAwardedAtByStudentId: Map<string, Date>,
  today: DateTime,
): Promise<Map<string, number>> {
  const windowFloor = today.minus({ days: RECENT_WINDOW_DAYS });

  const attendances =
    candidateIds.length === 0
      ? []
      : await prisma.attendanceRecord.findMany({
          where: {
            studentId: { in: candidateIds },
            type: "CHECKIN",
            occurredAt: { gte: windowFloor.toJSDate(), lte: today.toJSDate() },
          },
          select: { studentId: true, occurredAt: true },
        });

  const datesByStudentId = new Map<string, DateTime[]>();
  for (const record of attendances) {
    const dates = datesByStudentId.get(record.studentId) ?? [];
    dates.push(DateTime.fromJSDate(record.occurredAt));
    datesByStudentId.set(record.studentId, dates);
  }

  const rateByStudentId = new Map<string, number>();
  for (const studentId of candidateIds) {
    const beltAwardedAt = beltAwardedAtByStudentId.get(studentId);
    const windowStart = beltAwardedAt
      ? DateTime.max(windowFloor, DateTime.fromJSDate(beltAwardedAt, { zone: ZONE }))
      : windowFloor;

    const windowDays = today.diff(windowStart, "days").days;
    if (windowDays <= 0) {
      rateByStudentId.set(studentId, 0);
      continue;
    }

    const count = (datesByStudentId.get(studentId) ?? []).filter((date) => date >= windowStart).length;
    rateByStudentId.set(studentId, count / (windowDays / 7));
  }

  return rateByStudentId;
}

/**
 * Director/admin progression-planning list (Phase 7 §4 Task 3) — ADMIN/
 * DIRECTOR only, self-enforced right here: `listApproachingStudents` itself
 * is intentionally open to every staff role (the dashboard's existing
 * "approaching" panel shows it to INSTRUCTOR too), so THIS wrapper is the
 * only place enforcing this panel's stricter gate.
 *
 * Reuses `listApproachingStudents` verbatim for "who's near a threshold"
 * (Phase 4's already-built, tested, self-gated classification) rather than a
 * third near-duplicate implementation of the same eligibility math — this
 * panel's planning list and the dashboard's promotion queue are meant to
 * agree on who counts as "approaching".
 *
 * `filters.academyId` narrows the result in memory (the session's own
 * `academyScopeWhere` is already applied inside `listApproachingStudents`) —
 * needed for an ADMIN who picked one specific academy while their session
 * itself spans both.
 *
 * Layers `projectThresholdDate` on top of each candidate's own
 * `remainingToNextStripe`, using a per-candidate recent-attendance rate
 * computed from `AttendanceRecord` (not carried by `PromotionCandidate`).
 */
export async function getProgressionPlanningList(
  session: StaffSession,
  filters: AnalyticsFilters,
  today: DateTime = DateTime.now().setZone(ZONE),
): Promise<ProgressionPlanningRow[]> {
  requireDirectorRole(session);

  const allApproaching = await listApproachingStudents(session);
  const candidates: PromotionCandidate[] = filters.academyId
    ? allApproaching.filter((c) => c.homeAcademyId === filters.academyId)
    : allApproaching;

  if (candidates.length === 0) return [];

  const students = await prisma.student.findMany({
    where: { id: { in: candidates.map((c) => c.studentId) } },
    select: { id: true, beltAwardedAt: true },
  });
  const beltAwardedAtByStudentId = new Map(students.map((s) => [s.id, s.beltAwardedAt]));

  const rateByStudentId = await computeRecentAttendanceRates(
    candidates.map((c) => c.studentId),
    beltAwardedAtByStudentId,
    today,
  );

  return candidates.map((candidate) => {
    const recentAttendancesPerWeek = rateByStudentId.get(candidate.studentId) ?? 0;
    return {
      studentId: candidate.studentId,
      firstName: candidate.firstName,
      lastName: candidate.lastName,
      homeAcademyName: candidate.homeAcademyName,
      currentBelt: candidate.currentBelt,
      currentStripes: candidate.currentStripes,
      atBeltCount: candidate.atBeltCount,
      remainingToNextStripe: candidate.remainingToNextStripe,
      recentAttendancesPerWeek,
      projectedDate: projectThresholdDate(candidate.remainingToNextStripe, recentAttendancesPerWeek, today),
    };
  });
}

export interface BeltDistributionRow {
  belt: Belt;
  count: number;
}

const BELT_ORDER: readonly Belt[] = ["WHITE", "BLUE", "PURPLE", "BROWN", "BLACK"];

/**
 * Director/admin belt-distribution panel data (Phase 7 §4 Task 3) — ADMIN/
 * DIRECTOR only, self-enforced. A simple `groupBy(currentBelt)` count over
 * ACTIVE students, scoped the same AND-array way `getHeadlineTiles` scopes
 * Student (`academyScopeWhere` translated to `homeAcademyId`, AND
 * `filters.academyId` when set — never spread into one object literal).
 *
 * Every belt appears, including a belt with zero current students — same
 * "surface the empty slot, don't filter it away" posture `getClassPopularity`
 * takes for a class with zero attendances — ordered `BELT_ORDER`
 * (progression order), not whatever order Prisma's `groupBy` happens to
 * return.
 */
export async function getBeltDistribution(
  session: StaffSession,
  filters: AnalyticsFilters,
): Promise<BeltDistributionRow[]> {
  requireDirectorRole(session);

  const scope = academyScopeWhere(session);
  const conditions: Prisma.StudentWhereInput[] = [{ status: "ACTIVE" }];
  if (scope.academyId) {
    conditions.push({ homeAcademyId: scope.academyId });
  }
  if (filters.academyId) {
    conditions.push({ homeAcademyId: filters.academyId });
  }

  const grouped = await prisma.student.groupBy({
    by: ["currentBelt"],
    where: { AND: conditions },
    _count: { _all: true },
  });
  const countByBelt = new Map(grouped.map((g) => [g.currentBelt, g._count._all]));

  return BELT_ORDER.map((belt) => ({ belt, count: countByBelt.get(belt) ?? 0 }));
}

export interface PromotionInRangeRow {
  promotionId: string;
  studentId: string;
  firstName: string;
  lastName: string;
  fromBelt: Belt;
  fromStripes: number;
  toBelt: Belt;
  toStripes: number;
  awardedAt: DateTime;
}

/**
 * Director/admin promotions-in-range panel data (Phase 7 §4 Task 3) — ADMIN/
 * DIRECTOR only, self-enforced. `Promotion.findMany` filtered by `awardedAt`
 * falling inside `filters.from`/`filters.to`, scoped the same AND-array way
 * `getClassPopularity` scopes `ClassSession` — `Promotion.academyId` is
 * already the right tenancy column (no `homeAcademyId`-style translation
 * needed, same as ClassSession).
 *
 * Ordered most-recent-first, matching the promotions list on the student
 * detail page.
 */
export async function getPromotionsInRange(
  session: StaffSession,
  filters: AnalyticsFilters,
): Promise<PromotionInRangeRow[]> {
  requireDirectorRole(session);

  const conditions: Prisma.PromotionWhereInput[] = [
    academyScopeWhere(session),
    { awardedAt: { gte: filters.from.toJSDate(), lte: filters.to.toJSDate() } },
  ];
  if (filters.academyId) {
    conditions.push({ academyId: filters.academyId });
  }

  const promotions = await prisma.promotion.findMany({
    where: { AND: conditions },
    select: {
      id: true,
      studentId: true,
      fromBelt: true,
      fromStripes: true,
      toBelt: true,
      toStripes: true,
      awardedAt: true,
      student: { select: { firstName: true, lastName: true } },
    },
    orderBy: { awardedAt: "desc" },
  });

  return promotions.map((promotion) => ({
    promotionId: promotion.id,
    studentId: promotion.studentId,
    firstName: promotion.student.firstName,
    lastName: promotion.student.lastName,
    fromBelt: promotion.fromBelt,
    fromStripes: promotion.fromStripes,
    toBelt: promotion.toBelt,
    toStripes: promotion.toStripes,
    awardedAt: DateTime.fromJSDate(promotion.awardedAt),
  }));
}
