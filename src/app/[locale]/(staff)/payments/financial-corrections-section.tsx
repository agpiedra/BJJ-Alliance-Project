"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { FIELD_CLASS, Input } from "@/components/ui/input";
import {
  correctLateFee,
  reversePaymentAction,
  waiveFee,
  getCorrectableLateFees,
  getReversiblePayments,
  getLateFeeStatus,
  getPaymentStatus,
} from "@/lib/dues/financial-corrections-actions";
import type { CorrectableLateFeeRow, ReversiblePaymentRow } from "@/lib/dues/financial-corrections-queries";
import { CURRENCIES } from "@/lib/payments/format-money";
import type { Currency, PaymentMethod } from "@/generated/prisma/client";

/**
 * Owner financial-corrections UI brief: late-fee correction, payment reversal, and late-fee waiver — three
 * ADMIN-only operations against existing records (never new purchases). §3 decision 3: ONE card, three clearly
 * separated flows; the fee-selection list is shared by correction and waiver, the payment-selection list is
 * reversal's own.
 *
 * STRUCTURALLY DIFFERENT RECOVERY MODEL from the three purchase cards (brief's own central finding, §1): every
 * target here (a `lateFeeId`/`paymentId`) is ALREADY a real, server-persisted id the owner selected from a list
 * BEFORE submitting anything — there is no client-generated submissionId, no `payment-attempt-storage.ts`
 * localStorage persistence, no `AttemptOperation` discriminator, no cross-card `useHasUnresolvedUnclassifiable`
 * integration. Recovery (brief §2.5/§3 decision 1) is the exact-target status-check pattern already proven live by
 * `ReceiptRow` (`awaiting-rate-receipt-list.tsx`) for `resolveAwaitingRateReceipt`/`cancelAwaitingRateReceipt` —
 * themselves also never wrapped by submission identity. A row's own draft (reason/tender/etc.) lives in plain React
 * state for the page's lifetime only: a reload loses an in-progress uncertain attempt's draft (unlike the three
 * purchase cards' own mount-time localStorage scan) — the owner can look the same record up again from the
 * selection list or a direct recovery lookup and see its real current state; nothing is silently lost, it is just
 * not auto-resumed across a reload. This is a deliberate scope choice, not an oversight.
 *
 * CORRECTION ROUND 2 (5 issues):
 * 1. Rows used to unmount on every refresh (parent gated the list on a single `loadStatus`, which a sibling row's
 *    own `onResolved()` flipped back through "loading") — destroying any OTHER row's typed draft or uncertain
 *    recovery state. Lists now render off `fees !== null`/`payments !== null` directly; a refresh overwrites the
 *    arrays in place once new data arrives, never nulls them out first — React's own stable `key={row.id}` then
 *    preserves every row's own component instance (and local state) across the swap. A student switch is the only
 *    path that still nulls/resets, and it now warns (via `window.confirm`) before discarding any row currently
 *    mid-recovery.
 * 2. "Amount received" no longer prefills from the late fee's own amount (a different, unrelated figure from what
 *    correction's settlement step actually requires as tender) — it starts blank. The obligation's own amount is
 *    shown as separate, clearly labeled reference context. Each operation shows its own explicit confirmation copy.
 * 3. Recovery-observed outcomes (reached via `getLateFeeStatus`/`getPaymentStatus` after an uncertain prior attempt)
 *    render DESCRIPTIVE copy only ("this fee is now shown as voided") — never the DIRECT-success copy ("this fee was
 *    voided and settled"), which is reserved for an outcome this exact request-response cycle actually produced.
 * 4. Both selection lists are now cursor-paginated ("Load older" per list) — a flat `take` cap alone made anything
 *    past the first page permanently unreachable.
 * 5. `notOnTime` copy corrected (it had the refusal's own meaning backwards); `stale` now genuinely reconciles (a
 *    scoped re-fetch of the row's own fresh revision, never a silent resubmit under the old one); settlement-total
 *    refusals (`notASelectableTotal`/`totalMismatch`) render their own `selectableTotals` detail.
 */

type Student = { id: string; firstName: string; lastName: string; academyId: string; academyName: string };

const METHODS: PaymentMethod[] = ["EFECTIVO", "SINPE", "TRANSFERENCIA", "TARJETA"];

function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Every refusal code across all three writers (brief §2.4/§2.6's own tables) maps to its own distinct copy key —
 * never a shared fallback for two different causes. Codes absent here fall through to a generic `t("error.unexpected")`.
 * Correction round 2: added the settlement-total codes (`notASelectableTotal`/`totalMismatch`/`ambiguousTotal`) that
 * were previously falling through to the generic "unexpected" copy. */
const ERROR_KEY: Record<string, string> = {
  notActive: "notActive",
  invalid: "invalid",
  notFound: "notFound",
  stale: "stale",
  alreadyRemoved: "alreadyRemoved",
  notOnTime: "notOnTime",
  alreadyPaid: "alreadyPaid",
  alreadyReversed: "alreadyReversed",
  unsupportedObligationType: "unsupportedObligationType",
  voidedFeeBlocksReversal: "voidedFeeBlocksReversal",
  prepaymentBlocksReversal: "prepaymentBlocksReversal",
  inconsistentState: "unexpected",
  notOldestFirst: "notOldestFirst",
  rateUnavailable: "rateUnavailable",
  alreadySettled: "alreadySettled",
  futureDate: "futureDate",
  tooOld: "tooOld",
  currencyMismatch: "currencyMismatch",
  notASelectableTotal: "notASelectableTotal",
  totalMismatch: "totalMismatch",
  ambiguousTotal: "ambiguousTotal",
};
function errorMessageKey(code: string): string {
  return ERROR_KEY[code] ?? "unexpected";
}

/** A refusal carrying `selectableTotals` — the subset of `CorrectLateFeeResult`'s own `{ok:false}` shape this
 * component actually reads. Both settlement-total codes above populate it (`record-payment.ts`); nothing else does. */
type RowError = { code: string; selectableTotals?: string[] };

export function FinancialCorrectionsSection({ organizationId, students }: { organizationId: string; students: Student[] }) {
  const t = useTranslations("payments.financialCorrections");
  const [selectedStudentId, setSelectedStudentId] = useState("");
  const [fees, setFees] = useState<CorrectableLateFeeRow[] | null>(null);
  const [payments, setPayments] = useState<ReversiblePaymentRow[] | null>(null);
  const [feesCursor, setFeesCursor] = useState<string | null>(null);
  const [paymentsCursor, setPaymentsCursor] = useState<string | null>(null);
  const [loadStatus, setLoadStatus] = useState<"idle" | "loading" | "loaded" | "failed">("idle");
  const [loadingMoreFees, setLoadingMoreFees] = useState(false);
  const [loadingMorePayments, setLoadingMorePayments] = useState(false);
  const requestRef = useRef(0);
  // Correction round 2, issue 1: which currently-mounted row ids are in an uncertain (needs-recovery) state right
  // now — a ref, not state, since it is only ever read synchronously at the moment of a student-switch attempt, never
  // rendered. Each row reports its own transitions via `reportUncertain`.
  const uncertainRowsRef = useRef<Set<string>>(new Set());

  function reportUncertain(id: string, uncertain: boolean) {
    if (uncertain) uncertainRowsRef.current.add(id);
    else uncertainRowsRef.current.delete(id);
  }

  /** The student-level load: resets everything and fetches page 1 of both lists. Only this path nulls `fees`/
   * `payments` — a background refresh (see `refresh` below) never does, so rows stay mounted through it. */
  function loadForStudent(studentId: string) {
    if (!studentId) return;
    const requestId = ++requestRef.current;
    setLoadStatus("loading");
    Promise.all([getCorrectableLateFees(organizationId, studentId), getReversiblePayments(organizationId, studentId)])
      .then(([feePage, paymentPage]) => {
        if (requestRef.current !== requestId) return;
        setFees(feePage.rows);
        setFeesCursor(feePage.nextCursor);
        setPayments(paymentPage.rows);
        setPaymentsCursor(paymentPage.nextCursor);
        setLoadStatus("loaded");
      })
      .catch(() => {
        if (requestRef.current !== requestId) return;
        setLoadStatus("failed");
      });
  }

  /** Correction round 2, issue 1: a BACKGROUND refresh — re-fetches page 1 of both lists and swaps the arrays in
   * place on success, but never nulls them first and never touches `loadStatus`. Every other row's own component
   * instance (and its own local state: a typed draft, a pending recovery check) survives this unchanged, since the
   * surrounding `fees !== null && payments !== null` render condition never goes false during it. */
  function refresh() {
    if (!selectedStudentId) return;
    const requestId = ++requestRef.current;
    Promise.all([getCorrectableLateFees(organizationId, selectedStudentId), getReversiblePayments(organizationId, selectedStudentId)])
      .then(([feePage, paymentPage]) => {
        if (requestRef.current !== requestId) return;
        setFees(feePage.rows);
        setFeesCursor(feePage.nextCursor);
        setPayments(paymentPage.rows);
        setPaymentsCursor(paymentPage.nextCursor);
      })
      .catch(() => {
        // A background refresh that fails just leaves the existing (possibly slightly stale) lists displayed —
        // never destructive. The next successful refresh (another row resolving, or a manual retry) corrects it.
      });
  }

  async function loadMoreFees() {
    if (!feesCursor || loadingMoreFees) return;
    setLoadingMoreFees(true);
    try {
      const page = await getCorrectableLateFees(organizationId, selectedStudentId, feesCursor);
      setFees((prev) => {
        const seen = new Set((prev ?? []).map((f) => f.id));
        return [...(prev ?? []), ...page.rows.filter((f) => !seen.has(f.id))];
      });
      setFeesCursor(page.nextCursor);
    } finally {
      setLoadingMoreFees(false);
    }
  }

  async function loadMorePayments() {
    if (!paymentsCursor || loadingMorePayments) return;
    setLoadingMorePayments(true);
    try {
      const page = await getReversiblePayments(organizationId, selectedStudentId, paymentsCursor);
      setPayments((prev) => {
        const seen = new Set((prev ?? []).map((p) => p.id));
        return [...(prev ?? []), ...page.rows.filter((p) => !seen.has(p.id))];
      });
      setPaymentsCursor(page.nextCursor);
    } finally {
      setLoadingMorePayments(false);
    }
  }

  /** Correction round 2, issue 1: switching students discards every currently-mounted row's own state (it is, after
   * all, a different student's records) — but if any row is currently uncertain (a lost response awaiting recovery,
   * or a stale-revision reconcile in flight), that is real in-doubt work, not a draft the owner can just retype.
   * Confirmed explicitly rather than silently discarded. */
  function handleStudentChange(next: string) {
    if (uncertainRowsRef.current.size > 0) {
      const proceed = window.confirm(t("confirmDiscardUncertain"));
      if (!proceed) return;
    }
    uncertainRowsRef.current.clear();
    setSelectedStudentId(next);
  }

  useEffect(() => {
    setFees(null);
    setPayments(null);
    setFeesCursor(null);
    setPaymentsCursor(null);
    setLoadStatus("idle");
    if (selectedStudentId) loadForStudent(selectedStudentId);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-fires only on an actual student change
  }, [selectedStudentId]);

  /** A row's own successful write (or discovered already-finalized state) means the lists are stale — refresh both
   * IN PLACE (issue 1's own fix), never leave a now-removed fee or now-reversed payment sitting in its old list
   * entry, and never unmount any sibling row to do it. */
  function handleRowResolved() {
    refresh();
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs text-muted-foreground">{t("body")}</p>

      <label className="flex flex-col gap-1 text-sm">
        <span>{t("fields.student")}</span>
        <select value={selectedStudentId} onChange={(e) => handleStudentChange(e.target.value)} className={FIELD_CLASS}>
          <option value="">{t("fields.studentPlaceholder")}</option>
          {students.map((s) => (
            <option key={s.id} value={s.id}>
              {s.firstName} {s.lastName} — {s.academyName}
            </option>
          ))}
        </select>
      </label>

      {selectedStudentId && loadStatus === "loading" && fees === null && <p className="text-sm text-muted-foreground">{t("loading")}</p>}
      {selectedStudentId && loadStatus === "failed" && fees === null && (
        <div className="flex items-center gap-2">
          <p role="alert" className="text-sm text-bad">
            {t("loadFailed")}
          </p>
          <Button type="button" variant="outline" onClick={() => loadForStudent(selectedStudentId)}>
            {t("retry")}
          </Button>
        </div>
      )}

      {selectedStudentId && fees !== null && payments !== null && (
        <>
          <div className="flex flex-col gap-2">
            <p className="text-sm font-medium">{t("fees.heading")}</p>
            {fees.length === 0 && <p className="text-sm text-muted-foreground">{t("fees.none")}</p>}
            {fees.length > 0 && (
              <ul className="flex flex-col gap-3">
                {fees.map((fee) => (
                  <LateFeeRow key={fee.id} organizationId={organizationId} fee={fee} onResolved={handleRowResolved} onUncertainChange={reportUncertain} />
                ))}
              </ul>
            )}
            {feesCursor && (
              <div>
                <Button type="button" variant="outline" disabled={loadingMoreFees} onClick={loadMoreFees}>
                  {loadingMoreFees ? t("loadingMore") : t("loadOlder")}
                </Button>
              </div>
            )}
          </div>

          <div className="flex flex-col gap-2">
            <p className="text-sm font-medium">{t("payments.heading")}</p>
            {payments.length === 0 && <p className="text-sm text-muted-foreground">{t("payments.none")}</p>}
            {payments.length > 0 && (
              <ul className="flex flex-col gap-3">
                {payments.map((payment) => (
                  <PaymentRow key={payment.id} organizationId={organizationId} payment={payment} onResolved={handleRowResolved} onUncertainChange={reportUncertain} />
                ))}
              </ul>
            )}
            {paymentsCursor && (
              <div>
                <Button type="button" variant="outline" disabled={loadingMorePayments} onClick={loadMorePayments}>
                  {loadingMorePayments ? t("loadingMore") : t("loadOlder")}
                </Button>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

type RecoveryState = {
  needsRefresh: boolean;
  refreshStatus: "idle" | "loading" | "failed";
  refreshNonce: number;
};

const IDLE_RECOVERY: RecoveryState = { needsRefresh: false, refreshStatus: "idle", refreshNonce: 0 };

/** Correction round 2, issue 3: which copy a finalized/observed state renders — `"direct"` (this exact
 * request-response cycle produced the outcome, genuinely attributable to this attempt) vs `"recovery"` (reached via
 * an exact-target status re-read after an earlier, uncertain attempt — descriptive only, never attributed). */
type ConfirmedState = { kind: "removed"; removalKind: "VOIDED" | "WAIVED"; source: "direct" | "recovery" } | { kind: "unchanged" } | null;

/** Exported for direct testing — mirrors `ReceiptRow`'s own exact recovery shape (brief §2.5's directly reusable
 * precedent), applied to a late fee's own two operations (correct, waive). */
export function LateFeeRow({
  organizationId,
  fee,
  onResolved,
  onUncertainChange,
}: {
  organizationId: string;
  fee: CorrectableLateFeeRow;
  onResolved: () => void;
  /** Correction round 2, issue 1: reports this row's own uncertain/not-uncertain transitions to the parent, so a
   * student switch can warn before discarding in-doubt work. Optional — standalone row tests never need to wire it. */
  onUncertainChange?: (id: string, uncertain: boolean) => void;
}) {
  const t = useTranslations("payments.financialCorrections");
  const [mode, setMode] = useState<"idle" | "correcting" | "waiving">("idle");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<RowError | null>(null);
  const [transportFailure, setTransportFailure] = useState(false);
  const [confirmedState, setConfirmedState] = useState<ConfirmedState>(null);
  const [recovery, setRecovery] = useState<RecoveryState>(IDLE_RECOVERY);
  // Correction round 2, issue 5: `stale` is NOT folded into the `needsRefresh`/recovery machinery above — that
  // machinery means "we don't know if an earlier attempt took effect." A `stale` refusal is the opposite: the
  // writer cleanly told us the view was outdated; nothing is uncertain, there is just a fresher revision to fetch.
  const [reconcilingStale, setReconcilingStale] = useState(false);
  // Correction round 2, issue 5: the revision actually used on the next submit — starts at the row's own prop, and
  // is updated in place once a `stale` reconcile fetches a fresher one. Never the prop directly after that point.
  const [currentRevision, setCurrentRevision] = useState(fee.expectedRevision);

  // Correction-only fields
  const [reason, setReason] = useState("");
  const [receivedOn, setReceivedOn] = useState(todayIso());
  // Correction round 2, issue 2: starts BLANK — never prefilled from `fee.amount` (the late fee itself, not the
  // amount correction's own settlement step actually requires as tender). The owner must type what was received.
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState<Currency>(fee.currency as Currency);
  const [method, setMethod] = useState<PaymentMethod>("EFECTIVO");
  const [notes, setNotes] = useState("");

  const needsRefresh = transportFailure || error?.code === "alreadyRemoved";

  // Correction round 2, issue 1 (CI-caught race, fixed): reporting this transition via a `useEffect` watching
  // `needsRefresh` is NOT guaranteed to have flushed before the very next synchronous test/user interaction (a
  // `useEffect` runs in React's own passive-effect phase, a tick after the triggering commit is visible) — this
  // raced and failed intermittently in CI. `onUncertainChange` is now called IMPERATIVELY at each exact mutation
  // point below, in the same synchronous handler/callback that sets the underlying state — never derived.
  // onUncertainChange is a fresh inline function every parent render; only fee.id identity should re-arm this cleanup.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => () => onUncertainChange?.(fee.id, false), [fee.id]); // unmount-only safety net

  useEffect(() => {
    if (!needsRefresh) return;
    let cancelled = false;
    setRecovery((r) => ({ ...r, refreshStatus: "loading" }));
    getLateFeeStatus(organizationId, fee.id)
      .then((current) => {
        if (cancelled) return;
        if (!current) {
          setRecovery((r) => ({ ...r, refreshStatus: "failed" }));
          return;
        }
        setRecovery({ needsRefresh: false, refreshStatus: "idle", refreshNonce: 0 });
        if (current.removedAt === null) {
          // The earlier attempt does not appear to have taken effect YET — a fresh read is a snapshot, not proof
          // the in-flight request has actually finished resolving. Never auto-resubmitted, just unlocked for an
          // explicit, owner-initiated retry.
          setTransportFailure(false);
          setError(null);
          setCurrentRevision(current.expectedRevision);
          setConfirmedState({ kind: "unchanged" });
          onUncertainChange?.(fee.id, false); // imperative — see the mount-effect's own doc comment above
        } else {
          setConfirmedState({ kind: "removed", removalKind: current.removalKind!, source: "recovery" });
          onUncertainChange?.(fee.id, false);
          onResolved();
        }
      })
      .catch(() => {
        if (!cancelled) setRecovery((r) => ({ ...r, refreshStatus: "failed" }));
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-runs on a fresh needsRefresh or an explicit retry nonce
  }, [needsRefresh, recovery.refreshNonce]);

  /** Correction round 2, issue 5: the promised "stale → safe refresh" reconciliation, actually implemented — an
   * explicit, owner-initiated re-fetch of THIS fee's own current revision (never automatic). Draft fields
   * (reason/amount/etc.) and `mode` are untouched; only `currentRevision` and `error` change. If the fee turns out
   * to have been removed by someone else in the meantime, that's reported the same way `alreadyRemoved` already is. */
  async function reconcileStale() {
    setReconcilingStale(true);
    try {
      const current = await getLateFeeStatus(organizationId, fee.id);
      if (!current) {
        setError({ code: "notFound" });
        return;
      }
      if (current.removedAt === null) {
        setCurrentRevision(current.expectedRevision);
        setError(null);
      } else {
        setConfirmedState({ kind: "removed", removalKind: current.removalKind!, source: "recovery" });
        onResolved();
      }
    } catch {
      // Reconcile itself failed — leave the stale error exactly as shown; the same button remains to retry it.
    } finally {
      setReconcilingStale(false);
    }
  }

  async function handleCorrect(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.set("lateFeeId", fee.id);
      fd.set("expectedRevision", currentRevision);
      fd.set("removalReason", reason);
      fd.set("receivedOn", receivedOn);
      fd.set("tenderCurrency", currency);
      fd.set("tenderAmount", amount);
      fd.set("method", method);
      if (notes.trim()) fd.set("notes", notes);
      const result = await correctLateFee(organizationId, {}, fd);
      if (result.ok) {
        setConfirmedState({ kind: "removed", removalKind: "VOIDED", source: "direct" });
        onResolved();
      } else {
        setError({ code: result.error, selectableTotals: "selectableTotals" in result ? result.selectableTotals : undefined });
        // alreadySettled: the obligation this fee was blocking is now settled some other way — the correction can
        // never commit from here, and no other row needs to care, but the parent's own lists ARE stale (something
        // changed) — now safe to refresh in place (issue 1's own fix removed the old unmount-everything hazard).
        if (result.error === "alreadySettled") onResolved();
        // alreadyRemoved specifically is the one error here that enters the needsRefresh/recovery flow — imperative,
        // same reasoning as the mount-effect's own doc comment above.
        if (result.error === "alreadyRemoved") onUncertainChange?.(fee.id, true);
      }
    } catch {
      setTransportFailure(true);
      onUncertainChange?.(fee.id, true);
    } finally {
      setBusy(false);
    }
  }

  async function handleWaive(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.set("lateFeeId", fee.id);
      fd.set("expectedRevision", currentRevision);
      fd.set("removalReason", reason);
      const result = await waiveFee(organizationId, {}, fd);
      if (result.ok) {
        setConfirmedState({ kind: "removed", removalKind: "WAIVED", source: "direct" });
        onResolved();
      } else {
        setError({ code: result.error });
        if (result.error === "alreadyRemoved") onUncertainChange?.(fee.id, true);
      }
    } catch {
      setTransportFailure(true);
      onUncertainChange?.(fee.id, true);
    } finally {
      setBusy(false);
    }
  }

  const finalized = confirmedState?.kind === "removed";
  const disabled = busy || needsRefresh || reconcilingStale;

  return (
    <li className="flex flex-col gap-2 rounded-lg border border-border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <span className="font-medium">
          {fee.coverageYear}-{String(fee.coverageMonth).padStart(2, "0")}
        </span>
        <span>{t("fee.feeAmountLabel", { amount: fee.amount, currency: fee.currency })}</span>
      </div>
      {/* Correction round 2, issue 2: reference-only context, clearly labeled and visually distinct from the fee
          amount above — never wired as any field's default value. */}
      <p className="text-xs text-muted-foreground">{t("fee.obligationAmountLabel", { amount: fee.obligationAmount, currency: fee.currency })}</p>

      {finalized && confirmedState.removalKind === "VOIDED" && (
        <p role="status" className="text-sm text-ok">
          {t(confirmedState.source === "direct" ? "fee.outcome.voidedDirect" : "fee.outcome.voidedObserved")}
        </p>
      )}
      {finalized && confirmedState.removalKind === "WAIVED" && (
        <p role="status" className="text-sm text-ok">
          {t(confirmedState.source === "direct" ? "fee.outcome.waivedDirect" : "fee.outcome.waivedObserved")}
        </p>
      )}
      {confirmedState?.kind === "unchanged" && <p className="text-xs text-muted-foreground">{t("recovery.unchanged")}</p>}

      {needsRefresh && recovery.refreshStatus === "idle" && (
        <p role="alert" className="text-sm text-bad">{t("recovery.transportFailure")}</p>
      )}
      {recovery.refreshStatus === "loading" && <p className="text-sm text-muted-foreground">{t("recovery.checking")}</p>}
      {recovery.refreshStatus === "failed" && (
        <div className="flex items-center gap-2">
          <p role="alert" className="text-sm text-bad">{t("recovery.checkFailed")}</p>
          <Button type="button" variant="outline" onClick={() => setRecovery((r) => ({ ...r, refreshNonce: r.refreshNonce + 1 }))}>
            {t("recovery.checkAgain")}
          </Button>
        </div>
      )}

      {error && !needsRefresh && error.code === "stale" && (
        <div className="flex items-center gap-2">
          <p role="alert" className="text-sm text-bad">{t("error.stale")}</p>
          <Button type="button" variant="outline" disabled={reconcilingStale} onClick={reconcileStale}>
            {reconcilingStale ? t("recovery.checking") : t("fee.reconcileRevision")}
          </Button>
        </div>
      )}
      {error && !needsRefresh && error.code !== "stale" && (
        <div className="flex flex-col gap-1">
          <p role="alert" className="text-sm text-bad">{t(`error.${errorMessageKey(error.code)}`)}</p>
          {error.code === "notOldestFirst" && <p className="text-xs text-muted-foreground">{t("fee.olderDebt")}</p>}
          {error.selectableTotals && error.selectableTotals.length > 0 && (
            <p className="text-xs text-muted-foreground">{t("error.selectableTotalsDetail", { totals: error.selectableTotals.join(", ") })}</p>
          )}
        </div>
      )}

      {!finalized && (
        <div className="flex gap-2">
          <Button type="button" variant={mode === "correcting" ? "default" : "outline"} disabled={disabled} onClick={() => setMode(mode === "correcting" ? "idle" : "correcting")}>
            {t("fee.correctAction")}
          </Button>
          <Button type="button" variant={mode === "waiving" ? "default" : "outline"} disabled={disabled} onClick={() => setMode(mode === "waiving" ? "idle" : "waiving")}>
            {t("fee.waiveAction")}
          </Button>
        </div>
      )}

      {!finalized && mode === "correcting" && (
        <form onSubmit={handleCorrect} className="flex flex-col gap-2 border-t border-border pt-2">
          <p className="text-xs text-muted-foreground">{t("fee.correctConfirmCopy")}</p>
          <label className="flex flex-col gap-1 text-sm">
            <span>{t("fields.reason")}</span>
            <Input type="text" required maxLength={500} disabled={disabled} value={reason} onChange={(e) => setReason(e.target.value)} />
          </label>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <label className="flex flex-col gap-1 text-sm">
              <span>{t("fields.receivedOn")}</span>
              <Input type="date" required disabled={disabled} value={receivedOn} onChange={(e) => setReceivedOn(e.target.value)} />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span>{t("fields.amount")}</span>
              <Input type="text" inputMode="decimal" required disabled={disabled} value={amount} onChange={(e) => setAmount(e.target.value)} />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span>{t("fields.currency")}</span>
              <select className={FIELD_CLASS} disabled={disabled} value={currency} onChange={(e) => setCurrency(e.target.value as Currency)}>
                {CURRENCIES.map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span>{t("fields.method")}</span>
              <select className={FIELD_CLASS} disabled={disabled} value={method} onChange={(e) => setMethod(e.target.value as PaymentMethod)}>
                {METHODS.map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
            </label>
          </div>
          <label className="flex flex-col gap-1 text-sm">
            <span>{t("fields.notes")}</span>
            <Input type="text" maxLength={500} disabled={disabled} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </label>
          <div>
            <Button type="submit" disabled={disabled}>{busy ? t("submitting") : t("fee.correctSubmit")}</Button>
          </div>
        </form>
      )}

      {!finalized && mode === "waiving" && (
        <form onSubmit={handleWaive} className="flex flex-col gap-2 border-t border-border pt-2">
          <p className="text-xs text-muted-foreground">{t("fee.waiveConfirmCopy")}</p>
          <label className="flex flex-col gap-1 text-sm">
            <span>{t("fields.reason")}</span>
            <Input type="text" required maxLength={500} disabled={disabled} value={reason} onChange={(e) => setReason(e.target.value)} />
          </label>
          <div>
            <Button type="submit" disabled={disabled}>{busy ? t("submitting") : t("fee.waiveSubmit")}</Button>
          </div>
        </form>
      )}
    </li>
  );
}

type PaymentConfirmedState = { kind: "reversed"; source: "direct" | "recovery" } | { kind: "unchanged" } | null;

/** Exported for direct testing — the reversal flow's own row, mirroring `LateFeeRow`'s recovery shape. Every row
 * stays visible regardless of restriction (brief §3 decision 4); a restricted row's own reversal action is disabled,
 * with a specific named explanation, never hidden. */
export function PaymentRow({
  organizationId,
  payment,
  onResolved,
  onUncertainChange,
}: {
  organizationId: string;
  payment: ReversiblePaymentRow;
  onResolved: () => void;
  onUncertainChange?: (id: string, uncertain: boolean) => void;
}) {
  const t = useTranslations("payments.financialCorrections");
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<RowError | null>(null);
  const [transportFailure, setTransportFailure] = useState(false);
  const [confirmedState, setConfirmedState] = useState<PaymentConfirmedState>(null);
  const [recovery, setRecovery] = useState<RecoveryState>(IDLE_RECOVERY);
  const [reason, setReason] = useState("");

  const needsRefresh = transportFailure || error?.code === "alreadyReversed";

  // Correction round 2, issue 1 (CI-caught race, fixed) — same reasoning as `LateFeeRow`'s own identical comment:
  // reported imperatively at each exact mutation point below, never derived via a `useEffect` watching `needsRefresh`.
  // Same reasoning as LateFeeRow's own identical comment above.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => () => onUncertainChange?.(payment.id, false), [payment.id]); // unmount-only safety net

  useEffect(() => {
    if (!needsRefresh) return;
    let cancelled = false;
    setRecovery((r) => ({ ...r, refreshStatus: "loading" }));
    getPaymentStatus(organizationId, payment.id)
      .then((current) => {
        if (cancelled) return;
        if (!current) {
          setRecovery((r) => ({ ...r, refreshStatus: "failed" }));
          return;
        }
        setRecovery({ needsRefresh: false, refreshStatus: "idle", refreshNonce: 0 });
        if (current.reversedAt === null) {
          setTransportFailure(false);
          setError(null);
          setConfirmedState({ kind: "unchanged" });
          onUncertainChange?.(payment.id, false);
        } else {
          setConfirmedState({ kind: "reversed", source: "recovery" });
          onUncertainChange?.(payment.id, false);
          onResolved();
        }
      })
      .catch(() => {
        if (!cancelled) setRecovery((r) => ({ ...r, refreshStatus: "failed" }));
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-runs on a fresh needsRefresh or an explicit retry nonce
  }, [needsRefresh, recovery.refreshNonce]);

  async function handleReverse(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.set("paymentId", payment.id);
      fd.set("reversalReason", reason);
      const result = await reversePaymentAction(organizationId, {}, fd);
      if (result.ok) {
        setConfirmedState({ kind: "reversed", source: "direct" });
        onResolved();
      } else {
        setError({ code: result.error });
        if (result.error === "alreadyReversed") onUncertainChange?.(payment.id, true);
      }
    } catch {
      setTransportFailure(true);
      onUncertainChange?.(payment.id, true);
    } finally {
      setBusy(false);
    }
  }

  const finalized = confirmedState?.kind === "reversed";
  const disabled = busy || needsRefresh;
  const restricted = payment.restrictions.hasUnsupportedObligationType || payment.restrictions.hasPrepaymentOrigin || payment.restrictions.hasVoidedFee;

  return (
    <li className="flex flex-col gap-2 rounded-lg border border-border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <span>{payment.receivedOn.year}-{String(payment.receivedOn.month).padStart(2, "0")}-{String(payment.receivedOn.day).padStart(2, "0")}</span>
        <span>{payment.tenderAmount} {payment.tenderCurrency}</span>
      </div>

      {finalized && (
        <p role="status" className="text-sm text-ok">
          {t(confirmedState.source === "direct" ? "payment.outcome.reversedDirect" : "payment.outcome.reversedObserved")}
        </p>
      )}
      {confirmedState?.kind === "unchanged" && <p className="text-xs text-muted-foreground">{t("recovery.unchanged")}</p>}

      {restricted && !finalized && (
        <div className="flex flex-col gap-0.5 text-xs text-muted-foreground">
          {payment.restrictions.hasUnsupportedObligationType && <p>{t("payment.restriction.unsupportedObligationType")}</p>}
          {payment.restrictions.hasPrepaymentOrigin && <p>{t("payment.restriction.prepaymentOrigin")}</p>}
          {payment.restrictions.hasVoidedFee && <p>{t("payment.restriction.voidedFee")}</p>}
        </div>
      )}

      {needsRefresh && recovery.refreshStatus === "idle" && (
        <p role="alert" className="text-sm text-bad">{t("recovery.transportFailure")}</p>
      )}
      {recovery.refreshStatus === "loading" && <p className="text-sm text-muted-foreground">{t("recovery.checking")}</p>}
      {recovery.refreshStatus === "failed" && (
        <div className="flex items-center gap-2">
          <p role="alert" className="text-sm text-bad">{t("recovery.checkFailed")}</p>
          <Button type="button" variant="outline" onClick={() => setRecovery((r) => ({ ...r, refreshNonce: r.refreshNonce + 1 }))}>
            {t("recovery.checkAgain")}
          </Button>
        </div>
      )}

      {error && !needsRefresh && <p role="alert" className="text-sm text-bad">{t(`error.${errorMessageKey(error.code)}`)}</p>}

      {!finalized && !open && (
        <div>
          <Button type="button" variant="outline" disabled={disabled || restricted} onClick={() => setOpen(true)}>
            {t("payment.reverseAction")}
          </Button>
        </div>
      )}

      {!finalized && open && (
        <form onSubmit={handleReverse} className="flex flex-col gap-2 border-t border-border pt-2">
          <p className="text-xs text-muted-foreground">{t("payment.reverseConfirmCopy")}</p>
          <label className="flex flex-col gap-1 text-sm">
            <span>{t("fields.reason")}</span>
            <Input type="text" required maxLength={500} disabled={disabled} value={reason} onChange={(e) => setReason(e.target.value)} />
          </label>
          <div>
            <Button type="submit" disabled={disabled}>{busy ? t("submitting") : t("payment.reverseSubmit")}</Button>
          </div>
        </form>
      )}
    </li>
  );
}
