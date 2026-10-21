import type { SystemJobContext, TenantContext } from "@/lib/tenant/types";
import { compareYearMonth, type YearMonth } from "@/lib/dues/calendar";
import { currentMonthIn } from "@/lib/dues/config-input";
import { eligibleAndAssigned, type AssignmentRow, type StatusHistoryRow } from "@/lib/dues/eligibility";
import { createMonthlyObligationInTx, isValidCoverageMonth, type CreateMonthlyObligationError } from "@/lib/dues/ledger/create-monthly-obligation";
import { fromDbDate, inTenantScope, latestEffective, lockBranchShared, lockStudent, type Tx } from "@/lib/dues/ledger/common";
import type { LedgerDeps } from "@/lib/dues/ledger/activation";
import { prisma } from "@/lib/prisma";

/**
 * Monthly-generation brief (§5, §8): the one function that connects `eligibleAndAssigned` (the pure reader) and
 * `createMonthlyObligationInTx` (the ledger's transaction-aware core) for one student, one branch, one coverage month.
 *
 * ONE transaction per student, in the ledger's existing lock order — branch FOR SHARE, then student FOR UPDATE — with the
 * status/assignment reads and the eligibility decision happening INSIDE that same held lock, before the terms/policy locks
 * `createMonthlyObligationInTx` takes. This is what closes both assignment races the brief describes: `assignPlan`
 * (`assignment-actions.ts`) now takes the same student lock before its own write, so whichever transaction — this one or a
 * concurrent `assignPlan` call — acquires the student lock first fully determines what the other sees. This function does
 * NOT retry, wait or loop if it finds no assignment: one read, one decision, reported honestly (brief §5.3 — the lock
 * guarantees a CONSISTENT answer, never that an obligation gets created regardless of ordering).
 *
 * Reports three distinct outcome categories (brief §2/§3), never one "skipped" bucket: `notEligible` (the pure function's
 * own three non-eligible outcomes — nothing to fix), `configurationGap` (eligible, but no effective priced terms/policy
 * for this month, or `createMonthlyObligationInTx` refused for a configuration reason — something to go fix),
 * `failure` (a real concurrency conflict or an unexpected error — investigate, never treat as a skip). `created` and
 * `alreadyCovered` are the two success shapes, matching `createMonthlyObligationInTx`'s own existing duplicate/
 * `coverageTaken` handling exactly (§4) — nothing new to guard there.
 *
 * No production caller. Not a route, not a server action, no scheduler entry (`vercel.json`'s `crons` array is untouched,
 * §7) — a plain library function, tested by calling it directly, closed by the same `LedgerActivation` default (inactive)
 * `createMonthlyObligationInTx` itself checks. Its one library caller is the generation job's visit loop
 * (`monthly-generation-progress.ts`), which has no production caller either.
 *
 * `month` is validated (`isValidCoverageMonth`) before anything else — before the student lookup, before any lock, before
 * eligibility or configuration is read — so a malformed month never reaches those, not even as a wasted query.
 *
 * Monthly-generation G1 (docs/dues/MONTHLY-GENERATION-TRIGGER-PLAN.md revision 4, §6.2), all optional and inert for a call
 * that passes none of them:
 *  - `fence` runs FIRST inside the transaction (the job locks and verifies its progress row there) and `record` runs LAST, with
 *    the outcome, for every outcome reached inside the transaction — so the job's cursor move and count commit or roll back
 *    together with whatever this transaction wrote. Either may throw `FenceLostError` to roll the WHOLE transaction back
 *    (obligation, coverage and audit rows included); that is reported as `fenced`, never swallowed as `unexpected`.
 *  - `bounds` sets `statement_timeout`/`lock_timeout` and Prisma's `maxWait`/`timeout` on the transaction.
 * Always, since G1: history and candidate reads are capped (`cap + 1` rows read; an overflow is reported, never decided on
 * partial data); the future month is checked here, under the branch lock, from the timezone read under it (the writer's own
 * check still follows, and its refusal is now a `failure`, not a configuration gap); an eligible student of an inactive
 * branch is a configuration gap (owner decision D4 — unresolved configuration work, never silently billed); and an
 * unexpected error's detail is its class name and code only, never its message.
 */
export type MonthlyGenerationOutcome =
  | { category: "created"; obligationId: string }
  | { category: "alreadyCovered"; reason: "existingObligation" | "packageCoverage"; obligationId?: string }
  | { category: "notEligible"; reason: "UNDECIDABLE" | "NOT_ELIGIBLE" | "NO_ASSIGNMENT" }
  | { category: "configurationGap"; reason: "noEffectiveVersion" | "inactiveBranch" | CreateMonthlyObligationError }
  | { category: "failure"; reason: CreateMonthlyObligationError | "unexpected" | "historyTooLarge" | "configurationTooLarge"; detail?: { name: string; code?: string } }
  | { category: "fenced" };

/** Thrown by a `fence`/`record` callback when the caller no longer holds what it fenced on: rolls the transaction back. */
export class FenceLostError extends Error {
  constructor() {
    super("fence lost");
    this.name = "FenceLostError";
  }
}

export interface GenerationBounds {
  statementTimeoutMs: number;
  lockTimeoutMs: number;
  maxWaitMs: number;
  timeoutMs: number;
}

export interface MonthlyGenerationRunnerOptions {
  fence?: (tx: Tx) => Promise<void>;
  record?: (tx: Tx, outcome: MonthlyGenerationOutcome) => Promise<void>;
  bounds?: GenerationBounds;
  historyCap?: number;
  configurationCap?: number;
  /** Test-only: called inside the transaction after the decision and any writes, right before `record`. Never set in production. */
  beforeRecordForTest?: (tx: Tx) => Promise<void>;
  /** Test-only: called inside the transaction right after `record`, before commit. Never set in production. */
  afterRecordForTest?: (tx: Tx) => Promise<void>;
}

/** Engineering defaults (plan §6.1): rows a history or candidate query may return before the student is reported as overflowing. */
export const DEFAULT_HISTORY_CAP = 500;
export const DEFAULT_CONFIGURATION_CAP = 500;

/** Error class name and Prisma/Postgres code only — never the message, which can carry names, amounts or SQL (plan §10). */
function sanitizedDetail(error: unknown): { name: string; code?: string } {
  if (!(error instanceof Error)) return { name: typeof error };
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? { name: error.name, code } : { name: error.name };
}

export async function generateMonthlyObligationForStudent(
  context: TenantContext | SystemJobContext,
  studentId: string,
  month: YearMonth,
  deps: LedgerDeps = {},
  options: MonthlyGenerationRunnerOptions = {},
): Promise<MonthlyGenerationOutcome> {
  if (!isValidCoverageMonth(month)) return { category: "failure", reason: "invalid" };
  const organizationId = context.organizationId;
  const historyCap = options.historyCap ?? DEFAULT_HISTORY_CAP;
  const configurationCap = options.configurationCap ?? DEFAULT_CONFIGURATION_CAP;

  // Re-read the student scoped to the organization; a forged or foreign id is a failure, never trusted — the same
  // discipline createMonthlyObligation's own pre-transaction lookup already uses.
  const student = await prisma.student.findFirst({ where: { id: studentId, organizationId }, select: { id: true, homeAcademyId: true } });
  if (!student || (context.kind === "tenant" && !inTenantScope(context, student.homeAcademyId))) return { category: "failure", reason: "notFound" };

  const decide = async (tx: Tx): Promise<MonthlyGenerationOutcome> => {
    // Same order createMonthlyObligationInTx uses: branch FOR SHARE, then student FOR UPDATE.
    const branch = await lockBranchShared(tx, organizationId, student.homeAcademyId);
    if (!branch) return { category: "failure", reason: "notFound" };
    // Decided under the branch lock, from the timezone read under it: a month the branch has not reached is never generated.
    if (compareYearMonth(month, currentMonthIn(branch.timezone, (deps.now ?? (() => new Date()))())) > 0) return { category: "failure", reason: "futureMonth" };
    const locked = await lockStudent(tx, organizationId, student.id);
    if (!locked || locked.homeAcademyId !== student.homeAcademyId) return { category: "failure", reason: "conflict" };

    // Status and assignment history, read fresh now that the student lock is held — this is what makes a concurrent
    // assignPlan call for this same student wait behind (or have already committed before) this read.
    const statusRows = await tx.studentStatusChange.findMany({
      where: { organizationId, studentId: student.id },
      select: { effectiveOn: true, sequence: true, status: true },
      take: historyCap + 1,
    });
    if (statusRows.length > historyCap) return { category: "failure", reason: "historyTooLarge" };
    const statusHistory: StatusHistoryRow[] = statusRows.map((row) => ({ effectiveOn: fromDbDate(row.effectiveOn), sequence: row.sequence, status: row.status }));

    const assignmentRows = await tx.studentPlanAssignment.findMany({
      where: { organizationId, studentId: student.id },
      select: { effectiveYear: true, effectiveMonth: true, planId: true },
      take: historyCap + 1,
    });
    if (assignmentRows.length > historyCap) return { category: "failure", reason: "historyTooLarge" };
    const planIds = [...new Set(assignmentRows.map((row) => row.planId).filter((id): id is string => id !== null))];
    const plans = planIds.length ? await tx.paymentPlan.findMany({ where: { organizationId, id: { in: planIds } }, select: { id: true, academyId: true } }) : [];
    const planAcademyById = new Map(plans.map((plan) => [plan.id, plan.academyId]));
    const assignments: AssignmentRow[] = assignmentRows.map((row) => ({
      effectiveYear: row.effectiveYear,
      effectiveMonth: row.effectiveMonth,
      planId: row.planId,
      planAcademyId: row.planId ? (planAcademyById.get(row.planId) ?? null) : null,
    }));

    const eligibility = eligibleAndAssigned(statusHistory, assignments, student.homeAcademyId, month);
    if (eligibility.outcome !== "ELIGIBLE") return { category: "notEligible", reason: eligibility.outcome };

    // D4: an eligible student of an inactive branch is unresolved configuration work — reported, never billed and never
    // counted as done. Read under the branch FOR SHARE lock already held, so a concurrent save cannot interleave.
    const branchState = await tx.academy.findFirst({ where: { id: student.homeAcademyId, organizationId }, select: { active: true } });
    if (!branchState) return { category: "failure", reason: "notFound" };
    if (!branchState.active) return { category: "configurationGap", reason: "inactiveBranch" };

    // Resolve a CANDIDATE effective terms/policy id — createMonthlyObligationInTx re-validates independently (brief §2);
    // this is only a plain "latest effective at or before target" query, not a guarantee.
    const termsCandidates = await tx.paymentPlanTerms.findMany({
      where: { organizationId, planId: eligibility.planId },
      select: { id: true, effectiveYear: true, effectiveMonth: true },
      take: configurationCap + 1,
    });
    const policyCandidates = await tx.duesPolicyVersion.findMany({
      where: { organizationId, academyId: student.homeAcademyId },
      select: { id: true, effectiveYear: true, effectiveMonth: true },
      take: configurationCap + 1,
    });
    if (termsCandidates.length > configurationCap || policyCandidates.length > configurationCap) return { category: "failure", reason: "configurationTooLarge" };
    const termsCandidate = latestEffective(termsCandidates, month);
    const policyCandidate = latestEffective(policyCandidates, month);
    if (!termsCandidate || !policyCandidate) return { category: "configurationGap", reason: "noEffectiveVersion" };

    const result = await createMonthlyObligationInTx(
      tx,
      { context, student, coverage: month, planTermsId: termsCandidate.id, policyVersionId: policyCandidate.id },
      deps,
    );

    if (result.ok) {
      return result.created
        ? { category: "created", obligationId: result.obligationId }
        : { category: "alreadyCovered", reason: "existingObligation", obligationId: result.obligationId };
    }
    if (result.error === "coverageTaken") return { category: "alreadyCovered", reason: "packageCoverage" };
    if (result.error === "conflict" || result.error === "notActive" || result.error === "invalid" || result.error === "futureMonth") {
      return { category: "failure", reason: result.error };
    }
    // staleVersion | inapplicable | notFound | currencyMismatch: our own candidate resolution was wrong, or a config row
    // disappeared mid-transaction — either way a configuration gap to go fix, never a failure to alarm on.
    return { category: "configurationGap", reason: result.error };
  };

  const { bounds } = options;
  try {
    return await prisma.$transaction(
      async (tx): Promise<MonthlyGenerationOutcome> => {
        if (bounds) {
          // SET LOCAL: these last only until this transaction ends. Postgres counts lock waiting inside statement_timeout.
          await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = ${Math.trunc(bounds.statementTimeoutMs)}`);
          await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = ${Math.trunc(bounds.lockTimeoutMs)}`);
        }
        await options.fence?.(tx);
        const outcome = await decide(tx);
        await options.beforeRecordForTest?.(tx);
        await options.record?.(tx, outcome);
        await options.afterRecordForTest?.(tx);
        return outcome;
      },
      bounds ? { maxWait: bounds.maxWaitMs, timeout: bounds.timeoutMs } : undefined,
    );
  } catch (error) {
    if (error instanceof FenceLostError) return { category: "fenced" };
    return { category: "failure", reason: "unexpected", detail: sanitizedDetail(error) };
  }
}
