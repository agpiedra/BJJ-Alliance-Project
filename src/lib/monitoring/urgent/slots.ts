/**
 * Urgent monitor (docs/dues/URGENT-ALERTING-ONE-HOUR-PROPOSAL.md §5; implementation plan PR-B): which billing slots were owed,
 * and which of them were missed. Pure: no clock, no database.
 *
 * The billing schedule is read from `vercel.json` (the entry Vercel runs) by the caller. Only SUPPORTED_BILLING_SCHEDULE is
 * supported: every 3 h at minute 0, UTC (legacy Cron Jobs run in UTC). Anything else is a monitoring fault (`FAULT:schedule`);
 * the monitor then pauses slot judging and preserves its checkpoint, it never guesses another schedule.
 */
export const SUPPORTED_BILLING_SCHEDULE = "0 */3 * * *";
export const SLOT_INTERVAL_MS = 3 * 60 * 60 * 1000;
/** The approved deadline, unchanged: a slot S is kept only by a run that finished by S + 10 min (2 min lateness + 5 min run + 3 min margin). */
export const SLOT_DEADLINE_MS = 10 * 60 * 1000;
/**
 * Clock tolerance at the window START only (PR-B review R1, disclosed for owner approval): a run may record a start up to
 * 2 min before S. `JobRun.startedAt` comes from a different clock than the scheduler's, so a scheduler whose clock leads the
 * database by even 1 ms would otherwise make every slot look missed (false alarms). The deadline above is NOT changed.
 * Windows stay disjoint: [S − 2 min, S + 10 min) never overlaps the next slot's [S + 3 h − 2 min, …), so one run can satisfy
 * at most one slot.
 */
export const SLOT_EARLY_TOLERANCE_MS = 2 * 60 * 1000;
/** At most this many slots are judged per monitor run; the checkpoint carries the rest to the next run (no slot is skipped). */
export const MAX_SLOTS_PER_RUN = 1000;

export type ScheduleCheck = { ok: true } | { ok: false; reason: "missing" | "unsupported" };

export function checkSchedule(expr: string | null | undefined): ScheduleCheck {
  if (expr === null || expr === undefined) return { ok: false, reason: "missing" };
  return expr.trim() === SUPPORTED_BILLING_SCHEDULE ? { ok: true } : { ok: false, reason: "unsupported" };
}

/** The first slot at or after `t`. */
function slotAtOrAfter(t: number): number {
  return Math.ceil(t / SLOT_INTERVAL_MS) * SLOT_INTERVAL_MS;
}

/**
 * Slots owed and judgeable now, oldest first: `S >= watchingSince`, `S > checkedThrough`, and `S + 10 min <= dbNow`
 * (the deadline has passed). At most MAX_SLOTS_PER_RUN.
 */
export function slotsDue(p: { watchingSince: Date; checkedThrough: Date | null; dbNow: Date }): Date[] {
  let s = slotAtOrAfter(p.watchingSince.getTime());
  if (p.checkedThrough !== null) s = Math.max(s, slotAtOrAfter(p.checkedThrough.getTime() + 1));
  const slots: Date[] = [];
  while (s + SLOT_DEADLINE_MS <= p.dbNow.getTime() && slots.length < MAX_SLOTS_PER_RUN) {
    slots.push(new Date(s));
    s += SLOT_INTERVAL_MS;
  }
  return slots;
}

export interface SlotRun {
  startedAt: Date;
  finishedAt: Date | null;
}

/** Kept: some run started in [S − 2 min, S + 10 min) and finished by S + 10 min, whatever its status. Missed otherwise. */
export function judgeSlots(slots: Date[], runs: SlotRun[]): { slot: Date; kept: boolean }[] {
  return slots.map((slot) => {
    const start = slot.getTime() - SLOT_EARLY_TOLERANCE_MS;
    const deadline = slot.getTime() + SLOT_DEADLINE_MS;
    const kept = runs.some((r) => r.startedAt.getTime() >= start && r.startedAt.getTime() < deadline && r.finishedAt !== null && r.finishedAt.getTime() <= deadline);
    return { slot, kept };
  });
}

/** The `JobRun.startedAt` range that can satisfy any of `slots` (for the read). */
export function slotRunWindow(slots: Date[]): { from: Date; to: Date } | null {
  if (slots.length === 0) return null;
  return { from: new Date(slots[0].getTime() - SLOT_EARLY_TOLERANCE_MS), to: new Date(slots[slots.length - 1].getTime() + SLOT_DEADLINE_MS) };
}

export const slotKey = (slot: Date) => `SLOT:${slot.toISOString().slice(0, 16)}Z`;

export type StreakOp =
  | { op: "insert"; key: string; slot: Date }
  | { op: "extend"; key: string; slot: Date }
  | { op: "clear"; key: string };

/**
 * Deduplication: one open SLOT key at a time. A missed slot opens a key (insert) or extends the open one (`missedCount + 1`, no
 * new email); a kept slot clears the open key; the next miss after that starts a new key (a new email).
 */
export function streakOps(openKey: string | null, judged: { slot: Date; kept: boolean }[]): StreakOp[] {
  const ops: StreakOp[] = [];
  let open = openKey;
  for (const { slot, kept } of judged) {
    if (kept) {
      if (open !== null) ops.push({ op: "clear", key: open });
      open = null;
    } else if (open !== null) {
      ops.push({ op: "extend", key: open, slot });
    } else {
      open = slotKey(slot);
      ops.push({ op: "insert", key: open, slot });
    }
  }
  return ops;
}
