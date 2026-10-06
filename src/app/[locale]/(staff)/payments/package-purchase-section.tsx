"use client";

import { useRef, useState, useEffect } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { FIELD_CLASS, Input } from "@/components/ui/input";
import { checkSubmissionOutcome, getPayableObligations } from "@/lib/dues/payment-entry-actions";
import { purchasePackage, getPackagePlanOptions, getFirstAvailablePackageMonth } from "@/lib/dues/package-purchase-actions";
import { beginAttempt, readPackageAttempt, clearAttempt, scanAttemptsByOperation, useHasUnresolvedUnclassifiable, type StoredPackageAttemptPayload } from "@/lib/dues/payment-attempt-storage";
import { classifyWriteResult, classifyRecoveryCheck, shouldClearAfterRecoveryCheck, type WriteOutcomeClassification, type RecoveryCheckClassification } from "@/lib/dues/payment-entry-recovery";
import { CURRENCIES } from "@/lib/payments/format-money";
import { decimalToMinor } from "@/lib/dues/ledger/minor-units";
import type { PayableObligation } from "@/lib/dues/payment-entry-queries";
import type { PackagePlanOption } from "@/lib/dues/package-purchase-queries";
import type { CalendarDate, YearMonth } from "@/lib/dues/calendar";
import type { Currency, PaymentMethod } from "@/generated/prisma/client";

/**
 * Package-purchase UI brief §2/§5: the new, SEPARATE package-purchase card for `payments/page.tsx` (never
 * `payments/plans/page.tsx`) — ADMIN only (matching `purchasePackageWithSubmissionIdentity`'s own hard-coded
 * ADMIN-only check), mounted alongside (never replacing) the ordinary ledger card. Deliberately mirrors
 * `payment-entry-section.tsx`'s own submit/recovery state machine structure (the same corrected 8 points that file's
 * own doc comment lists) rather than inventing a new one — this is the SAME architecture, applied to a second
 * operation. Reuses `classifyWriteResult`/`classifyRecoveryCheck`/`shouldClearAfterRecoveryCheck`
 * (`payment-entry-recovery.ts`) directly against `purchasePackageWithSubmissionIdentity`'s own result shape (now
 * typed generically for exactly this reuse) and `checkSubmissionOutcome`/`getPayableObligations`
 * (`payment-entry-actions.ts`) directly, rather than duplicating either.
 *
 * Since this card renders for ADMIN only (the page-level gate below), it carries no `organizationRole` prop at all —
 * the capture-outcome guidance always links into the exchange-rate queue directly.
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
function parseYearMonthIso(iso: string): YearMonth | null {
  const match = /^(\d{4})-(\d{2})$/.exec(iso);
  if (!match) return null;
  return { year: Number(match[1]), month: Number(match[2]) };
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
  /** A `staleTerms` refusal's own re-fetch of the plan/terms read — locked for its duration, exactly like
   * `reconcilingObligations` in the ordinary card. */
  | "reconcilingTerms"
  /** A `debtNotFullySettled`/`coverageGap`/`alreadySettled` refusal's own re-fetch-and-reconcile of the existing-debt
   * display — the package's own equivalent of the ordinary card's `reconcilingObligations`. */
  | "reconcilingDebt";

type OutcomeDisplay = { source: "write"; classification: WriteOutcomeClassification | { kind: "rejected" } } | { source: "recovery"; classification: RecoveryCheckClassification };

type FormError = { error: string; selectableTotals?: string[]; alreadySettledIds?: string[] };

const TERMINAL_WRITE_KINDS = new Set(["freshSuccess", "replaySuccess", "freshCapture", "replayCapture"]);

/** Business refusals whose own stale-selection is reconciled by re-fetching something, rather than just shown
 * inline (brief §2.9) — `staleTerms` re-fetches the plan/terms picker, the other two re-fetch the existing-debt
 * display (and, for `coverageGap`, the first-available-month advisory too). */
const RECONCILES_TERMS = new Set(["staleTerms"]);
const RECONCILES_DEBT = new Set(["debtNotFullySettled", "coverageGap", "alreadySettled"]);

export function PackagePurchaseSection({
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
  const t = useTranslations("payments.packagePurchase");
  const tMethod = useTranslations("payments.method");

  const [phase, setPhase] = useState<Phase>("form");
  const [selectedStudentId, setSelectedStudentId] = useState("");

  const [plans, setPlans] = useState<PackagePlanOption[] | null>(null);
  const [plansError, setPlansError] = useState<string | null>(null);
  const [selectedPlanTermsId, setSelectedPlanTermsId] = useState("");

  const [advisoryMonth, setAdvisoryMonth] = useState<YearMonth | null>(null);
  const [requestedStartMonth, setRequestedStartMonth] = useState("");

  const [obligations, setObligations] = useState<PayableObligation[] | null>(null);
  const [mixedCurrency, setMixedCurrency] = useState(false);
  const [obligationsError, setObligationsError] = useState<string | null>(null);
  const [obligationsErrorSource, setObligationsErrorSource] = useState<"fetch" | "reconcile" | null>(null);
  const [studentDataRetryNonce, setStudentDataRetryNonce] = useState(0);

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
  // Cross-card submission-blocking correction: this card NEVER processes an unclassifiable entry itself (that stays
  // the ordinary card's sole recovery responsibility) — it only OBSERVES the shared, storage-backed signal to block
  // its own submit while one is unresolved.
  const blockedByUnresolvedUnclassifiable = useHasUnresolvedUnclassifiable(organizationId, currentUserId);

  const submissionIdRef = useRef<string | null>(null);
  const recoveryQueueRef = useRef<string[]>([]);
  const studentDataRequestRef = useRef(0);
  const requestedStartMonthTouchedRef = useRef(false);
  const pendingClearRef = useRef<{ id: string; onSuccess: () => void | Promise<void> } | null>(null);

  const locked =
    phase === "recoveryChecking" ||
    phase === "recoveryBlocked" ||
    phase === "submitting" ||
    phase === "loadingStudentData" ||
    phase === "storageUnavailable" ||
    phase === "reconcilingTerms" ||
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
    const read = readPackageAttempt(organizationId, currentUserId, id);
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
    // Package-purchase UI brief §2.10: this card scans for ITS OWN operation only — `otherOperations` (the
    // ordinary card's own entries) is never read or acted on here, and `unclassifiable` is the ordinary card's
    // SOLE responsibility — never referenced here either.
    const scanned = scanAttemptsByOperation(organizationId, currentUserId, "PACKAGE");
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

  // ---- student data fetch: plan/terms picker, first-available-month advisory, existing debt ----

  useEffect(() => {
    setSelectedPlanTermsId("");
    setPlans(null);
    setPlansError(null);
    setAdvisoryMonth(null);
    setRequestedStartMonth("");
    requestedStartMonthTouchedRef.current = false;
    setObligations(null);
    setMixedCurrency(false);
    setObligationsError(null);
    setObligationsErrorSource(null);
    setFormError(null);
    if (!selectedStudentId) return;
    const requestId = ++studentDataRequestRef.current;
    setPhase("loadingStudentData");

    getPackagePlanOptions(organizationId, selectedStudentId)
      .then((result) => {
        if (studentDataRequestRef.current !== requestId) return;
        if (!result.ok) {
          setPlansError(result.error);
          setPlans([]);
        } else {
          setPlans(result.plans);
        }
      })
      .catch(() => {
        if (studentDataRequestRef.current !== requestId) return;
        setPlansError("transportFailure");
        setPlans([]);
      });

    getFirstAvailablePackageMonth(organizationId, selectedStudentId)
      .then((result) => {
        if (studentDataRequestRef.current !== requestId) return;
        if (result.ok) {
          setAdvisoryMonth(result.month);
          // Reads the REF, never the closed-over `requestedStartMonthTouched` state (stale by construction — this
          // effect deliberately excludes it from its own deps, see the eslint-disable below) — otherwise a response
          // that resolves after the owner has since typed a custom month would silently overwrite it.
          if (result.month && !requestedStartMonthTouchedRef.current) setRequestedStartMonth(yearMonthToIso(result.month));
        }
      })
      .catch(() => {
        // Advisory-only — a failure here just means no suggestion, never surfaced as a blocking error.
      });

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
          if (!receivedOnTouched) setReceivedOn(calendarDateToIso(result.todayLocal));
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- receivedOnTouched intentionally not a dep: re-fetching must not re-run on every edit (requestedStartMonthTouched is tracked via a ref now, not state, so it's not a dep candidate at all)
  }, [organizationId, selectedStudentId, studentDataRetryNonce]);

  /** brief §2.9: `staleTerms`'s own re-fetch — re-reads the plan/terms picker and clears the previously-selected
   * terms id so the owner must explicitly confirm the (possibly new) price before resubmitting, never silently
   * resubmitting under the old one. Locked (`reconcilingTerms`) for its whole duration, genuinely awaited. */
  async function refetchPlansReconciling(): Promise<void> {
    if (!selectedStudentId) {
      setPhase("form");
      return;
    }
    const requestId = ++studentDataRequestRef.current;
    setPhase("reconcilingTerms");
    try {
      const result = await getPackagePlanOptions(organizationId, selectedStudentId);
      if (studentDataRequestRef.current !== requestId) return;
      if (!result.ok) {
        setPlansError(result.error);
        setPhase("form");
        return;
      }
      setPlans(result.plans);
      setPlansError(null);
      setSelectedPlanTermsId("");
      setPhase("form");
    } catch {
      if (studentDataRequestRef.current !== requestId) return;
      setPlansError("transportFailure");
      setPhase("form");
    }
  }

  /** brief §2.9: the package's own equivalent of the ordinary card's `refetchObligationsReconciling` — a
   * `debtNotFullySettled`/`coverageGap`/`alreadySettled` refusal's own re-fetch of the (forced, non-deselectable)
   * existing-debt display. Locked (`reconcilingDebt`), genuinely awaited, discriminator-protected. */
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

  // ---- totals (brief §2.5): per-currency, debt grouped with the package's own single current price, never blended ----

  const selectedPlan = plans?.find((p) => p.planTermsId === selectedPlanTermsId);

  function computeCurrencyTotals(): Array<{ currency: string; totalMinor: number }> {
    const totals = new Map<string, number>();
    for (const o of obligations ?? []) totals.set(o.currency, (totals.get(o.currency) ?? 0) + o.outstandingAmountMinor);
    if (selectedPlan) {
      const priceMinor = decimalToMinor(selectedPlan.priceAmount);
      totals.set(selectedPlan.currency, (totals.get(selectedPlan.currency) ?? 0) + priceMinor);
    }
    return [...totals.entries()].map(([entryCurrency, totalMinor]) => ({ currency: entryCurrency, totalMinor }));
  }
  const currencyTotals = computeCurrencyTotals();

  function currentPayload(): StoredPackageAttemptPayload {
    const [y, m, d] = receivedOn.split("-").map(Number);
    const startMonth = parseYearMonthIso(requestedStartMonth) ?? { year: 0, month: 1 };
    return {
      operation: "PACKAGE",
      studentId: selectedStudentId,
      planTermsId: selectedPlanTermsId,
      requestedStartMonth: startMonth,
      existingObligationIds: (obligations ?? []).map((o) => o.obligationId),
      receivedOn: { year: y, month: m, day: d },
      tender: { currency, amount },
      method,
      notes: notes.trim() === "" ? undefined : notes,
    };
  }

  function buildFormData(payload: StoredPackageAttemptPayload, submissionId: string): FormData {
    const fd = new FormData();
    fd.set("studentId", payload.studentId);
    fd.set("planTermsId", payload.planTermsId);
    fd.set("requestedStartMonth", yearMonthToIso(payload.requestedStartMonth));
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
    // Invalidates any student-data fetch (including the coverageGap follow-up) still in flight for the
    // student/selection being cleared here — without this, a response that resolves after this reset could still
    // pass its own discriminator check and apply to the now-blank form.
    studentDataRequestRef.current++;
    setSelectedStudentId("");
    setSelectedPlanTermsId("");
    setPlans(null);
    setPlansError(null);
    setAdvisoryMonth(null);
    setRequestedStartMonth("");
    requestedStartMonthTouchedRef.current = false;
    setAmount("");
    setReceivedOnTouched(false);
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
    !plansError &&
    !mixedCurrency &&
    selectedPlanTermsId !== "" &&
    requestedStartMonth.trim() !== "" &&
    amount.trim() !== "";

  async function runWrite(submissionId: string, formData: FormData, isRecoveryRetry: boolean) {
    setPhase("submitting");
    setBeginError(null);
    let settled: { status: "fulfilled"; value: Awaited<ReturnType<typeof purchasePackage>> } | { status: "rejected"; reason: unknown };
    try {
      const value = await purchasePackage(organizationId, {}, formData);
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
          if (RECONCILES_TERMS.has(classification.error)) {
            await refetchPlansReconciling();
          } else if (RECONCILES_DEBT.has(classification.error)) {
            await refetchObligationsReconciling();
            if (classification.error === "coverageGap") {
              // Discriminator-protected exactly like every other fetch in this file (previously missing here): a
              // student switch, or a `resetForm()` after a meanwhile-completed submission, bumps
              // `studentDataRequestRef` and this stale response is discarded instead of silently overwriting
              // `advisoryMonth` for whatever is now displayed.
              const advisoryRequestId = studentDataRequestRef.current;
              void getFirstAvailablePackageMonth(organizationId, selectedStudentId)
                .then((r) => {
                  if (studentDataRequestRef.current !== advisoryRequestId) return;
                  if (r.ok) setAdvisoryMonth(r.month);
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
    const read = readPackageAttempt(organizationId, currentUserId, submissionId);
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

      {(phase === "form" || phase === "loadingStudentData" || phase === "submitting" || phase === "reconcilingTerms" || phase === "reconcilingDebt") && (
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

          {phase === "loadingStudentData" && <p className="text-sm text-muted-foreground">{t("plan.loading")}</p>}

          {selectedStudentId && plansError && (
            <div className="flex items-center gap-2">
              <p role="alert" className="text-sm text-bad">{t(`error.${plansError}`, { defaultValue: t("error.unexpected") })}</p>
              <Button type="button" variant="outline" onClick={retryStudentData}>
                {t("obligations.retry")}
              </Button>
            </div>
          )}

          {selectedStudentId && plans && !plansError && (
            <label className="flex flex-col gap-1 text-sm">
              <span>{t("fields.plan")}</span>
              <select
                required
                disabled={locked}
                value={selectedPlanTermsId}
                onChange={(e) => setSelectedPlanTermsId(e.target.value)}
                className={FIELD_CLASS}
              >
                <option value="" disabled>
                  {t("fields.planPlaceholder")}
                </option>
                {plans.map((p) => (
                  <option key={p.planTermsId} value={p.planTermsId}>
                    {p.planName} — {t("plan.priceNote", { months: p.monthsCovered, price: p.priceAmount, currency: p.currency })}
                  </option>
                ))}
              </select>
              {plans.length === 0 && <p className="text-sm text-muted-foreground">{t("plan.none")}</p>}
            </label>
          )}

          {selectedStudentId && (
            <label className="flex flex-col gap-1 text-sm">
              <span>{t("fields.startMonth")}</span>
              <Input
                type="month"
                required
                disabled={locked}
                value={requestedStartMonth}
                onChange={(e) => {
                  requestedStartMonthTouchedRef.current = true;
                  setRequestedStartMonth(e.target.value);
                }}
              />
              {advisoryMonth && (
                <span className="text-xs text-muted-foreground">{t("advisory.suggestion", { month: yearMonthToIso(advisoryMonth) })}</span>
              )}
            </label>
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

          {!mixedCurrency && currencyTotals.length > 0 && (
            <div className="flex flex-col gap-1">
              <p className="text-sm font-medium">{t("totals.heading")}</p>
              {currencyTotals.map(({ currency: c, totalMinor }) => (
                <p key={c} className="text-sm">{t("totals.line", { amount: (totalMinor / 100).toFixed(2), currency: c })}</p>
              ))}
              <p className="text-xs text-muted-foreground">{t("totals.disclaimer")}</p>
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
                <p className="text-xs text-muted-foreground">{t("error.coverageGapAdvisory", { month: yearMonthToIso(advisoryMonth) })}</p>
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
