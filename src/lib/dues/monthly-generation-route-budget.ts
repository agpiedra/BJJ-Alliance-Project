import { HEARTBEAT_TIMEOUT_MS } from "@/lib/jobs/heartbeat";
import type { BookkeepingBounds } from "@/lib/jobs/run-scheduled-job";
import { admissionBudgetMs, type GenerationLimits } from "@/lib/dues/monthly-generation-progress";

/**
 * G2a (docs/dues/G2-ROUTE-BUDGET-PLAN.md revision 2, §2): the whole-route budget of the monthly-generation cron route, as one
 * pure calculation. No I/O, no clock. No production caller: the route that would use it is G2b, after D5. Every input that
 * depends on the host — `functionMaxMs` (F), `coldStartReserveMs` (C), `marginMs` (M) — is a parameter; nothing here assumes
 * a production value.
 *
 * Sequential costs outside the runner's deadline, each counted once: the JobRun create (charged to the runner's own admission
 * check, because the route passes `elapsedMs` measured from the handler's start), then after the runner the finalize, the
 * heartbeat request and the heartbeat-status write (`post`). Discovery, every visit, every student and the lease release are
 * reserved by the runner itself inside its deadline and are not added again.
 *
 * What a feasible result means: the runner can ADMIT at least one visit under worst-case bounds, and every exit path still has
 * room for its own bookkeeping. It is not a predicted run time, and not a throughput or capacity figure — those need a hosted
 * measurement.
 */
export interface RouteBudgetInput {
  /** F: the host's maximum duration for the route (unknown until D5). */
  functionMaxMs: number;
  /** C: cold start before the handler runs; the route cannot measure it, so it is reserved. */
  coldStartReserveMs: number;
  /** M: response and runtime margin. */
  marginMs: number;
  bookkeeping: BookkeepingBounds;
  generation: GenerationLimits;
  /** Defaults to the heartbeat client's own abort. */
  heartbeatTimeoutMs?: number;
}

export interface RouteReserves {
  /** One bookkeeping transaction's worst case: maxWait + timeout + the statement still in flight when it expires. */
  bookkeepingTransactionMs: number;
  /** After the runner: finalize + heartbeat request + heartbeat-status write. */
  postMs: number;
  /** What each early exit still needs after it is decided (each is covered by `postMs + marginMs`). */
  createFailedMs: number;
  budgetInfeasibleMs: number;
  finalizeUnconfirmedMs: number;
}

export type RouteBudget =
  | {
      ok: true;
      /** Pass as `limits.deadlineMs`, with `elapsedMs` measured from the handler's start. */
      generationDeadlineMs: number;
      /** Worst-case elapsed time the runner needs before its first claim: the JobRun create + discovery + one visit's entry. */
      admissionMs: number;
      reserves: RouteReserves;
    }
  | { ok: false; reason: "invalidInput"; detail: string }
  | {
      ok: false;
      reason: "budgetInfeasible";
      generationDeadlineMs: number;
      admissionMs: number;
      reserves: RouteReserves;
      /** Whether even the refusal can be recorded: C + create + finalize + heartbeat + heartbeat-status + M <= F. */
      failurePathFits: boolean;
    }
  | { ok: false; reason: "leaseTooShort"; leaseMs: number; functionMaxMs: number };

export function planRouteBudget(input: RouteBudgetInput): RouteBudget {
  const { functionMaxMs: F, coldStartReserveMs: C, marginMs: M, bookkeeping: b, generation } = input;
  const heartbeat = input.heartbeatTimeoutMs ?? HEARTBEAT_TIMEOUT_MS;
  const values = { F, C, M, heartbeat, ...b };
  for (const [name, value] of Object.entries(values)) {
    if (!Number.isFinite(value) || value < 0) return { ok: false, reason: "invalidInput", detail: `${name} must be a finite non-negative number` };
  }
  if (b.lockTimeoutMs > b.statementTimeoutMs || b.statementTimeoutMs > b.timeoutMs || b.idleInTransactionTimeoutMs <= 0 || b.idleInTransactionTimeoutMs > b.timeoutMs) {
    return { ok: false, reason: "invalidInput", detail: "bookkeeping: lock <= statement <= transaction timeout, and 0 < idle <= transaction timeout" };
  }

  const leaseMs = generation.leaseSeconds * 1000;
  if (!(leaseMs > F)) return { ok: false, reason: "leaseTooShort", leaseMs, functionMaxMs: F };

  const tx = b.maxWaitMs + b.timeoutMs + b.statementTimeoutMs;
  const reserves: RouteReserves = {
    bookkeepingTransactionMs: tx,
    postMs: 2 * tx + heartbeat,
    createFailedMs: heartbeat + M,
    budgetInfeasibleMs: tx + heartbeat + tx + M,
    finalizeUnconfirmedMs: heartbeat + M,
  };
  const generationDeadlineMs = F - C - M - reserves.postMs;
  const admissionMs = tx + admissionBudgetMs(generation);
  // The runner admits a unit only if elapsed + unit < deadline (strict), so feasibility is strict too.
  if (!(generationDeadlineMs > admissionMs)) {
    const failurePathFits = C + tx + reserves.budgetInfeasibleMs <= F;
    return { ok: false, reason: "budgetInfeasible", generationDeadlineMs, admissionMs, reserves, failurePathFits };
  }
  return { ok: true, generationDeadlineMs, admissionMs, reserves };
}
