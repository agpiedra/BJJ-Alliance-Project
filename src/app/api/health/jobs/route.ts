import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireEnv } from "@/lib/env";
import { JOB_NAMES, type JobName } from "@/lib/jobs/job-names";

/**
 * How long a job may go without a fresh run before it's reported STALE — its own schedule
 * (`vercel.json`) plus a generous buffer for a missed or delayed trigger, not the schedule
 * itself: this endpoint is a second, independent signal alongside the Healthchecks.io
 * heartbeat (`src/lib/jobs/heartbeat.ts`), not a replacement for it.
 */
const STALE_AFTER_HOURS: Record<JobName, number> = {
  "weekly-digest": 24 * 8, // weekly (Monday) + a day of slack
};

/** A RUNNING row older than this never finished — almost certainly a crashed or killed
 * invocation, not a job still legitimately working. */
const STUCK_AFTER_MINUTES = 30;

interface JobHealth {
  lastRun: {
    status: string;
    startedAt: string;
    finishedAt: string | null;
    sent: number;
    failed: number;
    skipped: number;
    heartbeatStatus: string | null;
  } | null;
  stale: boolean;
  stuck: boolean;
}

/**
 * C1: job freshness, behind the same shared secret the cron routes themselves use
 * (`CRON_SECRET`) — this names real organization-touching activity (how many emails sent,
 * how many promotions awarded), so unlike `/api/health` it is never public.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${requireEnv("CRON_SECRET")}`) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const jobs: Record<JobName, JobHealth> = {} as Record<JobName, JobHealth>;
  for (const jobName of JOB_NAMES) {
    const run = await prisma.jobRun.findFirst({ where: { jobName }, orderBy: { startedAt: "desc" } });
    const now = Date.now();

    const stuck = run !== null && run.status === "RUNNING" && now - run.startedAt.getTime() > STUCK_AFTER_MINUTES * 60_000;
    const stale = run === null || now - run.startedAt.getTime() > STALE_AFTER_HOURS[jobName] * 3_600_000;

    jobs[jobName] = {
      lastRun: run
        ? {
            status: run.status,
            startedAt: run.startedAt.toISOString(),
            finishedAt: run.finishedAt?.toISOString() ?? null,
            sent: run.sent,
            failed: run.failed,
            skipped: run.skipped,
            heartbeatStatus: run.heartbeatStatus,
          }
        : null,
      stale,
      stuck,
    };
  }

  const healthy = Object.values(jobs).every((job) => !job.stale && !job.stuck);
  return NextResponse.json({ ok: healthy, jobs }, { status: 200 });
}
