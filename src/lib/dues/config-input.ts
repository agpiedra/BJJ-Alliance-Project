import { DateTime } from "luxon";
import type { Currency } from "@/generated/prisma/client";
import { addMonths, type YearMonth } from "@/lib/dues/calendar";

/**
 * Input rules for the owner's dues configuration. Pure functions, no clock (the caller passes `now`), no storage.
 *
 * Money is parsed as a STRING: no `Number`, no `Math.round`, no locale. The existing plan form's `parseDefaultAmount` does
 * `Math.round(Number(raw) * 100) / 100`, which silently rounds ("1.005" is stored as 1.01 or 1.00); that behaviour is legacy and must
 * not be reused for prices or fees.
 */

/** The calendar window the schema's CHECK constraints accept for an effective year (2000 to 2100). */
export const SUPPORTED_YEAR_MIN = 2000;
export const SUPPORTED_YEAR_MAX = 2100;

/**
 * The most months a plan can cover, or a prepayment limit can name, is the supported calendar span itself: a package cannot run
 * past the years the schema supports. It is a technical bound derived from the same constants as the CHECK, not a business limit; the
 * owner-configured prepayment limit is a separate setting and is never inferred from it.
 */
export const MAX_SUPPORTED_MONTHS = (SUPPORTED_YEAR_MAX - SUPPORTED_YEAR_MIN + 1) * 12;

export type Parsed<T> = { ok: true; value: T } | { ok: false };

const MONEY = /^(0|[1-9][0-9]{0,7})(\.[0-9]{1,2})?$/;

/**
 * An amount in the column's own shape, `Decimal(10, 2)` (up to 99,999,999.99), from the exact text the owner typed. More than two
 * decimals, an exponent, a sign, spaces, thousands separators, a comma decimal, a leading zero and an empty value are all refused, never
 * rounded or repaired. Returns the canonical two-decimal string. `allowZero` is true for a fee, false for a price.
 */
export function parseMoney(raw: string | null | undefined, opts: { allowZero: boolean }): Parsed<string> {
  if (typeof raw !== "string" || !MONEY.test(raw)) return { ok: false };
  const [whole, fraction = ""] = raw.split(".");
  const canonical = `${whole}.${fraction.padEnd(2, "0")}`;
  if (!opts.allowZero && !/[1-9]/.test(canonical)) return { ok: false };
  return { ok: true, value: canonical };
}

const WHOLE = /^(0|[1-9][0-9]{0,9})$/;

/** A whole number from digits only, within `min` to `max` inclusive. */
export function parseWholeNumber(raw: string | null | undefined, min: number, max: number): Parsed<number> {
  if (typeof raw !== "string" || !WHOLE.test(raw)) return { ok: false };
  const value = Number(raw); // at most 10 digits: exact
  return value >= min && value <= max ? { ok: true, value } : { ok: false };
}

/** A real calendar month inside the supported years. */
export function parseEffectiveMonth(yearRaw: string | null | undefined, monthRaw: string | null | undefined): Parsed<YearMonth> {
  if (typeof yearRaw !== "string" || !/^[0-9]{4}$/.test(yearRaw)) return { ok: false };
  const year = Number(yearRaw);
  if (year < SUPPORTED_YEAR_MIN || year > SUPPORTED_YEAR_MAX) return { ok: false };
  const month = parseWholeNumber(monthRaw, 1, 12);
  return month.ok ? { ok: true, value: { year, month: month.value } } : { ok: false };
}

/** The calendar month it is right now in the BRANCH's timezone (never the server's or UTC). Throws for an unknown timezone. */
export function currentMonthIn(zone: string, now: Date = new Date()): YearMonth {
  const local = DateTime.fromJSDate(now, { zone });
  if (!local.isValid) throw new RangeError(`Unknown timezone: ${zone}`);
  return { year: local.year, month: local.month };
}

/** The month after the current one in the branch's timezone: a sensible default for "effective from". */
export function nextMonthIn(zone: string, now: Date = new Date()): YearMonth {
  return addMonths(currentMonthIn(zone, now), 1);
}

/**
 * A token for the values a version had when an editor loaded it. An edit sends it back and the server recomputes it from the row
 * inside the transaction: a mismatch means someone else changed the row first, so the edit is refused instead of overwriting them.
 * Key order does not matter; null, numbers and strings are all distinguished.
 */
export function versionRevision(fields: Record<string, string | number | null>): string {
  return JSON.stringify(
    Object.keys(fields)
      .sort()
      .map((key) => [key, fields[key]]),
  );
}

/**
 * Second review round (currency-conversion brief PR 3): a `DuesPolicyVersion` row's OWN per-month billing values —
 * `dueDay`/`graceDay`/`lateFeeAmount`/`lateFeeCurrency`, the fields that actually shape what a SPECIFIC month's
 * obligation needs — fingerprinted via `versionRevision`'s existing, field-generic mechanism (the same tool
 * `assignmentRevision` already uses for a `planId`). A future-effective policy row can be corrected IN PLACE (same id,
 * new values), exactly like a terms row can; an id match alone never proves these are unchanged. One shared function so
 * a capture site and its matching resolution re-check can never drift apart.
 *
 * Deliberately EXCLUDES `maxPrepaidMonths`: that is a standing, branch-wide HORIZON setting evaluated ONCE against the
 * live current month (mirroring `prepayMonthlyObligations`'s own capture-time horizon check, resolved from
 * `purchaseInstant` rather than per requested month) — a separate concern from what any one month's own obligation
 * needs, re-checked by its own dedicated mechanism rather than folded into this per-month fingerprint.
 */
export function policyRevisionOf(policy: { dueDay: number; graceDay: number; lateFeeAmount: string; lateFeeCurrency: Currency }): string {
  return versionRevision({
    dueDay: policy.dueDay,
    graceDay: policy.graceDay,
    lateFeeAmount: policy.lateFeeAmount,
    lateFeeCurrency: policy.lateFeeCurrency,
  });
}

/**
 * One currency across a branch's whole dues configuration (every plan's terms and every fee): the calculation library prices tuition
 * and fee in one currency and nothing converts. `existing` is every currency already saved for the branch (repeats allowed); a history
 * that already mixes currencies is never compatible with anything.
 */
export function currenciesCompatible(existing: readonly Currency[], next: Currency): boolean {
  return new Set([...existing, next]).size === 1;
}

type Money = { toFixed(digits: number): string };

/** The stale-edit token of a terms row, from the values an editor could have changed. */
export function termsRevision(row: { priceAmount: Money; currency: string; monthsCovered: number }): string {
  return versionRevision({ priceAmount: row.priceAmount.toFixed(2), currency: row.currency, monthsCovered: row.monthsCovered });
}

/** The stale-edit token of a policy version row. */
export function policyRevision(row: {
  dueDay: number;
  graceDay: number;
  lateFeeAmount: Money;
  lateFeeCurrency: string;
  maxPrepaidMonths: number | null;
}): string {
  return versionRevision({
    dueDay: row.dueDay,
    graceDay: row.graceDay,
    lateFeeAmount: row.lateFeeAmount.toFixed(2),
    lateFeeCurrency: row.lateFeeCurrency,
    maxPrepaidMonths: row.maxPrepaidMonths,
  });
}
