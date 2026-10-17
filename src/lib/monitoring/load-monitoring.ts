import { requireSuperAdmin } from "@/lib/auth/require-super-admin";
import { getDatabaseHealth } from "@/lib/health/database-check";
import { JOB_NAMES, type JobName } from "@/lib/jobs/job-names";
import { isJobStale, isJobStuck, resolveJobSchedule, STALE_AFTER_HOURS, type JobSchedule } from "@/lib/jobs/job-health";
import {
  countDuesPaymentRecordEvents,
  countKioskAttemptsByOutcome,
  getJobRunSummary,
  listRecentAuditEvents,
  type JobRunSummary,
  type KioskAttemptCounts,
  type MonitoringAuditEvent,
  type MonitoringWindow,
} from "@/lib/tenant/platform-lookups";

export const MONITORING_WINDOW_MS = 24 * 60 * 60 * 1000;
export const RECENT_EVENT_LIMIT = 50;

export const ACCESS_DENIAL_ACTIONS = ["organization.accessRefused"] as const;

/** Platform-admin actions only (src/app/[locale]/platform/** and platform-lookups.ts's grant/revoke). */
export const PRIVILEGED_CHANGE_ACTIONS = [
  "organization.approve",
  "organization.reject",
  "organization.suspend",
  "organization.cancel",
  "organization.reactivate",
  "organization.createManual",
  "organization.graceDays.changed",
  "organizationInvoice.create",
  "organizationInvoice.recordPayment",
  "organizationInvoice.void",
  "organizationInvoice.acknowledgeReview",
  "organizationInvoice.graceExtended",
  "user.superAdminGranted",
  "user.superAdminRevoked",
] as const;

/** A panel either loaded or could not — "could not load" is never shown as zero or as "no history". */
export type Panel<T> = { status: "ok"; data: T } | { status: "unavailable" };

export type JobFreshness = "no_recorded_run" | "overdue" | "on_schedule";

export interface JobStatusView {
  jobName: JobName;
  schedule: JobSchedule | null;
  staleAfterHours: number;
  latestRun: JobRunSummary["latestRun"];
  latestSuccess: JobRunSummary["latestSuccess"];
  /** Same rule as /api/health/jobs's `stale`, split so "never ran" is its own state. */
  freshness: JobFreshness;
  /** When the latest run stops counting as fresh: its start + `staleAfterHours`. */
  freshUntil: Date | null;
  stuck: boolean;
}

export interface MonitoringSnapshot {
  snapshotAt: Date;
  window: MonitoringWindow;
  database: Panel<{ reachable: boolean; checkedAt: Date }>;
  jobs: Panel<JobStatusView[]>;
  kiosk: Panel<KioskAttemptCounts>;
  payments: Panel<{ recordedEvents: number }>;
  accessDenials: Panel<MonitoringAuditEvent[]>;
  privilegedChanges: Panel<MonitoringAuditEvent[]>;
}

export function classifyJob(jobName: JobName, summary: JobRunSummary, now: number): JobStatusView {
  const { latestRun, latestSuccess } = summary;
  const staleAfterHours = STALE_AFTER_HOURS[jobName];
  const freshness: JobFreshness = !latestRun ? "no_recorded_run" : isJobStale(jobName, latestRun.startedAt, now) ? "overdue" : "on_schedule";
  return {
    jobName,
    schedule: resolveJobSchedule(jobName),
    staleAfterHours,
    latestRun,
    latestSuccess,
    freshness,
    freshUntil: latestRun ? new Date(latestRun.startedAt.getTime() + staleAfterHours * 3_600_000) : null,
    stuck: isJobStuck(latestRun?.status ?? null, latestRun?.startedAt ?? null, now),
  };
}

async function settle<T>(panel: string, load: () => Promise<T>): Promise<Panel<T>> {
  try {
    return { status: "ok", data: await load() };
  } catch (error) {
    console.error("[monitoring] panel query failed", { panel, error });
    return { status: "unavailable" };
  }
}

/**
 * The /platform/monitoring data-access boundary. Authorizes FIRST, outside any per-panel
 * try/catch: a refusal is `requireSuperAdmin()`'s `notFound()` and must reach Next as a
 * refusal — it is never caught and turned into "panel unavailable", and no monitoring query
 * starts until it has passed. Every activity panel then reads the same window ending at one
 * snapshot instant; each panel settles on its own, so one failed query leaves the others intact.
 */
export async function loadMonitoringSnapshot(now: Date = new Date()): Promise<MonitoringSnapshot> {
  await requireSuperAdmin();

  const window: MonitoringWindow = { start: new Date(now.getTime() - MONITORING_WINDOW_MS), end: now };
  const [database, jobs, kiosk, payments, accessDenials, privilegedChanges] = await Promise.all([
    settle("database", async () => {
      const { ok, checkedAt } = await getDatabaseHealth();
      return { reachable: ok, checkedAt };
    }),
    settle("jobs", () => Promise.all(JOB_NAMES.map(async (jobName) => classifyJob(jobName, await getJobRunSummary(jobName), now.getTime())))),
    settle("kiosk", () => countKioskAttemptsByOutcome(window)),
    settle("payments", async () => ({ recordedEvents: await countDuesPaymentRecordEvents(window) })),
    settle("accessDenials", () => listRecentAuditEvents(ACCESS_DENIAL_ACTIONS, window, RECENT_EVENT_LIMIT)),
    settle("privilegedChanges", () => listRecentAuditEvents(PRIVILEGED_CHANGE_ACTIONS, window, RECENT_EVENT_LIMIT)),
  ]);

  return { snapshotAt: now, window, database, jobs, kiosk, payments, accessDenials, privilegedChanges };
}
