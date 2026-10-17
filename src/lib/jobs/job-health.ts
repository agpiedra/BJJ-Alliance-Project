import vercelConfig from "../../../vercel.json";
import type { JobName } from "@/lib/jobs/job-names";

/**
 * How long a job may go without a fresh run before it's reported STALE — its own schedule
 * (`vercel.json`) plus a generous buffer for a missed or delayed trigger, not the schedule
 * itself: `/api/health/jobs` is a second, independent signal alongside the Healthchecks.io
 * heartbeat (`src/lib/jobs/heartbeat.ts`), not a replacement for it. Shared with
 * `/platform/monitoring` so the page and the endpoint can never disagree on "stale".
 */
export const STALE_AFTER_HOURS: Record<JobName, number> = {
  "weekly-digest": 24 * 8, // weekly (Monday) + a day of slack
};

/** A RUNNING row older than this never finished — almost certainly a crashed or killed
 * invocation, not a job still legitimately working. */
export const STUCK_AFTER_MINUTES = 30;

export function isJobStale(jobName: JobName, startedAt: Date | null, now: number): boolean {
  return startedAt === null || now - startedAt.getTime() > STALE_AFTER_HOURS[jobName] * 3_600_000;
}

export function isJobStuck(status: string | null, startedAt: Date | null, now: number): boolean {
  return status === "RUNNING" && startedAt !== null && now - startedAt.getTime() > STUCK_AFTER_MINUTES * 60_000;
}

/**
 * A job's schedule as `vercel.json` declares it (Vercel Cron evaluates every expression in UTC).
 * `weekly` is filled only for the one shape every current job uses — fixed minute, fixed hour,
 * any day of month, any month, one weekday — so the page can render it in words; any other
 * expression is shown raw rather than misdescribed.
 */
export interface JobSchedule {
  cron: string;
  weekly: { weekday: number; hourUtc: number; minuteUtc: number } | null;
}

export function resolveJobSchedule(jobName: JobName, crons: { path: string; schedule: string }[] = vercelConfig.crons): JobSchedule | null {
  const entry = crons.find((cron) => cron.path === `/api/cron/${jobName}`);
  if (!entry) return null;
  const match = /^(\d{1,2}) (\d{1,2}) \* \* ([0-6])$/.exec(entry.schedule.trim());
  if (!match) return { cron: entry.schedule, weekly: null };
  const [minuteUtc, hourUtc, weekday] = match.slice(1).map(Number);
  if (minuteUtc > 59 || hourUtc > 23) return { cron: entry.schedule, weekly: null };
  return { cron: entry.schedule, weekly: { weekday, hourUtc, minuteUtc } };
}
