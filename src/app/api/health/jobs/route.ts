import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireEnv } from "@/lib/env";
import { JOB_NAMES, type JobName } from "@/lib/jobs/job-names";
import { isJobStale, isJobStuck } from "@/lib/jobs/job-health";

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

    const stuck = isJobStuck(run?.status ?? null, run?.startedAt ?? null, now);
    const stale = isJobStale(jobName, run?.startedAt ?? null, now);

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
