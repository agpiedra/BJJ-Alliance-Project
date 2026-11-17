import type { KeyRow } from "@/lib/monitoring/urgent/keys";
import type { SummaryInput } from "@/lib/monitoring/urgent/summary";

/**
 * Which M2 request sequence this run sends, and which problems it counts (design §6.4, §7). Pure.
 * - new: never accepted yet. repeat: first accepted in an EARLIER run, not yet repeat-accepted (exactly one repeat each).
 * - reminder: when 60 min or more have passed since the last accepted `/fail`. Every due `/fail` carries the counts of ALL
 *   unresolved problems, so any accepted `/fail` also counts as the reminder.
 * - sequences: `success` (nothing unresolved), `failRefresh` (unresolved, nothing due: refreshes the body, M2 already Down, no
 *   transition), `fail` (due content and M2 last confirmed Up), `rearmFail` (due content otherwise: success first, then `/fail`,
 *   so there is a fresh Down transition and a fresh email).
 */
export const REMINDER_INTERVAL_MS = 60 * 60 * 1000;

export type M2Sequence = "success" | "failRefresh" | "fail" | "rearmFail";
export type M2Signal = "success" | "fail" | "unknown";

export interface M2Plan {
  sequence: M2Sequence;
  newKeys: string[];
  repeatKeys: string[];
  /** True when this `/fail` is due content (new, repeat or reminder): its acceptance resets the reminder clock. */
  due: boolean;
  summary: Omit<SummaryInput, "runRef">;
}

const RUN_CATEGORIES = new Set(["RUNERR", "RUNDET"]);

export function planM2(p: { rows: KeyRow[]; m2LastSignal: M2Signal; lastReminderAt: Date | null; dbNow: Date }): M2Plan {
  const newRows = p.rows.filter((r) => r.firstAcceptedAt === null);
  const repeatRows = p.rows.filter((r) => r.firstAcceptedAt !== null && r.repeatAcceptedAt === null);
  const unresolved = p.rows.filter((r) => r.clearedAt === null);
  const reminderDue = unresolved.length > 0 && (p.lastReminderAt === null || p.dbNow.getTime() - p.lastReminderAt.getTime() >= REMINDER_INTERVAL_MS);
  const due = newRows.length > 0 || repeatRows.length > 0 || reminderDue;

  const included = new Map<string, KeyRow>();
  for (const r of [...newRows, ...repeatRows, ...unresolved]) included.set(r.key, r);
  const listed = new Set([...newRows, ...repeatRows].map((r) => r.key));
  const counts = { A: 0, C: 0, SLOT: 0, RUN: 0, F: 0 };
  let slotStreak = 0;
  let oldest: Date | null = null;
  for (const r of included.values()) {
    if (r.category === "A") counts.A++;
    else if (r.category === "C") counts.C++;
    else if (r.category === "SLOT") {
      counts.SLOT++;
      slotStreak = Math.max(slotStreak, r.missedCount);
    } else if (RUN_CATEGORIES.has(r.category)) counts.RUN++;
    else counts.F++;
    const bound = r.onsetNotBefore ?? r.evidenceAt ?? r.firstSeenAt;
    if (oldest === null || bound.getTime() < oldest.getTime()) oldest = bound;
  }
  const summary = {
    new: newRows.length,
    repeat: repeatRows.length,
    reminder: [...included.keys()].filter((k) => !listed.has(k)).length,
    counts,
    slotStreak,
    oldest,
  };

  let sequence: M2Sequence;
  if (due) sequence = p.m2LastSignal === "success" ? "fail" : "rearmFail";
  else if (unresolved.length > 0) sequence = "failRefresh";
  else sequence = "success";
  return { sequence, newKeys: newRows.map((r) => r.key), repeatKeys: repeatRows.map((r) => r.key), due, summary };
}
