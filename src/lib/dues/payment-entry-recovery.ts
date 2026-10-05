import type { RecordDuesPaymentWithSubmissionIdentityResult, SubmissionOutcome } from "@/lib/dues/ledger/submission-identity";

/**
 * Ordinary payment-entry UI brief §2.4c: the recovery-state table's own decision logic, as pure functions — kept
 * separate from the React component so every one of the table's rows is independently, directly testable (tier 5)
 * without needing to drive a full DOM journey for each one.
 *
 * Deliberately NOT exported from the engine layer: this is UI-side classification of results the engine already
 * returns — it changes no engine behavior, and the engine itself has no notion of "was this a recovery retry."
 */

/** `notActive`/`invalid`/`notFound` — the three pre-arbitration codes `recordDuesPaymentWithSubmissionIdentity`'s own
 * read order (§2.4c) evaluates BEFORE its identity-row INSERT. Definitive on a genuinely fresh submission; silent
 * about the original attempt's real fate on a recovery retry of an already-uncertain one. */
const PRE_ARBITRATION_ERRORS = new Set(["notActive", "invalid", "notFound"]);

export type WriteOutcomeClassification =
  | { kind: "freshSuccess" }
  | { kind: "replaySuccess"; currentlyReversed: boolean }
  | { kind: "freshCapture"; receiptId: string }
  | { kind: "replayCapture"; receiptId: string; currentStatus: "PENDING" | "RESOLVED" | "CANCELLED" }
  /** Case 5 — should not normally be reachable from this UI's own flow (every retry reuses the stored, unchanged
   * payload); seeing it indicates a bug in this UI's own retry wiring, not a normal outcome. */
  | { kind: "payloadMismatch" }
  /** Case 6, either the in-transaction business codes (always definitive) or a pre-arbitration code on a GENUINELY
   * FRESH submission (also definitive — first-ever call, nothing could predate it). Safe to clear and unlock. */
  | { kind: "businessRefusal"; error: string; selectableTotals?: string[]; alreadySettledIds?: string[] }
  /** The new row (point: pre-arbitration refusals during recovery): a pre-arbitration code reached WHILE retrying an
   * already-uncertain stored attempt. Proves nothing about the original call — preserve, lock, explain blocked. */
  | { kind: "recoveryBlocked"; error: string };

/**
 * Classifies a single `recordDuesPaymentWithSubmissionIdentity` (via `recordPayment`) result. `isRecoveryRetry` is
 * the caller's own knowledge of which kind of call just happened — the engine itself has no such concept, and the
 * distinction only matters for pre-arbitration codes (§2.4c's correction).
 */
export function classifyWriteResult(result: RecordDuesPaymentWithSubmissionIdentityResult, context: { isRecoveryRetry: boolean }): WriteOutcomeClassification {
  if (result.ok) {
    if ("replay" in result && result.replay) return { kind: "replaySuccess", currentlyReversed: result.currentlyReversed };
    return { kind: "freshSuccess" };
  }
  if (result.error === "captured") {
    // `receiptId` is optional on the shared refusal shape but always present for "captured" (the engine's own
    // invariant — never constructed without one); asserted here rather than widening this classifier's own type.
    if ("replay" in result && result.replay) return { kind: "replayCapture", receiptId: result.receiptId!, currentStatus: result.currentStatus };
    return { kind: "freshCapture", receiptId: result.receiptId! };
  }
  if (result.error === "submissionPayloadMismatch") return { kind: "payloadMismatch" };
  if (context.isRecoveryRetry && PRE_ARBITRATION_ERRORS.has(result.error)) {
    return { kind: "recoveryBlocked", error: result.error };
  }
  return { kind: "businessRefusal", error: result.error, selectableTotals: result.selectableTotals, alreadySettledIds: result.alreadySettledIds };
}

/** Whether the stored attempt should be cleared after this write-result classification (recovery-state table). */
export function shouldClearAfterWrite(classification: WriteOutcomeClassification): boolean {
  switch (classification.kind) {
    case "freshSuccess":
    case "replaySuccess":
    case "freshCapture":
    case "replayCapture":
    case "businessRefusal":
      return true;
    case "payloadMismatch":
    case "recoveryBlocked":
      return false;
  }
}

/** The promise itself rejected (network/timeout) — no result at all. Always uncertain: preserve, lock, route to
 * recovery. Modeled as its own type rather than folded into `WriteOutcomeClassification` since there is no engine
 * result to classify. */
export type WriteRejected = { kind: "rejected" };

export type RecoveryCheckClassification =
  /** `getSubmissionOutcome` resolved `committed` — render exactly as the matching live-write case, clear storage,
   * no new financial write occurred (this is a read). */
  | { kind: "committed"; outcome: Extract<SubmissionOutcome, { status: "committed" }>["outcome"] }
  /** Resolved `notFound` with no prior ambiguity in play — still not proof of anything (point 1), preserved, offers
   * a safe identity-preserving retry. */
  | { kind: "notFound" }
  /** `checkSubmissionOutcome` THREW (a genuine member with the wrong role) — preserve, explain blocked, distinct
   * from a plain `notFound`. */
  | { kind: "authFailure" }
  /** The check call itself rejected for a non-authorization reason (network/timeout) — preserve, explain uncertain. */
  | { kind: "rejected" };

/** Classifies the outcome of calling `checkSubmissionOutcome`, including a thrown rejection. */
export function classifyRecoveryCheck(settled: { status: "fulfilled"; value: SubmissionOutcome } | { status: "rejected"; reason: unknown }): RecoveryCheckClassification {
  if (settled.status === "rejected") {
    if (settled.reason instanceof Error && settled.reason.message === "FORBIDDEN") return { kind: "authFailure" };
    return { kind: "rejected" };
  }
  const outcome = settled.value;
  if (outcome.status === "notFound") return { kind: "notFound" };
  return { kind: "committed", outcome: outcome.outcome };
}

/** Whether the stored attempt should be cleared after this recovery-check classification. */
export function shouldClearAfterRecoveryCheck(classification: RecoveryCheckClassification): boolean {
  return classification.kind === "committed";
}
