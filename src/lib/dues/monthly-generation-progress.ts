import { randomUUID } from "node:crypto";
import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { resolveSystemJobContext } from "@/lib/tenant/context";
import { listClaimableGenerationSegments } from "@/lib/tenant/platform-lookups";
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
 *  - BOUNDS. One deadline for the invocation; a unit starts only if its maximum duration fits. Every statement runs under
 *    `statement_timeout`/`lock_timeout`; every read has a LIMIT; month rows are created at most `rolloverRows` per visit.
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
  statementTimeoutMs: number;
  lockTimeoutMs: number;
  maxWaitMs: number;
  timeoutMs: number;
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
  maxWaitMs: 2_000,
  timeoutMs: 5_000,
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
  /** The organization's start month S. Production default: none, so no segment is ever processed (plan §4). */
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
  rollover?: { inserted: number } | { skipped: "configurationTooLarge" | "error" };
  passFinished?: { ineligible: number; covered: number; unpriced: number; pending: number; clean: boolean };
  ended: "slice" | "deadline" | "passEnd" | "fenced" | "recordFailed" | "refused";
}

export interface MonthlyGenerationRunReport {
  visits: SegmentVisitReport[];
  claimErrors: number;
  stoppedBy: "deadline" | "noClaimableSegment";
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

export async function runMonthlyGeneration(deps: MonthlyGenerationRunDeps): Promise<MonthlyGenerationRunReport> {
  const limits: GenerationLimits = { ...DEFAULT_GENERATION_LIMITS, ...deps.limits };
  const started = performance.now();
  const elapsed = deps.elapsedMs ?? (() => performance.now() - started);
  const fits = (unitMs: number) => elapsed() + unitMs < limits.deadlineMs;
  const s = limits.statementTimeoutMs;
  const studentUnit = limits.maxWaitMs + limits.timeoutMs + s; // the student transaction, then at most one failure record
  // claim + gate (3 reads) + rollover (3 statements) + page + marker + one student
  const minimumVisit = s + 3 * s + 3 * s + s + s + studentUnit;

  const visits: SegmentVisitReport[] = [];
  // A segment whose pass ended, or that was refused or lost, is not claimed again in this invocation: re-walking a finished
  // pass in the same run would spend the budget on work already observed. A segment left mid-pass (slice) may be claimed again
  // once least-recently-visited order reaches it.
  const settled = new Set<string>();
  let claimErrors = 0;
  while (fits(s + minimumVisit)) {
    const candidates = (await listClaimableGenerationSegments(limits.discoveryLimit, s)).filter((c) => !settled.has(c.id));
    if (candidates.length === 0) return { visits, claimErrors, stoppedBy: "noClaimableSegment" };
    let claimedAny = false;
    for (const candidate of candidates) {
      if (!fits(minimumVisit)) return { visits, claimErrors, stoppedBy: "deadline" };
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

/** One short transaction with the statement and lock timeouts set. */
function bounded<T>(limits: GenerationLimits, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = ${Math.trunc(limits.statementTimeoutMs)}`);
      await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = ${Math.trunc(limits.lockTimeoutMs)}`);
      return fn(tx);
    },
    { maxWait: limits.maxWaitMs, timeout: limits.timeoutMs },
  );
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
    ended: "slice",
  };
}

async function visitSegment(claim: Claim, deps: MonthlyGenerationRunDeps, limits: GenerationLimits, fits: (unitMs: number) => boolean): Promise<SegmentVisitReport> {
  const report = emptyVisit(claim);
  const month: YearMonth = { year: claim.year, month: claim.month };
  const s = limits.statementTimeoutMs;
  const studentUnit = limits.maxWaitMs + limits.timeoutMs + s;
  const hook = deps.boundaryForTest ?? (async () => {});

  const refuse = async (reason: NonNullable<SegmentVisitReport["refused"]>) => {
    report.refused = reason;
    report.ended = "refused";
    await release(claim, limits);
    return report;
  };

  // The organization gate (plan §4): a progress row grants nothing.
  const context = await resolveSystemJobContext(claim.organizationId, GENERATION_JOB_NAME);
  if (!context) return refuse("organizationNotActive");
  if (!(await (deps.activation ?? inactiveLedgerActivation).isActive(claim.organizationId))) return refuse("ledgerNotActive");
  const start = await (deps.generationStart ?? (async () => null))(claim.organizationId);
  if (!start || compareYearMonth(month, start) < 0) return refuse("beforeStart");

  report.rollover = await rollover(claim, deps, limits);

  let cursor = claim.cursorStudentId;
  let processed = 0;
  let markerWritten = false;
  const tally = (cls: GenerationClass, reason?: string) => {
    report.classes[cls]++;
    if (reason) report.reasons[reason] = (report.reasons[reason] ?? 0) + 1;
  };

  visit: while (true) {
    if (processed >= limits.studentsPerVisit) {
      report.ended = "slice";
      break;
    }
    if (!fits(s + s + studentUnit)) {
      report.ended = "deadline";
      break;
    }
    const pageCursor = cursor;
    const page = await bounded(limits, (tx) =>
      tx.student.findMany({
        where: { organizationId: claim.organizationId, ...(pageCursor ? { id: { gt: pageCursor } } : {}) },
        orderBy: { id: "asc" },
        select: { id: true },
        take: limits.pageSize,
      }),
    );

    if (page.length === 0) {
      await hook("beforePassEnd", { segmentId: claim.id });
      const finished = await passEnd(claim, cursor, limits);
      if (!finished) {
        report.ended = "fenced";
        break;
      }
      report.passFinished = finished;
      await hook("afterPassEnd", { segmentId: claim.id });
      report.ended = "passEnd";
      break;
    }

    for (const { id: studentId } of page) {
      if (processed >= limits.studentsPerVisit) {
        report.ended = "slice";
        break visit;
      }
      if (!fits(studentUnit + (markerWritten ? 0 : s))) {
        report.ended = "deadline";
        break visit;
      }

      if (!markerWritten) {
        // Plan §6.4: before the visit's first student, count this visit as an attempt at it.
        markerWritten = true;
        const attempts = await markInFlight(claim, cursor, studentId, limits);
        if (attempts === null) {
          report.ended = "fenced";
          break visit;
        }
        await hook("afterMarker", { segmentId: claim.id, studentId });
        if (attempts > limits.maxAttempts) {
          if (!(await recordFailure(claim, cursor, studentId, limits, { clearMarker: true }))) {
            report.ended = "fenced";
            break visit;
          }
          tally("PENDING", "repeatedFailure");
          cursor = studentId;
          processed++;
          continue;
        }
      }

      const expected = cursor;
      let recordedInTx = false;
      const outcome = await generateMonthlyObligationForStudent(context, studentId, month, deps, {
        bounds: boundsOf(limits),
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

      if (outcome.category === "fenced") {
        report.ended = "fenced";
        break visit;
      }
      // `unexpected` is the only outcome of a transaction that did not commit, even if `record` ran inside it first.
      const committed = recordedInTx && !(outcome.category === "failure" && outcome.reason === "unexpected");
      if (committed) {
        const cls = classifyOutcome(outcome);
        tally(cls, cls === "UNPRICED" || cls === "PENDING" ? reasonOf(outcome) : undefined);
        if (outcome.category === "created") report.created++;
        cursor = studentId;
        await hook("afterStudentCommit", { segmentId: claim.id, studentId });
      } else {
        await hook("afterStudentFailure", { segmentId: claim.id, studentId });
        let recorded: boolean;
        try {
          recorded = await recordFailure(claim, expected, studentId, limits, { clearMarker: false });
        } catch {
          report.ended = "recordFailed"; // the next visit retries this student, and the marker counts it (plan §6.4)
          break visit;
        }
        if (!recorded) {
          report.ended = "fenced";
          break visit;
        }
        tally("PENDING", reasonOf(outcome));
        cursor = studentId;
        await hook("afterFailureRecord", { segmentId: claim.id, studentId });
      }
      processed++;
    }
  }

  if (report.ended !== "fenced") await release(claim, limits);
  return report;
}

function reasonOf(outcome: MonthlyGenerationOutcome): string {
  return "reason" in outcome ? outcome.reason : outcome.category;
}

function boundsOf(limits: GenerationLimits): GenerationBounds {
  return { statementTimeoutMs: limits.statementTimeoutMs, lockTimeoutMs: limits.lockTimeoutMs, maxWaitMs: limits.maxWaitMs, timeoutMs: limits.timeoutMs };
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

/** A student whose transaction did not commit: recorded PENDING by one compare-and-set, contiguously. */
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
 * visit. Idempotent (`ON CONFLICT DO NOTHING`), and never modifies an existing row. A branch-list overflow skips it.
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
  } catch {
    return { skipped: "error" };
  }
}

function nextMonth(m: YearMonth): YearMonth {
  return m.month === 12 ? { year: m.year + 1, month: 1 } : { year: m.year, month: m.month + 1 };
}
