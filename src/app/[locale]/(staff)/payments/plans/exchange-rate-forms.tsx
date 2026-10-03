"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Disclosure, Outcome, TextField, useDuesAction } from "./dues-config-forms";
import { enterOrCorrectExchangeRate, getCurrentExchangeRate, getExchangeRateCorrectionWarning } from "@/lib/dues/exchange-rate-actions";
import type { ExchangeRateQuoteRow } from "@/lib/dues/exchange-rate-queries";

/**
 * The owner's exchange-rate forms (currency-conversion brief; this feature's own planning brief). Same conventions
 * as `dues-config-forms.tsx`'s Add/Correct pairing: `useDuesAction` (reset-on-success only, so a refused submission
 * never discards what the owner typed), `TextField` (`type="text"` + `inputMode`, never a locale-dependent
 * `type="number"`), `Outcome`, `Disclosure`.
 */

type FetchStatus = "loading" | "loaded" | "failed";
type QuoteDateParts = ExchangeRateQuoteRow["quoteDate"];

const FIELD_GRID = "grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4";

function todayParts(): QuoteDateParts {
  const now = new Date();
  return { year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate() };
}

/** Reads the date the owner actually submitted off the real `FormData` — never `todayParts()`'s default, since the
 * owner may have edited the date fields before submitting. */
function readSubmittedDate(formData: FormData): QuoteDateParts | null {
  const year = Number(formData.get("quoteYear"));
  const month = Number(formData.get("quoteMonth"));
  const day = Number(formData.get("quoteDay"));
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
  return { year, month, day };
}

function DateFields({ defaults }: { defaults: QuoteDateParts }) {
  const t = useTranslations("payments.plans.exchangeRate.fields");
  return (
    <>
      <TextField label={t("year")} name="quoteYear" defaultValue={String(defaults.year)} inputMode="numeric" maxLength={4} />
      <TextField label={t("month")} name="quoteMonth" defaultValue={String(defaults.month)} inputMode="numeric" maxLength={2} />
      <TextField label={t("day")} name="quoteDay" defaultValue={String(defaults.day)} inputMode="numeric" maxLength={2} />
    </>
  );
}

/**
 * Add a first entry for a date with no existing quote — `expectedCurrentRevision=0`, "believed first entry." On a
 * `"stale"` refusal (someone else already entered a rate for this date first), the owner's typed value is never
 * discarded (`useDuesAction` only resets on success). Unlike a date that happens to be in `listRecentExchangeRateQuotes`'s
 * own most-recent-20 window, the date the owner submitted here might not be rendered as a Correct form ANYWHERE
 * else on the page — pointing at "the Correct form listed for that date" would be a dead end. Instead, this fetches
 * the current row for the EXACT submitted date and renders a full, working `CorrectExchangeRateForm` inline for it
 * (the same component, reused rather than re-implementing its accept/retry/warning logic a third time).
 */
export function AddExchangeRateForm({ organizationId }: { organizationId: string }) {
  const t = useTranslations("payments.plans.exchangeRate");
  const { state, onSubmit, isPending } = useDuesAction(enterOrCorrectExchangeRate.bind(null, organizationId));
  const [submittedDate, setSubmittedDate] = useState<QuoteDateParts | null>(null);
  const [staleTarget, setStaleTarget] = useState<ExchangeRateQuoteRow | null>(null);
  const [staleTargetStatus, setStaleTargetStatus] = useState<FetchStatus>("loading");

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    setSubmittedDate(readSubmittedDate(new FormData(event.currentTarget)));
    onSubmit(event);
  };

  useEffect(() => {
    if (state.error !== "stale" || !submittedDate) return;
    let cancelled = false;
    setStaleTargetStatus("loading");
    setStaleTarget(null);
    getCurrentExchangeRate(organizationId, submittedDate)
      .then((current) => {
        if (cancelled) return;
        setStaleTarget(current);
        setStaleTargetStatus("loaded");
      })
      .catch(() => {
        if (!cancelled) setStaleTargetStatus("failed");
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-runs only when a fresh "stale" result arrives
  }, [state, submittedDate]);

  return (
    <Disclosure summary={t("add.open")}>
      <form onSubmit={handleSubmit} className="flex flex-col gap-3">
        <input type="hidden" name="expectedCurrentRevision" value="0" />
        <div className={FIELD_GRID}>
          <DateFields defaults={todayParts()} />
          <TextField label={t("fields.value")} name="value" inputMode="decimal" />
          <TextField label={t("fields.sourceNote")} name="sourceNote" inputMode="text" maxLength={500} />
        </div>
        {state.error === "stale" ? (
          <p role="alert" className="text-sm text-bad">
            {staleTargetStatus === "failed" ? t("add.staleLoadFailed") : t("add.stale")}
          </p>
        ) : (
          <Outcome state={state} success={t("add.success")} />
        )}
        <div>
          <Button type="submit" disabled={isPending}>
            {t("add.submit")}
          </Button>
        </div>
      </form>
      {/* A SIBLING of the form above, never nested inside it — HTML forbids a <form> inside a <form>, and
          CorrectExchangeRateForm renders its own. */}
      {state.error === "stale" && staleTargetStatus === "loaded" && staleTarget && (
        <CorrectExchangeRateForm organizationId={organizationId} row={staleTarget} />
      )}
    </Disclosure>
  );
}

/**
 * Correct an existing quote. On a `"stale"` refusal, the owner's typed value is never discarded (`useDuesAction`
 * only resets on success) — a fresh read of the now-current row and its own warning count are fetched and shown
 * alongside the untouched input.
 *
 * Retrying actually works: the hidden `expectedCurrentRevision` is bound to an explicitly owner-ACCEPTED target
 * (`acceptedTarget`), never to `row.revision` unconditionally and never auto-populated from the refresh — the owner
 * must click "Use revision N" (a distinct, non-submitting button) and only then resubmit. A fresh stale result
 * always clears any prior acceptance, so a SECOND concurrent correction forces a fresh, explicit accept of the
 * newest target too — the recovery cycle repeats correctly no matter how many times it races.
 *
 * The warning count has exactly one source of truth: `currentTargetId` (the refreshed target's id once one exists,
 * else the original row's). A single effect keyed on it re-fires whenever the displayed target changes, and a ref
 * (updated every render, not just when the effect's own deps change) is checked at resolution time — a response for
 * a target that is no longer current is discarded, not applied, closing the race where a slower fetch for the
 * ORIGINAL target could otherwise overwrite a correct, already-displayed count for a NEWER one.
 */
export function CorrectExchangeRateForm({ organizationId, row }: { organizationId: string; row: ExchangeRateQuoteRow }) {
  const t = useTranslations("payments.plans.exchangeRate");
  const { state, onSubmit, isPending } = useDuesAction(enterOrCorrectExchangeRate.bind(null, organizationId));
  const [warning, setWarning] = useState<number | null>(null);
  const [warningStatus, setWarningStatus] = useState<FetchStatus>("loading");
  const [refreshed, setRefreshed] = useState<ExchangeRateQuoteRow | null>(null);
  const [refreshStatus, setRefreshStatus] = useState<FetchStatus>("loading");
  const [acceptedTarget, setAcceptedTarget] = useState<ExchangeRateQuoteRow | null>(null);

  const currentTargetId = refreshed?.id ?? row.id;
  const currentTargetIdRef = useRef(currentTargetId);
  useEffect(() => {
    currentTargetIdRef.current = currentTargetId;
  });

  useEffect(() => {
    let cancelled = false;
    const forId = currentTargetId;
    setWarningStatus("loading");
    getExchangeRateCorrectionWarning(organizationId, forId)
      .then((count) => {
        if (cancelled || currentTargetIdRef.current !== forId) return; // a response for a target that's no longer current
        setWarning(count);
        setWarningStatus("loaded");
      })
      .catch(() => {
        if (cancelled || currentTargetIdRef.current !== forId) return;
        setWarningStatus("failed");
      });
    return () => {
      cancelled = true;
    };
  }, [organizationId, currentTargetId]);

  useEffect(() => {
    if (state.error !== "stale") return;
    let cancelled = false;
    setRefreshStatus("loading");
    setAcceptedTarget(null); // a fresh stale result always requires a fresh, explicit accept of the new target
    getCurrentExchangeRate(organizationId, row.quoteDate)
      .then((current) => {
        if (cancelled) return;
        setRefreshed(current);
        setRefreshStatus("loaded");
      })
      .catch(() => {
        if (!cancelled) setRefreshStatus("failed");
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-runs only when a fresh `"stale"` result arrives
  }, [state]);

  const target = acceptedTarget ?? row;
  const stillNeedsAccept = state.error === "stale" && refreshed !== null && acceptedTarget?.id !== refreshed.id;
  const canSubmit = !isPending && (state.error !== "stale" || !stillNeedsAccept);

  return (
    // key={row.revision}: remounts with fresh defaults only after a SUCCESSFUL correction changes the row's
    // revision (the parent re-renders with the new row). Never remounts on a "stale" refusal.
    <Disclosure key={row.revision} summary={t("correct.open")}>
      <form onSubmit={onSubmit} className="flex flex-col gap-3">
        <input type="hidden" name="quoteYear" value={row.quoteDate.year} />
        <input type="hidden" name="quoteMonth" value={row.quoteDate.month} />
        <input type="hidden" name="quoteDay" value={row.quoteDate.day} />
        <input type="hidden" name="expectedCurrentRevision" value={target.revision} />
        <div className={FIELD_GRID}>
          <TextField label={t("fields.value")} name="value" defaultValue={row.value} inputMode="decimal" />
          <TextField label={t("fields.sourceNote")} name="sourceNote" inputMode="text" maxLength={500} />
        </div>
        {warningStatus === "failed" && <p className="text-xs text-bad">{t("correct.warningLoadFailed")}</p>}
        {warningStatus === "loaded" && warning !== null && warning > 0 && (
          <p className="text-xs text-muted-foreground">{t("correct.warning", { count: warning })}</p>
        )}
        {state.error === "stale" && (
          <div className="flex flex-col gap-2">
            {refreshStatus === "failed" && (
              <p role="alert" className="text-sm text-bad">
                {t("correct.staleLoadFailed")}
              </p>
            )}
            {refreshStatus === "loaded" && refreshed && (
              <>
                <p role="alert" className="text-sm text-bad">
                  {t("correct.staleBanner", { revision: refreshed.revision, value: refreshed.value })}
                </p>
                {stillNeedsAccept && (
                  <div>
                    <Button type="button" variant="outline" onClick={() => setAcceptedTarget(refreshed)}>
                      {t("correct.useRevision", { revision: refreshed.revision })}
                    </Button>
                  </div>
                )}
              </>
            )}
          </div>
        )}
        {state.error !== "stale" && <Outcome state={state} success={t("correct.success")} />}
        <div>
          <Button type="submit" disabled={!canSubmit}>
            {t("correct.submit")}
          </Button>
        </div>
      </form>
    </Disclosure>
  );
}
