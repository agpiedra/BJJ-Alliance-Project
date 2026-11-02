import type { NextResponse } from "next/server";
import { runScheduledJob, type BookkeepingBounds, type JobOrgBreakdown, type JobOutcome } from "@/lib/jobs/run-scheduled-job";
import { planRouteBudget, type RouteBudget } from "@/lib/dues/monthly-generation-route-budget";
import {
  DEFAULT_GENERATION_LIMITS,
  runMonthlyGeneration,
  type MonthlyGenerationRunDeps,
  type MonthlyGenerationRunReport,
} from "@/lib/dues/monthly-generation-progress";

/**
 * G2b (docs/dues/G2-ROUTE-BUDGET-PLAN.md §7, owner approval 2026-11-02): the monthly-generation cron route's logic.
 * `src/app/api/cron/monthly-generation/route.ts` is a thin wrapper around `handleMonthlyGenerationRequest`.
 *
 * NOT SCHEDULED: `vercel.json` has no entry for this route until the schedule (D5) is approved, so the platform never calls
 * it; it runs only when someone sends `CRON_SECRET`. With production defaults (`LedgerActivation` inactive, no
 * `generationStart`, an empty `DuesGenerationProgress` table until stage 9) a run claims no segment and writes no financial
 * row and no progress row.
 *
 * WHAT A SUCCESSFUL RESPONSE MEANS: this invocation ran and recorded no failure (`JobRun` SUCCEEDED). It NEVER means that
 * any month's billing is complete — a run may stop at its deadline with passes in progress; pass results live on the
 * progress rows (MONTHLY-GENERATION-TRIGGER-PLAN.md §3, §8). The body says so in `billingCompletenessCertified: false`.
 */

/** F: the function's maximum duration. MUST equal `maxDuration` in the route file (a unit test checks). Owner-approved. */
export const MONTHLY_GENERATION_FUNCTION_MAX_SECONDS = 300;
/**
 * C and M are RESERVES chosen by the owner (2026-11-02) — not measured values and not guaranteed bounds. Neither the cold
 * start nor the function-to-database round trip has been measured on the host (docs/dues/PHASE2-MEASUREMENT-PROPOSAL.md
 * §6), and whether pre-handler initialization counts against F is not documented.
 */
export const COLD_START_RESERVE_MS = 30_000;
export const MARGIN_MS = 30_000;
/** The G2a bookkeeping bounds (4 s per write: maxWait 1 s + timeout 2 s + statement 1 s), as planned in the G2 plan §2. */
export const MONTHLY_GENERATION_BOOKKEEPING: BookkeepingBounds = {
  maxWaitMs: 1_000,
  timeoutMs: 2_000,
  statementTimeoutMs: 1_000,
  lockTimeoutMs: 1_000,
  idleInTransactionTimeoutMs: 1_000,
};

/** Thrown inside the wrapped job so the wrapper records FAILED, pings `/fail` and answers 500 with this name as the code. */
export class RouteBudgetInfeasibleError extends Error {
  constructor() {
    super("route budget infeasible");
    this.name = "RouteBudgetInfeasibleError";
  }
}

export function monthlyGenerationRouteBudget(functionMaxMs = MONTHLY_GENERATION_FUNCTION_MAX_SECONDS * 1000): RouteBudget {
  return planRouteBudget({
    functionMaxMs,
    coldStartReserveMs: COLD_START_RESERVE_MS,
    marginMs: MARGIN_MS,
    bookkeeping: MONTHLY_GENERATION_BOOKKEEPING,
    generation: DEFAULT_GENERATION_LIMITS,
  });
}

/**
 * MONTHLY-GENERATION-TRIGGER-PLAN.md §8 outcome mapping: `sent` = created; `skipped` = INELIGIBLE + COVERED; `failed` = a
 * pass that finished with UNPRICED or PENDING students, a skipped rollover, and an error outside a student transaction
 * (a visit's stage error, a claim error, a discovery error). A run that stops at its deadline with work left is NOT a
 * failure. NOT implemented here (recorded gaps, needed before stage 9; each needs a read the route budget does not reserve,
 * and the progress table is empty until stage 9): the "overdue month" detection from persisted progress state, and the
 * body's `remainingSegments` and cursors left (§8) — today a deadline stop shows only `stoppedBy` and each visit's `ended`.
 * Only ids, months, reason codes and counts leave this function (plan §10).
 */
export function summarizeMonthlyGenerationRun(report: MonthlyGenerationRunReport): { outcome: JobOutcome; body: Record<string, unknown> } {
  let sent = 0;
  let skipped = 0;
  let failed = 0;
  const errors: string[] = [];
  const byOrganization = new Map<string, JobOrgBreakdown>();

  for (const visit of report.visits) {
    const month = `${visit.year}-${String(visit.month).padStart(2, "0")}`;
    const where = `segment:${visit.segmentId} org:${visit.organizationId} ${month}`;
    let visitFailed = 0;
    if (visit.passFinished && (visit.passFinished.unpriced > 0 || visit.passFinished.pending > 0)) {
      visitFailed++;
      errors.push(`${where} passEnded unpriced=${visit.passFinished.unpriced} pending=${visit.passFinished.pending}`);
    }
    if (visit.rollover && "skipped" in visit.rollover) {
      visitFailed++;
      errors.push(`${where} rolloverSkipped=${visit.rollover.skipped}${visit.rollover.skipped === "error" ? `:${visit.rollover.code}` : ""}`);
    }
    if (visit.error) {
      visitFailed++;
      errors.push(`${where} stage=${visit.error.stage} code=${visit.error.code}`);
    }
    const visitSkipped = visit.classes.INELIGIBLE + visit.classes.COVERED;
    sent += visit.created;
    skipped += visitSkipped;
    failed += visitFailed;
    const org = byOrganization.get(visit.organizationId) ?? { organizationId: visit.organizationId, sent: 0, failed: 0, skipped: 0 };
    org.sent += visit.created;
    org.failed += visitFailed;
    org.skipped += visitSkipped;
    byOrganization.set(visit.organizationId, org);
  }
  if (report.claimErrors > 0) {
    failed += report.claimErrors;
    errors.push(`claimErrors=${report.claimErrors}`);
  }
  if (report.discoveryError) {
    failed += 1;
    errors.push(`discovery code=${report.discoveryError}`);
  }

  const body = {
    ok: failed === 0,
    billingCompletenessCertified: false,
    stoppedBy: report.stoppedBy,
    created: sent,
    failed,
    skipped,
    claimErrors: report.claimErrors,
    ...(report.discoveryError ? { discoveryError: report.discoveryError } : {}),
    visits: report.visits.map((v) => ({
      segmentId: v.segmentId,
      organizationId: v.organizationId,
      year: v.year,
      month: v.month,
      ended: v.ended,
      created: v.created,
      ...(v.refused ? { refused: v.refused } : {}),
      ...(v.passFinished ? { passFinished: v.passFinished } : {}),
      ...(v.error ? { error: v.error } : {}),
      // Codes and counts only (plan §10): UNPRICED/PENDING reason codes, and safe codes of student transactions that failed.
      // A student failure becomes a run failure only when its pass ends (§8); until then it is visible here.
      ...(Object.keys(v.reasons).length ? { reasons: v.reasons } : {}),
      ...(Object.keys(v.errorCodes).length ? { errorCodes: v.errorCodes } : {}),
    })),
  };
  return {
    outcome: { sent, failed, skipped, organizationsProcessed: byOrganization.size, organizationBreakdown: [...byOrganization.values()], errors },
    body,
  };
}

/** Test seams only: the route passes none of these. */
export interface MonthlyGenerationRouteTestOverrides {
  functionMaxMs?: number;
  run?: (deps: MonthlyGenerationRunDeps) => Promise<MonthlyGenerationRunReport>;
}

/**
 * `startedAtMs` is `performance.now()` taken on the handler's first line, so the JobRun create's real duration is charged to
 * the runner's own admission check (G2 plan §2 wiring).
 */
export function handleMonthlyGenerationRequest(
  request: Request,
  startedAtMs: number,
  overrides: MonthlyGenerationRouteTestOverrides = {},
): Promise<NextResponse> {
  const elapsedMs = () => performance.now() - startedAtMs;
  const run = overrides.run ?? runMonthlyGeneration;
  return runScheduledJob(
    "monthly-generation",
    request,
    async () => {
      const budget = monthlyGenerationRouteBudget(overrides.functionMaxMs);
      if (!budget.ok) throw new RouteBudgetInfeasibleError();
      // Production defaults only: no activation, no start month, no closure (D3 pending; "none" is G1's only value).
      const report = await run({ closurePolicy: "none", limits: { deadlineMs: budget.generationDeadlineMs }, elapsedMs });
      return summarizeMonthlyGenerationRun(report);
    },
    { bookkeeping: MONTHLY_GENERATION_BOOKKEEPING },
  );
}
