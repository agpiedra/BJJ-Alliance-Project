"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { TextField } from "./dues-config-forms";
import { listReceipts, resolveReceipt, cancelReceipt, getReceiptStatus } from "@/lib/dues/awaiting-rate-receipt-actions";
import type { AwaitingRateReceiptRow, AwaitingRateReceiptStatusFilter } from "@/lib/dues/awaiting-rate-receipt-queries";

/**
 * The owner's awaiting-rate receipt queue list (this feature's own planning brief). A client component calling
 * `"use server"` read actions directly for tab-switching/pagination — the same precedent
 * `exchange-rate-forms.tsx`'s own `getCurrentExchangeRate`/`getExchangeRateCorrectionWarning` already established —
 * chosen over URL-searchParams-driven server rendering so status tabs and "load more" stay interactive with no new
 * page/searchParams plumbing.
 */

const STATUS_TABS: AwaitingRateReceiptStatusFilter[] = ["PENDING", "RESOLVED", "CANCELLED"];
type LoadStatus = "loading" | "loaded" | "failed";
type RowStatus = "PENDING" | "RESOLVED" | "CANCELLED";

/** Every `ResolveAwaitingRateReceiptError`/`CancelAwaitingRateReceiptError` member maps to its own distinct copy key
 * (this feature's brief §2.4) — no shared fallback for two different causes, and the two structurally-present but
 * unreachable-from-resolution members (`futureDate`, `tooOld`, plus `captured`) get their own visibly-different
 * "unexpected" treatment rather than a genuine recoverable-outcome message. */
const ERROR_KEY: Record<string, string> = {
  notActive: "notActive",
  invalid: "invalid",
  notFound: "notFound",
  alreadyResolved: "alreadyHandled",
  alreadyCancelled: "alreadyHandled",
  malformedSnapshot: "malformedSnapshot",
  staleTerms: "drifted",
  staleSelection: "drifted",
  noLongerFuture: "drifted",
  alreadySettled: "obligationChanged",
  notOldestFirst: "obligationChanged",
  feeAlreadyAssessed: "obligationChanged",
  rateUnavailable: "rateUnavailable",
  currencyMismatch: "currencyMismatchReceipt",
  ambiguousTotal: "ambiguousTotal",
  notASelectableTotal: "totalMismatch",
  totalMismatch: "totalMismatch",
  amountUnsupported: "amountUnsupported",
  conflict: "conflict",
  futureDate: "unexpected",
  tooOld: "unexpected",
  captured: "unexpected",
};

function errorMessageKey(code: string): string {
  return ERROR_KEY[code] ?? "unexpected";
}

export function ReceiptQueueList({ organizationId }: { organizationId: string }) {
  const t = useTranslations("payments.plans.receipts");
  const [status, setStatus] = useState<AwaitingRateReceiptStatusFilter>("PENDING");
  const [rows, setRows] = useState<AwaitingRateReceiptRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadStatus, setLoadStatus] = useState<LoadStatus>("loading");

  const loadPage = useCallback(
    (targetStatus: AwaitingRateReceiptStatusFilter, afterCursor: string | null, replace: boolean) => {
      setLoadStatus("loading");
      listReceipts(organizationId, { status: targetStatus, cursor: afterCursor ?? undefined })
        .then((result) => {
          setRows((prev) => (replace ? result.rows : [...prev, ...result.rows]));
          setCursor(result.nextCursor);
          setLoadStatus("loaded");
        })
        .catch(() => setLoadStatus("failed"));
    },
    [organizationId],
  );

  useEffect(() => {
    loadPage(status, null, true);
  }, [status, loadPage]);

  // A row whose own status changed (confirmed via the terminal-status refresh) no longer belongs to the tab it was
  // originally listed under — remove it from view rather than leave a RESOLVED row sitting under the PENDING tab.
  function handleRowStatusChanged(receiptId: string, newStatus: RowStatus) {
    if (newStatus !== status) setRows((prev) => prev.filter((r) => r.id !== receiptId));
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex gap-2">
        {STATUS_TABS.map((tab) => (
          <Button key={tab} type="button" variant={tab === status ? "default" : "outline"} onClick={() => setStatus(tab)}>
            {t(`tabs.${tab}`)}
          </Button>
        ))}
      </div>

      {loadStatus === "loading" && rows.length === 0 && <p className="text-sm text-muted-foreground">{t("loading")}</p>}
      {loadStatus === "failed" && (
        <p role="alert" className="text-sm text-bad">
          {t("loadFailed")}
        </p>
      )}
      {loadStatus === "loaded" && rows.length === 0 && <p className="text-sm text-muted-foreground">{t("empty")}</p>}

      {rows.length > 0 && (
        <ul className="flex flex-col gap-3">
          {rows.map((row) => (
            <ReceiptRow key={row.id} organizationId={organizationId} row={row} onStatusChanged={handleRowStatusChanged} />
          ))}
        </ul>
      )}

      {cursor && (
        <div>
          <Button type="button" variant="outline" disabled={loadStatus === "loading"} onClick={() => loadPage(status, cursor, false)}>
            {t("loadMore")}
          </Button>
        </div>
      )}
    </div>
  );
}

function CoverageSummary({ row, t }: { row: AwaitingRateReceiptRow; t: ReturnType<typeof useTranslations> }) {
  if (!row.proposal.ok) {
    return (
      <p role="alert" className="text-sm text-bad">
        {t("snapshotIntegrityFailure")}
      </p>
    );
  }
  const { existingObligationIds, proposedCoverage } = row.proposal;
  const monthList = (months: Array<{ year: number; month: number }>) =>
    months.map((m) => `${m.year}-${String(m.month).padStart(2, "0")}`).join(", ");
  return (
    <div className="flex flex-col gap-1 text-sm">
      {existingObligationIds.length > 0 && <p>{t("existingReferenced", { count: existingObligationIds.length })}</p>}
      {proposedCoverage && proposedCoverage.length > 0 && (
        <p>
          {row.status === "PENDING" && t("proposedPending", { months: monthList(proposedCoverage) })}
          {row.status === "RESOLVED" && t("proposedResolved", { months: monthList(proposedCoverage) })}
          {row.status === "CANCELLED" && t("proposedCancelled", { months: monthList(proposedCoverage) })}
        </p>
      )}
    </div>
  );
}

/** Exported for direct testing — a single row's coordinated Resolve/Cancel + terminal-status-refresh behavior does
 * not need to be driven through the full list's own fetch/tab machinery. */
export function ReceiptRow({
  organizationId,
  row,
  onStatusChanged,
}: {
  organizationId: string;
  row: AwaitingRateReceiptRow;
  onStatusChanged: (receiptId: string, status: RowStatus) => void;
}) {
  const t = useTranslations("payments.plans.receipts");
  const [busy, setBusy] = useState<"idle" | "resolving" | "cancelling">("idle");
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState(false);
  const [confirmedTerminal, setConfirmedTerminal] = useState<RowStatus | null>(null);
  const [refreshStatus, setRefreshStatus] = useState<"idle" | "loading" | "failed">("idle");
  const [refreshNonce, setRefreshNonce] = useState(0);

  const needsRefresh = error === "alreadyResolved" || error === "alreadyCancelled";

  useEffect(() => {
    if (!needsRefresh) return;
    let cancelled = false;
    setRefreshStatus("loading");
    getReceiptStatus(organizationId, row.id)
      .then((current) => {
        if (cancelled) return;
        if (!current) {
          setRefreshStatus("failed");
          return;
        }
        setRefreshStatus("idle");
        setConfirmedTerminal(current.status);
        if (current.status !== row.status) onStatusChanged(row.id, current.status);
      })
      .catch(() => {
        if (!cancelled) setRefreshStatus("failed");
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-runs on a fresh already-terminal result or an explicit Retry
  }, [error, refreshNonce]);

  async function handleResolve() {
    setBusy("resolving");
    setOk(false);
    const formData = new FormData();
    formData.set("receiptId", row.id);
    const result = await resolveReceipt(organizationId, {}, formData);
    setBusy("idle");
    if (result.ok) {
      setOk(true);
      setError(null);
      setConfirmedTerminal("RESOLVED");
      onStatusChanged(row.id, "RESOLVED");
    } else {
      setError(result.error ?? "unexpected");
    }
  }

  async function handleCancel(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget; // captured before the await — never cleared on a refusal, matching useDuesAction's own convention
    setBusy("cancelling");
    setOk(false);
    const formData = new FormData(form);
    const result = await cancelReceipt(organizationId, {}, formData);
    setBusy("idle");
    if (result.ok) {
      setOk(true);
      setError(null);
      form.reset();
      setConfirmedTerminal("CANCELLED");
      onStatusChanged(row.id, "CANCELLED");
    } else {
      setError(result.error ?? "unexpected");
    }
  }

  const actionable = row.status === "PENDING" && confirmedTerminal === null;
  const disabled = busy !== "idle";

  return (
    <li className="flex flex-col gap-2 rounded-lg border border-border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <span className="font-medium">{row.studentName}</span>
        <span className="text-xs text-muted-foreground">{t(`kinds.${row.kind}`)}</span>
      </div>
      <p className="text-sm">{t("tender", { amount: row.tenderAmount, currency: row.tenderCurrency })}</p>
      <CoverageSummary row={row} t={t} />
      {confirmedTerminal && confirmedTerminal !== row.status && <p className="text-xs text-muted-foreground">{t(`tabs.${confirmedTerminal}`)}</p>}

      {refreshStatus === "failed" && (
        <div className="flex items-center gap-2">
          <p role="alert" className="text-sm text-bad">
            {t("statusRefreshFailed")}
          </p>
          <Button type="button" variant="outline" onClick={() => setRefreshNonce((n) => n + 1)}>
            {t("retry")}
          </Button>
        </div>
      )}

      {error && !needsRefresh && (
        <p role="alert" className="text-sm text-bad">
          {t(`error.${errorMessageKey(error)}`)}
        </p>
      )}
      {ok && (
        <p role="status" className="text-sm text-ok">
          {t("actionSuccess")}
        </p>
      )}

      {actionable && (
        <div className="flex flex-col gap-2">
          <div>
            <Button type="button" disabled={disabled} onClick={handleResolve}>
              {t("resolve")}
            </Button>
          </div>
          <form onSubmit={handleCancel} className="flex flex-col gap-2">
            <input type="hidden" name="receiptId" value={row.id} />
            <p className="text-xs text-muted-foreground">{t("cancelDisclaimer")}</p>
            <TextField label={t("fields.cancellationReason")} name="reason" inputMode="text" maxLength={500} />
            <div>
              <Button type="submit" variant="outline" disabled={disabled}>
                {t("cancel")}
              </Button>
            </div>
          </form>
        </div>
      )}
    </li>
  );
}
