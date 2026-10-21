import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireEnv } from "@/lib/env";
import { safeErrorCode, type SafeErrorCode } from "@/lib/auth/password-reset-log";
import { pingHeartbeat, type HeartbeatOutcome } from "@/lib/jobs/heartbeat";
import type { JobName } from "@/lib/jobs/job-names";
import { Prisma, type JobStatus } from "@/generated/prisma/client";

/** Per-organization line of the capped breakdown stored on the JobRun row — ids and counts
 * only, never a name/email/other detail (see JobRun.organizationBreakdown's schema comment). */
export interface JobOrgBreakdown {
  organizationId: string;
  sent: number;
  failed: number;
  skipped: number;
}

/** What a scheduled job reports back to the wrapper — deliberately separate from the JSON
 * body the route itself returns to its caller (Vercel Cron), so a route can keep its own
 * existing response shape (`{ok, processed, errors: [...]}`, etc.) while still giving the
 * wrapper normalized counts for the JobRun row and the heartbeat decision. */
export interface JobOutcome {
  sent: number;
  failed: number;
  skipped: number;
  organizationsProcessed: number;
  organizationBreakdown?: JobOrgBreakdown[];
  /** Human-readable error messages, truncated into JobRun.errorSummary. Never the reason a
   * route's own JSON body is built — that's the route's job, from its own richer errors.
   * CALLER-OWNED: stored as given; the wrapper does not sanitize what a job chooses to put here. */
  errors?: string[];
}

/**
 * G2a (docs/dues/G2-ROUTE-BUDGET-PLAN.md revision 2): bounded bookkeeping. When given, the JobRun create, finalize and
 * heartbeat-status writes each run in one transaction that waits at most `maxWaitMs` for a pool connection, with
 * `statement_timeout`, `lock_timeout` and `idle_in_transaction_session_timeout` set first, and Prisma's `timeout` on the
 * whole. Without it, those writes are the plain queries they always were (the weekly digest's path, unchanged).
 */
export interface BookkeepingBounds {
  maxWaitMs: number;
  timeoutMs: number;
  statementTimeoutMs: number;
  lockTimeoutMs: number;
  idleInTransactionTimeoutMs: number;
}
export interface ScheduledJobOptions {
  bookkeeping?: BookkeepingBounds;
}

/** What the heartbeat client observed — never proof of what Healthchecks.io received or recorded. */
export type HeartbeatRequestObservation = "accepted" | "notConfirmed" | "notConfigured";
export type BookkeepingStage = "create" | "finalize" | "heartbeatStatus";

const MAX_BREAKDOWN_ENTRIES = 100;
const MAX_ERROR_SUMMARY_LENGTH = 2000;

function deriveStatus(threw: boolean, outcome: JobOutcome): JobStatus {
  if (threw) return "FAILED";
  if (outcome.failed === 0) return "SUCCEEDED";
  return outcome.sent > 0 || outcome.skipped > 0 ? "PARTIAL" : "FAILED";
}

function observe(outcome: HeartbeatOutcome): HeartbeatRequestObservation {
  return outcome === "ok" ? "accepted" : outcome === "failed" ? "notConfirmed" : "notConfigured";
}

/** One bookkeeping write: bounded when `bounds` is given, the original plain query otherwise. */
function bookkeep<T>(bounds: BookkeepingBounds | undefined, write: (db: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  if (!bounds) return write(prisma as unknown as Prisma.TransactionClient);
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = ${Math.trunc(bounds.statementTimeoutMs)}`);
      await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = ${Math.trunc(bounds.lockTimeoutMs)}`);
      await tx.$executeRawUnsafe(`SET LOCAL idle_in_transaction_session_timeout = ${Math.trunc(bounds.idleInTransactionTimeoutMs)}`);
      return write(tx as unknown as Prisma.TransactionClient);
    },
    { maxWait: bounds.maxWaitMs, timeout: bounds.timeoutMs },
  );
}

/**
 * Every cron route (`src/app/api/cron/**`) goes through this — checks the shared secret,
 * writes a RUNNING JobRun row, runs the job, finalizes that row, then pings the
 * Healthchecks.io dead-man's switch. `fn` builds the route's OWN JSON body (so each route
 * keeps its existing shape) alongside a normalized `outcome` this wrapper uses for the
 * JobRun row and the heartbeat.
 *
 * ORDERING IS DELIBERATE: the JobRun row is finalized (status + finishedAt + counts)
 * BEFORE the heartbeat is pinged, never the other way around. If this function is killed
 * between the two — a Vercel execution timeout, a cold-start eviction — the row is left
 * reading its real final status but NO ping ever reaches Healthchecks, so Healthchecks
 * alerts on the missed check-in once its grace period elapses. That is a FALSE ALARM, not
 * silence — the correct failure direction for a dead-man's switch, since a human checking
 * the alert finds a JobRun row that already says what actually happened. The reverse order
 * (ping, then finalize) would let that same kill leave a recorded SUCCESS ping for a run
 * whose own JobRun row never finished — silencing the one signal meant to catch it. Do not
 * reorder this to "fix" the race between the two writes; there is no reordering that isn't
 * strictly worse than this one.
 *
 * Wrapper-generated diagnostics (G2a, every caller): an exception the wrapper catches is reported by `safeErrorCode` only —
 * in the stored `errorSummary`, the 500 body's `error` and every console argument — never its name, message, stack, meta or
 * cause. What `fn` itself returns (`body`, `outcome.errors`) or logs is caller-owned and passed through unchanged.
 *
 * With `options.bookkeeping` (G2a; the monthly-generation route, none today), additionally:
 *  - JobRun create failing (or its commit uncertain): the job does not run; ONE best-effort `/fail` ping; 500.
 *  - finalize failing or uncertain: ONE best-effort `/fail` ping and never a success ping; the heartbeat-status write is not
 *    attempted; 500 with `finalized: "unknown"`.
 *  - heartbeat-status write failing or uncertain (it happens AFTER the one ping): the ping's observed outcome is kept,
 *    persistence is reported `unknown`, and NO second ping is sent.
 *  - the body gains `{ ok, finalized, heartbeat: { request, resultPersisted }, bookkeepingError? }` on top of the caller's
 *    body. `ok` is true only for a confirmed finalize of a SUCCEEDED run. None of these fields — nor HTTP 200 — says anything
 *    about billing completeness or any other work the job did.
 */
export async function runScheduledJob(
  jobName: JobName,
  request: Request,
  fn: () => Promise<{ outcome: JobOutcome; body: Record<string, unknown> }>,
  options: ScheduledJobOptions = {},
): Promise<NextResponse> {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${requireEnv("CRON_SECRET")}`) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const bounds = options.bookkeeping;

  let runId: string;
  if (!bounds) {
    runId = (await prisma.jobRun.create({ data: { jobName } })).id;
  } else {
    try {
      runId = (await bookkeep(bounds, (db) => db.jobRun.create({ data: { jobName }, select: { id: true } }))).id;
    } catch (error) {
      // Whether the row committed is unknown (a timeout around COMMIT is ambiguous); the job never runs.
      const code = safeErrorCode(error);
      console.error(`[cron:${jobName}] JobRun create failed`, { error: code });
      const ping = await pingHeartbeat(jobName, false);
      return NextResponse.json(
        { ok: false, finalized: "unknown", heartbeat: { request: observe(ping), resultPersisted: "notAttempted" }, bookkeepingError: { stage: "create", code } },
        { status: 500 },
      );
    }
  }

  let outcome: JobOutcome;
  let body: Record<string, unknown>;
  let threw: SafeErrorCode | null = null;
  try {
    ({ outcome, body } = await fn());
  } catch (error) {
    threw = safeErrorCode(error);
    outcome = { sent: 0, failed: 1, skipped: 0, organizationsProcessed: 0, errors: [threw] };
    body = { ok: false, error: threw };
  }

  const status = deriveStatus(threw !== null, outcome);
  const errorSummary = outcome.errors?.length ? outcome.errors.join("; ").slice(0, MAX_ERROR_SUMMARY_LENGTH) : null;
  const finalData = {
    status,
    finishedAt: new Date(),
    sent: outcome.sent,
    failed: outcome.failed,
    skipped: outcome.skipped,
    organizationsProcessed: outcome.organizationsProcessed,
    organizationBreakdown: outcome.organizationBreakdown?.slice(0, MAX_BREAKDOWN_ENTRIES) as unknown as Prisma.InputJsonValue | undefined,
    errorSummary,
  };

  if (!bounds) {
    await prisma.jobRun.update({ where: { id: runId }, data: finalData });
  } else {
    try {
      await bookkeep(bounds, (db) => db.jobRun.update({ where: { id: runId }, data: finalData, select: { id: true } }));
    } catch (error) {
      // Finalization not confirmed: never a success ping, whatever the job did.
      const code = safeErrorCode(error);
      console.error(`[cron:${jobName}] JobRun finalize not confirmed`, { runId, error: code });
      const ping = await pingHeartbeat(jobName, false);
      return NextResponse.json(
        { ...body, ok: false, finalized: "unknown", heartbeat: { request: observe(ping), resultPersisted: "notAttempted" }, bookkeepingError: { stage: "finalize", code } },
        { status: 500 },
      );
    }
  }

  const success = threw === null && outcome.failed === 0;
  const heartbeatOutcome = await pingHeartbeat(jobName, success);
  let resultPersisted: "confirmed" | "unknown" = "confirmed";
  let bookkeepingError: { stage: BookkeepingStage; code: SafeErrorCode } | undefined;
  try {
    await bookkeep(bounds, (db) => db.jobRun.update({ where: { id: runId }, data: { heartbeatStatus: heartbeatOutcome }, select: { id: true } }));
  } catch (error) {
    // Purely observational — the ping already happened and the run's own result is already
    // committed above; losing this last write must never turn a real result into an error.
    // Its stored value is now unknown (null, or the new value if the commit landed); no second ping is sent.
    resultPersisted = "unknown";
    bookkeepingError = { stage: "heartbeatStatus", code: safeErrorCode(error) };
    console.error("[runScheduledJob] failed to record heartbeat status", { jobName, runId, error: bookkeepingError.code });
  }

  if (threw) console.error(`[cron:${jobName}] threw`, { error: threw });

  if (bounds) {
    const finalBody = {
      ...body,
      ok: status === "SUCCEEDED",
      finalized: "confirmed",
      heartbeat: { request: observe(heartbeatOutcome), resultPersisted },
      ...(bookkeepingError ? { bookkeepingError } : {}),
    };
    return NextResponse.json(finalBody, { status: threw ? 500 : 200 });
  }
  return NextResponse.json(body, { status: threw ? 500 : 200 });
}
