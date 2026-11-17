import { prisma } from "@/lib/prisma";
import type { JobName } from "@/lib/jobs/job-names";
import type { FinalizedRun, KeyRow, Reconciled } from "@/lib/monitoring/urgent/keys";
import type { M2Signal } from "@/lib/monitoring/urgent/plan";
import type { SlotRun } from "@/lib/monitoring/urgent/slots";

/**
 * The urgent monitor's database access (implementation plan PR-B, steps 2, 4, 5, 7, 9).
 * - Writes ONLY its own tables, `MonitorState` (one row) and `UrgentAlertKey`. Every write after the lease is fenced: it
 *   first locks the state row WHERE "leaseId" = this run's lease, and aborts if another run took it.
 * - Reads `JobRun` (bookkeeping, never billing data) in a `READ ONLY` transaction. Billing data is read only through the
 *   existing read-only detection (`detectGenerationAlertsDetailed`), never here.
 * - Lease columns are written and compared only in SQL, with UTC on both sides; every other column goes through Prisma (UTC).
 */
export type Db = typeof prisma;

/**
 * Lease length (PR-B review R2): longer than the function limit (60 s) plus one full minute plus 5 s. A run that crashes or fails
 * to release keeps the lease, so the earliest takeover starts ≥ 125 s after it, i.e. ≥ 65 s after its last possible request:
 * no 60-second window ever holds requests of both, so the ≤ 4-per-minute bound holds through crashes too.
 */
export const LEASE_SECONDS = 125;
/** After a clean release, a run starts only this long after the previous run ended (≤ 4 requests per run to one check). */
export const RUN_SPACING_SECONDS = 75;
/** Finalized billing runs turned into keys per monitor run; the rest are taken by the next run (none is ever skipped). */
export const FINDINGS_BATCH = 500;
/** More `JobRun` rows than this in the due-slot window is a read failure (D): at most a few runs per slot are expected. */
export const SLOT_RUNS_CAP = 1000;
const GENERATION: JobName = "monthly-generation";
const READ_BOUNDS = { maxWait: 1_000, timeout: 4_000 };
const WRITE_BOUNDS = { maxWait: 1_000, timeout: 8_000 };

export class LeaseLostError extends Error {
  constructor() {
    super("urgent monitor lease lost");
    this.name = "LeaseLostError";
  }
}

export interface MonitorState {
  watchingSince: Date | null;
  slotCheckedThrough: Date | null;
  /** The latest `finishedAt` among processed billing runs: a run that finished earlier and commits later is processed as late. */
  findingsHighWater: Date | null;
  m2LastSignal: M2Signal;
  lastReminderAt: Date | null;
}

/** Step 2: take the lease only if it is free AND the previous run ended ≥ 75 s ago (database clock). Null: skipped. */
export async function acquireLease(db: Db, leaseId: string): Promise<{ dbNow: Date; state: MonitorState } | null> {
  const rows = await db.$queryRaw<{ dbNow: Date }[]>`
    UPDATE "MonitorState"
       SET "leaseId" = ${leaseId}, "leaseUntil" = (now() AT TIME ZONE 'UTC') + ${LEASE_SECONDS} * interval '1 second'
     WHERE id = 1
       AND ("leaseUntil" IS NULL OR "leaseUntil" < (now() AT TIME ZONE 'UTC'))
       AND ("lastRunEndedAt" IS NULL OR "lastRunEndedAt" < (now() AT TIME ZONE 'UTC') - ${RUN_SPACING_SECONDS} * interval '1 second')
    RETURNING now() AS "dbNow"`;
  if (rows.length === 0) return null;
  const s = await db.monitorState.findUniqueOrThrow({ where: { id: 1 } });
  return {
    dbNow: new Date(rows[0].dbNow),
    state: {
      watchingSince: s.watchingSince,
      slotCheckedThrough: s.slotCheckedThrough,
      findingsHighWater: s.findingsHighWater,
      m2LastSignal: s.m2LastSignal as M2Signal,
      lastReminderAt: s.lastReminderAt,
    },
  };
}

/** Step 9: release, and record the end time that spaces the next run. Only the lease holder can release. */
export async function release(db: Db, leaseId: string): Promise<void> {
  await db.$executeRaw`
    UPDATE "MonitorState" SET "leaseId" = NULL, "leaseUntil" = NULL, "lastRunEndedAt" = (now() AT TIME ZONE 'UTC')
     WHERE id = 1 AND "leaseId" = ${leaseId}`;
}

async function bounded(tx: Parameters<Parameters<Db["$transaction"]>[0]>[0], readOnly: boolean) {
  if (readOnly) await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
  await tx.$executeRawUnsafe("SET LOCAL statement_timeout = 3000");
  await tx.$executeRawUnsafe("SET LOCAL lock_timeout = 1000");
  await tx.$executeRawUnsafe("SET LOCAL idle_in_transaction_session_timeout = 2000");
}

/**
 * Step 4 (read-only): finalized billing runs NOT yet in the processed ledger (review fix B2), and the runs inside the due-slot
 * window. The ledger, not a time cursor, decides what is new: a run that finished earlier but committed after a newer run was
 * processed is still unprocessed, so it is read here. No commit-delay bound is assumed. Only runs finished at or after
 * `watchingSince` count (before the monitor's first run, nothing is owed). Ids are selected in SQL (both timestamps compared in
 * the database, no parameter conversion), then read through Prisma.
 */
export async function readJobRuns(
  db: Db,
  p: { highWater: Date | null; slotWindow: { from: Date; to: Date } | null },
): Promise<{ finalized: FinalizedRun[]; slotRuns: SlotRun[] }> {
  return db.$transaction(async (tx) => {
    await bounded(tx, true);
    const ids = await tx.$queryRaw<{ id: string }[]>`
      SELECT j.id FROM "JobRun" j, "MonitorState" s
       WHERE s.id = 1 AND j."jobName" = ${GENERATION} AND j."finishedAt" IS NOT NULL
         AND j."finishedAt" >= COALESCE(s."watchingSince", now() AT TIME ZONE 'UTC')
         AND NOT EXISTS (SELECT 1 FROM "MonitorProcessedRun" p WHERE p."jobRunId" = j.id)
       ORDER BY j."finishedAt", j.id
       LIMIT ${FINDINGS_BATCH}`;
    const rows = ids.length
      ? await tx.jobRun.findMany({
          where: { id: { in: ids.map((r) => r.id) } },
          orderBy: [{ finishedAt: "asc" }, { id: "asc" }],
          select: { id: true, startedAt: true, finishedAt: true, urgentFindings: true },
        })
      : [];
    const finalized = rows.map((r) => ({ ...r, finishedAt: r.finishedAt!, late: p.highWater !== null && r.finishedAt!.getTime() < p.highWater.getTime() }));
    let slotRuns: SlotRun[] = [];
    if (p.slotWindow) {
      slotRuns = await tx.jobRun.findMany({
        where: { jobName: GENERATION, startedAt: { gte: p.slotWindow.from, lt: p.slotWindow.to } },
        select: { startedAt: true, finishedAt: true },
        take: SLOT_RUNS_CAP + 1,
      });
      if (slotRuns.length > SLOT_RUNS_CAP) throw Object.assign(new Error("slot window over cap"), { code: "overflow" });
    }
    return { finalized, slotRuns };
  }, READ_BOUNDS);
}

async function fence(tx: Parameters<Parameters<Db["$transaction"]>[0]>[0], leaseId: string) {
  const held = await tx.$queryRaw<{ id: number }[]>`SELECT id FROM "MonitorState" WHERE id = 1 AND "leaseId" = ${leaseId} FOR UPDATE`;
  if (held.length === 0) throw new LeaseLostError();
}

const toRow = (r: KeyRow) => ({
  problemKey: r.problemKey,
  occurrence: r.occurrence,
  category: r.category,
  source: r.source,
  onsetNotBefore: r.onsetNotBefore,
  evidenceAt: r.evidenceAt,
  firstSeenAt: r.firstSeenAt,
  lastSeenAt: r.lastSeenAt,
  clearedAt: r.clearedAt,
  firstAcceptedAt: r.firstAcceptedAt,
  repeatAcceptedAt: r.repeatAcceptedAt,
  lastMissedSlot: r.lastMissedSlot,
  missedCount: r.missedCount,
  lastAttemptAt: r.lastAttemptAt,
  lastErrorCode: r.lastErrorCode,
});

/**
 * Step 5: ONE fenced transaction, committed before any ping: the occurrences (reconciled from the rows as they are inside this
 * transaction), the processed-run ledger, the findings high-water mark and the slot checkpoint change together or not at all.
 * A run is marked processed only in the transaction that applied its findings, so it is applied exactly once (a crash before
 * commit leaves it unprocessed; `skipDuplicates` makes a replay of the same commit harmless). Checkpoints are written only when
 * given: a schedule fault passes no `slotCheckedThrough`, so the slot checkpoint is preserved. Returns the rows after the writes.
 */
export async function persist(
  db: Db,
  leaseId: string,
  p: {
    reconcile: (existing: KeyRow[]) => Reconciled;
    watchingSince?: Date;
    slotCheckedThrough?: Date;
    processedRunIds?: string[];
    findingsHighWater?: Date;
  },
): Promise<KeyRow[]> {
  return db.$transaction(async (tx) => {
    await bounded(tx, false);
    await fence(tx, leaseId);
    const existing = (await tx.urgentAlertKey.findMany()) as KeyRow[];
    const r = p.reconcile(existing);
    if (r.deletes.length > 0) await tx.urgentAlertKey.deleteMany({ where: { key: { in: r.deletes } } });
    for (const row of r.upserts) await tx.urgentAlertKey.upsert({ where: { key: row.key }, create: { key: row.key, ...toRow(row) }, update: toRow(row) });
    if (p.processedRunIds && p.processedRunIds.length > 0) {
      await tx.monitorProcessedRun.createMany({ data: p.processedRunIds.map((jobRunId) => ({ jobRunId })), skipDuplicates: true });
    }
    await tx.monitorState.update({
      where: { id: 1 },
      data: {
        ...(p.watchingSince ? { watchingSince: p.watchingSince } : {}),
        ...(p.slotCheckedThrough ? { slotCheckedThrough: p.slotCheckedThrough } : {}),
        ...(p.findingsHighWater ? { findingsHighWater: p.findingsHighWater } : {}),
      },
    });
    return r.rows;
  }, WRITE_BOUNDS);
}

/**
 * Step 7: record this run's M2 outcome. Problems are marked accepted ONLY after HTTP 200 on the `/fail` that counted them,
 * and only the keys it counted (a key added by a later run is never marked). Fenced like every write.
 */
export async function recordOutcome(
  db: Db,
  leaseId: string,
  o: { newKeys: string[]; repeatKeys: string[]; failAccepted: boolean; due: boolean; signal: M2Signal | null; errorCode: string | null },
): Promise<void> {
  await db.$transaction(async (tx) => {
    await bounded(tx, false);
    await fence(tx, leaseId);
    const [{ now }] = await tx.$queryRaw<{ now: Date }[]>`SELECT now() AS "now"`;
    const at = new Date(now);
    const counted = [...o.newKeys, ...o.repeatKeys];
    if (o.failAccepted) {
      if (o.newKeys.length > 0) {
        await tx.urgentAlertKey.updateMany({ where: { key: { in: o.newKeys }, firstAcceptedAt: null }, data: { firstAcceptedAt: at, lastAttemptAt: at, lastErrorCode: null } });
      }
      if (o.repeatKeys.length > 0) {
        await tx.urgentAlertKey.updateMany({
          where: { key: { in: o.repeatKeys }, repeatAcceptedAt: null, firstAcceptedAt: { not: null } },
          data: { repeatAcceptedAt: at, lastAttemptAt: at, lastErrorCode: null },
        });
      }
      await tx.urgentAlertKey.deleteMany({ where: { clearedAt: { not: null }, repeatAcceptedAt: { not: null } } });
    } else if (counted.length > 0 && o.errorCode !== null) {
      await tx.urgentAlertKey.updateMany({ where: { key: { in: counted } }, data: { lastAttemptAt: at, lastErrorCode: o.errorCode } });
    }
    await tx.monitorState.update({
      where: { id: 1 },
      data: { ...(o.signal ? { m2LastSignal: o.signal } : {}), ...(o.failAccepted && o.due ? { lastReminderAt: at } : {}) },
    });
  }, WRITE_BOUNDS);
}
