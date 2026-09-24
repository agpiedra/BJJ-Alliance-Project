import { prisma } from "@/lib/prisma";

export interface RecentAttendanceEntry {
  id: string;
  /** Costa Rica ledger day, `YYYY-MM-DD`. */
  day: string;
  type: "CHECKIN" | "ADJUSTMENT";
  source: "KIOSK" | "PORTAL" | "STAFF";
  reason: string | null;
  className: string | null;
  /** ISO string, or null while the entry is valid. */
  voidedAt: string | null;
  voidReason: string | null;
}

/**
 * The staff correction view of a student's latest attendance entries, newest first. Unlike every progress
 * reader it INCLUDES voided rows (marked), so a voided mistake stays visible with who-said-why instead of
 * silently disappearing. Not the accessible attendance history (PR 3) - just enough to find an entry to void.
 */
export async function getRecentAttendanceEntries(
  studentId: string,
  organizationId: string,
  limit = 20,
): Promise<RecentAttendanceEntry[]> {
  const rows = await prisma.attendanceRecord.findMany({
    where: { studentId, organizationId },
    orderBy: [{ date: "desc" }, { occurredAt: "desc" }],
    take: limit,
    select: {
      id: true,
      date: true,
      type: true,
      source: true,
      reason: true,
      voidedAt: true,
      voidReason: true,
      classSession: { select: { name: true } },
    },
  });
  return rows.map((row) => ({
    id: row.id,
    day: row.date.toISOString().slice(0, 10),
    type: row.type,
    source: row.source,
    reason: row.reason,
    className: row.classSession?.name ?? null,
    voidedAt: row.voidedAt ? row.voidedAt.toISOString() : null,
    voidReason: row.voidReason,
  }));
}
