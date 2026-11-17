import { atRiskKey, type AtRiskEvidence, type GenerationAlertReport } from "@/lib/dues/monthly-generation-alerts";
import type { UrgentFindingsV1 } from "@/lib/dues/urgent-findings";
import { SLOT_DEADLINE_MS, type StreakOp } from "@/lib/monitoring/urgent/slots";

/**
 * Urgent monitor problems and the one pure rule that turns observations into rows (implementation plan PR-B, including the
 * binding PR-A review decisions and the PR-B review fixes). No clock, no database: `dbNow` is passed in.
 *
 * A PROBLEM is identified by its problem key:
 * - `A:<org>:<yyyy-mm>` (new month not observed fully billed at T_open + 15 h), `C:<org>:noProgress` / `C:<org>:noActivation`;
 * - `RUNERR:<org>` / `RUNERR:global` (a billing run's run-level errors), `RUNDET` (a billing run's own detection failed);
 * - `SLOT:<first missed slot>` (one open streak at a time);
 * - `FAULT:schedule` (billing schedule missing or unsupported), `FAULT:findings` (a finalized billing run without findings).
 *
 * Each time a problem starts, it gets a new OCCURRENCE (row key `<problem key>#<n>`), with its own first alert and its own one
 * repeat (review fix B1). At most one occurrence of a problem is open at a time. A problem that clears and comes back is a new
 * occurrence with a fresh alert, while the earlier occurrence keeps its pending alert or repeat until they are accepted; only
 * then is it deleted.
 *
 * Bounds (`onsetNotBefore`, `evidenceAt`) are evidence bounds, never "the onset", and only ever move EARLIER within an
 * occurrence; `firstSeenAt` is the occurrence's age and never changes. Nothing here postpones an alert or resets an age.
 */
export type Category = "A" | "C" | "SLOT" | "RUNERR" | "RUNDET" | "FAULT";
export type Source = "monitorRead" | "billingRun" | "slot" | "monitor";

export interface ObservedKey {
  problemKey: string;
  category: Category;
  source: Source;
  onsetNotBefore: Date | null;
  evidenceAt: Date | null;
}

/** Mirrors the `UrgentAlertKey` table: one row per occurrence. */
export interface KeyRow extends ObservedKey {
  /** `<problemKey>#<occurrence>` */
  key: string;
  occurrence: number;
  firstSeenAt: Date;
  lastSeenAt: Date;
  clearedAt: Date | null;
  firstAcceptedAt: Date | null;
  repeatAcceptedAt: Date | null;
  lastMissedSlot: Date | null;
  missedCount: number;
  lastAttemptAt: Date | null;
  lastErrorCode: string | null;
}

export const FAULT_SCHEDULE = "FAULT:schedule";
export const FAULT_FINDINGS = "FAULT:findings";
export const RUNDET_KEY = "RUNDET";
export const RUNERR_GLOBAL = "RUNERR:global";
export const occurrenceKey = (problemKey: string, occurrence: number) => `${problemKey}#${occurrence}`;

const aKey = (m: { organizationId: string; year: number; month: number }) => `A:${atRiskKey(m)}`;
const parse = (iso: string | null | undefined) => (iso ? new Date(iso) : null);

/** A and C from a successful monitor read. C's onset is unknown; the read proves it. */
export function keysFromRead(report: GenerationAlertReport, atRisk: Record<string, AtRiskEvidence>, readAt: Date): ObservedKey[] {
  const keys: ObservedKey[] = report.newMonthAtRisk.map((m) => {
    const e = atRisk[atRiskKey(m)];
    return { problemKey: aKey(m), category: "A", source: "monitorRead", onsetNotBefore: parse(e?.onsetNotBefore), evidenceAt: parse(e?.evidenceAt) ?? readAt };
  });
  for (const org of report.conditionC?.activatedWithoutProgress ?? []) keys.push({ problemKey: `C:${org}:noProgress`, category: "C", source: "monitorRead", onsetNotBefore: null, evidenceAt: readAt });
  for (const org of report.conditionC?.progressWithoutActivation ?? []) keys.push({ problemKey: `C:${org}:noActivation`, category: "C", source: "monitorRead", onsetNotBefore: null, evidenceAt: readAt });
  return keys;
}

export interface FinalizedRun {
  id: string;
  startedAt: Date;
  finishedAt: Date;
  /** The stored column: findings, the unavailable marker, or NULL. */
  urgentFindings: unknown;
  /**
   * True when the run finished BEFORE a run the monitor already processed (it committed late). Its findings are reported as
   * evidence, but it never clears anything: a newer run already decided what is current.
   */
  late?: boolean;
}

/** Valid findings, or null when the column holds the unavailable marker, NULL, or anything that is not v1 findings. */
export function validFindings(value: unknown): UrgentFindingsV1 | null {
  if (typeof value !== "object" || value === null) return null;
  const f = value as Partial<UrgentFindingsV1> & { unavailable?: unknown };
  if (f.v !== 1 || "unavailable" in f || typeof f.detection !== "string" || !Array.isArray(f.newMonthAtRisk) || typeof f.runErrors !== "object" || f.runErrors === null) return null;
  return f as UrgentFindingsV1;
}

export interface Observation {
  dbNow: Date;
  /** Unprocessed finalized monthly-generation runs (at or after `watchingSince`), oldest finish first. */
  runs: FinalizedRun[];
  /** Slot streak operations, or null when slot judging is paused (schedule fault). */
  slotOps: StreakOp[] | null;
  scheduleFault: "missing" | "unsupported" | null;
  /** A and C from this run's successful monitor read. */
  read: ObservedKey[];
}

export interface Reconciled {
  /** The final value of every row this observation touched. */
  upserts: KeyRow[];
  /** Occurrence keys to delete: cleared and already repeat-accepted. */
  deletes: string[];
  /** Every row that remains after the writes, for planning this run's alert. */
  rows: KeyRow[];
}

const earlier = (a: Date | null, b: Date | null) => (a === null ? b : b === null ? a : a.getTime() <= b.getTime() ? a : b);

/** The open occurrence of a problem, if any (at most one). */
export const openOccurrence = (rows: Iterable<KeyRow>, problemKey: string) => [...rows].find((r) => r.problemKey === problemKey && r.clearedAt === null);

/**
 * Applies one monitor run's observations to the existing rows. Order: billing runs (oldest finish first), then slots, then the
 * schedule fault, then the monitor read (the newest evidence). Rules:
 * - observe: refresh the problem's OPEN occurrence (`lastSeenAt`, bounds only earlier); with none open, start a NEW occurrence
 *   (`firstSeenAt = dbNow`, a fresh alert). A cleared occurrence is never reopened.
 * - observeLate (a late-committing run): refresh the open occurrence if any; else move the bounds of the latest occurrence
 *   earlier (its evidence was older than the clear); only with no occurrence at all does it start one (unreported evidence).
 * - A and C are cleared ONLY by a successful monitor read in which they are absent; billing findings never clear them.
 * - RUNERR:<org> is cleared by a later valid, non-thrown, untruncated, on-time run without it; RUNERR:global by a later valid
 *   on-time run with no global error; RUNDET by a later on-time run whose detection was ok.
 * - FAULT:findings is raised by a finalized run with no valid findings (marker or NULL), late or not, and cleared by a later
 *   valid on-time run.
 * - FAULT:schedule is raised while the schedule is missing or unsupported and cleared when it is supported again.
 */
export function reconcile(existing: KeyRow[], obs: Observation): Reconciled {
  const rows = new Map(existing.map((r) => [r.key, { ...r }]));
  const touched = new Set<string>();
  const now = obs.dbNow;

  const start = (o: ObservedKey) => {
    const occurrence = Math.max(0, ...[...rows.values()].filter((r) => r.problemKey === o.problemKey).map((r) => r.occurrence)) + 1;
    const key = occurrenceKey(o.problemKey, occurrence);
    rows.set(key, {
      ...o,
      key,
      occurrence,
      firstSeenAt: now,
      lastSeenAt: now,
      clearedAt: null,
      firstAcceptedAt: null,
      repeatAcceptedAt: null,
      lastMissedSlot: null,
      missedCount: 1,
      lastAttemptAt: null,
      lastErrorCode: null,
    });
    touched.add(key);
    return rows.get(key)!;
  };
  const refresh = (row: KeyRow, o: ObservedKey) => {
    row.lastSeenAt = now;
    row.onsetNotBefore = earlier(row.onsetNotBefore, o.onsetNotBefore);
    row.evidenceAt = earlier(row.evidenceAt, o.evidenceAt);
    touched.add(row.key);
    return row;
  };
  const observe = (o: ObservedKey) => {
    const open = openOccurrence(rows.values(), o.problemKey);
    return open ? refresh(open, o) : start(o);
  };
  const observeLate = (o: ObservedKey) => {
    const open = openOccurrence(rows.values(), o.problemKey);
    if (open) return refresh(open, o);
    const latest = [...rows.values()].filter((r) => r.problemKey === o.problemKey).sort((a, b) => b.occurrence - a.occurrence)[0];
    if (latest) {
      latest.onsetNotBefore = earlier(latest.onsetNotBefore, o.onsetNotBefore);
      latest.evidenceAt = earlier(latest.evidenceAt, o.evidenceAt);
      touched.add(latest.key);
      return latest;
    }
    return start(o);
  };
  const clear = (problemKey: string) => {
    const open = openOccurrence(rows.values(), problemKey);
    if (open) {
      open.clearedAt = now;
      touched.add(open.key);
    }
  };
  const openProblems = (prefix: string) => [...rows.values()].filter((r) => r.clearedAt === null && r.problemKey.startsWith(prefix)).map((r) => r.problemKey);

  for (const run of obs.runs) {
    const see = run.late ? observeLate : observe;
    const f = validFindings(run.urgentFindings);
    const bounds = { onsetNotBefore: run.startedAt, evidenceAt: run.finishedAt };
    if (!f) {
      see({ problemKey: FAULT_FINDINGS, category: "FAULT", source: "billingRun", ...bounds });
      continue;
    }
    if (!run.late) clear(FAULT_FINDINGS);
    for (const m of f.newMonthAtRisk) {
      see({ problemKey: aKey(m), category: "A", source: "billingRun", onsetNotBefore: parse(m.onsetNotBefore), evidenceAt: parse(m.evidenceAt) ?? run.startedAt });
    }
    for (const org of f.conditionC?.activatedWithoutProgress ?? []) see({ problemKey: `C:${org}:noProgress`, category: "C", source: "billingRun", onsetNotBefore: null, evidenceAt: run.startedAt });
    for (const org of f.conditionC?.progressWithoutActivation ?? []) see({ problemKey: `C:${org}:noActivation`, category: "C", source: "billingRun", onsetNotBefore: null, evidenceAt: run.startedAt });
    if (f.detection === "ok") {
      if (!run.late) clear(RUNDET_KEY);
    } else if (f.detection !== "notEvaluated") see({ problemKey: RUNDET_KEY, category: "RUNDET", source: "billingRun", ...bounds });
    if (f.runErrors.global > 0) see({ problemKey: RUNERR_GLOBAL, category: "RUNERR", source: "billingRun", ...bounds });
    else if (!run.late) clear(RUNERR_GLOBAL);
    const erroring = new Set(f.runErrors.organizations.map((org) => `RUNERR:${org}`));
    for (const problemKey of erroring) see({ problemKey, category: "RUNERR", source: "billingRun", ...bounds });
    if (!run.late && !f.thrown && !f.truncated) {
      for (const problemKey of openProblems("RUNERR:")) if (problemKey !== RUNERR_GLOBAL && !erroring.has(problemKey)) clear(problemKey);
    }
  }

  for (const op of obs.slotOps ?? []) {
    if (op.op === "clear") {
      clear(op.key);
    } else {
      const due = new Date(op.slot.getTime() + SLOT_DEADLINE_MS);
      if (op.op === "insert") {
        observe({ problemKey: op.key, category: "SLOT", source: "slot", onsetNotBefore: due, evidenceAt: due }).lastMissedSlot = op.slot;
      } else {
        const open = openOccurrence(rows.values(), op.key);
        if (open) {
          open.missedCount += 1;
          open.lastMissedSlot = op.slot;
          open.lastSeenAt = now;
          touched.add(open.key);
        }
      }
    }
  }

  if (obs.scheduleFault) observe({ problemKey: FAULT_SCHEDULE, category: "FAULT", source: "monitor", onsetNotBefore: null, evidenceAt: now });
  else clear(FAULT_SCHEDULE);

  const seen = new Set(obs.read.map((k) => k.problemKey));
  for (const k of obs.read) observe(k);
  for (const row of [...rows.values()]) {
    if ((row.category === "A" || row.category === "C") && row.clearedAt === null && !seen.has(row.problemKey)) clear(row.problemKey);
  }

  const deletes = [...rows.values()].filter((r) => r.clearedAt !== null && r.repeatAcceptedAt !== null).map((r) => r.key);
  for (const key of deletes) rows.delete(key);
  return {
    upserts: [...touched].filter((k) => rows.has(k)).map((k) => rows.get(k)!),
    deletes,
    rows: [...rows.values()],
  };
}
