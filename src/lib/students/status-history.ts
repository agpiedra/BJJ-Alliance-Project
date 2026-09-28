import { DateTime } from "luxon";
import type { StudentStatus } from "@/generated/prisma/client";
import type { Tx } from "@/lib/students/lock";

/**
 * The branch-local calendar date it is right now in `zone` (never the server's or UTC's), as the UTC midnight `@db.Date` columns
 * store. A second, deliberately separate copy of `todayIn` from `src/lib/dues/ledger/common.ts` — not imported from there, since
 * anything under `src/lib/dues/ledger/` must have zero callers outside it (tests/unit/dues-ledger-not-exposed.test.ts) until the
 * approved payment-write integration stage. Three lines of pure calendar arithmetic is a smaller cost than weakening that guard.
 */
export function todayInAsDbDate(zone: string, now: Date): Date {
  const local = DateTime.fromJSDate(now, { zone });
  if (!local.isValid) throw new RangeError(`Unknown timezone: ${zone}`);
  return new Date(Date.UTC(local.year, local.month - 1, local.day));
}

/**
 * Eligibility-prerequisites brief, section 3.2. Appends ONE `StudentStatusChange` row, with `sequence` computed as
 * `MAX(sequence)+1` for this student. The caller MUST have already locked the student row (`lockStudent`, `FOR UPDATE`) earlier in
 * this same transaction — that lock is what makes this read-then-insert race-free (a second transaction's `MAX` query cannot start
 * until the first has committed and released the lock), not anything this function does on its own. `sequence`, not `createdAt`,
 * is what makes same-day ordering deterministic: `createdAt` is a transaction-START timestamp, which a queued lock can make
 * disagree with the true commit order.
 */
export async function appendStatusChange(
  tx: Tx,
  params: { organizationId: string; studentId: string; status: StudentStatus; effectiveOn: Date; source: "EVENT" | "BASELINE"; actorId: string | null },
): Promise<void> {
  const rows = await tx.$queryRaw<{ next: number }[]>`
    SELECT COALESCE(MAX("sequence"), 0) + 1 AS next FROM "StudentStatusChange"
    WHERE "studentId" = ${params.studentId} AND "organizationId" = ${params.organizationId}`;
  await tx.studentStatusChange.create({
    data: {
      organizationId: params.organizationId,
      studentId: params.studentId,
      status: params.status,
      effectiveOn: params.effectiveOn,
      sequence: rows[0].next,
      source: params.source,
      actorId: params.actorId,
    },
  });
}
