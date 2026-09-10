import { prisma } from "@/lib/prisma";
import type { StaffSession } from "@/lib/auth/session";
import { getHeadlineTiles } from "@/lib/analytics/headline-tiles";
import type { Prisma } from "@/generated/prisma/client";
import type { AnalyticsFilters } from "@/lib/analytics/filters";

/**
 * The ONE gate both functions in this file share — spec's "Locations
 * (admin only)" heading is explicit that this panel, unlike every other
 * panel in this phase, rejects DIRECTOR outright rather than narrowing to
 * their own academy.
 */
function requireAdminOnly(session: StaffSession): void {
  if (session.role !== "ADMIN") {
    throw new Error("FORBIDDEN");
  }
}

export interface LocationComparisonRow {
  academyId: string;
  academyName: string;
  activeStudents: number;
  totalAttendances: number;
  avgPerClass: number;
  paymentHealthPercent: number;
}

/**
 * Director/admin locations panel — side-by-side per-academy comparison
 * (Phase 7 §4 Task 4, PROJECT_SPEC.md's "Locations (admin only)"). No
 * `academyScopeWhere(session)` composition is needed anywhere below: the
 * gate above guarantees `session.academyIds === "ALL"` for every caller that
 * reaches this point, so that fragment would always resolve to `{}` — a
 * permanent no-op, not a missing scope check.
 *
 * Queries the real `Academy` rows in scope (`filters.academyId` narrows to
 * one when set, else every academy — never a hardcoded "exactly two"). For
 * each one, `getHeadlineTiles` is called once with `academyId` pinned to
 * that academy — reusing its already-tested active/totalAttendances/
 * paymentHealthPercent computation rather than a second implementation of
 * the same metrics (this task's resolved ambiguity: `getHeadlineTiles`
 * already ANDs in `filters.academyId` as its own independent condition, so
 * calling it once per real academy id scopes correctly with zero changes to
 * `headline-tiles.ts`).
 *
 * `avgPerClass` isn't part of `HeadlineTiles`, so it's computed here: that
 * academy's `totalAttendances` (same range) divided by however many
 * `ClassSession` rows it has (active and inactive both count — same posture
 * `getClassPopularity` already takes toward class sessions), or 0 for an
 * academy with no classes at all.
 */
export async function getLocationComparison(
  session: StaffSession,
  filters: AnalyticsFilters,
): Promise<LocationComparisonRow[]> {
  requireAdminOnly(session);

  const academies = await prisma.academy.findMany({
    where: filters.academyId ? { id: filters.academyId } : undefined,
    orderBy: { name: "asc" },
    select: { id: true, name: true },
  });

  return Promise.all(
    academies.map(async (academy) => {
      const [tiles, classCount] = await Promise.all([
        getHeadlineTiles(session, { ...filters, academyId: academy.id }),
        prisma.classSession.count({ where: { academyId: academy.id } }),
      ]);

      return {
        academyId: academy.id,
        academyName: academy.name,
        activeStudents: tiles.active,
        totalAttendances: tiles.totalAttendances,
        avgPerClass: classCount > 0 ? tiles.totalAttendances / classCount : 0,
        paymentHealthPercent: tiles.paymentHealthPercent,
      };
    }),
  );
}

export interface CrossTrainingEntry {
  studentId: string;
  studentName: string;
  homeAcademyName: string;
  visitedAcademyName: string;
  visitCount: number;
}

/**
 * Director/admin cross-training panel (Phase 7 §4 Task 4) — same ADMIN-only
 * gate as `getLocationComparison`, for the same reason (`academyScopeWhere`
 * omitted below for the same "permanent no-op under this gate" reason).
 *
 * A "visit" is any `CHECKIN` `AttendanceRecord` whose `academyId` differs
 * from the student's own `homeAcademyId`, inside `filters.from`/`filters.to`
 * — the same CHECKIN-only distinction `getHeadlineTiles`/`getClassPopularity`
 * already draw (an `ADJUSTMENT` correction is not a physical visit).
 * `filters.academyId`, when set, narrows to visits recorded AT that specific
 * academy (`AttendanceRecord.academyId`) — the same column every other
 * function in this phase narrows on for this model.
 *
 * Grouped by (student, visited academy) so a student who cross-trained at
 * two different locations gets one entry per location, each with its own
 * count — never merged into a single cross-academy total. Sorted by
 * `visitCount` descending, matching this phase's "surface the most
 * meaningful rows first" convention (`getClassPopularity`'s ranking).
 */
export async function getCrossTraining(
  session: StaffSession,
  filters: AnalyticsFilters,
): Promise<CrossTrainingEntry[]> {
  requireAdminOnly(session);

  const conditions: Prisma.AttendanceRecordWhereInput[] = [
    { type: "CHECKIN" },
    { occurredAt: { gte: filters.from.toJSDate(), lte: filters.to.toJSDate() } },
  ];
  if (filters.academyId) {
    conditions.push({ academyId: filters.academyId });
  }

  const grouped = await prisma.attendanceRecord.groupBy({
    by: ["studentId", "academyId"],
    where: { AND: conditions },
    _count: { _all: true },
  });
  if (grouped.length === 0) return [];

  const studentIds = Array.from(new Set(grouped.map((g) => g.studentId)));
  const students = await prisma.student.findMany({
    where: { id: { in: studentIds } },
    select: { id: true, firstName: true, lastName: true, homeAcademyId: true },
  });
  const studentById = new Map(students.map((s) => [s.id, s]));

  const academies = await prisma.academy.findMany({ select: { id: true, name: true } });
  const academyNameById = new Map(academies.map((a) => [a.id, a.name]));

  const entries: CrossTrainingEntry[] = [];
  for (const group of grouped) {
    const student = studentById.get(group.studentId);
    // Same academy as home — a normal check-in, not cross-training.
    if (!student || group.academyId === student.homeAcademyId) continue;

    entries.push({
      studentId: student.id,
      studentName: `${student.firstName} ${student.lastName}`,
      homeAcademyName: academyNameById.get(student.homeAcademyId) ?? "",
      visitedAcademyName: academyNameById.get(group.academyId) ?? "",
      visitCount: group._count._all,
    });
  }

  return entries.sort((a, b) => b.visitCount - a.visitCount);
}
