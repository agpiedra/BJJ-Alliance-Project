import type { prisma } from "@/lib/prisma";

/**
 * Genuine-return-to-training brief §4: binds a request to a SPECIFIC archive event, not merely a status. A
 * status-only (`ARCHIVED`) precondition cannot distinguish a stale retry from a fresh request across two different
 * archive events that happen to produce the same status (archived September, returned October, archived again
 * November — a delayed retry of the ORIGINAL October request, submitted in December, must still refuse).
 *
 * The student's latest `StudentStatusChange` row — found by `sequence desc`, NEVER `createdAt` (a queued lock can
 * make a transaction-start timestamp disagree with true commit order) — is the archive-event identity. A `BASELINE`
 * row (the owner-reviewed one-time observation of an existing student's status at capture time) is NOT evidence of
 * a real archive action and must never be bound to: there is no actual event there to supersede or distinguish it
 * from. Called twice by design: once (with the plain `prisma` client) to decide whether to OFFER the action and
 * populate its hidden `archiveEventId` field, and once more (with an open `tx`, under the student lock) to
 * authoritatively re-verify the submission before any write — same function, same query shape, so the two can never
 * silently drift apart.
 */
export type ArchiveEventResolution =
  | { ok: true; archiveEventId: string }
  | {
      ok: false;
      /** Not currently `ARCHIVED`, or `statusBeforeArchive` is not `ACTIVE`/`INACTIVE` (D20). */
      reason: "notEligible";
    }
  | {
      ok: false;
      /** The latest `ARCHIVED`-status row is `BASELINE`-sourced, or (defensively) no `StudentStatusChange` row
       * exists at all despite `status === ARCHIVED` — a database-level inconsistency nothing in this codebase can
       * currently produce. Never falls back to a status-only check, and never fabricates a synthetic event id. */
      reason: "noTrustworthyArchiveEvent";
    };

/** Everything this needs: the guarded client, or a transaction on it. */
type ArchiveEventDb = Pick<typeof prisma, "student" | "studentStatusChange">;

export async function resolveTrustworthyArchiveEvent(db: ArchiveEventDb, organizationId: string, studentId: string): Promise<ArchiveEventResolution> {
  const student = await db.student.findFirst({
    where: { id: studentId, organizationId },
    select: { status: true, statusBeforeArchive: true },
  });
  if (!student || student.status !== "ARCHIVED" || (student.statusBeforeArchive !== "ACTIVE" && student.statusBeforeArchive !== "INACTIVE")) {
    return { ok: false, reason: "notEligible" };
  }

  const latest = await db.studentStatusChange.findFirst({
    where: { organizationId, studentId },
    orderBy: { sequence: "desc" },
    select: { id: true, status: true, source: true },
  });
  if (!latest || latest.status !== "ARCHIVED" || latest.source !== "EVENT") {
    return { ok: false, reason: "noTrustworthyArchiveEvent" };
  }

  return { ok: true, archiveEventId: latest.id };
}
