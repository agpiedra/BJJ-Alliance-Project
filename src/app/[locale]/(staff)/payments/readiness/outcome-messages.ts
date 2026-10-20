import type { ActionState } from "@/lib/action-state";

/**
 * Stage 8d-2 (docs/dues/STAGE-8D2-IMPLEMENTATION-PLAN.md §4): what a submission's RESPONSE proves, and nothing else.
 *
 * - `saved`: an explicit `{ ok: true }`.
 * - `rejected`: an explicit `ActionState` error. Every error these actions return is decided before any write (or by a
 *   rolled-back unique violation), so the call wrote nothing.
 * - `unknown`: the call threw (lost response, network failure, timeout, 500). It may have committed, may not have, or may
 *   still commit. Refreshed data never turns this into `saved` or `rejected`: no row records which request wrote it.
 *
 * Pure, so the classification is unit-tested without a browser or database.
 */
export type Settled = { status: "fulfilled"; value: ActionState & { count?: number } } | { status: "rejected" };

export type ResponseOutcome =
  | { kind: "saved"; count?: number }
  | { kind: "rejected"; code: RejectionCode; fieldErrors: Record<string, string[]> }
  | { kind: "unknown" };

const CODES = ["notFound", "invalid", "stale", "declarationMismatch", "monthHasDraft", "monthAssigned", "pastMonth", "notFuture"] as const;
export type RejectionCode = (typeof CODES)[number] | "unexpected";

export function classifyResponse(settled: Settled): ResponseOutcome {
  if (settled.status === "rejected") return { kind: "unknown" };
  const { value } = settled;
  if (value.ok) return { kind: "saved", count: value.count };
  if (!value.error) return { kind: "rejected", code: "unexpected", fieldErrors: {} };
  const fieldErrors = value.fieldErrors ?? {};
  // A declaration that no longer matches the active drafts is the same situation as `stale`: the content changed after load.
  if (value.error === "invalid" && fieldErrors.declaration?.includes("mismatch")) return { kind: "rejected", code: "declarationMismatch", fieldErrors: {} };
  const code = (CODES as readonly string[]).includes(value.error) ? (value.error as RejectionCode) : "unexpected";
  return { kind: "rejected", code, fieldErrors };
}

/** Rejections that mean "the displayed data is out of date": the page refreshes, and nothing is resubmitted. */
export function rejectionRefreshes(code: RejectionCode): boolean {
  return code === "stale" || code === "declarationMismatch" || code === "notFound" || code === "monthHasDraft" || code === "monthAssigned";
}

/** The message key for one field's refusal, shown under that field. */
export function fieldErrorKey(field: string, reason: string): string {
  if (field === "coverageMonth" && reason === "future") return "field.futureMonth";
  if (field === "legacyPaymentPeriodId" && reason === "mismatch") return "field.linkMismatch";
  return `field.${field}`;
}
