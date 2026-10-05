"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { FIELD_CLASS, Input } from "@/components/ui/input";
import { recordPayment, checkSubmissionOutcome, getPayableObligations } from "@/lib/dues/payment-entry-actions";
import { beginAttempt, readAttempt, clearAttempt, listStoredAttemptIds, type StoredAttemptPayload } from "@/lib/dues/payment-attempt-storage";
import { classifyWriteResult, classifyRecoveryCheck, shouldClearAfterWrite, shouldClearAfterRecoveryCheck, type WriteOutcomeClassification, type RecoveryCheckClassification } from "@/lib/dues/payment-entry-recovery";
import { CURRENCIES } from "@/lib/payments/format-money";
import type { PayableObligation } from "@/lib/dues/payment-entry-queries";
import type { Currency, PaymentMethod } from "@/generated/prisma/client";

/**
 * Ordinary payment-entry UI brief §2/§8/§10: the new, functionally-integrated ledger payment card for
 * `payments/page.tsx` (§0 — never `payments/plans/page.tsx`). Deliberately does NOT reuse `useDuesAction`
 * (`dues-config-forms.tsx:27-41` has no rejected-promise handling and resets the form on any truthy `result.ok`,
 * including a reversed-payment replay) — this component owns its own submit/recovery state machine, built on the
 * same visual primitives (`TextField`-equivalent inputs, `Button`) and the same `startTransition`-free manual
 * busy/error/ok pattern `ReceiptRow` (`awaiting-rate-receipt-list.tsx`) already establishes for a form that must
 * route a rejected promise into recovery rather than lose it.
 */

const METHODS: PaymentMethod[] = ["EFECTIVO", "SINPE", "TRANSFERENCIA", "TARJETA"];

function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

type Student = { id: string; firstName: string; lastName: string; academyId: string; academyName: string };

type Phase =
  | "form"
  | "loadingObligations"
  | "submitting"
  | "recoveryChecking"
  | "recoveryBlocked"
  | "outcome";

type OutcomeDisplay = { source: "write"; classification: WriteOutcomeClassification } | { source: "write"; classification: { kind: "rejected" } } | { source: "recovery"; classification: RecoveryCheckClassification };

export function PaymentEntrySection({ organizationId, currentUserId, students }: { organizationId: string; currentUserId: string; students: Student[] }) {
  const t = useTranslations("payments.ledgerEntry");
  const tMethod = useTranslations("payments.method");

  const [phase, setPhase] = useState<Phase>("form");
  const [selectedStudentId, setSelectedStudentId] = useState("");
  const [obligations, setObligations] = useState<PayableObligation[] | null>(null);
  const [mixedCurrency, setMixedCurrency] = useState(false);
  const [obligationsError, setObligationsError] = useState<string | null>(null);
  const [selectedObligationIds, setSelectedObligationIds] = useState<Set<string>>(new Set());

  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState<Currency>("USD");
  const [receivedOn, setReceivedOn] = useState(todayIso());
  const [method, setMethod] = useState<PaymentMethod>("EFECTIVO");
  const [notes, setNotes] = useState("");

  const [outcome, setOutcome] = useState<OutcomeDisplay | null>(null);
  const [storedPayloadReadable, setStoredPayloadReadable] = useState(true);
  const [beginError, setBeginError] = useState<"alreadyExists" | "storageUnavailable" | null>(null);

  const submissionIdRef = useRef<string | null>(null);
  // Guards a stale fetch (a student change while a prior fetch is in flight) from overwriting newer state —
  // the same discriminator-based discard `ReceiptQueueList` already uses for its own tab-switch race.
  const obligationsRequestRef = useRef(0);

  const locked = phase === "recoveryChecking" || phase === "recoveryBlocked" || phase === "submitting";

  async function runRecoveryCheck(submissionId: string) {
    setPhase("recoveryChecking");
    const settled = (await Promise.allSettled([checkSubmissionOutcome(organizationId, submissionId)]))[0];
    const classification = classifyRecoveryCheck(settled);
    if (shouldClearAfterRecoveryCheck(classification)) {
      clearAttempt(organizationId, currentUserId, submissionId);
      submissionIdRef.current = null;
      setOutcome({ source: "recovery", classification });
      setPhase("outcome");
      return;
    }
    setOutcome({ source: "recovery", classification });
    setPhase("recoveryBlocked");
  }

  // Reload-recovery mount check (brief §2.4b): never auto-cleared, never auto-retried — the owner sees the blocked
  // state and chooses to check status or retry.
  useEffect(() => {
    const ids = listStoredAttemptIds(organizationId, currentUserId);
    if (ids.length === 0) return;
    const submissionId = ids[0];
    submissionIdRef.current = submissionId;
    const read = readAttempt(organizationId, currentUserId, submissionId);
    setStoredPayloadReadable(read.status === "ok");
    void runRecoveryCheck(submissionId);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only
  }, []);

  useEffect(() => {
    if (!selectedStudentId) {
      setObligations(null);
      setSelectedObligationIds(new Set());
      return;
    }
    const requestId = ++obligationsRequestRef.current;
    setPhase("loadingObligations");
    setObligationsError(null);
    getPayableObligations(organizationId, selectedStudentId)
      .then((result) => {
        if (obligationsRequestRef.current !== requestId) return;
        if (!result.ok) {
          setObligationsError(result.error);
          setObligations([]);
          setMixedCurrency(false);
        } else {
          setObligations(result.obligations);
          setMixedCurrency(result.mixedCurrency);
          // Default-check the oldest unselected run (§2.1) — the single oldest item only; the owner extends the
          // selection themselves for a longer run, and a non-prefix selection is flagged before submission.
          setSelectedObligationIds(result.obligations.length > 0 ? new Set([result.obligations[0].obligationId]) : new Set());
        }
        setPhase((p) => (p === "loadingObligations" ? "form" : p));
      })
      .catch(() => {
        if (obligationsRequestRef.current !== requestId) return;
        setObligationsError("transportFailure");
        setObligations([]);
        setPhase((p) => (p === "loadingObligations" ? "form" : p));
      });
  }, [organizationId, selectedStudentId]);

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

  function resetForm() {
    setSelectedStudentId("");
    setAmount("");
    setReceivedOn(todayIso());
    setNotes("");
    setObligations(null);
    setSelectedObligationIds(new Set());
  }

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
    if (shouldClearAfterWrite(classification)) {
      clearAttempt(organizationId, currentUserId, submissionId);
      submissionIdRef.current = null;
      resetForm();
    }
    setOutcome({ source: "write", classification });
    setPhase("outcome");
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (selectedObligationIds.size === 0) return;

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
    await runWrite(submissionId, buildFormData(payload, submissionId), false);
  }

  function handleRetrySafely() {
    const submissionId = submissionIdRef.current;
    if (!submissionId) return;
    const read = readAttempt(organizationId, currentUserId, submissionId);
    if (read.status !== "ok") return; // no payload to resend — only the status check remains available
    void runWrite(submissionId, buildFormData(read.payload, submissionId), true);
  }

  function handleCheckStatusAgain() {
    const submissionId = submissionIdRef.current;
    if (!submissionId) return;
    void runRecoveryCheck(submissionId);
  }

  function startOver() {
    setOutcome(null);
    setPhase("form");
  }

  // ---- outcome copy (brief §2.3/§2.4c) ----
  function renderOutcome(display: OutcomeDisplay): React.ReactNode {
    if (display.source === "recovery") {
      const c = display.classification;
      if (c.kind === "committed") {
        const inner = c.outcome.kind === "payment"
          ? c.outcome.currentlyReversed
            ? t("outcome.reversed")
            : t("outcome.success")
          : c.outcome.currentStatus === "PENDING"
            ? t("outcome.capturedPending")
            : c.outcome.currentStatus === "RESOLVED"
              ? t("outcome.capturedResolved")
              : t("outcome.capturedCancelled");
        return (
          <p role="status" className="text-sm text-ok">
            {inner}
          </p>
        );
      }
      return null; // handled by the "recoveryBlocked" phase render below
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
        return <p role="status" className="text-sm text-ok">{t(`outcome.${key}`)}</p>;
      }
      case "payloadMismatch":
        return <p role="alert" className="text-sm text-bad">{t("outcome.payloadMismatch")}</p>;
      case "businessRefusal":
        return <p role="alert" className="text-sm text-bad">{t(`error.${c.error}`, { defaultValue: t("error.unexpected") })}</p>;
      case "recoveryBlocked":
        return null; // handled by the "recoveryBlocked" phase render below
    }
  }

  const canRecordMore = phase === "outcome" || phase === "form";

  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs text-muted-foreground">{t("body")}</p>

      {beginError && (
        <p role="alert" className="text-sm text-bad">
          {beginError === "alreadyExists" ? t("error.attemptAlreadyExists") : t("error.storageUnavailable")}
        </p>
      )}

      {(phase === "recoveryChecking" || phase === "recoveryBlocked") && (
        <div className="flex flex-col gap-2 rounded-lg border border-border p-3">
          <p className="text-sm">{t("recovery.inProgress")}</p>
          {phase === "recoveryChecking" && <p className="text-xs text-muted-foreground">{t("recovery.checking")}</p>}
          {phase === "recoveryBlocked" && outcome?.source === "recovery" && (
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
          {phase === "recoveryBlocked" && outcome?.source === "write" && outcome.classification.kind === "recoveryBlocked" && (
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
          {phase === "recoveryBlocked" && outcome?.source === "write" && outcome.classification.kind === "rejected" && (
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
          {canRecordMore && (
            <div>
              <Button type="button" variant="outline" onClick={startOver}>
                {t("recordAnother")}
              </Button>
            </div>
          )}
        </div>
      )}

      {(phase === "form" || phase === "loadingObligations" || phase === "submitting") && (
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
          {obligationsError && <p role="alert" className="text-sm text-bad">{t(`error.${obligationsError}`, { defaultValue: t("error.unexpected") })}</p>}

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
              {receivedOn !== todayIso() && <p className="text-xs text-muted-foreground">{t("obligations.backdatedDisclaimer")}</p>}
            </div>
          )}
          {!mixedCurrency && obligations && obligations.length === 0 && selectedStudentId && (
            <p className="text-sm text-muted-foreground">{t("obligations.none")}</p>
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
              <Input type="date" required disabled={locked} value={receivedOn} onChange={(e) => setReceivedOn(e.target.value)} />
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
            <Button type="submit" disabled={locked || selectedObligationIds.size === 0 || !amount}>
              {phase === "submitting" ? t("submitting") : t("submit")}
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}
