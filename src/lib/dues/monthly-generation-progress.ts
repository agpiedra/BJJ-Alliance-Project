import { randomUUID } from "node:crypto";
import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { safeErrorCode, type SafeErrorCode } from "@/lib/auth/password-reset-log";
import { resolveSystemJobContext } from "@/lib/tenant/context";
import { listClaimableGenerationSegments } from "@/lib/tenant/platform-lookups";
import type { SystemJobContext } from "@/lib/tenant/types";
import { compareYearMonth, type YearMonth } from "@/lib/dues/calendar";
import { currentMonthIn } from "@/lib/dues/config-input";
import { inactiveLedgerActivation, type LedgerDeps } from "@/lib/dues/ledger/activation";
import type { Tx } from "@/lib/dues/ledger/common";
import {
  DEFAULT_CONFIGURATION_CAP,
  DEFAULT_HISTORY_CAP,
  FenceLostError,
  generateMonthlyObligationForStudent,
  type GenerationBounds,
  type MonthlyGenerationOutcome,
} from "@/lib/dues/monthly-generation";

/**
 * Monthly-generation G1: the visit loop over `DuesGenerationProgress` (docs/dues/MONTHLY-GENERATION-TRIGGER-PLAN.md revision 4,
 * §5–§8). One invocation discovers claimable (organization, month) segments, least recently visited first, claims each with a
 * lease, and walks its students by id, one student per transaction.
 *
 * The protocol, enforced here and proved by tests/integration/monthly-generation-progress.test.ts:
 *  - CONTIGUITY. Every cursor move is a compare-and-set from the previous committed cursor, covers exactly one student, and
 *    carries that student's class count in the same statement. A student that reached a decision inside its transaction is
 *    recorded by the transaction itself (the runner's `record` callback), so its obligation, coverage and audit rows, its count
 *    and the cursor commit or roll back as one. A student whose transaction threw is recorded PENDING by one separate
 *    compare-and-set afterwards. Nothing is batched per page.
 *  - FENCING. The progress row is locked FOR UPDATE first in every student transaction, verifying the lease token, its expiry
 *    and the expected cursor; the cursor update re-verifies token and cursor and throws `FenceLostError` on anything but one row,
 *    rolling back the whole transaction. Every other progress write is a compare-and-set on (token, cursor). Lock order: progress
 *    row, then the ledger's own (branch FOR SHARE, student FOR UPDATE, terms/policy FOR SHARE).
 *  - FAILURE ISOLATION. A recoverable database failure ends only what it belongs to: inside a student's transaction it is that
 *    student's failure (rolled back, then recorded PENDING by the failure record); in the gate, page read, marker, failure
 *    record or pass end it ends that segment's visit with a reported `error` and the committed cursor and counts untouched;
 *    in a claim it skips that segment; in discovery it ends the run with a report. Later segments still progress. Test hooks
 *    (`boundaryForTest`) are never inside these catches: a simulated process death still ends the whole invocation.
 *  - BOUNDS. Every database operation runs inside a transaction with `maxWait` (waiting for a pool connection and BEGIN),
 *    `timeout`, `statement_timeout` and `lock_timeout`. Measured on this stack: `maxWait` does bound pool acquisition, but
 *    Prisma's `timeout` does NOT interrupt a statement already running — that statement ends at its own `statement_timeout`.
 *    So one transaction's worst case is `maxWait + timeout + statement_timeout`, and a unit starts only if the elapsed time
 *    plus the worst case of everything it may still need (including the lease release) fits before the deadline. See
 *    `runMonthlyGeneration` for exactly what the deadline does and does not guarantee.
 *  - CRASHES. A per-visit marker counts consecutive visits that started at the same student; past `maxAttempts` that student is
 *    recorded PENDING (`repeatedFailure`) and passed. It stays pending, so the pass cannot be clean.
 *
 * What this does NOT do (owner decisions still pending): no month closure (D3 — `closurePolicy` is a required input whose only
 * value is "none", and no production value exists), no route, registry entry or scheduler (D5). No production caller: closed by
 * the same defaults as every ledger writer — `generationStart` defaults to "no start month" and `LedgerActivation` to inactive,
 * so a run with production defaults refuses every segment and writes no financial row; and the progress table itself is empty
 * until stage 9 inserts an organization's first row.
 */

export const GENERATION_JOB_NAME = "monthly-generation";

export interface GenerationLimits {
  /** Postgres `statement_timeout` for every statement; lock waits count inside it. Must not exceed either transaction timeout. */
  statementTimeoutMs: number;
  lockTimeoutMs: number;
  /** A short transaction (discovery, claim, gate, rollover, page, marker, failure record, pass end, release). */
  shortMaxWaitMs: number;
  shortTimeoutMs: number;
  /** The student transaction (the runner). */
  studentMaxWaitMs: number;
  studentTimeoutMs: number;
  /** The invocation deadline `T`. */
  deadlineMs: number;
  /** The lease `L`; must exceed the host's maximum function duration (confirmed by a person under D5). */
  leaseSeconds: number;
  discoveryLimit: number;
  pageSize: number;
  studentsPerVisit: number;
  rolloverRows: number;
  historyCap: number;
  configurationCap: number;
  branchCap: number;
  maxAttempts: number;
}

/** Engineering defaults (plan §6.1, §12): reviewable, not owner decisions. */
export const DEFAULT_GENERATION_LIMITS: GenerationLimits = {
  statementTimeoutMs: 1_000,
  lockTimeoutMs: 1_000,
  shortMaxWaitMs: 1_000,
  shortTimeoutMs: 2_000,
  studentMaxWaitMs: 2_000,
  studentTimeoutMs: 5_000,
  deadlineMs: 45_000,
  leaseSeconds: 600,
  discoveryLimit: 20,
  pageSize: 100,
  studentsPerVisit: 50,
  rolloverRows: 3,
  historyCap: DEFAULT_HISTORY_CAP,
  configurationCap: DEFAULT_CONFIGURATION_CAP,
  branchCap: 100,
  maxAttempts: 3,
};

export type GenerationBoundary = "afterClaim" | "afterMarker" | "afterStudentCommit" | "afterStudentFailure" | "afterFailureRecord" | "beforePassEnd" | "afterPassEnd";

export interface MonthlyGenerationRunDeps extends LedgerDeps {
  /** Owner decision D3 is pending. Required, and "none" (no automatic closure) is the only value G1 implements. */
  closurePolicy: "none";
  /**
   * The organization's start month S. Production default: none, so no segment is ever processed (plan §4). Like
   * `activation.isActive`, it is called outside any bounded transaction: the defaults do no I/O, and stage 9's implementations
   * must bound their own reads (a stated limit of the deadline, see `runMonthlyGeneration`).
   */
  generationStart?: (organizationId: string) => Promise<YearMonth | null>;
  limits?: Partial<GenerationLimits>;
  /** The budget clock in milliseconds since the invocation began. Tests fix it; production leaves it out. */
  elapsedMs?: () => number;
  /** Test-only: called at each commit boundary of plan §6.4. Throwing simulates the process dying there. Never set in production. */
  boundaryForTest?: (boundary: GenerationBoundary, at: { segmentId: string; studentId?: string }) => Promise<void>;
  /** Test-only: passed to the runner's `beforeRecordForTest` / `afterRecordForTest`. Never set in production. */
  beforeRecordForTest?: (tx: Tx, studentId: string) => Promise<void>;
  afterRecordForTest?: (tx: Tx, studentId: string) => Promise<void>;
}

export type GenerationClass = "INELIGIBLE" | "COVERED" | "UNPRICED" | "PENDING";

const CLASS_COLUMN: Record<GenerationClass, Prisma.Sql> = {
  INELIGIBLE: Prisma.raw(`"passIneligible"`),
  COVERED: Prisma.raw(`"passCovered"`),
  UNPRICED: Prisma.raw(`"passUnpriced"`),
  PENDING: Prisma.raw(`"passPending"`),
};

/** Plan §3. A failure of any kind is PENDING: eligibility was not shown false, and nothing was created. */
export function classifyOutcome(outcome: Exclude<MonthlyGenerationOutcome, { category: "fenced" }>): GenerationClass {
  switch (outcome.category) {
    case "created":
    case "alreadyCovered":
      return "COVERED";
    case "notEligible":
      return "INELIGIBLE";
    case "configurationGap":
      return "UNPRICED";
    case "failure":
      return "PENDING";
  }
}

export type VisitStage = "gate" | "page" | "marker" | "failureRecord" | "passEnd";

export interface SegmentVisitReport {
  segmentId: string;
  organizationId: string;
  year: number;
  month: number;
  refused?: "organizationNotActive" | "ledgerNotActive" | "beforeStart";
  created: number;
  classes: Record<GenerationClass, number>;
  /** Reason codes of UNPRICED and PENDING students (codes only, plan §10). */
  reasons: Record<string, number>;
  /** `safeErrorCode` values of students whose transaction failed unexpectedly (validated codes or the fixed fallback only). */
  errorCodes: Record<string, number>;
  rollover?: { inserted: number } | { skipped: "configurationTooLarge" } | { skipped: "error"; code: SafeErrorCode };
  passFinished?: { ineligible: number; covered: number; unpriced: number; pending: number; clean: boolean };
  /** The stage whose recoverable database failure ended this visit; the committed cursor and counts are untouched. */
  error?: { stage: VisitStage; code: SafeErrorCode };
  ended: "slice" | "deadline" | "passEnd" | "fenced" | "refused" | "error";
}

export interface MonthlyGenerationRunReport {
  visits: SegmentVisitReport[];
  claimErrors: number;
  discoveryError?: SafeErrorCode;
  stoppedBy: "deadline" | "noClaimableSegment" | "discoveryFailed";
}

interface Claim {
  id: string;
  organizationId: string;
  year: number;
  month: number;
  cursorStudentId: string | null;
  token: string;
}

const NOW_UTC = Prisma.sql`(now() AT TIME ZONE 'UTC')`;

/** Worst-case wall time of one transaction, as measured on this stack (see the module comment). */
function budgetOf(limits: GenerationLimits) {
  const short = limits.shortMaxWaitMs + limits.shortTimeoutMs + limits.statementTimeoutMs;
  const student = limits.studentMaxWaitMs + limits.studentTimeoutMs + limits.statementTimeoutMs;
  // A student: its transaction, then (if it threw) one failure record.
  const studentUnit = student + short;
  return {
    short,
    studentUnit,
    // claim, gate, rollover, page read, marker, one student, release
    visitEntry: short * 5 + studentUnit + short,
  };
}

/**
 * One invocation. THE DEADLINE GUARANTEE: no unit starts unless `elapsed + its worst case + the worst case of everything the
 * visit may still need afterwards (at least the lease release) < deadlineMs`, where every database operation is one bounded
 * transaction of worst case `maxWait + timeout + statement_timeout`. So, provided that (a) the database server enforces
 * `statement_timeout` and answers (no network stall, which nothing here bounds — the pg client has no socket timeout), (b) the
 * injected `activation.isActive` and `generationStart` return promptly (the production defaults do no I/O; stage 9's must bound
 * themselves), (c) the process is not starved of CPU, and (d) `statement_timeout` does not exceed either transaction timeout
 * (checked below), the invocation returns by `deadlineMs` plus JavaScript overhead. Test hooks are outside the guarantee.
 */
export async function runMonthlyGeneration(deps: MonthlyGenerationRunDeps): Promise<MonthlyGenerationRunReport> {
  const limits: GenerationLimits = { ...DEFAULT_GENERATION_LIMITS, ...deps.limits };
  if (limits.statementTimeoutMs > limits.shortTimeoutMs || limits.statementTimeoutMs > limits.studentTimeoutMs || limits.lockTimeoutMs > limits.statementTimeoutMs) {
    throw new RangeError("generation limits: lock_timeout <= statement_timeout <= each transaction timeout is required for the deadline bound");
  }
  const budget = budgetOf(limits);
  const started = performance.now();
  const elapsed = deps.elapsedMs ?? (() => performance.now() - started);
  const fits = (unitMs: number) => elapsed() + unitMs < limits.deadlineMs;

  const visits: SegmentVisitReport[] = [];
  // A segment whose pass ended, or that was refused, lost or failed, is not claimed again in this invocation: re-walking a
  // finished pass or retrying a failing segment in the same run would spend the budget on it. A segment left mid-pass (slice,
  // deadline) may be claimed again once least-recently-visited order reaches it.
  const settled = new Set<string>();
  let claimErrors = 0;
  while (fits(budget.short + budget.visitEntry)) {
    let found: { id: string; organizationId: string }[];
    try {
      found = await listClaimableGenerationSegments(limits.discoveryLimit, shortBounds(limits));
    } catch (error) {
      return { visits, claimErrors, discoveryError: safeErrorCode(error), stoppedBy: "discoveryFailed" };
    }
    const candidates = found.filter((c) => !settled.has(c.id));
    if (candidates.length === 0) return { visits, claimErrors, stoppedBy: "noClaimableSegment" };
    let claimedAny = false;
    for (const candidate of candidates) {
      if (!fits(budget.visitEntry)) return { visits, claimErrors, stoppedBy: "deadline" };
      let claim: Claim | null;
      try {
        claim = await claimSegment(candidate, limits);
      } catch {
        claimErrors++; // a lock timeout on a row held by another run, or a database error: skip it, never wait
        continue;
      }
      if (!claim) continue;
      claimedAny = true;
      await deps.boundaryForTest?.("afterClaim", { segmentId: claim.id });
      const visit = await visitSegment(claim, deps, limits, fits);
      visits.push(visit);
      if (visit.ended !== "slice" && visit.ended !== "deadline") settled.add(claim.id);
    }
    if (!claimedAny) return { visits, claimErrors, stoppedBy: "noClaimableSegment" };
  }
  return { visits, claimErrors, stoppedBy: "deadline" };
}

function shortBounds(limits: GenerationLimits): GenerationBounds {
  return { statementTimeoutMs: limits.statementTimeoutMs, lockTimeoutMs: limits.lockTimeoutMs, maxWaitMs: limits.shortMaxWaitMs, timeoutMs: limits.shortTimeoutMs };
}
function studentBounds(limits: GenerationLimits): GenerationBounds {
  return { statementTimeoutMs: limits.statementTimeoutMs, lockTimeoutMs: limits.lockTimeoutMs, maxWaitMs: limits.studentMaxWaitMs, timeoutMs: limits.studentTimeoutMs };
}

/** One short transaction with the statement and lock timeouts set, waiting at most `shortMaxWaitMs` for a connection. */
function bounded<T>(limits: GenerationLimits, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = ${Math.trunc(limits.statementTimeoutMs)}`);
      await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = ${Math.trunc(limits.lockTimeoutMs)}`);
      return fn(tx);
    },
    { maxWait: limits.shortMaxWaitMs, timeout: limits.shortTimeoutMs },
  );
}

type Attempt<T> = { ok: true; value: T } | { ok: false; code: SafeErrorCode };
/** A database step whose failure is recoverable at the segment boundary. Never wraps a test hook. */
async function attempt<T>(fn: () => Promise<T>): Promise<Attempt<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (error) {
    return { ok: false, code: safeErrorCode(error) };
  }
}

/** The claim (plan §6.3): the database clock decides whether the lease is free; a fresh random token fences every later write. */
async function claimSegment(candidate: { id: string; organizationId: string }, limits: GenerationLimits): Promise<Claim | null> {
  const token = randomUUID();
  const rows = await bounded(limits, (tx) =>
    tx.$queryRaw<{ id: string; organizationId: string; year: number; month: number; cursorStudentId: string | null }[]>`
      UPDATE "DuesGenerationProgress"
      SET "leaseToken" = ${token}, "leaseUntil" = ${NOW_UTC} + ${Math.trunc(limits.leaseSeconds)} * interval '1 second', "lastVisitedAt" = ${NOW_UTC}
      WHERE "id" = ${candidate.id} AND "organizationId" = ${candidate.organizationId}
        AND ("leaseUntil" IS NULL OR "leaseUntil" < ${NOW_UTC})
      RETURNING "id", "organizationId", "year", "month", "cursorStudentId"`,
  );
  return rows[0] ? { ...rows[0], token } : null;
}

/** The predicate every write after the claim carries: this run's token and the cursor it last committed. */
function fenced(claim: Claim, cursor: string | null): Prisma.Sql {
  return Prisma.sql`"id" = ${claim.id} AND "organizationId" = ${claim.organizationId} AND "leaseToken" = ${claim.token}
    AND "cursorStudentId" IS NOT DISTINCT FROM ${cursor}::text`;
}

function emptyVisit(claim: Claim): SegmentVisitReport {
  return {
    segmentId: claim.id,
    organizationId: claim.organizationId,
    year: claim.year,
    month: claim.month,
    created: 0,
    classes: { INELIGIBLE: 0, COVERED: 0, UNPRICED: 0, PENDING: 0 },
    reasons: {},
    errorCodes: {},
    ended: "slice",
  };
}

async function visitSegment(claim: Claim, deps: MonthlyGenerationRunDeps, limits: GenerationLimits, fits: (unitMs: number) => boolean): Promise<SegmentVisitReport> {
  const report = emptyVisit(claim);
  const month: YearMonth = { year: claim.year, month: claim.month };
  const budget = budgetOf(limits);
  const hook = deps.boundaryForTest ?? (async () => {});

  const finish = async (ended: SegmentVisitReport["ended"], extra: Partial<SegmentVisitReport> = {}) => {
    Object.assign(report, extra, { ended });
    if (ended !== "fenced") await release(claim, limits); // a fenced visit no longer owns the lease
    return report;
  };
  const fail = (stage: VisitStage, code: SafeErrorCode) => finish("error", { error: { stage, code } });

  // The organization gate (plan §4): a progress row grants nothing. The organization read is one bounded transaction.
  const gate = await attempt(async () => {
    const context = await bounded(limits, (tx) => resolveSystemJobContext(claim.organizationId, GENERATION_JOB_NAME, tx));
    if (!context) return { refused: "organizationNotActive" as const };
    if (!(await (deps.activation ?? inactiveLedgerActivation).isActive(claim.organizationId))) return { refused: "ledgerNotActive" as const };
    const start = await (deps.generationStart ?? (async () => null))(claim.organizationId);
    if (!start || compareYearMonth(month, start) < 0) return { refused: "beforeStart" as const };
    return { context };
  });
  if (!gate.ok) return fail("gate", gate.code);
  if ("refused" in gate.value) return finish("refused", { refused: gate.value.refused });
  const context: SystemJobContext = gate.value.context;

  report.rollover = await rollover(claim, deps, limits);

  let cursor = claim.cursorStudentId;
  let processed = 0;
  let markerWritten = false;
  const tally = (cls: GenerationClass, reason?: string) => {
    report.classes[cls]++;
    if (reason) report.reasons[reason] = (report.reasons[reason] ?? 0) + 1;
  };

  while (true) {
    if (processed >= limits.studentsPerVisit) return finish("slice");
    // A page read, then either a pass end or (a marker and) one student, then the release.
    if (!fits(budget.short + (markerWritten ? 0 : budget.short) + budget.studentUnit + budget.short)) return finish("deadline");
    const pageCursor = cursor;
    const page = await attempt(() =>
      bounded(limits, (tx) =>
        tx.student.findMany({
          where: { organizationId: claim.organizationId, ...(pageCursor ? { id: { gt: pageCursor } } : {}) },
          orderBy: { id: "asc" },
          select: { id: true },
          take: limits.pageSize,
        }),
      ),
    );
    if (!page.ok) return fail("page", page.code);

    if (page.value.length === 0) {
      await hook("beforePassEnd", { segmentId: claim.id });
      const finished = await attempt(() => passEnd(claim, cursor, limits));
      if (!finished.ok) return fail("passEnd", finished.code);
      if (!finished.value) return finish("fenced");
      report.passFinished = finished.value;
      await hook("afterPassEnd", { segmentId: claim.id });
      return finish("passEnd");
    }

    for (const { id: studentId } of page.value) {
      if (processed >= limits.studentsPerVisit) return finish("slice");
      if (!fits((markerWritten ? 0 : budget.short) + budget.studentUnit + budget.short)) return finish("deadline");

      if (!markerWritten) {
        // Plan §6.4: before the visit's first student, count this visit as an attempt at it.
        markerWritten = true;
        const marked = await attempt(() => markInFlight(claim, cursor, studentId, limits));
        if (!marked.ok) return fail("marker", marked.code);
        if (marked.value === null) return finish("fenced");
        await hook("afterMarker", { segmentId: claim.id, studentId });
        if (marked.value > limits.maxAttempts) {
          const skipped = await attempt(() => recordFailure(claim, cursor, studentId, limits, { clearMarker: true }));
          if (!skipped.ok) return fail("failureRecord", skipped.code);
          if (!skipped.value) return finish("fenced");
          tally("PENDING", "repeatedFailure");
          cursor = studentId;
          processed++;
          continue;
        }
      }

      const expected = cursor;
      let recordedInTx = false;
      // Never throws: every failure of the student's transaction (its lookup included) is returned as an outcome.
      const outcome = await generateMonthlyObligationForStudent(context, studentId, month, deps, {
        bounds: studentBounds(limits),
        historyCap: limits.historyCap,
        configurationCap: limits.configurationCap,
        fence: (tx) => fenceRow(tx, claim, expected),
        record: async (tx, decided) => {
          if (decided.category === "fenced") return;
          await advanceInTx(tx, claim, expected, studentId, classifyOutcome(decided));
          recordedInTx = true;
        },
        beforeRecordForTest: deps.beforeRecordForTest ? (tx) => deps.beforeRecordForTest!(tx, studentId) : undefined,
        afterRecordForTest: deps.afterRecordForTest ? (tx) => deps.afterRecordForTest!(tx, studentId) : undefined,
      });

      if (outcome.category === "fenced") return finish("fenced");
      // `unexpected` is the only outcome of a transaction that did not commit, even if `record` ran inside it first.
      const committed = recordedInTx && !(outcome.category === "failure" && outcome.reason === "unexpected");
      if (committed) {
        const cls = classifyOutcome(outcome);
        tally(cls, cls === "UNPRICED" || cls === "PENDING" ? reasonOf(outcome) : undefined);
        if (outcome.category === "created") report.created++;
        cursor = studentId;
        await hook("afterStudentCommit", { segmentId: claim.id, studentId });
      } else {
        if (outcome.category === "failure" && outcome.detail) report.errorCodes[outcome.detail.code] = (report.errorCodes[outcome.detail.code] ?? 0) + 1;
        await hook("afterStudentFailure", { segmentId: claim.id, studentId });
        // The student is never passed without its outcome: if this record fails, the visit ends with the cursor before it,
        // and the next visit retries it (the marker counts that visit).
        const recorded = await attempt(() => recordFailure(claim, expected, studentId, limits, { clearMarker: false }));
        if (!recorded.ok) return fail("failureRecord", recorded.code);
        if (!recorded.value) return finish("fenced");
        tally("PENDING", reasonOf(outcome));
        cursor = studentId;
        await hook("afterFailureRecord", { segmentId: claim.id, studentId });
      }
      processed++;
    }
  }
}

function reasonOf(outcome: MonthlyGenerationOutcome): string {
  return "reason" in outcome ? outcome.reason : outcome.category;
}

/** Step 1 of plan §6.2: lock the progress row first, verifying token, expiry and the expected cursor. */
async function fenceRow(tx: Tx, claim: Claim, cursor: string | null): Promise<void> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "DuesGenerationProgress"
    WHERE ${fenced(claim, cursor)} AND "leaseUntil" > ${NOW_UTC}
    FOR UPDATE`;
  if (rows.length !== 1) throw new FenceLostError();
}

/** Step 4 of plan §6.2: the cursor moves by exactly this student, with its count, inside the student's own transaction. */
async function advanceInTx(tx: Tx, claim: Claim, cursor: string | null, studentId: string, cls: GenerationClass): Promise<void> {
  const column = CLASS_COLUMN[cls];
  const count = await tx.$executeRaw`
    UPDATE "DuesGenerationProgress"
    SET "cursorStudentId" = ${studentId}, ${column} = ${column} + 1, "passStartedAt" = COALESCE("passStartedAt", ${NOW_UTC})
    WHERE ${fenced(claim, cursor)}`;
  if (count !== 1) throw new FenceLostError(); // rolls back the obligation, coverage and audit rows with it
}

/** A student whose transaction did not commit: recorded PENDING by one compare-and-set, contiguously. False on fence loss. */
async function recordFailure(claim: Claim, cursor: string | null, studentId: string, limits: GenerationLimits, options: { clearMarker: boolean }): Promise<boolean> {
  const marker = options.clearMarker ? Prisma.sql`, "inFlightStudentId" = NULL, "inFlightAttempts" = 0` : Prisma.empty;
  const count = await bounded(
    limits,
    (tx) => tx.$executeRaw`
      UPDATE "DuesGenerationProgress"
      SET "cursorStudentId" = ${studentId}, "passPending" = "passPending" + 1, "passStartedAt" = COALESCE("passStartedAt", ${NOW_UTC}) ${marker}
      WHERE ${fenced(claim, cursor)}`,
  );
  return count === 1;
}

/** Plan §6.4: one more attempt at `studentId` if the last visit also started there, otherwise the first. Null on fence loss. */
async function markInFlight(claim: Claim, cursor: string | null, studentId: string, limits: GenerationLimits): Promise<number | null> {
  const rows = await bounded(
    limits,
    (tx) => tx.$queryRaw<{ inFlightAttempts: number }[]>`
      UPDATE "DuesGenerationProgress"
      SET "inFlightAttempts" = CASE WHEN "inFlightStudentId" = ${studentId} THEN "inFlightAttempts" + 1 ELSE 1 END,
          "inFlightStudentId" = ${studentId}
      WHERE ${fenced(claim, cursor)}
      RETURNING "inFlightAttempts"`,
  );
  return rows[0]?.inFlightAttempts ?? null;
}

/** Plan §6.2, pass end: keep the pass's counts as the last finished pass and start a new one. Applies once (compare-and-set). */
async function passEnd(claim: Claim, cursor: string | null, limits: GenerationLimits): Promise<SegmentVisitReport["passFinished"] | null> {
  const rows = await bounded(
    limits,
    (tx) => tx.$queryRaw<{ lastPassIneligible: number; lastPassCovered: number; lastPassUnpriced: number; lastPassPending: number; lastPassClean: boolean }[]>`
      UPDATE "DuesGenerationProgress"
      SET "lastPassCompletedAt" = ${NOW_UTC},
          "lastPassIneligible" = "passIneligible", "lastPassCovered" = "passCovered",
          "lastPassUnpriced" = "passUnpriced", "lastPassPending" = "passPending",
          "lastPassClean" = ("passUnpriced" = 0 AND "passPending" = 0),
          "cursorStudentId" = NULL, "passStartedAt" = NULL,
          "passIneligible" = 0, "passCovered" = 0, "passUnpriced" = 0, "passPending" = 0,
          "inFlightStudentId" = NULL, "inFlightAttempts" = 0
      WHERE ${fenced(claim, cursor)}
      RETURNING "lastPassIneligible", "lastPassCovered", "lastPassUnpriced", "lastPassPending", "lastPassClean"`,
  );
  const row = rows[0];
  if (!row) return null;
  return { ineligible: row.lastPassIneligible, covered: row.lastPassCovered, unpriced: row.lastPassUnpriced, pending: row.lastPassPending, clean: row.lastPassClean };
}

/** Ends this run's lease early so the segment is claimable again; a failure here only delays the next claim until expiry. */
async function release(claim: Claim, limits: GenerationLimits): Promise<void> {
  try {
    await bounded(
      limits,
      (tx) => tx.$executeRaw`
        UPDATE "DuesGenerationProgress" SET "leaseUntil" = ${NOW_UTC}
        WHERE "id" = ${claim.id} AND "organizationId" = ${claim.organizationId} AND "leaseToken" = ${claim.token}`,
    );
  } catch {
    // expiry covers it
  }
}

/**
 * Plan §5, rollover: when the claimed row is the organization's newest, insert the missing months up to `current_min` — the
 * earliest branch-local current month, so a month exists only once every branch has reached it — at most `rolloverRows` per
 * visit. Idempotent (`ON CONFLICT DO NOTHING`), and never modifies an existing row. A branch-list overflow skips it; a database
 * failure skips it with its safe code (the claimed row is still processed).
 */
async function rollover(claim: Claim, deps: MonthlyGenerationRunDeps, limits: GenerationLimits): Promise<SegmentVisitReport["rollover"]> {
  try {
    return await bounded(limits, async (tx) => {
      const later = await tx.duesGenerationProgress.findFirst({
        where: { organizationId: claim.organizationId, OR: [{ year: { gt: claim.year } }, { year: claim.year, month: { gt: claim.month } }] },
        select: { id: true },
      });
      if (later) return { inserted: 0 };
      const branches = await tx.academy.findMany({ where: { organizationId: claim.organizationId }, select: { timezone: true }, take: limits.branchCap + 1 });
      if (branches.length > limits.branchCap) return { skipped: "configurationTooLarge" as const };
      if (branches.length === 0) return { inserted: 0 };
      const now = (deps.now ?? (() => new Date()))();
      const currentMin = branches.map((b) => currentMonthIn(b.timezone, now)).reduce((min, m) => (compareYearMonth(m, min) < 0 ? m : min));
      const months: YearMonth[] = [];
      let next = nextMonth({ year: claim.year, month: claim.month });
      while (months.length < limits.rolloverRows && compareYearMonth(next, currentMin) <= 0) {
        months.push(next);
        next = nextMonth(next);
      }
      if (months.length === 0) return { inserted: 0 };
      const inserted = await tx.duesGenerationProgress.createMany({
        data: months.map((m) => ({ organizationId: claim.organizationId, year: m.year, month: m.month, lastVisitedAt: new Date(0) })),
        skipDuplicates: true,
      });
      return { inserted: inserted.count };
    });
  } catch (error) {
    return { skipped: "error", code: safeErrorCode(error) };
  }
}

function nextMonth(m: YearMonth): YearMonth {
  return m.month === 12 ? { year: m.year + 1, month: 1 } : { year: m.year, month: m.month + 1 };
}
