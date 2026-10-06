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
 */

type Student = { id: string; firstName: string; lastName: string; academyId: string; academyName: string };

const METHODS: PaymentMethod[] = ["EFECTIVO", "SINPE", "TRANSFERENCIA", "TARJETA"];

function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Every refusal code across all three writers (brief §2.4/§2.6's own tables) maps to its own distinct copy key —
 * never a shared fallback for two different causes. Codes absent here fall through to a generic `t("error.unexpected")`. */
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
};
function errorMessageKey(code: string): string {
  return ERROR_KEY[code] ?? "unexpected";
}

export function FinancialCorrectionsSection({ organizationId, students }: { organizationId: string; students: Student[] }) {
  const t = useTranslations("payments.financialCorrections");
  const [selectedStudentId, setSelectedStudentId] = useState("");
  const [fees, setFees] = useState<CorrectableLateFeeRow[] | null>(null);
  const [payments, setPayments] = useState<ReversiblePaymentRow[] | null>(null);
  const [loadStatus, setLoadStatus] = useState<"idle" | "loading" | "loaded" | "failed">("idle");
  const requestRef = useRef(0);

  function load() {
    if (!selectedStudentId) return;
    const requestId = ++requestRef.current;
    setLoadStatus("loading");
    Promise.all([getCorrectableLateFees(organizationId, selectedStudentId), getReversiblePayments(organizationId, selectedStudentId)])
      .then(([feeRows, paymentRows]) => {
        if (requestRef.current !== requestId) return;
        setFees(feeRows);
        setPayments(paymentRows);
        setLoadStatus("loaded");
      })
      .catch(() => {
        if (requestRef.current !== requestId) return;
        setLoadStatus("failed");
      });
  }

  useEffect(() => {
    setFees(null);
    setPayments(null);
    setLoadStatus("idle");
    if (selectedStudentId) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-fires only on an actual student change
  }, [selectedStudentId]);

  /** A row's own successful write (or discovered already-finalized state) means the lists are stale — re-fetch both,
   * never leave a now-removed fee or now-reversed payment sitting in its old list entry. */
  function handleRowResolved() {
    load();
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs text-muted-foreground">{t("body")}</p>

      <label className="flex flex-col gap-1 text-sm">
        <span>{t("fields.student")}</span>
        <select value={selectedStudentId} onChange={(e) => setSelectedStudentId(e.target.value)} className={FIELD_CLASS}>
          <option value="">{t("fields.studentPlaceholder")}</option>
          {students.map((s) => (
            <option key={s.id} value={s.id}>
              {s.firstName} {s.lastName} — {s.academyName}
            </option>
          ))}
        </select>
      </label>

      {selectedStudentId && loadStatus === "loading" && <p className="text-sm text-muted-foreground">{t("loading")}</p>}
      {selectedStudentId && loadStatus === "failed" && (
        <div className="flex items-center gap-2">
          <p role="alert" className="text-sm text-bad">
            {t("loadFailed")}
          </p>
          <Button type="button" variant="outline" onClick={load}>
            {t("retry")}
          </Button>
        </div>
      )}

      {selectedStudentId && loadStatus === "loaded" && (
        <>
          <div className="flex flex-col gap-2">
            <p className="text-sm font-medium">{t("fees.heading")}</p>
            {fees && fees.length === 0 && <p className="text-sm text-muted-foreground">{t("fees.none")}</p>}
            {fees && fees.length > 0 && (
              <ul className="flex flex-col gap-3">
                {fees.map((fee) => (
                  <LateFeeRow key={fee.id} organizationId={organizationId} fee={fee} onResolved={handleRowResolved} />
                ))}
              </ul>
            )}
          </div>

          <div className="flex flex-col gap-2">
            <p className="text-sm font-medium">{t("payments.heading")}</p>
            {payments && payments.length === 0 && <p className="text-sm text-muted-foreground">{t("payments.none")}</p>}
            {payments && payments.length > 0 && (
              <ul className="flex flex-col gap-3">
                {payments.map((payment) => (
                  <PaymentRow key={payment.id} organizationId={organizationId} payment={payment} onResolved={handleRowResolved} />
                ))}
              </ul>
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

/** Exported for direct testing — mirrors `ReceiptRow`'s own exact recovery shape (brief §2.5's directly reusable
 * precedent), applied to a late fee's own two operations (correct, waive). */
export function LateFeeRow({
  organizationId,
  fee,
  onResolved,
}: {
  organizationId: string;
  fee: CorrectableLateFeeRow;
  onResolved: () => void;
}) {
  const t = useTranslations("payments.financialCorrections");
  const [mode, setMode] = useState<"idle" | "correcting" | "waiving">("idle");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [transportFailure, setTransportFailure] = useState(false);
  const [confirmedState, setConfirmedState] = useState<{ kind: "removed"; removalKind: "VOIDED" | "WAIVED" } | { kind: "unchanged" } | null>(null);
  const [recovery, setRecovery] = useState<RecoveryState>(IDLE_RECOVERY);

  // Correction-only fields
  const [reason, setReason] = useState("");
  const [receivedOn, setReceivedOn] = useState(todayIso());
  const [amount, setAmount] = useState(fee.amount);
  const [currency, setCurrency] = useState<Currency>(fee.currency as Currency);
  const [method, setMethod] = useState<PaymentMethod>("EFECTIVO");
  const [notes, setNotes] = useState("");

  const needsRefresh = transportFailure || error === "alreadyRemoved";

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
          // The earlier attempt does not appear to have taken effect — never auto-resubmitted, just unlocked.
          setTransportFailure(false);
          setError(null);
          setConfirmedState({ kind: "unchanged" });
        } else {
          setConfirmedState({ kind: "removed", removalKind: current.removalKind! });
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

  async function handleCorrect(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.set("lateFeeId", fee.id);
      fd.set("expectedRevision", fee.expectedRevision);
      fd.set("removalReason", reason);
      fd.set("receivedOn", receivedOn);
      fd.set("tenderCurrency", currency);
      fd.set("tenderAmount", amount);
      fd.set("method", method);
      if (notes.trim()) fd.set("notes", notes);
      const result = await correctLateFee(organizationId, {}, fd);
      if (result.ok) {
        setConfirmedState({ kind: "removed", removalKind: "VOIDED" });
        onResolved();
      } else {
        setError(result.error);
      }
    } catch {
      setTransportFailure(true);
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
      fd.set("expectedRevision", fee.expectedRevision);
      fd.set("removalReason", reason);
      const result = await waiveFee(organizationId, {}, fd);
      if (result.ok) {
        setConfirmedState({ kind: "removed", removalKind: "WAIVED" });
        onResolved();
      } else {
        setError(result.error);
      }
    } catch {
      setTransportFailure(true);
    } finally {
      setBusy(false);
    }
  }

  const finalized = confirmedState?.kind === "removed";
  const disabled = busy || needsRefresh;

  return (
    <li className="flex flex-col gap-2 rounded-lg border border-border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <span className="font-medium">
          {fee.coverageYear}-{String(fee.coverageMonth).padStart(2, "0")}
        </span>
        <span>{fee.amount} {fee.currency}</span>
      </div>

      {finalized && confirmedState.removalKind === "VOIDED" && (
        <p role="status" className="text-sm text-ok">{t("fee.outcome.voided")}</p>
      )}
      {finalized && confirmedState.removalKind === "WAIVED" && (
        <p role="status" className="text-sm text-ok">{t("fee.outcome.waived")}</p>
      )}
      {confirmedState?.kind === "unchanged" && (
        <p className="text-xs text-muted-foreground">{t("recovery.unchanged")}</p>
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

      {error && !needsRefresh && (
        <div className="flex flex-col gap-1">
          <p role="alert" className="text-sm text-bad">{t(`error.${errorMessageKey(error)}`)}</p>
          {error === "notOldestFirst" && <p className="text-xs text-muted-foreground">{t("fee.olderDebt")}</p>}
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

/** Exported for direct testing — the reversal flow's own row, mirroring `LateFeeRow`'s recovery shape. Every row
 * stays visible regardless of restriction (brief §3 decision 4); a restricted row's own reversal action is disabled,
 * with a specific named explanation, never hidden. */
export function PaymentRow({
  organizationId,
  payment,
  onResolved,
}: {
  organizationId: string;
  payment: ReversiblePaymentRow;
  onResolved: () => void;
}) {
  const t = useTranslations("payments.financialCorrections");
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [transportFailure, setTransportFailure] = useState(false);
  const [confirmedState, setConfirmedState] = useState<{ kind: "reversed" } | { kind: "unchanged" } | null>(null);
  const [recovery, setRecovery] = useState<RecoveryState>(IDLE_RECOVERY);
  const [reason, setReason] = useState("");

  const needsRefresh = transportFailure || error === "alreadyReversed";

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
        } else {
          setConfirmedState({ kind: "reversed" });
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
        setConfirmedState({ kind: "reversed" });
        onResolved();
      } else {
        setError(result.error);
      }
    } catch {
      setTransportFailure(true);
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

      {finalized && <p role="status" className="text-sm text-ok">{t("payment.outcome.reversed")}</p>}
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

      {error && !needsRefresh && (
        <p role="alert" className="text-sm text-bad">{t(`error.${errorMessageKey(error)}`)}</p>
      )}

      {!finalized && !open && (
        <div>
          <Button type="button" variant="outline" disabled={disabled || restricted} onClick={() => setOpen(true)}>
            {t("payment.reverseAction")}
          </Button>
        </div>
      )}

      {!finalized && open && (
        <form onSubmit={handleReverse} className="flex flex-col gap-2 border-t border-border pt-2">
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
