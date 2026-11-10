"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { FIELD_CLASS, Input } from "@/components/ui/input";
import { cancelOpeningObligationAction, getOpeningObligations } from "@/lib/dues/financial-corrections-actions";
import type { OpeningObligationRow } from "@/lib/dues/financial-corrections-queries";
import { OPENING_CANCELLATION_CATEGORIES, type OpeningCancellationCategory } from "@/lib/dues/reversal-classification";

/**
 * Stage 9 O2 (approved A3–A4, 2026-11-10): the owner cancels an opening balance that was entered in error. Owner only (the page
 * renders this card for ADMIN; the action and the writer re-check), a required category and a required text, an explicit
 * confirmation step. Refused while a payment is applied (A3) — the row says so and offers nothing to submit.
 *
 * Recovery is a plain re-read: after any attempt (success, refusal, or a lost response) the list is re-fetched from the server,
 * so what the owner sees is the stored truth (a cancelled row shows as cancelled with its reason) — never inferred client-side.
 * Rendered keyed by student, so switching student discards this component's state.
 */
export function OpeningCancellationList({ organizationId, studentId }: { organizationId: string; studentId: string }) {
  const t = useTranslations("payments.financialCorrections.opening");
  const [rows, setRows] = useState<OpeningObligationRow[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);

  const load = useCallback(() => {
    setLoadFailed(false);
    getOpeningObligations(organizationId, studentId)
      .then(setRows)
      .catch(() => setLoadFailed(true));
  }, [organizationId, studentId]);

  useEffect(load, [load]);

  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm font-medium">{t("heading")}</p>
      <p className="text-xs text-muted-foreground">{t("explainer")}</p>
      {loadFailed && (
        <div className="flex items-center gap-2">
          <p role="alert" className="text-sm text-bad">{t("loadFailed")}</p>
          <Button type="button" variant="outline" onClick={load}>{t("retry")}</Button>
        </div>
      )}
      {rows !== null && rows.length === 0 && <p className="text-sm text-muted-foreground">{t("none")}</p>}
      {rows !== null && rows.length > 0 && (
        <ul className="flex flex-col gap-3">
          {rows.map((row) => (
            <OpeningRow key={row.id} organizationId={organizationId} row={row} onSettled={load} />
          ))}
        </ul>
      )}
    </div>
  );
}

function OpeningRow({ organizationId, row, onSettled }: { organizationId: string; row: OpeningObligationRow; onSettled: () => void }) {
  const t = useTranslations("payments.financialCorrections.opening");
  const [category, setCategory] = useState<OpeningCancellationCategory | "">("");
  const [reason, setReason] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "bad"; key: string } | null>(null);

  const month = `${row.coverageYear}-${String(row.coverageMonth).padStart(2, "0")}`;
  const canSubmit = category !== "" && reason.trim() !== "" && !busy;

  async function submit() {
    if (!canSubmit) return;
    setBusy(true);
    setMessage(null);
    const fd = new FormData();
    fd.set("obligationId", row.id);
    fd.set("reasonCategory", category);
    fd.set("reason", reason);
    try {
      const result = await cancelOpeningObligationAction(organizationId, {}, fd);
      setMessage(result.ok ? { tone: "ok", key: "success" } : { tone: "bad", key: `errors.${result.error}` });
    } catch {
      // The response was lost: the cancellation may or may not have committed. The re-read below shows the stored truth.
      setMessage({ tone: "bad", key: "errors.unknownOutcome" });
    } finally {
      setBusy(false);
      setConfirming(false);
      onSettled();
    }
  }

  return (
    <li className="flex flex-col gap-2 rounded-lg border border-border p-3 text-sm">
      <div className="flex items-center justify-between gap-2">
        <span>{t("monthLabel", { month })}</span>
        <span>{row.amount} {row.currency}</span>
      </div>

      {row.cancelledAt !== null && (
        <p className="text-muted-foreground">{t("cancelled", { reason: row.cancellationReason ?? "" })}</p>
      )}
      {row.cancelledAt === null && row.hasActivePayment && <p className="text-muted-foreground">{t("hasActivePayment")}</p>}

      {row.cancelledAt === null && !row.hasActivePayment && (
        <div className="flex flex-col gap-2">
          <label className="flex flex-col gap-1">
            <span>{t("category")}</span>
            <select value={category} disabled={busy} onChange={(e) => setCategory(e.target.value as OpeningCancellationCategory | "")} className={FIELD_CLASS}>
              <option value="">{t("categoryPlaceholder")}</option>
              {OPENING_CANCELLATION_CATEGORIES.map((c) => (
                <option key={c} value={c}>{t(`categories.${c}`)}</option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span>{t("reason")}</span>
            <Input value={reason} disabled={busy} required onChange={(e) => setReason(e.target.value)} />
          </label>
          {!confirming && (
            <div>
              <Button type="button" variant="outline" disabled={!canSubmit} onClick={() => setConfirming(true)}>{t("cancelButton")}</Button>
            </div>
          )}
          {confirming && (
            <div className="flex flex-col gap-2 rounded-md bg-muted p-2">
              <p>{t("confirmCopy", { month, amount: `${row.amount} ${row.currency}` })}</p>
              <div className="flex gap-2">
                <Button type="button" variant="primary" disabled={!canSubmit} onClick={submit}>{busy ? t("working") : t("confirm")}</Button>
                <Button type="button" variant="outline" disabled={busy} onClick={() => setConfirming(false)}>{t("back")}</Button>
              </div>
            </div>
          )}
        </div>
      )}

      {message && (
        <p role={message.tone === "bad" ? "alert" : "status"} className={message.tone === "bad" ? "text-bad" : "text-ok"}>{t(message.key)}</p>
      )}
    </li>
  );
}
