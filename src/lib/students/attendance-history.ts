import { prisma } from "@/lib/prisma";
import { AttendanceType } from "@/generated/prisma/client";

/**
 * What one row of a student's ledger IS, so the history can say it plainly instead of showing a bare signed number:
 *  - class_checkin: a physical attendance attached to a class.
 *  - unmatched_checkin: a physical attendance with no class (a tap nothing matched; kept in the ledger).
 *  - staff_day: one attendance day recorded by a coach (an ADJUSTMENT of +1).
 *  - adjustment: any other signed ledger adjustment (legacy rows; the academy no longer creates them).
 */
export type AttendanceEntryKind = "class_checkin" | "unmatched_checkin" | "staff_day" | "adjustment";

export interface AttendanceHistoryEntry {
  id: string;
  date: Date;
  type: AttendanceType;
  kind: AttendanceEntryKind;
  delta: number;
  className: string | null;
  reason: string | null;
}

export interface AttendanceHistoryPage {
  entries: AttendanceHistoryEntry[];
  /** Opaque token for the next (older) page, or null when this was the last page. */
  nextCursor: string | null;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

function kindOf(record: { type: AttendanceType; delta: number; classSessionId: string | null }): AttendanceEntryKind {
  if (record.type === AttendanceType.ADJUSTMENT) return record.delta === 1 ? "staff_day" : "adjustment";
  return record.classSessionId ? "class_checkin" : "unmatched_checkin";
}

/** Keyset cursor over the stable order (occurredAt DESC, id DESC): `base64url(JSON [isoInstant, id])`. */
function encodeCursor(occurredAt: Date, id: string): string {
  return Buffer.from(JSON.stringify([occurredAt.toISOString(), id])).toString("base64url");
}

function decodeCursor(cursor: string): { at: Date; id: string } | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (!Array.isArray(parsed) || typeof parsed[0] !== "string" || typeof parsed[1] !== "string") return null;
    const at = new Date(parsed[0]);
    return Number.isNaN(at.getTime()) ? null : { at, id: parsed[1] };
  } catch {
    return null;
  }
}

/**
 * One page of a student's own attendance ledger, most-recent-first, VALID entries only (a voided entry stays in
 * the database but is not history the student sees). Lives in `src/lib/students/` (alongside
 * `attendance-summary.ts`, which reads the same table); it takes no session/scope parameter - the caller passes
 * the student and organization it already verified, and every query is filtered by both.
 *
 * Stable pagination: the order is (occurredAt DESC, id DESC) and the cursor is the last row's pair, so a page
 * boundary can never skip or repeat rows that share an instant, and a record that arrives while the student is
 * reading (always newer than everything loaded) cannot shift the older pages. An unreadable cursor yields an empty
 * page rather than restarting from the top, so a tampered value can never loop a client.
 *
 * `className` comes from the joined `ClassSession.name` when `classSessionId` is set; a staff-added day or an
 * unmatched check-in has no class and reports `null`.
 */
export async function getAttendanceHistoryPage(
  studentId: string,
  organizationId: string,
  opts: { cursor?: string | null; limit?: number } = {},
): Promise<AttendanceHistoryPage> {
  const limit = Math.min(Math.max(1, Math.floor(opts.limit ?? DEFAULT_LIMIT)), MAX_LIMIT);

  let after: { at: Date; id: string } | null = null;
  if (opts.cursor) {
    after = decodeCursor(opts.cursor);
    if (!after) return { entries: [], nextCursor: null };
  }

  const records = await prisma.attendanceRecord.findMany({
    where: {
      studentId,
      organizationId,
      voidedAt: null,
      ...(after ? { OR: [{ occurredAt: { lt: after.at } }, { occurredAt: after.at, id: { lt: after.id } }] } : {}),
    },
    orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    select: {
      id: true,
      occurredAt: true,
      type: true,
      delta: true,
      reason: true,
      classSessionId: true,
      classSession: { select: { name: true } },
    },
  });

  const pageRows = records.slice(0, limit);
  const last = pageRows[pageRows.length - 1];
  return {
    entries: pageRows.map((record) => ({
      id: record.id,
      date: record.occurredAt,
      type: record.type,
      kind: kindOf(record),
      delta: record.delta,
      className: record.classSession?.name ?? null,
      reason: record.reason,
    })),
    nextCursor: records.length > limit && last ? encodeCursor(last.occurredAt, last.id) : null,
  };
}

/** The first page of the same history (kept for callers that only want the newest entries). */
export async function getAttendanceHistory(studentId: string, organizationId: string, limit = DEFAULT_LIMIT): Promise<AttendanceHistoryEntry[]> {
  return (await getAttendanceHistoryPage(studentId, organizationId, { limit })).entries;
}

/**
 * The student's total attendance, defined as three parts that always reconcile with each other and with the
 * "lifetime attendances" figure every other screen shows (the sum of `delta` over valid rows):
 *  - `checkIns`: physical check-ins (matched to a class or not);
 *  - `staffDays`: attendance days a coach recorded (ADJUSTMENT rows of +1);
 *  - `otherAdjustments`: legacy signed adjustments that are not +1 (`count` rows, `net` effect).
 * `total = checkIns + staffDays + otherAdjustments.net`. Voided entries count for nothing and promotion credits
 * are not attendance, so they are not here. Computed over the WHOLE ledger with aggregates - never from the
 * length of a loaded page. `entryCount` is the number of valid rows behind the total (what "showing X of Y
 * entries" counts): it differs from `total` only when a legacy adjustment is not +1.
 */
export interface AttendanceTotals {
  total: number;
  entryCount: number;
  checkIns: number;
  staffDays: number;
  otherAdjustments: { count: number; net: number };
}

export async function getAttendanceTotals(studentId: string, organizationId: string): Promise<AttendanceTotals> {
  const valid = { studentId, organizationId, voidedAt: null } as const;
  const [checkIns, staffDays, other] = await Promise.all([
    prisma.attendanceRecord.aggregate({ where: { ...valid, type: AttendanceType.CHECKIN }, _sum: { delta: true }, _count: true }),
    prisma.attendanceRecord.aggregate({ where: { ...valid, type: AttendanceType.ADJUSTMENT, delta: 1 }, _sum: { delta: true }, _count: true }),
    prisma.attendanceRecord.aggregate({ where: { ...valid, type: AttendanceType.ADJUSTMENT, NOT: { delta: 1 } }, _sum: { delta: true }, _count: true }),
  ]);
  const checkInTotal = checkIns._sum.delta ?? 0;
  const staffDayTotal = staffDays._sum.delta ?? 0;
  const otherNet = other._sum.delta ?? 0;
  return {
    total: checkInTotal + staffDayTotal + otherNet,
    entryCount: checkIns._count + staffDays._count + other._count,
    checkIns: checkInTotal,
    staffDays: staffDayTotal,
    otherAdjustments: { count: other._count, net: otherNet },
  };
}
