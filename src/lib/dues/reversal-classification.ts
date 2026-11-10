import { compareYearMonth, type YearMonth } from "@/lib/dues/calendar";

/**
 * O4 (owner decisions B1–B10, 2026-11-09; docs/dues/O4-PREPAYMENT-REVERSAL-PLAN.md §3): what reversing payment P does to one
 * obligation P settled. Pure — shared by `reversePayment` (decided under its locks) and the owner's preview (advisory only).
 *
 *  - `cancel` (R1): a prepaid obligation whose ONLY settlement ever is P's, for a month AFTER `currentMonth`. By invariant I1
 *    (a PREPAYMENT obligation is settled in the transaction that creates it — database-enforced, migration 20261110120000),
 *    its first settlement is the payment that bought it, so "exactly one settlement ever, and it is P's" means P created it
 *    and nothing else has ever paid it.
 *  - `owedStarted` (R2): the same, but its month has started (B3): owed again, never cancelled.
 *  - `owedIndependent` (R3): every other obligation P settled — scheduled or staff charges, or a prepaid obligation that has
 *    had more than one settlement (its creating payment was reversed earlier and someone else paid it): owed again.
 *
 * `currentMonth` must be the student's home-branch month at the deciding instant (the monthly job's own rule, B3/B9).
 */
export type ReversalClass = "cancel" | "owedStarted" | "owedIndependent";

export interface ReversalCandidate {
  origin: string;
  coverageYear: number;
  coverageMonth: number;
  /** The payment id of EVERY settlement this obligation has ever had, reversed ones included. */
  settlementPaymentIds: readonly string[];
}

export function classifyReversedObligation(obligation: ReversalCandidate, paymentId: string, currentMonth: YearMonth): ReversalClass {
  const createdByThisPaymentAlone =
    obligation.origin === "PREPAYMENT" && obligation.settlementPaymentIds.length === 1 && obligation.settlementPaymentIds[0] === paymentId;
  if (!createdByThisPaymentAlone) return "owedIndependent";
  const month: YearMonth = { year: obligation.coverageYear, month: obligation.coverageMonth };
  return compareYearMonth(month, currentMonth) > 0 ? "cancel" : "owedStarted";
}

/** Reason categories (B7). Stored as a prefix of the existing free-text `reversalReason` — no schema change. Reversal never
 * represents a refund or a departing student; the owner screen says so. */
export const REVERSAL_REASON_CATEGORIES = ["NOT_RECEIVED", "RECORDED_IN_ERROR"] as const;
export type ReversalReasonCategory = (typeof REVERSAL_REASON_CATEGORIES)[number];

export function isReversalReasonCategory(value: unknown): value is ReversalReasonCategory {
  return typeof value === "string" && (REVERSAL_REASON_CATEGORIES as readonly string[]).includes(value);
}

export function storedReversalReason(category: ReversalReasonCategory, text: string): string {
  return storedCategorizedReason(category, text);
}

/** The one stored format for a categorized correction reason (O4 reversal, O2 opening cancellation): `[CATEGORY] text`. */
export function storedCategorizedReason(category: string, text: string): string {
  return `[${category}] ${text.trim()}`;
}

/** O2 (approved A3–A4, 2026-11-10): why the owner cancels an opening obligation. Required, with a required free text. */
export const OPENING_CANCELLATION_CATEGORIES = ["ENTERED_IN_ERROR", "DUPLICATE"] as const;
export type OpeningCancellationCategory = (typeof OPENING_CANCELLATION_CATEGORIES)[number];

export function isOpeningCancellationCategory(value: unknown): value is OpeningCancellationCategory {
  return typeof value === "string" && (OPENING_CANCELLATION_CATEGORIES as readonly string[]).includes(value);
}

/** Order-insensitive equality of two id sets (the owner-confirmed cancel set versus the one recomputed under the locks). */
export function sameIdSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return set.size === a.length && b.every((id) => set.has(id));
}
