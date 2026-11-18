import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireEnv } from "@/lib/env";
import { bearerMatches } from "@/lib/auth/secrets-match";
import { JOB_NAMES, type JobName } from "@/lib/jobs/job-names";
import { isJobStale, isJobStuck, resolveJobSchedule } from "@/lib/jobs/job-health";
import { digestSwitch } from "@/lib/jobs/digest-switch";

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
  /** Whether `vercel.json` schedules this job. An unscheduled job (monthly-generation until D5) is never stale. */
  scheduled: boolean;
  stale: boolean;
  stuck: boolean;
  /**
   * weekly-digest only (`WEEKLY_DIGEST_ENABLED`): `disabled` = intentionally off on this environment (never stale or stuck,
   * excluded from `ok`); `misconfigured` = unrecognized value (digest does nothing; `ok` is false). Absent on other jobs.
   */
  state?: "enabled" | "disabled" | "misconfigured";
  reason?: "unset" | "false";
}

/**
 * C1: job freshness, behind the same shared secret the cron routes themselves use
 * (`CRON_SECRET`) — this names real organization-touching activity (how many emails sent,
 * how many promotions awarded), so unlike `/api/health` it is never public.
 */
export async function GET(request: Request): Promise<NextResponse> {
  // Constant-time (src/lib/auth/secrets-match.ts); accepts exactly the header value the former `!==` check accepted.
  if (!bearerMatches(request.headers.get("authorization"), requireEnv("CRON_SECRET"))) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const digest = digestSwitch();
  const jobs: Record<JobName, JobHealth> = {} as Record<JobName, JobHealth>;
  for (const jobName of JOB_NAMES) {
    const run = await prisma.jobRun.findFirst({ where: { jobName }, orderBy: { startedAt: "desc" } });
    const now = Date.now();
    // A switched-off digest is not expected to run: never stale or stuck (a misconfigured one fails `ok` below instead).
    const off = jobName === "weekly-digest" && digest.state !== "enabled";

    const stuck = !off && isJobStuck(run?.status ?? null, run?.startedAt ?? null, now);
    const stale = !off && isJobStale(jobName, run?.startedAt ?? null, now);

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
      scheduled: resolveJobSchedule(jobName) !== null,
      stale,
      stuck,
      ...(jobName === "weekly-digest" ? { state: digest.state, ...(digest.state === "disabled" ? { reason: digest.reason } : {}) } : {}),
    };
  }

  const healthy = Object.values(jobs).every((job) => !job.stale && !job.stuck && job.state !== "misconfigured");
  return NextResponse.json({ ok: healthy, jobs }, { status: 200 });
}
