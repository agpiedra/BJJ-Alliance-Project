"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { FIELD_CLASS, Input } from "@/components/ui/input";
import { recordPayment, checkSubmissionOutcome, getPayableObligations } from "@/lib/dues/payment-entry-actions";
import { beginAttempt, readAttempt, clearAttempt, listStoredAttemptIds, type StoredAttemptPayload } from "@/lib/dues/payment-attempt-storage";
import { classifyWriteResult, classifyRecoveryCheck, shouldClearAfterRecoveryCheck, type WriteOutcomeClassification, type RecoveryCheckClassification } from "@/lib/dues/payment-entry-recovery";
import { CURRENCIES } from "@/lib/payments/format-money";
import type { PayableObligation } from "@/lib/dues/payment-entry-queries";
import type { CalendarDate } from "@/lib/dues/calendar";
import type { Currency, PaymentMethod } from "@/generated/prisma/client";

/**
 * Ordinary payment-entry UI brief §2/§8/§10: the new, functionally-integrated ledger payment card for
 * `payments/page.tsx` (§0 — never `payments/plans/page.tsx`). Deliberately does NOT reuse `useDuesAction`
 * (`dues-config-forms.tsx:27-41` has no rejected-promise handling and resets the form on any truthy `result.ok`,
 * including a reversed-payment replay) — this component owns its own submit/recovery state machine.
 *
 * Corrected (post-review, 8 points): the write-result CLASSIFICATION now genuinely controls `phase` (a
 * `recoveryBlocked`/`payloadMismatch` classification never falls through to the terminal "outcome" screen); an
 * ordinary business refusal clears only the stored IDENTITY, never the owner's typed draft; the student-change
 * obligations fetch clears its own stale selection synchronously and the loading phase is itself locked; EVERY
 * stored attempt (not just the first) is processed before the form ever unlocks; a storage-access failure is
 * treated as blocking, never as "nothing stored"; the student picker is not filtered to `status: "ACTIVE"`; the
 * default `receivedOn`/disclaimer use the student's own branch-local date, never the browser's; a capture outcome's
 * guidance is role-aware (a `DIRECTOR` is never shown a link into a page section only an `ADMIN` can see there).
 */

const METHODS: PaymentMethod[] = ["EFECTIVO", "SINPE", "TRANSFERENCIA", "TARJETA"];

/** Used only before any student/branch is known — the moment a student is selected, the branch-local date from
 * `getPayableObligations` takes over (point 7). */
function browserTodayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function calendarDateToIso(d: CalendarDate): string {
  return `${d.year}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`;
}

type Student = { id: string; firstName: string; lastName: string; academyId: string; academyName: string };

type Phase =
  | "form"
  | "loadingObligations"
  | "submitting"
  | "recoveryChecking"
  | "recoveryBlocked"
  | "outcome"
  /** Point 5: `listStoredAttemptIds`/`readAttempt` itself couldn't be inspected — never silently treated as
   * "nothing stored." The whole form stays blocked: starting a new entry while unable to verify an existing
   * uncertain one would be exactly the double-submission risk this feature exists to prevent. */
  | "storageUnavailable"
  /** Round-3 point 3: an `alreadySettled` refusal's own re-fetch-and-reconcile — locked the same way
   * `loadingObligations` is, so a submit can never race a selection the server has already told us is stale. */
  | "reconcilingObligations";

type OutcomeDisplay = { source: "write"; classification: WriteOutcomeClassification | { kind: "rejected" } } | { source: "recovery"; classification: RecoveryCheckClassification };

/** A business refusal (brief §2.3 case 6) shown INLINE in the still-editable form — never the separate terminal
 * "outcome" screen, and never a reason to wipe the owner's typed draft (point 2). */
type FormError = { error: string; selectableTotals?: string[]; alreadySettledIds?: string[] };

const TERMINAL_WRITE_KINDS = new Set(["freshSuccess", "replaySuccess", "freshCapture", "replayCapture"]);

export function PaymentEntrySection({
  organizationId,
  currentUserId,
  students,
  organizationRole,
  plansHref,
}: {
  organizationId: string;
  currentUserId: string;
  students: Student[];
  /** Point 8: a capture outcome's own guidance is role-aware — only an `ADMIN` can see the receipt queue section on
   * `payments/plans/page.tsx` (that page gates it to `organizationRole === "ADMIN"` even though a `DIRECTOR` can
   * load the page itself); a `DIRECTOR` is never shown a link implying access they don't have. */
  organizationRole: "ADMIN" | "DIRECTOR";
  plansHref: string;
}) {
  const t = useTranslations("payments.ledgerEntry");
  const tMethod = useTranslations("payments.method");

  const [phase, setPhase] = useState<Phase>("form");
  const [selectedStudentId, setSelectedStudentId] = useState("");
  const [obligations, setObligations] = useState<PayableObligation[] | null>(null);
  const [mixedCurrency, setMixedCurrency] = useState(false);
  const [obligationsError, setObligationsError] = useState<string | null>(null);
  // Round-3 point 3: which path produced the current obligationsError — so "Retry" re-runs the RIGHT fetch (a plain
  // re-fetch for the main effect, vs. a reconciling re-fetch that must not reset the selection to just-the-oldest).
  const [obligationsErrorSource, setObligationsErrorSource] = useState<"fetch" | "reconcile" | null>(null);
  const [selectedObligationIds, setSelectedObligationIds] = useState<Set<string>>(new Set());
  const [obligationsRetryNonce, setObligationsRetryNonce] = useState(0);

  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState<Currency>("USD");
  const [receivedOn, setReceivedOn] = useState(browserTodayIso());
  const [receivedOnTouched, setReceivedOnTouched] = useState(false);
  const [branchToday, setBranchToday] = useState<CalendarDate | null>(null);
  const [method, setMethod] = useState<PaymentMethod>("EFECTIVO");
  const [notes, setNotes] = useState("");

  const [outcome, setOutcome] = useState<OutcomeDisplay | null>(null);
  const [formError, setFormError] = useState<FormError | null>(null);
  const [storedPayloadReadable, setStoredPayloadReadable] = useState(true);
  const [beginError, setBeginError] = useState<"alreadyExists" | "storageUnavailable" | null>(null);
  const [clearFailed, setClearFailed] = useState(false);

  const submissionIdRef = useRef<string | null>(null);
  // The FULL set of still-unresolved stored attempt ids (point 4) — index 0 is always the one currently shown while
  // phase is recoveryChecking/recoveryBlocked. Never just "the first one found."
  const recoveryQueueRef = useRef<string[]>([]);
  // Guards a stale fetch (a student change while a prior fetch is in flight) from overwriting newer state —
  // the same discriminator-based discard `ReceiptQueueList` already uses for its own tab-switch race.
  const obligationsRequestRef = useRef(0);
  // Round-3 point 1: a `clearAttempt` that genuinely failed, and what to do once a LATER retry (via "Finish cleanup")
  // finally succeeds — the single shared mechanism every clear-then-advance call site below uses, so the
  // write path and the recovery-read path can no longer drift (the write path previously discarded this result
  // entirely and advanced as if cleanup had succeeded).
  const pendingClearRef = useRef<{ id: string; onSuccess: () => void | Promise<void> } | null>(null);

  const locked =
    phase === "recoveryChecking" ||
    phase === "recoveryBlocked" ||
    phase === "submitting" ||
    phase === "loadingObligations" ||
    phase === "storageUnavailable" ||
    phase === "reconcilingObligations";

  /** The ONE place a stored identity is ever cleared (point 1). On success, runs `onSuccess` immediately. On
   * failure, preserves exactly what `onSuccess` would have needed (never assumes the entry is gone, never advances
   * the queue, never resets any draft) and offers "Finish cleanup", which retries the SAME clear and — only once it
   * genuinely succeeds — runs the SAME `onSuccess` the original call would have run. */
  function attemptClear(id: string, onSuccess: () => void | Promise<void>) {
    const cleared = clearAttempt(organizationId, currentUserId, id);
    if (!cleared.ok) {
      pendingClearRef.current = { id, onSuccess };
      setClearFailed(true);
      setPhase("recoveryBlocked");
      return;
    }
    void onSuccess();
  }

  function handleFinishCleanup() {
    const pending = pendingClearRef.current;
    if (!pending) return;
    const cleared = clearAttempt(organizationId, currentUserId, pending.id);
    if (!cleared.ok) return; // still failing — stay exactly as-is, the button remains
    pendingClearRef.current = null;
    setClearFailed(false);
    void pending.onSuccess();
  }

  /** Pops `id` off the front of the queue if it's still there, then either continues to the next queued id or runs
   * `otherwise` (the genuinely-nothing-left-uncertain case). Shared by every "an attempt just finished resolving"
   * call site so queue-advancement logic lives in exactly one place. */
  function popQueueAndContinueOrElse(id: string, otherwise: () => void | Promise<void>) {
    if (recoveryQueueRef.current[0] === id) recoveryQueueRef.current = recoveryQueueRef.current.slice(1);
    if (recoveryQueueRef.current.length > 0) {
      void resolveQueueHead();
      return;
    }
    void otherwise();
  }

  // ---- recovery: process EVERY stored attempt, one at a time, never just the first (point 4) ----

  async function resolveQueueHead(): Promise<void> {
    const id = recoveryQueueRef.current[0];
    if (!id) return;
    submissionIdRef.current = id;
    setClearFailed(false);
    const read = readAttempt(organizationId, currentUserId, id);
    setStoredPayloadReadable(read.status === "ok");
    setPhase("recoveryChecking");
    const settled = (await Promise.allSettled([checkSubmissionOutcome(organizationId, id)]))[0];
    const classification = classifyRecoveryCheck(settled);
    if (!shouldClearAfterRecoveryCheck(classification)) {
      setOutcome({ source: "recovery", classification });
      setPhase("recoveryBlocked");
      return;
    }
    setOutcome({ source: "recovery", classification });
    attemptClear(id, () => {
      // Round-3 point 2: a definitive, confirmed outcome reached via the RECOVERY path resets the draft exactly
      // like a fresh write success already did — otherwise a filled-in-then-lost submission's own student/amount/
      // selection stays sitting in the form, one click from a genuine duplicate under a brand-new submissionId.
      popQueueAndContinueOrElse(id, () => {
        submissionIdRef.current = null;
        resetForm();
        setPhase("outcome");
      });
    });
  }

  useEffect(() => {
    const scanned = listStoredAttemptIds(organizationId, currentUserId);
    if (scanned.status === "unavailable") {
      setPhase("storageUnavailable");
      return;
    }
    if (scanned.ids.length === 0) return;
    recoveryQueueRef.current = scanned.ids;
    void resolveQueueHead();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only
  }, []);

  function handleCheckStatusAgain() {
    if (recoveryQueueRef.current.length === 0) return;
    void resolveQueueHead();
  }

  // ---- obligations fetch (point 3: synchronous clear, loading is locked, mixed-currency never pre-selects) ----

  useEffect(() => {
    // Synchronous, same render as the student change — no stale selection survives into the fetch window.
    setSelectedObligationIds(new Set());
    setObligations(null);
    setMixedCurrency(false);
    setObligationsError(null);
    setObligationsErrorSource(null);
    setFormError(null);
    if (!selectedStudentId) return;
    const requestId = ++obligationsRequestRef.current;
    setPhase("loadingObligations");
    getPayableObligations(organizationId, selectedStudentId)
      .then((result) => {
        if (obligationsRequestRef.current !== requestId) return;
        if (!result.ok) {
          setObligationsError(result.error);
          setObligationsErrorSource("fetch");
          setObligations([]);
          setMixedCurrency(false);
        } else {
          setObligations(result.obligations);
          setMixedCurrency(result.mixedCurrency);
          setBranchToday(result.todayLocal);
          if (!receivedOnTouched) setReceivedOn(calendarDateToIso(result.todayLocal));
          // Default-check the oldest unselected run (§2.1) — never when mixed-currency (no selectable set exists).
          setSelectedObligationIds(!result.mixedCurrency && result.obligations.length > 0 ? new Set([result.obligations[0].obligationId]) : new Set());
        }
        setPhase((p) => (p === "loadingObligations" ? "form" : p));
      })
      .catch(() => {
        if (obligationsRequestRef.current !== requestId) return;
        setObligationsError("transportFailure");
        setObligationsErrorSource("fetch");
        setObligations([]);
        setPhase((p) => (p === "loadingObligations" ? "form" : p));
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- receivedOnTouched intentionally not a dep: re-fetching must not re-run on every date edit
  }, [organizationId, selectedStudentId, obligationsRetryNonce]);

  /**
   * Round-3 point 3: `alreadySettled`'s own re-fetch-and-reconcile — LOCKED (`reconcilingObligations`, included in
   * `locked`) for its entire duration so a submit can never race a selection the server has already told us is
   * stale, genuinely `await`ed (not fire-and-forgotten) by every caller, and its own rejection is caught here —
   * never an unhandled promise rejection. Never resets the selection to just-the-oldest (unlike the main fetch
   * above): it drops ids no longer present and keeps the rest, exactly what "reconcile" means here. The same
   * `obligationsRequestRef` discriminator the main fetch already uses discards a lagging response, including one for
   * a student the owner has since changed away from.
   */
  async function refetchObligationsReconciling(): Promise<void> {
    if (!selectedStudentId) {
      setPhase("form");
      return;
    }
    const requestId = ++obligationsRequestRef.current;
    setPhase("reconcilingObligations");
    try {
      const result = await getPayableObligations(organizationId, selectedStudentId);
      if (obligationsRequestRef.current !== requestId) return; // a newer fetch (or student change) has since started
      if (!result.ok) {
        setObligationsError(result.error);
        setObligationsErrorSource("reconcile");
        setPhase("form");
        return;
      }
      setObligations(result.obligations);
      setMixedCurrency(result.mixedCurrency);
      const validIds = new Set(result.obligations.map((o) => o.obligationId));
      setSelectedObligationIds((prev) => new Set([...prev].filter((id) => validIds.has(id))));
      setObligationsError(null);
      setObligationsErrorSource(null);
      setPhase("form");
    } catch {
      if (obligationsRequestRef.current !== requestId) return;
      setObligationsError("transportFailure");
      setObligationsErrorSource("reconcile");
      setPhase("form");
    }
  }

  function toggleObligation(id: string) {
    setSelectedObligationIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  // A non-prefix selection is flagged client-side (§2.1) — the server enforces `notOldestFirst` regardless; this is
  // advisory, never the authoritative check.
  const orderedObligationIds = obligations?.map((o) => o.obligationId) ?? [];
  const selectedCount = selectedObligationIds.size;
  const isPrefixSelection = orderedObligationIds.slice(0, selectedCount).every((id) => selectedObligationIds.has(id));

  const todaysTotalMinor = (obligations ?? [])
    .filter((o) => selectedObligationIds.has(o.obligationId))
    .reduce((sum, o) => sum + o.outstandingAmountMinor, 0);

  function currentPayload(): StoredAttemptPayload {
    const [y, m, d] = receivedOn.split("-").map(Number);
    return {
      studentId: selectedStudentId,
      obligationIds: [...selectedObligationIds],
      receivedOn: { year: y, month: m, day: d },
      tender: { currency, amount },
      method,
      notes: notes.trim() === "" ? undefined : notes,
    };
  }

  function buildFormData(payload: StoredAttemptPayload, submissionId: string): FormData {
    const fd = new FormData();
    fd.set("studentId", payload.studentId);
    for (const id of payload.obligationIds) fd.append("obligationIds", id);
    fd.set("receivedOn", `${payload.receivedOn.year}-${String(payload.receivedOn.month).padStart(2, "0")}-${String(payload.receivedOn.day).padStart(2, "0")}`);
    fd.set("tenderCurrency", payload.tender.currency);
    fd.set("tenderAmount", payload.tender.amount);
    fd.set("method", payload.method);
    if (payload.notes) fd.set("notes", payload.notes);
    fd.set("submissionId", submissionId);
    return fd;
  }

  /** The CONFIRMED-SLATE reset (point 2) — only ever called for a terminal, genuinely confirmed outcome
   * (freshSuccess/replaySuccess/freshCapture/replayCapture). An ordinary business refusal never calls this: the
   * owner's typed draft survives so they can fix one field and resubmit. */
  function resetForm() {
    setSelectedStudentId("");
    setAmount("");
    setReceivedOnTouched(false);
    setReceivedOn(browserTodayIso());
    setBranchToday(null);
    setNotes("");
    setObligations(null);
    setSelectedObligationIds(new Set());
    setFormError(null);
    setObligationsError(null);
    setObligationsErrorSource(null);
  }

  const canSubmit = !locked && !obligationsError && !mixedCurrency && isPrefixSelection && selectedObligationIds.size > 0 && amount.trim() !== "";

  async function runWrite(submissionId: string, formData: FormData, isRecoveryRetry: boolean) {
    setPhase("submitting");
    setBeginError(null);
    let settled: { status: "fulfilled"; value: Awaited<ReturnType<typeof recordPayment>> } | { status: "rejected"; reason: unknown };
    try {
      const value = await recordPayment(organizationId, {}, formData);
      settled = { status: "fulfilled", value };
    } catch (reason) {
      settled = { status: "rejected", reason };
    }
    if (settled.status === "rejected") {
      // Uncertain — never claimed as safe to retry automatically. Preserved, locked, routed to recovery.
      setOutcome({ source: "write", classification: { kind: "rejected" } });
      setPhase("recoveryBlocked");
      return;
    }

    const classification = classifyWriteResult(settled.value, { isRecoveryRetry });

    // Point 1 (the core bug): the classification genuinely controls phase. A recoveryBlocked/payloadMismatch
    // classification NEVER reaches the terminal "outcome" screen — it stays locked, in the SAME recoveryBlocked
    // rendering the recovery-check path already uses.
    if (classification.kind === "recoveryBlocked" || classification.kind === "payloadMismatch") {
      setOutcome({ source: "write", classification });
      setPhase("recoveryBlocked");
      return;
    }

    // Every remaining classification (businessRefusal or a TERMINAL_WRITE_KINDS member) clears the stored identity
    // (round-3 point 1: via the SAME `attemptClear` the recovery-read path uses — a `clearAttempt` failure here used
    // to be silently discarded, advancing as if cleanup had succeeded while the stale entry stayed in `localStorage`
    // under the old key).
    if (classification.kind === "businessRefusal") {
      // Point 2 (prior round): clears only the IDENTITY — the draft (amount/currency/receivedOn/notes/selection) is
      // preserved so the owner can fix one field and resubmit, never retype everything.
      setFormError({ error: classification.error, selectableTotals: classification.selectableTotals, alreadySettledIds: classification.alreadySettledIds });
      attemptClear(submissionId, () => {
        // Another stored attempt may still be queued (rare multi-tab case) — recheck it before unlocking the form.
        popQueueAndContinueOrElse(submissionId, async () => {
          submissionIdRef.current = null;
          if (classification.error === "alreadySettled") {
            await refetchObligationsReconciling(); // round-3 point 3: locked for its own duration, genuinely awaited
          } else {
            setPhase("form");
          }
        });
      });
      return;
    }

    if (TERMINAL_WRITE_KINDS.has(classification.kind)) {
      setOutcome({ source: "write", classification });
      attemptClear(submissionId, () => {
        popQueueAndContinueOrElse(submissionId, () => {
          // Round-3 point 2: the draft is reset only once the identity is CONFIRMED cleared (or, if clearing
          // failed, only once "Finish cleanup" confirms it) — never unconditionally beforehand.
          submissionIdRef.current = null;
          resetForm();
          setPhase("outcome");
        });
      });
    }
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // Defense-in-depth beyond the submit button's own `disabled` (point 3/1): never reachable while locked, while
    // an unresolved stored attempt exists, or while the selection is not a genuine, complete, single-currency
    // oldest-first prefix.
    if (locked || submissionIdRef.current || !canSubmit) return;

    const submissionId = crypto.randomUUID();
    const payload = currentPayload();
    const begin = beginAttempt(organizationId, currentUserId, submissionId, payload);
    if (!begin.ok) {
      // Durable persistence is a hard precondition for submission (§2.4b, corrected) — never "warn then submit
      // anyway". Nothing was sent.
      setBeginError(begin.error);
      return;
    }
    submissionIdRef.current = submissionId;
    // A fresh submission is its own one-item recovery queue (point 4's queue is what handleRetrySafely/
    // handleCheckStatusAgain read from) — without this, a rejected promise from THIS call would have nothing for
    // either handler to act on.
    recoveryQueueRef.current = [submissionId];
    await runWrite(submissionId, buildFormData(payload, submissionId), false);
  }

  function handleRetrySafely() {
    const submissionId = recoveryQueueRef.current[0];
    if (!submissionId) return;
    const read = readAttempt(organizationId, currentUserId, submissionId);
    if (read.status !== "ok") return; // no payload to resend — only the status check remains available
    void runWrite(submissionId, buildFormData(read.payload, submissionId), true);
  }

  function startOver() {
    setOutcome(null);
    setPhase("form");
  }

  function retryObligations() {
    // Round-3 point 3: a reconciliation-sourced error retries the RECONCILING fetch (preserving the current
    // selection, filtered to whatever is still valid) — never the plain fetch, which would reset the selection
    // back to just-the-oldest and discard the very reconciliation this error interrupted.
    if (obligationsErrorSource === "reconcile") {
      void refetchObligationsReconciling();
      return;
    }
    setObligationsRetryNonce((n) => n + 1);
  }

  // ---- outcome copy (brief §2.3/§2.4c) ----
  function renderCaptureGuidance(): React.ReactNode {
    // Point 8: role-aware — a DIRECTOR cannot see the receipt queue section on payments/plans/page.tsx (gated there
    // to ADMIN even though the page itself admits DIRECTOR), so they are never shown a link implying otherwise.
    if (organizationRole === "ADMIN") {
      return (
        <a href={plansHref} className="text-xs underline">
          {t("outcome.capturedAdminLink")}
        </a>
      );
    }
    return <p className="text-xs text-muted-foreground">{t("outcome.capturedDirectorGuidance")}</p>;
  }

  function renderOutcome(display: OutcomeDisplay): React.ReactNode {
    if (display.source === "recovery") {
      const c = display.classification;
      if (c.kind === "committed") {
        const isCapture = c.outcome.kind === "receipt";
        const inner =
          c.outcome.kind === "payment"
            ? c.outcome.currentlyReversed
              ? t("outcome.reversed")
              : t("outcome.success")
            : c.outcome.currentStatus === "PENDING"
              ? t("outcome.capturedPending")
              : c.outcome.currentStatus === "RESOLVED"
                ? t("outcome.capturedResolved")
                : t("outcome.capturedCancelled");
        return (
          <>
            <p role="status" className="text-sm text-ok">
              {inner}
            </p>
            {isCapture && renderCaptureGuidance()}
          </>
        );
      }
      return null; // notFound/authFailure/rejected — handled by the "recoveryBlocked" phase render below
    }
    const c = display.classification;
    switch (c.kind) {
      case "freshSuccess":
        return <p role="status" className="text-sm text-ok">{t("outcome.success")}</p>;
      case "replaySuccess":
        return <p role="status" className={c.currentlyReversed ? "text-sm text-bad" : "text-sm text-ok"}>{c.currentlyReversed ? t("outcome.reversed") : t("outcome.success")}</p>;
      case "freshCapture":
      case "replayCapture": {
        const status = c.kind === "replayCapture" ? c.currentStatus : "PENDING";
        const key = status === "PENDING" ? "capturedPending" : status === "RESOLVED" ? "capturedResolved" : "capturedCancelled";
        return (
          <>
            <p role="status" className="text-sm text-ok">{t(`outcome.${key}`)}</p>
            {renderCaptureGuidance()}
          </>
        );
      }
      case "payloadMismatch":
      case "recoveryBlocked":
      case "rejected":
        return null; // handled by the "recoveryBlocked" phase render below
      case "businessRefusal":
        // businessRefusal no longer reaches phase "outcome" (point 1/2) — kept only so this switch stays exhaustive.
        return null;
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs text-muted-foreground">{t("body")}</p>

      {phase === "storageUnavailable" && (
        <p role="alert" className="text-sm text-bad">
          {t("recovery.storageUnavailable")}
        </p>
      )}

      {beginError && (
        <p role="alert" className="text-sm text-bad">
          {beginError === "alreadyExists" ? t("error.attemptAlreadyExists") : t("error.storageUnavailable")}
        </p>
      )}

      {(phase === "recoveryChecking" || phase === "recoveryBlocked") && (
        <div className="flex flex-col gap-2 rounded-lg border border-border p-3">
          <p className="text-sm">{t("recovery.inProgress")}</p>
          {phase === "recoveryChecking" && <p className="text-xs text-muted-foreground">{t("recovery.checking")}</p>}
          {phase === "recoveryBlocked" && clearFailed && (
            <>
              <p role="alert" className="text-sm text-bad">{t("recovery.clearFailed")}</p>
              <div>
                <Button type="button" variant="outline" onClick={handleFinishCleanup}>
                  {t("recovery.finishCleanup")}
                </Button>
              </div>
            </>
          )}
          {phase === "recoveryBlocked" && !clearFailed && outcome?.source === "recovery" && (
            <>
              <p role="alert" className="text-sm text-bad">
                {outcome.classification.kind === "authFailure" ? t("recovery.blockedAuth") : outcome.classification.kind === "notFound" ? t("recovery.blockedNotFound") : t("recovery.blockedRejected")}
              </p>
              {!storedPayloadReadable && <p className="text-xs text-muted-foreground">{t("recovery.unreadableDraft")}</p>}
              <div className="flex gap-2">
                <Button type="button" variant="outline" onClick={handleCheckStatusAgain}>
                  {t("recovery.checkAgain")}
                </Button>
                {storedPayloadReadable && (
                  <Button type="button" onClick={handleRetrySafely}>
                    {t("recovery.retrySafely")}
                  </Button>
                )}
              </div>
            </>
          )}
          {phase === "recoveryBlocked" && !clearFailed && outcome?.source === "write" && outcome.classification.kind === "recoveryBlocked" && (
            <>
              <p role="alert" className="text-sm text-bad">
                {t("recovery.blockedWrite", { reason: outcome.classification.error })}
              </p>
              <div className="flex gap-2">
                <Button type="button" variant="outline" onClick={handleCheckStatusAgain}>
                  {t("recovery.checkAgain")}
                </Button>
                <Button type="button" onClick={handleRetrySafely}>
                  {t("recovery.retrySafely")}
                </Button>
              </div>
            </>
          )}
          {phase === "recoveryBlocked" && !clearFailed && outcome?.source === "write" && outcome.classification.kind === "payloadMismatch" && (
            // Never offered a "retry safely" affordance (point 1): retrying would resend the identical payload that
            // already mismatched, reproducing the same refusal. Only the read-only status check remains useful.
            <>
              <p role="alert" className="text-sm text-bad">
                {t("outcome.payloadMismatch")}
              </p>
              <div>
                <Button type="button" variant="outline" onClick={handleCheckStatusAgain}>
                  {t("recovery.checkAgain")}
                </Button>
              </div>
            </>
          )}
          {phase === "recoveryBlocked" && !clearFailed && outcome?.source === "write" && outcome.classification.kind === "rejected" && (
            <>
              <p role="alert" className="text-sm text-bad">
                {t("recovery.blockedRejected")}
              </p>
              <div className="flex gap-2">
                <Button type="button" variant="outline" onClick={handleCheckStatusAgain}>
                  {t("recovery.checkAgain")}
                </Button>
                <Button type="button" onClick={handleRetrySafely}>
                  {t("recovery.retrySafely")}
                </Button>
              </div>
            </>
          )}
        </div>
      )}

      {phase === "outcome" && outcome && (
        <div className="flex flex-col gap-2 rounded-lg border border-border p-3">
          {renderOutcome(outcome)}
          <div>
            <Button type="button" variant="outline" onClick={startOver}>
              {t("recordAnother")}
            </Button>
          </div>
        </div>
      )}

      {(phase === "form" || phase === "loadingObligations" || phase === "submitting" || phase === "reconcilingObligations") && (
        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-sm">
            <span>{t("fields.student")}</span>
            <select
              name="studentId"
              required
              disabled={locked}
              value={selectedStudentId}
              onChange={(e) => setSelectedStudentId(e.target.value)}
              className={FIELD_CLASS}
            >
              <option value="" disabled>
                {t("fields.studentPlaceholder")}
              </option>
              {students.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.firstName} {s.lastName} — {s.academyName}
                </option>
              ))}
            </select>
          </label>

          {phase === "loadingObligations" && <p className="text-sm text-muted-foreground">{t("obligations.loading")}</p>}
          {obligationsError && (
            <div className="flex items-center gap-2">
              <p role="alert" className="text-sm text-bad">{t(`error.${obligationsError}`, { defaultValue: t("error.unexpected") })}</p>
              <Button type="button" variant="outline" onClick={retryObligations}>
                {t("obligations.retry")}
              </Button>
            </div>
          )}

          {mixedCurrency && (
            <p role="alert" className="text-sm text-bad">
              {t("obligations.mixedCurrency")}
            </p>
          )}

          {!mixedCurrency && obligations && obligations.length > 0 && (
            <div className="flex flex-col gap-2">
              <ul className="flex flex-col gap-2">
                {obligations.map((o) => (
                  <li key={o.obligationId} className="flex items-center justify-between gap-2 rounded-lg border border-border p-2 text-sm">
                    <label className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={selectedObligationIds.has(o.obligationId)}
                        disabled={locked}
                        onChange={() => toggleObligation(o.obligationId)}
                      />
                      <span>
                        {o.coverageYear}-{String(o.coverageMonth).padStart(2, "0")} ({t(`obligations.type.${o.type}`)})
                      </span>
                    </label>
                    <span>{o.outstandingAmountMinor / 100} {o.currency}</span>
                  </li>
                ))}
              </ul>
              {!isPrefixSelection && (
                <p role="alert" className="text-sm text-bad">
                  {t("obligations.notOldestFirst")}
                </p>
              )}
              <p className="text-sm font-medium">{t("obligations.todaysTotal", { amount: (todaysTotalMinor / 100).toFixed(2) })}</p>
              {branchToday && receivedOn !== calendarDateToIso(branchToday) && <p className="text-xs text-muted-foreground">{t("obligations.backdatedDisclaimer")}</p>}
            </div>
          )}
          {!mixedCurrency && obligations && obligations.length === 0 && selectedStudentId && (
            <p className="text-sm text-muted-foreground">{t("obligations.none")}</p>
          )}

          {formError && (
            <div className="flex flex-col gap-1">
              <p role="alert" className="text-sm text-bad">{t(`error.${formError.error}`, { defaultValue: t("error.unexpected") })}</p>
              {formError.alreadySettledIds && formError.alreadySettledIds.length > 0 && (
                <p className="text-xs text-muted-foreground">{t("error.alreadySettledDetail", { ids: formError.alreadySettledIds.join(", ") })}</p>
              )}
              {formError.selectableTotals && formError.selectableTotals.length > 0 && (
                <p className="text-xs text-muted-foreground">{t("error.selectableTotalsDetail", { totals: formError.selectableTotals.join(", ") })}</p>
              )}
            </div>
          )}

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1 text-sm">
              <span>{t("fields.amount")}</span>
              <Input type="text" inputMode="decimal" required disabled={locked} value={amount} onChange={(e) => setAmount(e.target.value)} />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span>{t("fields.currency")}</span>
              <select className={FIELD_CLASS} disabled={locked} value={currency} onChange={(e) => setCurrency(e.target.value as Currency)}>
                {CURRENCIES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span>{t("fields.receivedOn")}</span>
              <Input
                type="date"
                required
                disabled={locked}
                value={receivedOn}
                onChange={(e) => {
                  setReceivedOnTouched(true);
                  setReceivedOn(e.target.value);
                }}
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span>{t("fields.method")}</span>
              <select className={FIELD_CLASS} disabled={locked} value={method} onChange={(e) => setMethod(e.target.value as PaymentMethod)}>
                {METHODS.map((m) => (
                  <option key={m} value={m}>
                    {tMethod(m)}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label className="flex flex-col gap-1 text-sm">
            <span>{t("fields.notes")}</span>
            <Input type="text" maxLength={500} disabled={locked} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </label>

          <div>
            <Button type="submit" disabled={!canSubmit}>
              {phase === "submitting" ? t("submitting") : t("submit")}
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}
