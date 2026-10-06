import type { SubmissionOutcome } from "@/lib/dues/ledger/submission-identity";

/**
 * Ordinary payment-entry UI brief §2.4c: the recovery-state table's own decision logic, as pure functions — kept
 * separate from the React component so every one of the table's rows is independently, directly testable (tier 5)
 * without needing to drive a full DOM journey for each one.
 *
 * Deliberately NOT exported from the engine layer: this is UI-side classification of results the engine already
 * returns — it changes no engine behavior, and the engine itself has no notion of "was this a recovery retry."
 *
 * Package-purchase UI brief §2.8/§2.9: `classifyWriteResult` is now typed against `GenericSubmissionWriteResult`
 * (below) instead of the ordinary writer's own nominal `RecordDuesPaymentWithSubmissionIdentityResult` — its body
 * reads nothing but `ok`/`error`/`replay`/`currentlyReversed`/`receiptId`/`currentStatus`/`selectableTotals`/
 * `alreadySettledIds`, every one of which `PurchasePackageWithSubmissionIdentityResult` (purchase-submission-
 * identity.ts) carries with the identical name and meaning — the SAME six-shape structure the brief itself
 * confirms (fresh success / replay success / fresh capture / replay capture / submissionPayloadMismatch / ordinary
 * refusal). Genuine reuse of this classifier, not a thin package-specific sibling duplicating its logic: only the
 * TYPE is widened, matching the brief's own "prefer reuse" instruction. `PRE_ARBITRATION_ERRORS` below is already
 * generic (plain strings), so it classifies `purchasePackageWithSubmissionIdentity`'s own `notActive`/`invalid`/
 * `notFound` pre-arbitration codes identically, with no change needed.
 */

/**
 * The minimal structural shape both `RecordDuesPaymentWithSubmissionIdentityResult` and
 * `PurchasePackageWithSubmissionIdentityResult` satisfy — every field this module's classifiers actually read,
 * nothing else. `error` is widened to `string` (rather than either writer's own narrower literal-union) so EITHER
 * writer's refusal codes type-check here without this module needing to know the full set from either one; the
 * classifiers below never switch on specific literal values beyond the few named explicitly
 * (`"captured"`/`"submissionPayloadMismatch"`/the three pre-arbitration codes), so nothing is lost by widening it.
 */
export type GenericSubmissionWriteResult =
  | { ok: true; replay?: boolean; currentlyReversed?: boolean }
  | {
      ok: false;
      error: string;
      replay?: boolean;
      currentStatus?: "PENDING" | "RESOLVED" | "CANCELLED";
      receiptId?: string;
      selectableTotals?: string[];
      alreadySettledIds?: string[];
    };

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
export function classifyWriteResult(result: GenericSubmissionWriteResult, context: { isRecoveryRetry: boolean }): WriteOutcomeClassification {
  if (result.ok) {
    // `currentlyReversed` is optional on the widened generic shape but always present when `replay` is true (both
    // writers' own invariant — never constructed without it); asserted here rather than narrowing the shared type.
    if ("replay" in result && result.replay) return { kind: "replaySuccess", currentlyReversed: result.currentlyReversed! };
    return { kind: "freshSuccess" };
  }
  if (result.error === "captured") {
    // `receiptId`/`currentStatus` are optional on the shared refusal shape but always present for "captured" (the
    // engine's own invariant — never constructed without them); asserted here rather than widening this
    // classifier's own type.
    if ("replay" in result && result.replay) return { kind: "replayCapture", receiptId: result.receiptId!, currentStatus: result.currentStatus! };
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
