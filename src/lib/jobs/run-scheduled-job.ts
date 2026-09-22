import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireEnv } from "@/lib/env";
import { pingHeartbeat } from "@/lib/jobs/heartbeat";
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
   * route's own JSON body is built — that's the route's job, from its own richer errors. */
  errors?: string[];
}

const MAX_BREAKDOWN_ENTRIES = 100;
const MAX_ERROR_SUMMARY_LENGTH = 2000;

function deriveStatus(threw: boolean, outcome: JobOutcome): JobStatus {
  if (threw) return "FAILED";
  if (outcome.failed === 0) return "SUCCEEDED";
  return outcome.sent > 0 || outcome.skipped > 0 ? "PARTIAL" : "FAILED";
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
 */
export async function runScheduledJob(
  jobName: JobName,
  request: Request,
  fn: () => Promise<{ outcome: JobOutcome; body: Record<string, unknown> }>,
): Promise<NextResponse> {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${requireEnv("CRON_SECRET")}`) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const run = await prisma.jobRun.create({ data: { jobName } });

  let outcome: JobOutcome;
  let body: Record<string, unknown>;
  let threw: Error | null = null;
  try {
    ({ outcome, body } = await fn());
  } catch (error) {
    threw = error instanceof Error ? error : new Error(String(error));
    outcome = { sent: 0, failed: 1, skipped: 0, organizationsProcessed: 0, errors: [threw.message] };
    body = { ok: false, error: threw.message };
  }

  const status = deriveStatus(threw !== null, outcome);
  const errorSummary = outcome.errors?.length ? outcome.errors.join("; ").slice(0, MAX_ERROR_SUMMARY_LENGTH) : null;

  await prisma.jobRun.update({
    where: { id: run.id },
    data: {
      status,
      finishedAt: new Date(),
      sent: outcome.sent,
      failed: outcome.failed,
      skipped: outcome.skipped,
      organizationsProcessed: outcome.organizationsProcessed,
      organizationBreakdown: outcome.organizationBreakdown?.slice(0, MAX_BREAKDOWN_ENTRIES) as unknown as Prisma.InputJsonValue | undefined,
      errorSummary,
    },
  });

  const success = threw === null && outcome.failed === 0;
  const heartbeatOutcome = await pingHeartbeat(jobName, success);
  try {
    await prisma.jobRun.update({ where: { id: run.id }, data: { heartbeatStatus: heartbeatOutcome } });
  } catch (error) {
    // Purely observational — the ping already happened and the run's own result is already
    // committed above; losing this last write must never turn a real result into an error.
    console.error("[runScheduledJob] failed to record heartbeat status", { jobName, runId: run.id, error });
  }

  if (threw) {
    console.error(`[cron:${jobName}] threw`, threw);
    return NextResponse.json(body, { status: 500 });
  }
  return NextResponse.json(body, { status: 200 });
}
