import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireEnv } from "@/lib/env";
import { bearerMatches } from "@/lib/auth/secrets-match";
import { safeErrorCode } from "@/lib/auth/password-reset-log";
import { detectGenerationAlertsDetailed, type GenerationAlertDetail } from "@/lib/dues/monthly-generation-alerts";
import { resolveJobSchedule } from "@/lib/jobs/job-health";
import { requestHealthcheck, urgentMonitorUrl } from "@/lib/jobs/heartbeat";
import { keysFromRead, reconcile, FAULT_FINDINGS, FAULT_SCHEDULE, type KeyRow } from "@/lib/monitoring/urgent/keys";
import { checkSchedule, judgeSlots, slotRunWindow, slotsDue, streakOps } from "@/lib/monitoring/urgent/slots";
import { planM2 } from "@/lib/monitoring/urgent/plan";
import { encodeMonitorFault, encodeSummary } from "@/lib/monitoring/urgent/summary";
import { executeM2, ping, type PingResult, type SendDeps } from "@/lib/monitoring/urgent/send";
import * as defaultStore from "@/lib/monitoring/urgent/store";

/**
 * The urgent monitor (docs/dues/URGENT-ALERTING-ONE-HOUR-PROPOSAL.md revision 5.1; implementation plan PR-B). One run, every
 * 15 minutes (`7,22,37,52 * * * *`):
 *  1. lease (one run at a time, ≥ 75 s apart; ≥ 125 s after a crash) → 2. schedule check → 3. reads (billing data only through the existing READ ONLY
 *  detection; `JobRun` read-only) → 4. ONE fenced transaction (occurrences, processed-run ledger, slot checkpoint) BEFORE any ping →
 *  5. M2 sequence → 6. record acceptance (only after HTTP 200 on the `/fail` that counted the keys) → 7. M1 → 8. release.
 * A failed read (D) sends M1 `/fail` and changes no key and no checkpoint. It never uses `runScheduledJob`: no `JobRun` rows.
 * Delivery is never confirmed: "accepted" is Healthchecks' HTTP 200, nothing more (hosted behavior unverified until drill X1).
 */
export const MONITOR_FUNCTION_MAX_SECONDS = 60;
/** Requests stop retrying when less than MIN_REMAINING_FOR_RETRY_MS of this budget remains (5 s under maxDuration). */
export const RUN_BUDGET_MS = 55_000;

type Store = typeof defaultStore;

export interface UrgentMonitorDeps {
  db: defaultStore.Db;
  detect: (now: Date) => Promise<GenerationAlertDetail>;
  scheduleExpr: () => string | null;
  urls: { m1?: string; m2?: string };
  request: SendDeps["request"];
  sleep: (ms: number) => Promise<void>;
  elapsedMs: () => number;
  newLeaseId: () => string;
  store?: Partial<Store>;
  /** Test seam: called after the persistence transaction committed, before any ping (crash-recovery tests). */
  afterPersist?: () => void | Promise<void>;
}

export interface UrgentMonitorResult {
  outcome: "ran" | "skipped" | "detectionFailed" | "leaseLost";
  sequence?: string;
  counts?: { new: number; repeat: number; reminder: number; unresolved: number };
  m2?: PingResult;
  m1?: PingResult;
  /** Monitoring faults open after this run: codes only. */
  faults?: string[];
  acceptanceRecorded?: boolean;
}

class DetectionFailed extends Error {
  constructor(readonly code: string) {
    super("detection failed");
  }
}

const faultParts = (rows: KeyRow[], scheduleReason: string | null) => {
  const open = new Set(rows.filter((r) => r.category === "FAULT" && r.clearedAt === null).map((r) => r.problemKey));
  const parts: string[] = [];
  if (open.has(FAULT_SCHEDULE)) parts.push(`schedule=${scheduleReason ?? "unsupported"}`);
  if (open.has(FAULT_FINDINGS)) parts.push("findings=unavailable");
  return parts;
};

export async function runUrgentMonitor(deps: UrgentMonitorDeps): Promise<UrgentMonitorResult> {
  const store: Store = { ...defaultStore, ...deps.store };
  const sendDeps: SendDeps = { request: deps.request, sleep: deps.sleep, remainingMs: () => RUN_BUDGET_MS - deps.elapsedMs() };
  const leaseId = deps.newLeaseId();
  const runRef = leaseId.replace(/[^0-9a-f]/gi, "").slice(0, 4);

  const lease = await store.acquireLease(deps.db, leaseId);
  if (!lease) return { outcome: "skipped" };
  try {
    const { dbNow, state } = lease;
    const schedule = checkSchedule(deps.scheduleExpr());
    const scheduleReason = schedule.ok ? null : schedule.reason;
    const watchingSince = state.watchingSince ?? dbNow;
    const slots = schedule.ok ? slotsDue({ watchingSince, checkedThrough: state.slotCheckedThrough, dbNow }) : [];

    let detail: GenerationAlertDetail;
    let jobRuns: Awaited<ReturnType<Store["readJobRuns"]>>;
    try {
      detail = await deps.detect(dbNow);
      if (detail.report.detection !== "ok") throw new DetectionFailed(detail.report.detection);
      jobRuns = await store.readJobRuns(deps.db, { highWater: state.findingsHighWater, slotWindow: slotRunWindow(slots) });
    } catch (error) {
      // D: the monitor cannot see. No key and no checkpoint changes; M1 /fail.
      const code = error instanceof DetectionFailed ? error.code : safeErrorCode(error);
      console.error("[urgent-monitor] read failed", { error: code });
      const m1 = await ping(deps.urls.m1, "fail", encodeMonitorFault([`D=${code}`], runRef), sendDeps);
      return { outcome: "detectionFailed", m1: m1.result };
    }

    const judged = judgeSlots(slots, jobRuns.slotRuns);
    const read = keysFromRead(detail.report, detail.atRisk, dbNow);
    const highWater = [state.findingsHighWater, ...jobRuns.finalized.map((r) => r.finishedAt)].reduce<Date | null>(
      (max, d) => (d !== null && (max === null || d.getTime() > max.getTime()) ? d : max),
      null,
    );
    const rows = await store.persist(deps.db, leaseId, {
      reconcile: (existing) => {
        const open = existing.find((r) => r.category === "SLOT" && r.clearedAt === null)?.problemKey ?? null;
        return reconcile(existing, {
          dbNow,
          runs: jobRuns.finalized,
          slotOps: schedule.ok ? streakOps(open, judged) : null,
          scheduleFault: scheduleReason as "missing" | "unsupported" | null,
          read,
        });
      },
      watchingSince: state.watchingSince ? undefined : dbNow,
      slotCheckedThrough: schedule.ok && slots.length > 0 ? slots[slots.length - 1] : undefined,
      processedRunIds: jobRuns.finalized.map((r) => r.id),
      findingsHighWater: highWater ?? undefined,
    });
    await deps.afterPersist?.();

    const plan = planM2({ rows, m2LastSignal: state.m2LastSignal, lastReminderAt: state.lastReminderAt, dbNow });
    const m2 = await executeM2(plan.sequence, deps.urls.m2, encodeSummary({ ...plan.summary, runRef }), sendDeps);
    let acceptanceRecorded = true;
    try {
      await store.recordOutcome(deps.db, leaseId, {
        newKeys: plan.sequence === "fail" || plan.sequence === "rearmFail" ? plan.newKeys : [],
        repeatKeys: plan.sequence === "fail" || plan.sequence === "rearmFail" ? plan.repeatKeys : [],
        failAccepted: m2.failAccepted,
        due: plan.due,
        signal: m2.signal,
        errorCode: m2.failAccepted ? null : m2.result,
      });
    } catch (error) {
      // Not marked accepted: the keys stay pending and are sent again next run (a duplicate email is possible, never a lost key).
      acceptanceRecorded = false;
      console.error("[urgent-monitor] acceptance not recorded", { error: safeErrorCode(error) });
    }

    const parts = faultParts(rows, scheduleReason);
    const m1 = await ping(deps.urls.m1, parts.length > 0 ? "fail" : "success", parts.length > 0 ? encodeMonitorFault(parts, runRef) : undefined, sendDeps);
    return {
      outcome: "ran",
      sequence: plan.sequence,
      counts: { new: plan.summary.new, repeat: plan.summary.repeat, reminder: plan.summary.reminder, unresolved: rows.filter((r) => r.clearedAt === null).length },
      m2: m2.result,
      m1: m1.result,
      faults: parts,
      acceptanceRecorded,
    };
  } catch (error) {
    if (error instanceof defaultStore.LeaseLostError) return { outcome: "leaseLost" };
    // An unexpected failure: best-effort M1 /fail so the fault is visible before silence would show it.
    await ping(deps.urls.m1, "fail", encodeMonitorFault([`error=${safeErrorCode(error)}`], runRef), sendDeps).catch(() => undefined);
    throw error;
  } finally {
    await store.release(deps.db, leaseId).catch((error) => console.error("[urgent-monitor] release failed", { error: safeErrorCode(error) }));
  }
}

export function defaultUrgentMonitorDeps(startedAtMs: number): UrgentMonitorDeps {
  return {
    db: prisma,
    detect: (now) => detectGenerationAlertsDetailed(now),
    scheduleExpr: () => resolveJobSchedule("monthly-generation")?.cron ?? null,
    urls: { m1: urgentMonitorUrl("monitor"), m2: urgentMonitorUrl("new") },
    request: (url, init) => requestHealthcheck(url, init, fetch, { urgentMonitor: "ping" }),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    elapsedMs: () => performance.now() - startedAtMs,
    newLeaseId: () => randomUUID(),
  };
}

/** GET handler logic: constant-time bearer check, then one monitor run. The body carries outcome codes and counts only. */
export async function handleUrgentMonitorRequest(request: Request, deps: UrgentMonitorDeps): Promise<NextResponse> {
  if (!bearerMatches(request.headers.get("authorization"), requireEnv("CRON_SECRET"))) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  try {
    const result = await runUrgentMonitor(deps);
    const ok = result.outcome === "ran" || result.outcome === "skipped";
    return NextResponse.json({ ok, ...result }, { status: 200 });
  } catch (error) {
    const code = safeErrorCode(error);
    console.error("[urgent-monitor] run failed", { error: code });
    return NextResponse.json({ ok: false, error: code }, { status: 500 });
  }
}
