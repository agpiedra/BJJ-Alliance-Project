"use client";

import { useRef, useState, useEffect } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { FIELD_CLASS, Input } from "@/components/ui/input";
import { checkSubmissionOutcome, getPayableObligations } from "@/lib/dues/payment-entry-actions";
import { prepayMonths, getFirstAvailablePrepaymentMonth, getMonthPrices } from "@/lib/dues/prepayment-actions";
import { beginAttempt, readPrepaymentAttempt, clearAttempt, scanAttemptsByOperation, useHasUnresolvedUnclassifiable, type StoredPrepaymentAttemptPayload } from "@/lib/dues/payment-attempt-storage";
import { classifyWriteResult, classifyRecoveryCheck, shouldClearAfterRecoveryCheck, type WriteOutcomeClassification, type RecoveryCheckClassification } from "@/lib/dues/payment-entry-recovery";
import { CURRENCIES } from "@/lib/payments/format-money";
import { decimalToMinor } from "@/lib/dues/ledger/minor-units";
import { compareYearMonth } from "@/lib/dues/calendar";
import type { MonthPrice } from "@/lib/dues/prepayment-queries";
import type { PayableObligation } from "@/lib/dues/payment-entry-queries";
import type { CalendarDate, YearMonth } from "@/lib/dues/calendar";
import type { Currency, PaymentMethod } from "@/generated/prisma/client";

/**
 * Monthly-prepayment UI brief §2/§5: the third, SEPARATE card for `payments/page.tsx` — ADMIN only (matching
 * `prepayMonthlyObligationsWithSubmissionIdentity`'s own hard-coded ADMIN-only check), mounted alongside (never
 * replacing) the ordinary ledger and package-purchase cards. Deliberately mirrors `package-purchase-section.tsx`'s
 * own submit/recovery state machine structure (itself mirroring `payment-entry-section.tsx`) rather than inventing a
 * new one. Reuses `classifyWriteResult`/`classifyRecoveryCheck`/`shouldClearAfterRecoveryCheck` directly against
 * `prepayMonthlyObligationsWithSubmissionIdentity`'s own result shape (already covered by the generic
 * `GenericSubmissionWriteResult` type — zero classifier changes needed) and `checkSubmissionOutcome`/
 * `getPayableObligations` directly, rather than duplicating either.
 *
 * The ONE genuinely new piece: the month-list is built via "add next month"/"remove last month" against a running,
 * always-consecutive list (never a free multi-select, since the writer refuses a non-consecutive set outright), and
 * each month's own price is resolved independently (a scheduled price change mid-span is real — see
 * `prepayment-queries.ts`'s own doc comment).
 */

const METHODS: PaymentMethod[] = ["EFECTIVO", "SINPE", "TRANSFERENCIA", "TARJETA"];

function browserTodayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function calendarDateToIso(d: CalendarDate): string {
  return `${d.year}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`;
}
function yearMonthToIso(m: YearMonth): string {
  return `${m.year}-${String(m.month).padStart(2, "0")}`;
}
function monthKey(m: YearMonth): string {
  return yearMonthToIso(m);
}
function nextMonthAfter(m: YearMonth): YearMonth {
  return m.month === 12 ? { year: m.year + 1, month: 1 } : { year: m.year, month: m.month + 1 };
}

type Student = { id: string; firstName: string; lastName: string; academyId: string; academyName: string };

type Phase =
  | "form"
  | "loadingStudentData"
  | "submitting"
  | "recoveryChecking"
  | "recoveryBlocked"
  | "outcome"
  | "storageUnavailable"
  /** A `debtNotFullySettled`/`coverageGap`/`alreadySettled` refusal's own re-fetch-and-reconcile of the existing-debt
   * display (and, for `coverageGap`, the advisory+horizon too) — this card's equivalent of the package card's
   * `reconcilingDebt`. There is no `reconcilingTerms` equivalent here: prepayment has no fixed, pre-chosen "terms id"
   * that can go stale the way a package's selected plan can — each month's price is always resolved fresh. */
  | "reconcilingDebt";

type OutcomeDisplay = { source: "write"; classification: WriteOutcomeClassification | { kind: "rejected" } } | { source: "recovery"; classification: RecoveryCheckClassification };

type FormError = { error: string; selectableTotals?: string[]; alreadySettledIds?: string[] };

const TERMINAL_WRITE_KINDS = new Set(["freshSuccess", "replaySuccess", "freshCapture", "replayCapture"]);

const RECONCILES_DEBT = new Set(["debtNotFullySettled", "coverageGap", "alreadySettled"]);

export function PrepaymentSection({
  organizationId,
  currentUserId,
  students,
  plansHref,
}: {
  organizationId: string;
  currentUserId: string;
  students: Student[];
  plansHref: string;
}) {
  const t = useTranslations("payments.prepayment");
  const tMethod = useTranslations("payments.method");

  const [phase, setPhase] = useState<Phase>("form");
  const [selectedStudentId, setSelectedStudentId] = useState("");

  const [requestedMonths, setRequestedMonths] = useState<YearMonth[]>([]);
  const [advisoryMonth, setAdvisoryMonth] = useState<YearMonth | null>(null);
  const [horizonEnd, setHorizonEnd] = useState<YearMonth | null>(null);
  // Corrected: a genuine `{ok:true, month:null, horizonEnd:null}` response ("no policy configured") and a mere
  // fetch REJECTION were previously indistinguishable (both just set a single `advisoryLoaded` boolean) — a network
  // failure falsely rendered "prepayment isn't available" and left "Add next month" permanently disabled with no
  // retry. Only the `"success"` branch below may ever write `advisoryMonth`/`horizonEnd`, including `null`.
  const [advisoryStatus, setAdvisoryStatus] = useState<"loading" | "success" | "failed">("loading");
  const [monthPrices, setMonthPrices] = useState<MonthPrice[] | null>(null);
  const [monthPricesLoading, setMonthPricesLoading] = useState(false);

  const [obligations, setObligations] = useState<PayableObligation[] | null>(null);
  const [mixedCurrency, setMixedCurrency] = useState(false);
  const [obligationsError, setObligationsError] = useState<string | null>(null);
  const [obligationsErrorSource, setObligationsErrorSource] = useState<"fetch" | "reconcile" | null>(null);
  const [studentDataRetryNonce, setStudentDataRetryNonce] = useState(0);

  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState<Currency>("USD");
  const [receivedOn, setReceivedOn] = useState(browserTodayIso());
  const [branchToday, setBranchToday] = useState<CalendarDate | null>(null);
  const [method, setMethod] = useState<PaymentMethod>("EFECTIVO");
  const [notes, setNotes] = useState("");

  const [outcome, setOutcome] = useState<OutcomeDisplay | null>(null);
  const [formError, setFormError] = useState<FormError | null>(null);
  const [storedPayloadReadable, setStoredPayloadReadable] = useState(true);
  const [beginError, setBeginError] = useState<"alreadyExists" | "storageUnavailable" | null>(null);
  const [clearFailed, setClearFailed] = useState(false);
  // Cross-card submission-blocking correction (extended to a third card): this card NEVER processes an
  // unclassifiable entry itself (that stays the ordinary card's sole recovery responsibility) — it only OBSERVES
  // the shared, storage-backed signal to block its own submit while one is unresolved.
  const blockedByUnresolvedUnclassifiable = useHasUnresolvedUnclassifiable(organizationId, currentUserId);

  const submissionIdRef = useRef<string | null>(null);
  const recoveryQueueRef = useRef<string[]>([]);
  const studentDataRequestRef = useRef(0);
  const monthPricesRequestRef = useRef(0);
  // `receivedOnTouched` is intentionally a REF here, never state read via closure — a confirmed, reachable defect
  // exists in BOTH already-shipped cards (`payment-entry-section.tsx`/`package-purchase-section.tsx` still read a
  // STATE value inside their own `getPayableObligations(...).then()`, stale by construction since neither effect
  // resets it on a student change) where a late response can overwrite a date the owner already edited. Left
  // unfixed there (out of scope for this PR, reported separately) — never copied into this new file.
  const receivedOnTouchedRef = useRef(false);
  // Same discipline as `package-purchase-section.tsx`'s own `requestedStartMonthTouchedRef`: once the owner has
  // manually built their own month list (add/remove), the advisory fetch's auto-seed must never run again,
  // regardless of the list's current length (even back down to zero).
  const monthsTouchedRef = useRef(false);
  const pendingClearRef = useRef<{ id: string; onSuccess: () => void | Promise<void> } | null>(null);

  const locked =
    phase === "recoveryChecking" ||
    phase === "recoveryBlocked" ||
    phase === "submitting" ||
    phase === "loadingStudentData" ||
    phase === "storageUnavailable" ||
    phase === "reconcilingDebt";

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
    if (!cleared.ok) return;
    pendingClearRef.current = null;
    setClearFailed(false);
    void pending.onSuccess();
  }

  function popQueueAndContinueOrElse(id: string, otherwise: () => void | Promise<void>) {
    if (recoveryQueueRef.current[0] === id) recoveryQueueRef.current = recoveryQueueRef.current.slice(1);
    if (recoveryQueueRef.current.length > 0) {
      void resolveQueueHead();
      return;
    }
    void otherwise();
  }

  async function resolveQueueHead(): Promise<void> {
    const id = recoveryQueueRef.current[0];
    if (!id) return;
    submissionIdRef.current = id;
    setClearFailed(false);
    const read = readPrepaymentAttempt(organizationId, currentUserId, id);
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
      popQueueAndContinueOrElse(id, () => {
        submissionIdRef.current = null;
        resetForm();
        setPhase("outcome");
      });
    });
  }

  useEffect(() => {
    // This card scans for ITS OWN operation only — `otherOperations` (the other two cards' own entries) is never
    // read or acted on here, and `unclassifiable` is the ordinary card's SOLE responsibility — never referenced here.
    const scanned = scanAttemptsByOperation(organizationId, currentUserId, "PREPAYMENT");
    if (scanned.status === "unavailable") {
      setPhase("storageUnavailable");
      return;
    }
    if (scanned.matching.length === 0) return;
    recoveryQueueRef.current = scanned.matching;
    void resolveQueueHead();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only
  }, []);

  function handleCheckStatusAgain() {
    if (recoveryQueueRef.current.length === 0) return;
    void resolveQueueHead();
  }

  // ---- student data fetch: advisory+horizon, existing debt ----

  /** Shared by the mount/student-change effect below AND the scoped `retryAdvisory` (issue 1's own fix) — the SAME
   * fetch-and-apply logic either way, so the two paths can never drift. Never resets `requestedMonths`/
   * `monthsTouchedRef` itself (that's the caller's job, only on a genuine student change) — a retry must preserve
   * whatever the owner has already deliberately built. */
  function fetchAdvisory(requestId: number) {
    getFirstAvailablePrepaymentMonth(organizationId, selectedStudentId)
      .then((result) => {
        if (studentDataRequestRef.current !== requestId) return;
        if (result.ok) {
          setAdvisoryStatus("success");
          setAdvisoryMonth(result.month);
          setHorizonEnd(result.horizonEnd);
          if (result.month && !monthsTouchedRef.current) setRequestedMonths([result.month]);
        } else {
          setAdvisoryStatus("failed");
        }
      })
      .catch(() => {
        if (studentDataRequestRef.current !== requestId) return;
        setAdvisoryStatus("failed");
      });
  }

  /** Advisory-only retry (issue 1): re-fires JUST the advisory fetch, under the SAME `studentDataRequestRef`
   * discriminator (so a meanwhile student-switch still correctly discards a stale response), WITHOUT touching
   * `requestedMonths`/`monthsTouchedRef` — a deliberately-built month list must survive a retry of the suggestion
   * that merely seeds it. */
  function retryAdvisory() {
    if (!selectedStudentId) return;
    setAdvisoryStatus("loading");
    fetchAdvisory(studentDataRequestRef.current);
  }

  useEffect(() => {
    setRequestedMonths([]);
    monthsTouchedRef.current = false;
    setAdvisoryMonth(null);
    setHorizonEnd(null);
    setAdvisoryStatus("loading");
    setObligations(null);
    setMixedCurrency(false);
    setObligationsError(null);
    setObligationsErrorSource(null);
    setFormError(null);
    if (!selectedStudentId) return;
    const requestId = ++studentDataRequestRef.current;
    setPhase("loadingStudentData");

    fetchAdvisory(requestId);

    getPayableObligations(organizationId, selectedStudentId)
      .then((result) => {
        if (studentDataRequestRef.current !== requestId) return;
        if (!result.ok) {
          setObligationsError(result.error);
          setObligationsErrorSource("fetch");
          setObligations([]);
          setMixedCurrency(false);
        } else {
          setObligations(result.obligations);
          setMixedCurrency(result.mixedCurrency);
          setBranchToday(result.todayLocal);
          // Reads the REF, never a closed-over state value — see `receivedOnTouchedRef`'s own doc comment above.
          if (!receivedOnTouchedRef.current) setReceivedOn(calendarDateToIso(result.todayLocal));
        }
        setPhase((p) => (p === "loadingStudentData" ? "form" : p));
      })
      .catch(() => {
        if (studentDataRequestRef.current !== requestId) return;
        setObligationsError("transportFailure");
        setObligationsErrorSource("fetch");
        setObligations([]);
        setPhase((p) => (p === "loadingStudentData" ? "form" : p));
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fetchAdvisory is recreated every render reading current closure state; including it would re-run this effect on every render
  }, [organizationId, selectedStudentId, studentDataRetryNonce]);

  // ---- per-month price fetch: re-runs whenever the running month list itself changes ----

  /** Shared by the effect below and `retryMonthPrices` (issue 2's own fix) — re-fires for whatever `requestedMonths`
   * currently is. Bumping `monthPricesRequestRef` here (not just in the effect) is what lets a manual retry
   * correctly invalidate itself if the list changes again before it resolves. */
  function runMonthPricesFetch() {
    const requestId = ++monthPricesRequestRef.current;
    if (!selectedStudentId || requestedMonths.length === 0) {
      setMonthPrices(null);
      setMonthPricesLoading(false);
      return;
    }
    setMonthPricesLoading(true);
    getMonthPrices(organizationId, selectedStudentId, requestedMonths)
      .then((result) => {
        if (monthPricesRequestRef.current !== requestId) return;
        setMonthPricesLoading(false);
        setMonthPrices(result.ok ? result.prices : null);
      })
      .catch(() => {
        if (monthPricesRequestRef.current !== requestId) return;
        setMonthPricesLoading(false);
        setMonthPrices(null);
      });
  }

  useEffect(() => {
    runMonthPricesFetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runMonthPricesFetch itself reads current closure state; re-running on its identity would defeat the point
  }, [organizationId, selectedStudentId, requestedMonths]);

  function retryMonthPrices() {
    runMonthPricesFetch();
  }

  function addNextMonth() {
    monthsTouchedRef.current = true;
    setRequestedMonths((prev) => {
      const next = prev.length === 0 ? advisoryMonth : nextMonthAfter(prev[prev.length - 1]);
      if (!next) return prev;
      return [...prev, next];
    });
  }
  function removeLastMonth() {
    monthsTouchedRef.current = true;
    setRequestedMonths((prev) => prev.slice(0, -1));
  }

  const nextCandidateMonth = requestedMonths.length === 0 ? advisoryMonth : nextMonthAfter(requestedMonths[requestedMonths.length - 1]);
  const addNextDisabled = locked || !nextCandidateMonth || (horizonEnd !== null && compareYearMonth(nextCandidateMonth, horizonEnd) > 0);
  // Only a SUCCESSFUL response may ever establish "no available month" / "no configured horizon" — a FAILED fetch
  // renders its own distinct error + retry below instead (issue 1's own fix).
  const prepaymentUnavailable = advisoryStatus === "success" && advisoryMonth === null && horizonEnd === null && requestedMonths.length === 0;

  /** brief §2.9: a `debtNotFullySettled`/`coverageGap`/`alreadySettled` refusal's own re-fetch of the (forced,
   * non-deselectable) existing-debt display. Locked (`reconcilingDebt`), genuinely awaited, discriminator-protected —
   * the package card's own `refetchObligationsReconciling` exactly, applied here. */
  async function refetchObligationsReconciling(): Promise<void> {
    if (!selectedStudentId) {
      setPhase("form");
      return;
    }
    const requestId = ++studentDataRequestRef.current;
    setPhase("reconcilingDebt");
    try {
      const result = await getPayableObligations(organizationId, selectedStudentId);
      if (studentDataRequestRef.current !== requestId) return;
      if (!result.ok) {
        setObligationsError(result.error);
        setObligationsErrorSource("reconcile");
        setPhase("form");
        return;
      }
      setObligations(result.obligations);
      setMixedCurrency(result.mixedCurrency);
      setObligationsError(null);
      setObligationsErrorSource(null);
      setPhase("form");
    } catch {
      if (studentDataRequestRef.current !== requestId) return;
      setObligationsError("transportFailure");
      setObligationsErrorSource("reconcile");
      setPhase("form");
    }
  }

  function retryStudentData() {
    if (obligationsErrorSource === "reconcile") {
      void refetchObligationsReconciling();
      return;
    }
    setStudentDataRetryNonce((n) => n + 1);
  }

  // ---- totals (brief §2.3, corrected): per-currency, debt grouped with each resolved month's OWN price, never
  // blended — and NEVER labeled the complete "estimated total" unless every selected month genuinely has a
  // resolved, non-error price for the CURRENT list. Issue 2's own fix: the old version summed whatever `monthPrices`
  // currently held regardless of whether it was still loading/stale for the list that produced it, or silently
  // skipped an `inapplicable` month — either way it could present an incomplete number as if it were the full total.

  type TotalsResult =
    | { status: "loading" }
    | { status: "failed" }
    | { status: "complete"; totals: Array<{ currency: string; totalMinor: number }> }
    | { status: "partial"; totals: Array<{ currency: string; totalMinor: number }>; pricedCount: number; totalCount: number };

  function sumDebtPlus(priced: Array<{ currency: string; priceAmount: string }>): Array<{ currency: string; totalMinor: number }> {
    const totals = new Map<string, number>();
    for (const o of obligations ?? []) totals.set(o.currency, (totals.get(o.currency) ?? 0) + o.outstandingAmountMinor);
    for (const p of priced) totals.set(p.currency, (totals.get(p.currency) ?? 0) + decimalToMinor(p.priceAmount));
    return [...totals.entries()].map(([entryCurrency, totalMinor]) => ({ currency: entryCurrency, totalMinor }));
  }

  function computeTotalsResult(): TotalsResult {
    if (requestedMonths.length === 0) return { status: "complete", totals: sumDebtPlus([]) };
    if (monthPricesLoading) return { status: "loading" };
    if (monthPrices === null) return { status: "failed" };
    const matched = requestedMonths.map((m) => monthPrices.find((p) => monthKey(p.month) === monthKey(m)));
    const priced = matched.filter((p): p is Extract<MonthPrice, { priceAmount: string }> => !!p && !("error" in p));
    if (priced.length === requestedMonths.length) return { status: "complete", totals: sumDebtPlus(priced) };
    return { status: "partial", totals: sumDebtPlus(priced), pricedCount: priced.length, totalCount: requestedMonths.length };
  }
  const totalsResult = computeTotalsResult();

  function currentPayload(): StoredPrepaymentAttemptPayload {
    const [y, m, d] = receivedOn.split("-").map(Number);
    return {
      operation: "PREPAYMENT",
      studentId: selectedStudentId,
      requestedMonths,
      existingObligationIds: (obligations ?? []).map((o) => o.obligationId),
      receivedOn: { year: y, month: m, day: d },
      tender: { currency, amount },
      method,
      notes: notes.trim() === "" ? undefined : notes,
    };
  }

  function buildFormData(payload: StoredPrepaymentAttemptPayload, submissionId: string): FormData {
    const fd = new FormData();
    fd.set("studentId", payload.studentId);
    for (const m of payload.requestedMonths) fd.append("requestedMonths", yearMonthToIso(m));
    for (const id of payload.existingObligationIds) fd.append("existingObligationIds", id);
    fd.set("receivedOn", `${payload.receivedOn.year}-${String(payload.receivedOn.month).padStart(2, "0")}-${String(payload.receivedOn.day).padStart(2, "0")}`);
    fd.set("tenderCurrency", payload.tender.currency);
    fd.set("tenderAmount", payload.tender.amount);
    fd.set("method", payload.method);
    if (payload.notes) fd.set("notes", payload.notes);
    fd.set("submissionId", submissionId);
    return fd;
  }

  function resetForm() {
    // Invalidates any student-data fetch still in flight for the student/selection being cleared here.
    studentDataRequestRef.current++;
    setSelectedStudentId("");
    setRequestedMonths([]);
    monthsTouchedRef.current = false;
    setAdvisoryMonth(null);
    setHorizonEnd(null);
    setAdvisoryStatus("loading");
    setAmount("");
    receivedOnTouchedRef.current = false;
    setReceivedOn(browserTodayIso());
    setBranchToday(null);
    setNotes("");
    setObligations(null);
    setFormError(null);
    setObligationsError(null);
    setObligationsErrorSource(null);
  }

  const canSubmit =
    !locked &&
    !blockedByUnresolvedUnclassifiable &&
    !obligationsError &&
    !mixedCurrency &&
    requestedMonths.length > 0 &&
    amount.trim() !== "";

  async function runWrite(submissionId: string, formData: FormData, isRecoveryRetry: boolean) {
    setPhase("submitting");
    setBeginError(null);
    let settled: { status: "fulfilled"; value: Awaited<ReturnType<typeof prepayMonths>> } | { status: "rejected"; reason: unknown };
    try {
      const value = await prepayMonths(organizationId, {}, formData);
      settled = { status: "fulfilled", value };
    } catch (reason) {
      settled = { status: "rejected", reason };
    }
    if (settled.status === "rejected") {
      setOutcome({ source: "write", classification: { kind: "rejected" } });
      setPhase("recoveryBlocked");
      return;
    }

    const classification = classifyWriteResult(settled.value, { isRecoveryRetry });

    if (classification.kind === "recoveryBlocked" || classification.kind === "payloadMismatch") {
      setOutcome({ source: "write", classification });
      setPhase("recoveryBlocked");
      return;
    }

    if (classification.kind === "businessRefusal") {
      setFormError({ error: classification.error, selectableTotals: classification.selectableTotals, alreadySettledIds: classification.alreadySettledIds });
      attemptClear(submissionId, () => {
        popQueueAndContinueOrElse(submissionId, async () => {
          submissionIdRef.current = null;
          if (RECONCILES_DEBT.has(classification.error)) {
            await refetchObligationsReconciling();
            if (classification.error === "coverageGap") {
              // Deliberately NOT `fetchAdvisory` (issue 1's fix, used by the mount/student-change effect and its own
              // retry): that helper auto-seeds `requestedMonths` from the advisory when untouched, which would
              // silently replace the very selection the owner just submitted — out of scope for this reconciliation
              // path, unchanged from before. Discriminator-protected exactly like every other fetch in this file.
              const advisoryRequestId = studentDataRequestRef.current;
              void getFirstAvailablePrepaymentMonth(organizationId, selectedStudentId)
                .then((r) => {
                  if (studentDataRequestRef.current !== advisoryRequestId) return;
                  if (r.ok) {
                    setAdvisoryMonth(r.month);
                    setHorizonEnd(r.horizonEnd);
                  }
                })
                .catch(() => {});
            }
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
          submissionIdRef.current = null;
          resetForm();
          setPhase("outcome");
        });
      });
    }
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (locked || blockedByUnresolvedUnclassifiable || submissionIdRef.current || !canSubmit) return;

    const submissionId = crypto.randomUUID();
    const payload = currentPayload();
    const begin = beginAttempt(organizationId, currentUserId, submissionId, payload);
    if (!begin.ok) {
      setBeginError(begin.error);
      return;
    }
    submissionIdRef.current = submissionId;
    recoveryQueueRef.current = [submissionId];
    await runWrite(submissionId, buildFormData(payload, submissionId), false);
  }

  function handleRetrySafely() {
    const submissionId = recoveryQueueRef.current[0];
    if (!submissionId) return;
    const read = readPrepaymentAttempt(organizationId, currentUserId, submissionId);
    if (read.status !== "ok") return;
    void runWrite(submissionId, buildFormData(read.payload, submissionId), true);
  }

  function startOver() {
    setOutcome(null);
    setPhase("form");
  }

  // ---- outcome copy ----
  function renderCaptureGuidance(): React.ReactNode {
    return (
      <a href={plansHref} className="text-xs underline">
        {t("outcome.capturedAdminLink")}
      </a>
    );
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
      return null;
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
        return null;
      case "businessRefusal":
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

      {(phase === "form" || phase === "loadingStudentData" || phase === "submitting" || phase === "reconcilingDebt") && (
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

          {phase === "loadingStudentData" && <p className="text-sm text-muted-foreground">{t("months.loading")}</p>}

          {selectedStudentId && !locked && prepaymentUnavailable && (
            <p role="alert" className="text-sm text-bad">{t("error.prepaymentUnavailable")}</p>
          )}

          {selectedStudentId && !locked && advisoryStatus === "failed" && (
            <div className="flex items-center gap-2">
              <p role="alert" className="text-sm text-bad">{t("error.advisoryFailed")}</p>
              <Button type="button" variant="outline" onClick={retryAdvisory}>
                {t("months.retryAdvisory")}
              </Button>
            </div>
          )}

          {selectedStudentId && (
            <div className="flex flex-col gap-2">
              <span className="text-sm">{t("fields.months")}</span>
              {requestedMonths.length === 0 && <p className="text-sm text-muted-foreground">{t("months.none")}</p>}
              {requestedMonths.length > 0 && (
                <ul className="flex flex-col gap-2">
                  {requestedMonths.map((m) => {
                    const price = monthPrices?.find((p) => monthKey(p.month) === monthKey(m));
                    return (
                      <li key={monthKey(m)} className="flex items-center justify-between gap-2 rounded-lg border border-border p-2 text-sm">
                        <span>{monthKey(m)}</span>
                        {monthPricesLoading && !price && <span className="text-xs text-muted-foreground">{t("months.priceLoading")}</span>}
                        {price && "error" in price && <span className="text-xs text-bad">{t("error.inapplicable")}</span>}
                        {price && !("error" in price) && <span>{price.priceAmount} {price.currency}</span>}
                      </li>
                    );
                  })}
                </ul>
              )}
              <div className="flex gap-2">
                <Button type="button" variant="outline" disabled={addNextDisabled} onClick={addNextMonth}>
                  {t("months.addNext")}
                </Button>
                <Button type="button" variant="outline" disabled={locked || requestedMonths.length === 0} onClick={removeLastMonth}>
                  {t("months.removeLast")}
                </Button>
              </div>
              {advisoryMonth && <p className="text-xs text-muted-foreground">{t("advisory.suggestion", { month: monthKey(advisoryMonth) })}</p>}
            </div>
          )}

          {obligationsError && (
            <div className="flex items-center gap-2">
              <p role="alert" className="text-sm text-bad">{t(`error.${obligationsError}`, { defaultValue: t("error.unexpected") })}</p>
              <Button type="button" variant="outline" onClick={retryStudentData}>
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
              <p className="text-xs text-muted-foreground">{t("obligations.allIncluded")}</p>
              <ul className="flex flex-col gap-2">
                {obligations.map((o) => (
                  <li key={o.obligationId} className="flex items-center justify-between gap-2 rounded-lg border border-border p-2 text-sm">
                    <span>
                      {o.coverageYear}-{String(o.coverageMonth).padStart(2, "0")} ({t(`obligations.type.${o.type}`)})
                    </span>
                    <span>{o.outstandingAmountMinor / 100} {o.currency}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {!mixedCurrency && obligations && obligations.length === 0 && selectedStudentId && (
            <p className="text-sm text-muted-foreground">{t("obligations.none")}</p>
          )}

          {!mixedCurrency && totalsResult.status === "loading" && (
            <p className="text-sm text-muted-foreground">{t("totals.loading")}</p>
          )}
          {!mixedCurrency && totalsResult.status === "failed" && (
            <div className="flex items-center gap-2">
              <p role="alert" className="text-sm text-bad">{t("totals.failed")}</p>
              <Button type="button" variant="outline" onClick={retryMonthPrices}>
                {t("totals.retry")}
              </Button>
            </div>
          )}
          {!mixedCurrency && (totalsResult.status === "complete" || totalsResult.status === "partial") && totalsResult.totals.length > 0 && (
            <div className="flex flex-col gap-1">
              <p className="text-sm font-medium">
                {totalsResult.status === "partial" ? t("totals.partialHeading", { priced: totalsResult.pricedCount, total: totalsResult.totalCount }) : t("totals.heading")}
              </p>
              {totalsResult.totals.map(({ currency: c, totalMinor }) => (
                <p key={c} className="text-sm">{t("totals.line", { amount: (totalMinor / 100).toFixed(2), currency: c })}</p>
              ))}
              <p className="text-xs text-muted-foreground">{totalsResult.status === "partial" ? t("totals.partialDisclaimer") : t("totals.disclaimer")}</p>
              {branchToday && receivedOn !== calendarDateToIso(branchToday) && <p className="text-xs text-muted-foreground">{t("totals.backdatedDisclaimer")}</p>}
            </div>
          )}

          {blockedByUnresolvedUnclassifiable && (
            <p role="alert" className="text-sm text-bad">
              {t("error.blockedByUnclassifiable")}
            </p>
          )}

          {formError && (
            <div className="flex flex-col gap-1">
              <p role="alert" className="text-sm text-bad">{t(`error.${formError.error}`, { defaultValue: t("error.unexpected") })}</p>
              {formError.error === "coverageGap" && advisoryMonth && (
                <p className="text-xs text-muted-foreground">{t("error.coverageGapAdvisory", { month: monthKey(advisoryMonth) })}</p>
              )}
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
                  receivedOnTouchedRef.current = true;
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
