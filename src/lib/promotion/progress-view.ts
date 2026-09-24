import type { PromotionMode } from "@/generated/prisma/client";
import type { NextTarget } from "@/lib/promotion/engine";

/**
 * The ONE display shaping for promotion progress, read by every consumer (staff
 * roster, student page, dashboard, portal, kiosk, analytics). The numbers are
 * the engine's (via AtBeltSummary); this only decides how to SHOW them, so no
 * page rebuilds a target as `count + remaining` - which overflows the moment a
 * student passes the threshold (42 / 30).
 *
 * Eligible always means "eligible for instructor review", never an automatic
 * award: the bar is full, remaining is 0, the displayed count is capped at the
 * target, and the real count is kept separately in `actualCount`.
 */
export type ProgressState =
  | "in_progress"
  | "eligible"
  | "time_pending"
  | "time_anchor_missing"
  | "not_configured"
  | "none"
  | "manual";

export interface ProgressViewInput {
  nextTarget: NextTarget;
  /** The EFFECTIVE mode of the student's rank. */
  mode: PromotionMode;
  isEligible: boolean;
  target: number | null;
  percent: number | null;
  atBeltCount: number;
  remainingAttendance: number | null;
  timeAnchorMissing: boolean;
  notConfigured: boolean;
  dueDate: Date | null;
  reachedOn: string | null;
}

export interface ProgressView {
  state: ProgressState;
  nextTarget: NextTarget;
  /** Displayed count, capped to 0..target. Null when there is no attendance fraction to show. */
  current: number | null;
  target: number | null;
  /** 0..100, or null when there is nothing meaningful to show a bar for. */
  percent: number | null;
  /** Never negative; null only when there is no attendance target. */
  remaining: number | null;
  /** The real count of qualifying days/classes (may exceed the target; shown on its own line). */
  actualCount: number;
  dueDate: Date | null;
  /** Costa Rica ledger day the threshold was reached, recalculated from current records. Set only when eligible. */
  reachedOn: string | null;
}

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const finite = (value: number | null): number | null => (value !== null && Number.isFinite(value) ? value : null);

export function buildProgressView(input: ProgressViewInput): ProgressView {
  const base = {
    nextTarget: input.nextTarget,
    actualCount: input.atBeltCount,
    current: null,
    target: null,
    percent: null,
    remaining: null,
    dueDate: null,
    reachedOn: null,
  } satisfies Omit<ProgressView, "state">;

  if (input.nextTarget === "NONE") return { ...base, state: "none" };
  if (input.mode === "MANUAL") return { ...base, state: "manual" };
  if (input.notConfigured) return { ...base, state: "not_configured" };

  const timeBased = input.mode === "TIME" || input.mode === "HYBRID";
  if (timeBased && input.timeAnchorMissing) return { ...base, state: "time_anchor_missing" };

  if (input.mode === "TIME") {
    return {
      ...base,
      state: input.isEligible ? "eligible" : "time_pending",
      percent: finite(input.percent),
      dueDate: input.dueDate,
      reachedOn: input.isEligible ? input.reachedOn : null,
    };
  }

  const target = finite(input.target);
  if (target === null || target <= 0) return { ...base, state: "none" };

  const count = input.atBeltCount;
  const eligible = input.isEligible;
  const current = eligible ? target : clamp(count, 0, target);
  return {
    ...base,
    state: eligible ? "eligible" : "in_progress",
    current,
    target,
    percent: eligible ? 100 : clamp(finite(input.percent) ?? (current / target) * 100, 0, 100),
    remaining: eligible ? 0 : Math.max(0, finite(input.remainingAttendance) ?? target - count),
    dueDate: input.mode === "HYBRID" ? input.dueDate : null,
    reachedOn: eligible ? input.reachedOn : null,
  };
}
