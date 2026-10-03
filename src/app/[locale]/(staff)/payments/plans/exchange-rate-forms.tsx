"use client";

import { useEffect, useState } from "react";
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

const FIELD_GRID = "grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4";

function todayParts(): { year: number; month: number; day: number } {
  const now = new Date();
  return { year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate() };
}

function DateFields({ defaults }: { defaults: { year: number; month: number; day: number } }) {
  const t = useTranslations("payments.plans.exchangeRate.fields");
  return (
    <>
      <TextField label={t("year")} name="quoteYear" defaultValue={String(defaults.year)} inputMode="numeric" maxLength={4} />
      <TextField label={t("month")} name="quoteMonth" defaultValue={String(defaults.month)} inputMode="numeric" maxLength={2} />
      <TextField label={t("day")} name="quoteDay" defaultValue={String(defaults.day)} inputMode="numeric" maxLength={2} />
    </>
  );
}

/** Add a first entry for a date with no existing quote — `expectedCurrentRevision=0`, "believed first entry." */
export function AddExchangeRateForm({ organizationId }: { organizationId: string }) {
  const t = useTranslations("payments.plans.exchangeRate");
  const { state, onSubmit, isPending } = useDuesAction(enterOrCorrectExchangeRate.bind(null, organizationId));
  return (
    <Disclosure summary={t("add.open")}>
      <form onSubmit={onSubmit} className="flex flex-col gap-3">
        <input type="hidden" name="expectedCurrentRevision" value="0" />
        <div className={FIELD_GRID}>
          <DateFields defaults={todayParts()} />
          <TextField label={t("fields.value")} name="value" inputMode="decimal" />
          <TextField label={t("fields.sourceNote")} name="sourceNote" inputMode="text" maxLength={500} />
        </div>
        {state.error !== "stale" && <Outcome state={state} success={t("add.success")} />}
        <div>
          <Button type="submit" disabled={isPending}>
            {t("add.submit")}
          </Button>
        </div>
      </form>
    </Disclosure>
  );
}

/**
 * Correct an existing quote. On a `"stale"` refusal, the owner's typed value is never discarded (`useDuesAction`
 * only resets on success) — instead a fresh read of the now-current row and its own warning count are fetched and
 * shown alongside the untouched input, so the owner sees exactly what changed before deciding to resubmit.
 */
export function CorrectExchangeRateForm({ organizationId, row }: { organizationId: string; row: ExchangeRateQuoteRow }) {
  const t = useTranslations("payments.plans.exchangeRate");
  const { state, onSubmit, isPending } = useDuesAction(enterOrCorrectExchangeRate.bind(null, organizationId));
  const [warning, setWarning] = useState<number | null>(null);
  const [refreshed, setRefreshed] = useState<ExchangeRateQuoteRow | null>(null);

  useEffect(() => {
    let cancelled = false;
    getExchangeRateCorrectionWarning(organizationId, row.id).then((count) => {
      if (!cancelled) setWarning(count);
    });
    return () => {
      cancelled = true;
    };
  }, [organizationId, row.id]);

  useEffect(() => {
    if (state.error !== "stale") return;
    let cancelled = false;
    void (async () => {
      const current = await getCurrentExchangeRate(organizationId, row.quoteDate);
      if (cancelled || !current) return;
      setRefreshed(current);
      const count = await getExchangeRateCorrectionWarning(organizationId, current.id);
      if (!cancelled) setWarning(count);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-runs only when a fresh `"stale"` result arrives
  }, [state]);

  return (
    // key={row.revision}: remounts with fresh defaults only after a SUCCESSFUL correction changes the row's
    // revision (the parent re-renders with the new row). Never remounts on a "stale" refusal.
    <Disclosure key={row.revision} summary={t("correct.open")}>
      <form onSubmit={onSubmit} className="flex flex-col gap-3">
        <input type="hidden" name="quoteYear" value={row.quoteDate.year} />
        <input type="hidden" name="quoteMonth" value={row.quoteDate.month} />
        <input type="hidden" name="quoteDay" value={row.quoteDate.day} />
        <input type="hidden" name="expectedCurrentRevision" value={row.revision} />
        <div className={FIELD_GRID}>
          <TextField label={t("fields.value")} name="value" defaultValue={row.value} inputMode="decimal" />
          <TextField label={t("fields.sourceNote")} name="sourceNote" inputMode="text" maxLength={500} />
        </div>
        {warning !== null && warning > 0 && <p className="text-xs text-muted-foreground">{t("correct.warning", { count: warning })}</p>}
        {state.error === "stale" && refreshed && (
          <p role="alert" className="text-sm text-bad">
            {t("correct.staleBanner", { revision: refreshed.revision, value: refreshed.value })}
          </p>
        )}
        {state.error !== "stale" && <Outcome state={state} success={t("correct.success")} />}
        <div>
          <Button type="submit" disabled={isPending}>
            {t("correct.submit")}
          </Button>
        </div>
      </form>
    </Disclosure>
  );
}
