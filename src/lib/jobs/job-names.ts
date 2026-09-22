/**
 * The two scheduled jobs (`vercel.json`), named once here — `run-scheduled-job.ts`,
 * `heartbeat.ts`'s env-var mapping, and `/api/health/jobs` all key off this single list,
 * so a third job can never register with only some of the three knowing its name.
 */
export const JOB_NAMES = ["weekly-digest", "promotion-auto-award"] as const;

export type JobName = (typeof JOB_NAMES)[number];
