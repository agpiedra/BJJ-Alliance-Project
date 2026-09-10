import { prisma } from "@/lib/prisma";
import type { AttendanceType } from "@/generated/prisma/client";

export interface AttendanceHistoryEntry {
  id: string;
  date: Date;
  type: AttendanceType;
  delta: number;
  className: string | null;
  reason: string | null;
}

const DEFAULT_LIMIT = 50;

/**
 * A student's own attendance ledger, most-recent-first. Lives in
 * `src/lib/students/` (alongside `attendance-summary.ts`, which already
 * reads from the same `AttendanceRecord` table) rather than colocated with
 * any one route tree, since both the student portal (Phase 5) and — in
 * principle — a future staff view could read the same shape; unlike
 * `get-promotion-history.ts`'s staff-scoped pattern, this function takes no
 * session/scope parameter at all, so there is no staff-only assumption to
 * keep separate from.
 *
 * `className` comes from the joined `ClassSession.name` when
 * `classSessionId` is set; a manual staff adjustment (Task 8, Phase 3) has
 * no class attached and reports `null` — same distinction
 * `attendance-summary.ts`'s `PROMOTION_RELEVANT` filter documents.
 *
 * `limit` defaults to 50 rather than loading a long-tenured student's entire
 * lifetime history unconditionally onto one page — this phase doesn't call
 * for pagination, just a sane bound for a mobile page on possibly-bad wifi.
 */
export async function getAttendanceHistory(
  studentId: string,
  limit = DEFAULT_LIMIT,
): Promise<AttendanceHistoryEntry[]> {
  const records = await prisma.attendanceRecord.findMany({
    where: { studentId },
    orderBy: { occurredAt: "desc" },
    take: limit,
    select: {
      id: true,
      occurredAt: true,
      type: true,
      delta: true,
      reason: true,
      classSession: { select: { name: true } },
    },
  });

  return records.map((record) => ({
    id: record.id,
    date: record.occurredAt,
    type: record.type,
    delta: record.delta,
    className: record.classSession?.name ?? null,
    reason: record.reason,
  }));
}
