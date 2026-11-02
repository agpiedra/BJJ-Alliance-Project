/**
 * The scheduled jobs (`vercel.json`), named once here — `run-scheduled-job.ts`,
 * `heartbeat.ts`'s env-var mapping, and `/api/health/jobs` all key off this single list,
 * so a new job can never register with only some of the three knowing its name.
 *
 * There is deliberately no promotion job: every promotion is awarded by an instructor
 * (docs/PROMOTION_PROGRESS_PROPOSAL.md), so the former `promotion-auto-award` cron was removed.
 *
 * `monthly-generation` (G2b) is registered but NOT scheduled: its route exists, and `vercel.json` has no entry for it until
 * the schedule (D5) is approved. `job-health.ts` reports it as unscheduled rather than stale.
 */
export const JOB_NAMES = ["weekly-digest", "monthly-generation"] as const;

export type JobName = (typeof JOB_NAMES)[number];
