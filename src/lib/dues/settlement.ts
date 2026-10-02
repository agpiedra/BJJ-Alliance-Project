import type { Currency } from "@/generated/prisma/client";
import { compareDates, compareYearMonth, nextDay, type CalendarDate, type YearMonth } from "@/lib/dues/calendar";

/**
 * Pure fee and settlement arithmetic for student dues. Amounts are integer MINOR units (USD cents) in the obligation's own currency.
 * Nothing here performs a currency conversion itself — `settleReceipt`'s own `crossCurrency` parameter accepts already-converted
 * candidate totals from a caller (currency-conversion brief PR 2: `exchange-rate-arithmetic.ts`'s exact BigInt arithmetic), so this
 * module never imports or duplicates that logic; omit it and cross-currency behavior is exactly what it always was (`CURRENCY_MISMATCH`).
 *
 * Guarantees are those of pure functions: same inputs, same output, nothing read or written. That a fee ROW can exist only once per
 * obligation, or that two people cannot settle the same obligation, are storage guarantees for later PRs.
 */

/** An obligation as a later PR will snapshot it at creation: amounts and dates never change afterwards. */
export interface ObligationTerms {
  id: string;
  /** The month it covers (used for oldest-first ordering). */
  coverage: YearMonth;
  currency: Currency;
  tuitionMinor: number;
  /** The late fee from this obligation's own snapshot (its branch's fee at creation). Zero is allowed. */
  lateFeeMinor: number;
  /** Inclusive: a payment received on this date is on time. */
  graceDeadline: CalendarDate;
}

/** One thing a payment can settle, in payment order. `amountMinor` is its full amount due. */
export interface SettlementItem {
  id: string;
  currency: Currency;
  amountMinor: number;
}

function assertPositiveMinor(value: number, label: string): void {
  if (!Number.isInteger(value) || value <= 0) throw new RangeError(`${label} must be a positive whole number of minor units, got ${value}`);
}

/** The fee applies when the payment is RECEIVED after the inclusive grace deadline. */
export function lateFeeApplies(receivedOn: CalendarDate, graceDeadline: CalendarDate): boolean {
  return compareDates(receivedOn, graceDeadline) > 0;
}

/** The first day the fee can be assessed: the day after the grace deadline. */
export function feeAssessableFrom(graceDeadline: CalendarDate): CalendarDate {
  return nextDay(graceDeadline);
}

/** What settling this obligation in full costs on `receivedOn`: tuition, plus its snapshotted fee if the payment is late. */
export function amountDueMinor(obligation: ObligationTerms, receivedOn: CalendarDate): number {
  assertPositiveMinor(obligation.tuitionMinor, `Tuition of ${obligation.id}`);
  if (!Number.isInteger(obligation.lateFeeMinor) || obligation.lateFeeMinor < 0) {
    throw new RangeError(`Late fee of ${obligation.id} must be a whole number of minor units, got ${obligation.lateFeeMinor}`);
  }
  return obligation.tuitionMinor + (lateFeeApplies(receivedOn, obligation.graceDeadline) ? obligation.lateFeeMinor : 0);
}

/**
 * The late fee owed on an obligation as of `asOf`: nothing through the grace deadline, then ONE fixed fee, however late the date and
 * however often this is asked (it never grows). It is judged by the RECEIVED date of the full settlement: settled on or before the
 * deadline means no fee; settled after it, or not at all, means the fee was owed. `settledOn` is null while unsettled.
 */
export function lateFeeToAssessMinor(obligation: ObligationTerms & { settledOn: CalendarDate | null }, asOf: CalendarDate): number {
  if (!lateFeeApplies(asOf, obligation.graceDeadline)) return 0;
  if (obligation.settledOn !== null && !lateFeeApplies(obligation.settledOn, obligation.graceDeadline)) return 0;
  return obligation.lateFeeMinor;
}

/**
 * Total late fees across obligations as of `asOf`, in their ONE shared currency: one fee per overdue obligation, so two overdue months
 * are two fees. Obligations in different currencies are rejected (there is no conversion here), so group by currency before calling.
 */
export function totalLateFeesMinor(obligations: readonly (ObligationTerms & { settledOn: CalendarDate | null })[], asOf: CalendarDate): number {
  if (new Set(obligations.map((o) => o.currency)).size > 1) {
    throw new RangeError("Late fees in different currencies cannot be added; group the obligations by currency first");
  }
  return obligations.reduce((sum, o) => sum + lateFeeToAssessMinor(o, asOf), 0);
}

/** Oldest coverage month first; `priorityOf` (default: everything equal) breaks a tie on the SAME coverage month before the id
 * tie-break does — a lower number sorts first (dues-signup-settlement brief D16: a SIGNUP due the same month as a MONTHLY sorts
 * ahead of it). Omitting it reproduces every existing caller's order byte-for-byte. Returns a new array. */
export function orderOldestFirst<T extends { id: string; coverage: YearMonth }>(items: readonly T[], priorityOf: (item: T) => number = () => 0): T[] {
  return [...items].sort(
    (a, b) => compareYearMonth(a.coverage, b.coverage) || (priorityOf(a) - priorityOf(b)) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

/** The unsettled obligations as settlement items: oldest first, each at its full amount due on `receivedOn`. */
export function outstandingItems(open: readonly ObligationTerms[], receivedOn: CalendarDate): SettlementItem[] {
  return orderOldestFirst(open).map((o) => ({ id: o.id, currency: o.currency, amountMinor: amountDueMinor(o, receivedOn) }));
}

/** Running totals of `items`' own amounts, oldest first as given — the exact prefix sums `settleReceipt` matches a receipt against.
 * Exported so a cross-currency caller can convert these SAME candidates (via `exchange-rate-arithmetic.ts`'s
 * `detectAmbiguousRoundedTotals`) before building `settleReceipt`'s own `crossCurrency` argument — one computation, not two. */
export function runningTotalsMinor(items: readonly { amountMinor: number }[]): number[] {
  const totals: number[] = [];
  items.reduce((running, item) => {
    totals.push(running + item.amountMinor);
    return running + item.amountMinor;
  }, 0);
  return totals;
}

/** `selectableTotalsMinor` is in the items' currency for a same-currency refusal, and in the RECEIPT's currency for a cross-currency
 * one (`AMBIGUOUS_TOTAL`/cross-currency `NOT_A_SELECTABLE_TOTAL`) — always empty on `CURRENCY_MISMATCH`. */
export type SettlementResult =
  | { ok: true; settledIds: string[]; totalMinor: number }
  | { ok: false; reason: "NOT_A_SELECTABLE_TOTAL" | "CURRENCY_MISMATCH" | "AMBIGUOUS_TOTAL"; selectableTotalsMinor: number[] };

/**
 * One converted candidate: `sourceMinor` is one of `items`' own prefix totals (its own currency), `requiredMinor` is what a receipt in
 * the OTHER currency would need to equal to settle exactly that prefix. Structurally identical to (and meant to be fed directly from)
 * `exchange-rate-arithmetic.ts`'s own `SelectableTotal` — no import here, so this module stays free of any currency-conversion dependency.
 */
export type CrossCurrencyCandidate = { sourceMinor: number; requiredMinor: number };

/**
 * The caller's own pre-converted candidates (currency-conversion brief PR 2, §3) — built from `runningTotalsMinor(items)` via
 * `exchange-rate-arithmetic.ts`'s `convertUsdToCrcMinor`/`convertCrcToUsdMinor` and `detectAmbiguousRoundedTotals`, never computed here.
 * `ambiguousRequiredMinors` are required totals produced by MORE than one distinct candidate (two distinct exact prefixes that round
 * to the same figure) — a receipt matching one is refused (`AMBIGUOUS_TOTAL`), since which prefix it was meant to settle is genuinely
 * unknowable from the number alone.
 */
export type CrossCurrencyCandidates = { totals: readonly CrossCurrencyCandidate[]; ambiguousRequiredMinors: readonly number[] };

/**
 * Whole-obligation settlement over items in payment order (outstanding oldest first, then any future periods). A receipt must equal the
 * running total of the first k items for some k of at least 1: several months can be settled together, but nothing is ever split, so a
 * partial amount, an amount between totals and an amount beyond the last total are all refused, with the totals that would be accepted.
 *
 * `crossCurrency`, when given, is tried ONLY when the items share one currency that differs from `receiptCurrency` — mixed-currency
 * items are always `CURRENCY_MISMATCH`, exactly as before, since there is no single source currency to convert from. Omitting it (every
 * existing caller before PR 2) reproduces the prior behavior byte-for-byte: any currency mismatch is `CURRENCY_MISMATCH`.
 */
export function settleReceipt(
  items: readonly SettlementItem[],
  receiptMinor: number,
  receiptCurrency: Currency,
  crossCurrency?: CrossCurrencyCandidates,
): SettlementResult {
  if (!Number.isInteger(receiptMinor) || receiptMinor < 0) throw new RangeError(`The receipt must be a whole number of minor units, got ${receiptMinor}`);
  items.forEach((item) => assertPositiveMinor(item.amountMinor, `Amount of ${item.id}`));

  const totals = runningTotalsMinor(items);
  const currencies = new Set(items.map((item) => item.currency));
  if (currencies.size > 1) return { ok: false, reason: "CURRENCY_MISMATCH", selectableTotalsMinor: [] };

  if (currencies.size === 0 || currencies.has(receiptCurrency)) {
    const k = totals.indexOf(receiptMinor);
    if (k === -1) return { ok: false, reason: "NOT_A_SELECTABLE_TOTAL", selectableTotalsMinor: totals };
    return { ok: true, settledIds: items.slice(0, k + 1).map((item) => item.id), totalMinor: receiptMinor };
  }

  if (!crossCurrency) return { ok: false, reason: "CURRENCY_MISMATCH", selectableTotalsMinor: [] };
  if (crossCurrency.ambiguousRequiredMinors.includes(receiptMinor)) return { ok: false, reason: "AMBIGUOUS_TOTAL", selectableTotalsMinor: [] };
  const match = crossCurrency.totals.find((t) => t.requiredMinor === receiptMinor);
  if (!match) return { ok: false, reason: "NOT_A_SELECTABLE_TOTAL", selectableTotalsMinor: crossCurrency.totals.map((t) => t.requiredMinor) };
  const k = totals.indexOf(match.sourceMinor);
  return { ok: true, settledIds: items.slice(0, k + 1).map((item) => item.id), totalMinor: receiptMinor };
}
