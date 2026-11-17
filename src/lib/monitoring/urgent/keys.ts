import { atRiskKey, type AtRiskEvidence, type GenerationAlertReport } from "@/lib/dues/monthly-generation-alerts";
import type { UrgentFindingsV1 } from "@/lib/dues/urgent-findings";
import { SLOT_DEADLINE_MS, type StreakOp } from "@/lib/monitoring/urgent/slots";

/**
 * Urgent monitor keys and the one pure rule that turns observations into key rows (implementation plan PR-B, including the
 * binding PR-A review decisions). No clock, no database: `dbNow` is passed in.
 *
 * One key per problem:
 * - `A:<org>:<yyyy-mm>` (new month not observed fully billed at T_open + 15 h), `C:<org>:noProgress` / `C:<org>:noActivation`;
 * - `RUNERR:<org>` / `RUNERR:global` (a billing run's run-level errors), `RUNDET` (a billing run's own detection failed);
 * - `SLOT:<first missed slot>` (one open streak at a time);
 * - `FAULT:schedule` (billing schedule missing or unsupported), `FAULT:findings` (a finalized billing run without findings).
 *
 * Bounds (`onsetNotBefore`, `evidenceAt`) are evidence bounds, never "the onset": the problem began no earlier than
 * `onsetNotBefore` (null: unknown) and is proven present by `evidenceAt`. A later observation only moves each bound EARLIER
 * (PR-A review); the alert age is `firstSeenAt`, set once. Nothing here ever postpones an alert or resets its age.
 */
export type Category = "A" | "C" | "SLOT" | "RUNERR" | "RUNDET" | "FAULT";
export type Source = "monitorRead" | "billingRun" | "slot" | "monitor";

export interface ObservedKey {
  key: string;
  category: Category;
  source: Source;
  onsetNotBefore: Date | null;
  evidenceAt: Date | null;
}

/** Mirrors the `UrgentAlertKey` table. */
export interface KeyRow extends ObservedKey {
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

const aKey = (m: { organizationId: string; year: number; month: number }) => `A:${atRiskKey(m)}`;
const parse = (iso: string | null | undefined) => (iso ? new Date(iso) : null);

/** A and C from a successful monitor read. C's onset is unknown; the read proves it. */
export function keysFromRead(report: GenerationAlertReport, atRisk: Record<string, AtRiskEvidence>, readAt: Date): ObservedKey[] {
  const keys: ObservedKey[] = report.newMonthAtRisk.map((m) => {
    const e = atRisk[atRiskKey(m)];
    return { key: aKey(m), category: "A", source: "monitorRead", onsetNotBefore: parse(e?.onsetNotBefore), evidenceAt: parse(e?.evidenceAt) ?? readAt };
  });
  for (const org of report.conditionC?.activatedWithoutProgress ?? []) keys.push({ key: `C:${org}:noProgress`, category: "C", source: "monitorRead", onsetNotBefore: null, evidenceAt: readAt });
  for (const org of report.conditionC?.progressWithoutActivation ?? []) keys.push({ key: `C:${org}:noActivation`, category: "C", source: "monitorRead", onsetNotBefore: null, evidenceAt: readAt });
  return keys;
}

export interface FinalizedRun {
  id: string;
  startedAt: Date;
  finishedAt: Date;
  /** The stored column: findings, the unavailable marker, or NULL. */
  urgentFindings: unknown;
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
  /** Finalized monthly-generation runs after the findings cursor (and at or after `watchingSince`), oldest first. */
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
  /** Keys to delete: cleared and already repeat-accepted. */
  deletes: string[];
  /** Every row that remains after the writes, for planning this run's alert. */
  rows: KeyRow[];
}

const earlier = (a: Date | null, b: Date | null) => (a === null ? b : b === null ? a : a.getTime() <= b.getTime() ? a : b);

/**
 * Applies one monitor run's observations to the existing rows. Order: billing runs (oldest first), then slots, then the schedule
 * fault, then the monitor read (the newest evidence). Rules:
 * - observe: insert at first sight (`firstSeenAt = dbNow`); on a later sight, reopen a cleared row, refresh `lastSeenAt` and move
 *   the bounds only earlier. `firstSeenAt` never changes.
 * - A and C are cleared ONLY by a successful monitor read in which they are absent; billing findings never clear them.
 * - RUNERR:<org> is cleared by a later valid, non-thrown, untruncated run without it; RUNERR:global by a later valid run with no
 *   global error; RUNDET by a later run whose detection was ok.
 * - FAULT:findings is raised by a finalized run with no valid findings (marker or NULL) and cleared by a later valid one.
 * - FAULT:schedule is raised while the schedule is missing or unsupported and cleared when it is supported again.
 */
export function reconcile(existing: KeyRow[], obs: Observation): Reconciled {
  const rows = new Map(existing.map((r) => [r.key, { ...r }]));
  const touched = new Set<string>();
  const now = obs.dbNow;

  const observe = (o: ObservedKey) => {
    const row = rows.get(o.key);
    if (row) {
      row.lastSeenAt = now;
      row.clearedAt = null;
      row.onsetNotBefore = earlier(row.onsetNotBefore, o.onsetNotBefore);
      row.evidenceAt = earlier(row.evidenceAt, o.evidenceAt);
    } else {
      rows.set(o.key, {
        ...o,
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
    }
    touched.add(o.key);
  };
  const clear = (key: string) => {
    const row = rows.get(key);
    if (row && row.clearedAt === null) {
      row.clearedAt = now;
      touched.add(key);
    }
  };
  const openKeys = (prefix: string) => [...rows.values()].filter((r) => r.clearedAt === null && r.key.startsWith(prefix)).map((r) => r.key);

  for (const run of obs.runs) {
    const f = validFindings(run.urgentFindings);
    const bounds = { onsetNotBefore: run.startedAt, evidenceAt: run.finishedAt };
    if (!f) {
      observe({ key: FAULT_FINDINGS, category: "FAULT", source: "billingRun", ...bounds });
      continue;
    }
    clear(FAULT_FINDINGS);
    for (const m of f.newMonthAtRisk) {
      observe({ key: aKey(m), category: "A", source: "billingRun", onsetNotBefore: parse(m.onsetNotBefore), evidenceAt: parse(m.evidenceAt) ?? run.startedAt });
    }
    for (const org of f.conditionC?.activatedWithoutProgress ?? []) observe({ key: `C:${org}:noProgress`, category: "C", source: "billingRun", onsetNotBefore: null, evidenceAt: run.startedAt });
    for (const org of f.conditionC?.progressWithoutActivation ?? []) observe({ key: `C:${org}:noActivation`, category: "C", source: "billingRun", onsetNotBefore: null, evidenceAt: run.startedAt });
    if (f.detection === "ok") clear(RUNDET_KEY);
    else if (f.detection !== "notEvaluated") observe({ key: RUNDET_KEY, category: "RUNDET", source: "billingRun", ...bounds });
    if (f.runErrors.global > 0) observe({ key: RUNERR_GLOBAL, category: "RUNERR", source: "billingRun", ...bounds });
    else clear(RUNERR_GLOBAL);
    const erroring = new Set(f.runErrors.organizations.map((org) => `RUNERR:${org}`));
    for (const key of erroring) observe({ key, category: "RUNERR", source: "billingRun", ...bounds });
    if (!f.thrown && !f.truncated) {
      for (const key of openKeys("RUNERR:")) if (key !== RUNERR_GLOBAL && !erroring.has(key)) clear(key);
    }
  }

  for (const op of obs.slotOps ?? []) {
    if (op.op === "clear") {
      clear(op.key);
    } else {
      const due = new Date(op.slot.getTime() + SLOT_DEADLINE_MS);
      if (op.op === "insert") {
        observe({ key: op.key, category: "SLOT", source: "slot", onsetNotBefore: due, evidenceAt: due });
        rows.get(op.key)!.lastMissedSlot = op.slot;
      } else {
        const row = rows.get(op.key);
        if (row) {
          row.missedCount += 1;
          row.lastMissedSlot = op.slot;
          row.lastSeenAt = now;
          touched.add(op.key);
        }
      }
    }
  }

  if (obs.scheduleFault) observe({ key: FAULT_SCHEDULE, category: "FAULT", source: "monitor", onsetNotBefore: null, evidenceAt: now });
  else clear(FAULT_SCHEDULE);

  const seen = new Set(obs.read.map((k) => k.key));
  for (const k of obs.read) observe(k);
  for (const row of [...rows.values()]) {
    if ((row.category === "A" || row.category === "C") && row.clearedAt === null && !seen.has(row.key)) clear(row.key);
  }

  const deletes = [...rows.values()].filter((r) => r.clearedAt !== null && r.repeatAcceptedAt !== null).map((r) => r.key);
  for (const key of deletes) rows.delete(key);
  return {
    upserts: [...touched].filter((k) => rows.has(k)).map((k) => rows.get(k)!),
    deletes,
    rows: [...rows.values()],
  };
}
