import { describe, expect, it } from "vitest";
import {
  classifyWriteResult,
  classifyRecoveryCheck,
  shouldClearAfterWrite,
  shouldClearAfterRecoveryCheck,
} from "../../src/lib/dues/payment-entry-recovery";
import type { RecordDuesPaymentWithSubmissionIdentityResult, SubmissionOutcome } from "../../src/lib/dues/ledger/submission-identity";

/**
 * Ordinary payment-entry UI brief §2.4c: the recovery-state table's own decision logic, tested directly against the
 * pure classifier — every one of the twelve rows, plus the three named regression scenarios, exercised without
 * needing a full DOM journey for each.
 */

describe("classifyWriteResult / shouldClearAfterWrite — the twelve-row table, write-result rows", () => {
  it("row: fresh settlement (ok:true, no replay) — clears", () => {
    const result: RecordDuesPaymentWithSubmissionIdentityResult = { ok: true, paymentId: "p1", settlementIds: ["s1"], feeIds: [], totalMinor: 10000 };
    const c = classifyWriteResult(result, { isRecoveryRetry: false });
    expect(c).toEqual({ kind: "freshSuccess" });
    expect(shouldClearAfterWrite(c)).toBe(true);
  });

  it("row: replay, currentlyReversed:false — clears, ordinary success", () => {
    const result: RecordDuesPaymentWithSubmissionIdentityResult = { ok: true, paymentId: "p1", replay: true, currentlyReversed: false };
    const c = classifyWriteResult(result, { isRecoveryRetry: true });
    expect(c).toEqual({ kind: "replaySuccess", currentlyReversed: false });
    expect(shouldClearAfterWrite(c)).toBe(true);
  });

  it("row: replay, currentlyReversed:true — clears, but a DISTINCT reversed classification (never generic success)", () => {
    const result: RecordDuesPaymentWithSubmissionIdentityResult = { ok: true, paymentId: "p1", replay: true, currentlyReversed: true };
    const c = classifyWriteResult(result, { isRecoveryRetry: true });
    expect(c).toEqual({ kind: "replaySuccess", currentlyReversed: true });
    expect(shouldClearAfterWrite(c)).toBe(true);
  });

  it("row: fresh capture (captured, no replay) — clears, outcome now known", () => {
    const result: RecordDuesPaymentWithSubmissionIdentityResult = { ok: false, error: "captured", receiptId: "r1" };
    const c = classifyWriteResult(result, { isRecoveryRetry: false });
    expect(c).toEqual({ kind: "freshCapture", receiptId: "r1" });
    expect(shouldClearAfterWrite(c)).toBe(true);
  });

  it("row: replay capture, any currentStatus — clears, per-status classification", () => {
    for (const currentStatus of ["PENDING", "RESOLVED", "CANCELLED"] as const) {
      const result: RecordDuesPaymentWithSubmissionIdentityResult = { ok: false, error: "captured", receiptId: "r1", replay: true, currentStatus };
      const c = classifyWriteResult(result, { isRecoveryRetry: true });
      expect(c).toEqual({ kind: "replayCapture", receiptId: "r1", currentStatus });
      expect(shouldClearAfterWrite(c)).toBe(true);
    }
  });

  it("row: submissionPayloadMismatch — PRESERVED, never cleared (a client-bug signal, not a normal outcome)", () => {
    const result: RecordDuesPaymentWithSubmissionIdentityResult = { ok: false, error: "submissionPayloadMismatch" };
    const c = classifyWriteResult(result, { isRecoveryRetry: true });
    expect(c).toEqual({ kind: "payloadMismatch" });
    expect(shouldClearAfterWrite(c)).toBe(false);
  });

  it("row: in-transaction business refusal — ALWAYS definitive, clears, fresh OR recovery alike", () => {
    const businessErrors = ["notOldestFirst", "currencyMismatch", "feeAlreadyAssessed", "amountUnsupported", "conflict", "futureDate", "tooOld", "alreadySettled", "notASelectableTotal", "totalMismatch", "ambiguousTotal"] as const;
    for (const error of businessErrors) {
      for (const isRecoveryRetry of [false, true]) {
        const result: RecordDuesPaymentWithSubmissionIdentityResult = { ok: false, error };
        const c = classifyWriteResult(result, { isRecoveryRetry });
        expect(c).toEqual({ kind: "businessRefusal", error, selectableTotals: undefined, alreadySettledIds: undefined });
        expect(shouldClearAfterWrite(c)).toBe(true);
      }
    }
  });

  it("row: pre-arbitration refusal (notActive/invalid/notFound) on a GENUINELY FRESH submission — definitive, clears", () => {
    for (const error of ["notActive", "invalid", "notFound"] as const) {
      const result: RecordDuesPaymentWithSubmissionIdentityResult = { ok: false, error };
      const c = classifyWriteResult(result, { isRecoveryRetry: false });
      expect(c).toEqual({ kind: "businessRefusal", error, selectableTotals: undefined, alreadySettledIds: undefined });
      expect(shouldClearAfterWrite(c)).toBe(true);
    }
  });

  it("row (NEW, the correction): pre-arbitration refusal DURING a recovery retry — PRESERVED, never cleared", () => {
    for (const error of ["notActive", "invalid", "notFound"] as const) {
      const result: RecordDuesPaymentWithSubmissionIdentityResult = { ok: false, error };
      const c = classifyWriteResult(result, { isRecoveryRetry: true });
      expect(c).toEqual({ kind: "recoveryBlocked", error });
      expect(shouldClearAfterWrite(c)).toBe(false);
    }
  });
});

describe("classifyRecoveryCheck / shouldClearAfterRecoveryCheck — the two read-path rows", () => {
  it("row: getSubmissionOutcome resolves notFound with no prior ambiguity — preserved", () => {
    const value: SubmissionOutcome = { status: "notFound" };
    const c = classifyRecoveryCheck({ status: "fulfilled", value });
    expect(c).toEqual({ kind: "notFound" });
    expect(shouldClearAfterRecoveryCheck(c)).toBe(false);
  });

  it("row: getSubmissionOutcome resolves committed — cleared, outcome rendered", () => {
    const value: SubmissionOutcome = { status: "committed", outcome: { kind: "payment", paymentId: "p1", currentlyReversed: false } };
    const c = classifyRecoveryCheck({ status: "fulfilled", value });
    expect(c).toEqual({ kind: "committed", outcome: { kind: "payment", paymentId: "p1", currentlyReversed: false } });
    expect(shouldClearAfterRecoveryCheck(c)).toBe(true);
  });

  it("a thrown FORBIDDEN (genuine wrong role) classifies as authFailure, preserved — distinct from notFound", () => {
    const c = classifyRecoveryCheck({ status: "rejected", reason: new Error("FORBIDDEN") });
    expect(c).toEqual({ kind: "authFailure" });
    expect(shouldClearAfterRecoveryCheck(c)).toBe(false);
  });

  it("a network/transport rejection classifies as rejected, preserved — distinct from authFailure", () => {
    const c = classifyRecoveryCheck({ status: "rejected", reason: new TypeError("fetch failed") });
    expect(c).toEqual({ kind: "rejected" });
    expect(shouldClearAfterRecoveryCheck(c)).toBe(false);
  });
});

describe("the three named regression scenarios (brief §2.4c/§8)", () => {
  it("(1) capture genuinely committed; retry hits notActive — attempt survives, never shown as a fresh capture", () => {
    const retryResult: RecordDuesPaymentWithSubmissionIdentityResult = { ok: false, error: "notActive" };
    const c = classifyWriteResult(retryResult, { isRecoveryRetry: true });
    expect(c.kind).not.toBe("freshCapture");
    expect(c).toEqual({ kind: "recoveryBlocked", error: "notActive" });
    expect(shouldClearAfterWrite(c)).toBe(false);
  });

  it("(2) payment genuinely committed; recovery refused by a thrown FORBIDDEN or a resolved notFound — attempt survives, never shown as an ordinary refusal", () => {
    const authFailure = classifyRecoveryCheck({ status: "rejected", reason: new Error("FORBIDDEN") });
    expect(shouldClearAfterRecoveryCheck(authFailure)).toBe(false);
    expect(authFailure.kind).not.toBe("committed");

    const scopeExcluded = classifyRecoveryCheck({ status: "fulfilled", value: { status: "notFound" } });
    expect(shouldClearAfterRecoveryCheck(scopeExcluded)).toBe(false);
    expect(scopeExcluded.kind).not.toBe("committed");

    // A write-retry under the same conditions (notFound from the engine's own pre-arbitration student/branch lookup)
    // is equally non-definitive.
    const writeRetryBlocked = classifyWriteResult({ ok: false, error: "notFound" }, { isRecoveryRetry: true });
    expect(writeRetryBlocked).toEqual({ kind: "recoveryBlocked", error: "notFound" });
    expect(shouldClearAfterWrite(writeRetryBlocked)).toBe(false);
  });

  it("(3) access restored; getSubmissionOutcome resolves committed with the original outcome — clears, renders the original outcome, no new financial write (this classifier itself never calls the engine)", () => {
    const outcome: SubmissionOutcome = { status: "committed", outcome: { kind: "payment", paymentId: "original-payment", currentlyReversed: false } };
    const c = classifyRecoveryCheck({ status: "fulfilled", value: outcome });
    expect(c).toEqual({ kind: "committed", outcome: { kind: "payment", paymentId: "original-payment", currentlyReversed: false } });
    expect(shouldClearAfterRecoveryCheck(c)).toBe(true);
  });
});
