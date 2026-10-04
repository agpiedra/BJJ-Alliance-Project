"use server";

import { revalidatePath } from "next/cache";
import { getLocale } from "next-intl/server";
import { resolveActionContext } from "@/lib/tenant/context";
import { enterExchangeRateQuote } from "@/lib/dues/ledger/exchange-rate";
import { countPaymentsAgainstQuote, findCurrentExchangeRateQuote, type ExchangeRateQuoteRow } from "@/lib/dues/exchange-rate-queries";
import type { ActionState } from "@/lib/action-state";

/**
 * Owner-only UI for the organization-wide BCR USD/CRC sell rate (currency-conversion brief; this feature's own
 * planning brief: Payment Schedules Proposal/OWNER-EXCHANGE-RATE-UI-BRIEF.md). Every export below independently
 * calls `resolveActionContext(organizationId, ["ADMIN"])` itself — the established "every export in a `"use
 * server"` file is independently client-invocable, so every export must independently defend itself" rule (the
 * "use server" export-exposure lesson from an earlier PR in this repo).
 *
 * `enterOrCorrectExchangeRate` is a thin wrapper: ALL business logic (revision allocation, RATE_VALUE/ZERO_VALUE
 * validation, the append-only/supersedesId model, the advisory-lock split, the owner-role check) lives in
 * `enterExchangeRateQuote` (exchange-rate.ts), unchanged. It NEVER passes a `deps` argument — production activation
 * stays exactly the hardcoded-false `inactiveLedgerActivation` default that function already applies on its own;
 * nothing client-reachable can ever override it.
 */

const text = (formData: FormData, name: string): string | null => {
  const value = formData.get(name);
  return typeof value === "string" ? value : null;
};

const DIGITS = /^[0-9]+$/;

/** The engine owns real calendar validity (`isRealDate`, inside `enterExchangeRateQuote`) — this only checks the
 * three fields are plain digit strings, so a non-digit or missing field refuses `invalid` before ever reaching it. */
function parseQuoteDate(formData: FormData): { year: number; month: number; day: number } | null {
  const yearRaw = text(formData, "quoteYear");
  const monthRaw = text(formData, "quoteMonth");
  const dayRaw = text(formData, "quoteDay");
  if (!yearRaw || !monthRaw || !dayRaw || !DIGITS.test(yearRaw) || !DIGITS.test(monthRaw) || !DIGITS.test(dayRaw)) return null;
  return { year: Number(yearRaw), month: Number(monthRaw), day: Number(dayRaw) };
}

function parseRevision(raw: string | null): number | null {
  if (raw === null || !DIGITS.test(raw)) return null;
  return Number(raw);
}

async function refreshExchangeRatePage(): Promise<void> {
  // Best-effort, same shape as config-actions.ts's own refreshPlanPages: a direct test call has no request-scoped
  // store, and the write has already committed by the time this runs.
  try {
    const locale = await getLocale();
    revalidatePath(`/${locale}/payments/plans`);
  } catch (error) {
    console.error("[exchange-rate-actions] failed to revalidate", { error });
  }
}

/**
 * First entry or correction of the organization-wide rate for one date — one function for both, exactly mirroring
 * `enterExchangeRateQuote` itself being one function keyed by `expectedCurrentRevision` (0 for a believed-first
 * entry, else the specific revision believed current). `value`/`sourceNote` are forwarded as raw typed text,
 * unvalidated here beyond non-blank — the engine owns `RATE_VALUE`/`ZERO_VALUE`.
 */
export async function enterOrCorrectExchangeRate(organizationId: string, _prevState: ActionState, formData: FormData): Promise<ActionState> {
  const auth = await resolveActionContext(organizationId, ["ADMIN"]);
  if (!auth.ok) return { error: "notFound" };
  const context = auth.context;

  const quoteDate = parseQuoteDate(formData);
  const value = text(formData, "value");
  const expectedCurrentRevision = parseRevision(text(formData, "expectedCurrentRevision"));
  const sourceNoteRaw = text(formData, "sourceNote");
  const sourceNote = sourceNoteRaw && sourceNoteRaw.trim() !== "" ? sourceNoteRaw : undefined;
  if (!quoteDate || value === null || value.trim() === "" || expectedCurrentRevision === null) {
    return { error: "invalid" };
  }

  const result = await enterExchangeRateQuote({ context, quoteDate, value, expectedCurrentRevision, sourceNote });
  if (!result.ok) return { error: result.error };
  await refreshExchangeRatePage();
  return { ok: true };
}

/**
 * How many settled payments reference the EXACT quote row `quoteId` — informational only, at read time, never
 * consulted by `enterOrCorrectExchangeRate`'s own `expectedCurrentRevision` check (the sole correctness guarantee
 * against a stale correction). A non-owner has no legitimate reason to call this and there is nothing sensitive in
 * a bare count, so a failed auth check returns 0 rather than a thrown error.
 */
export async function getExchangeRateCorrectionWarning(organizationId: string, quoteId: string): Promise<number> {
  const auth = await resolveActionContext(organizationId, ["ADMIN"]);
  if (!auth.ok) return 0;
  return countPaymentsAgainstQuote(organizationId, quoteId);
}

/**
 * The current row for one quoteDate — used only to refresh a Correct form's displayed "current" state after a
 * `"stale"` refusal, so the owner sees what changed without their own unsaved input being discarded or remounted.
 */
export async function getCurrentExchangeRate(
  organizationId: string,
  quoteDate: { year: number; month: number; day: number },
): Promise<ExchangeRateQuoteRow | null> {
  const auth = await resolveActionContext(organizationId, ["ADMIN"]);
  if (!auth.ok) return null;
  return findCurrentExchangeRateQuote(organizationId, quoteDate);
}
