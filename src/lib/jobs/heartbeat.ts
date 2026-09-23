import { JOB_NAMES, type JobName } from "@/lib/jobs/job-names";

/**
 * Healthchecks.io's own convention: GET the plain URL for a successful run, GET
 * `<url>/fail` for a failed one. This is the DEAD-MAN'S half of the switch — Healthchecks
 * alerts on a MISSED ping (the schedule's own period plus a grace window, configured on
 * their side; see docs/DEPLOYMENT_RUNBOOK.md), not only on an explicit `/fail`. So a Vercel
 * Cron misfire, or the route dying before this ever runs, is caught too, not just a run
 * that got far enough to report its own failure.
 */
const HEALTHCHECK_ENV: Record<JobName, string> = {
  "weekly-digest": "HEALTHCHECK_DIGEST_URL",
};

/** "not_configured" is a real, expected state until the runbook's Healthchecks.io setup step is
 * done — never silently absorbed into "ok" or "failed", so it stays visible on the JobRun row and
 * on /api/health/jobs. */
export type HeartbeatOutcome = "ok" | "failed" | "not_configured";

const TIMEOUT_MS = 5_000;

/**
 * Pings the given job's own configured Healthchecks.io URL — never the app's own database or
 * anything else that could fail for a reason unrelated to whether the job actually ran. Never
 * throws: a ping is observability, not a dependency the job's own success should hinge on
 * (`run-scheduled-job.ts` records this outcome but never lets it change the job's own result).
 *
 * `fetchImpl` defaults to the global `fetch` and exists so tests never make a real network call.
 */
export async function pingHeartbeat(jobName: JobName, success: boolean, fetchImpl: typeof fetch = fetch): Promise<HeartbeatOutcome> {
  if (!JOB_NAMES.includes(jobName)) return "not_configured";
  const baseUrl = process.env[HEALTHCHECK_ENV[jobName]];
  if (!baseUrl) return "not_configured";

  const url = success ? baseUrl : `${baseUrl}/fail`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, { method: "GET", signal: controller.signal });
    return response.ok ? "ok" : "failed";
  } catch (error) {
    console.error("[pingHeartbeat] failed to reach Healthchecks.io", { jobName, success, error });
    return "failed";
  } finally {
    clearTimeout(timeout);
  }
}
