import type { Currency } from "@/generated/prisma/client";
import { compareDates, compareYearMonth, nextDay, type CalendarDate, type YearMonth } from "@/lib/dues/calendar";

/**
 * Pure fee and settlement arithmetic for student dues. Amounts are integer MINOR units (USD cents) in the obligation's own currency;
 * nothing here converts between currencies, so a receipt in another currency is refused (conversion and its rounding are not decided).
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

/** Oldest coverage month first (ties broken by id so the order is deterministic). Returns a new array. */
export function orderOldestFirst<T extends { id: string; coverage: YearMonth }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => compareYearMonth(a.coverage, b.coverage) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** The unsettled obligations as settlement items: oldest first, each at its full amount due on `receivedOn`. */
export function outstandingItems(open: readonly ObligationTerms[], receivedOn: CalendarDate): SettlementItem[] {
  return orderOldestFirst(open).map((o) => ({ id: o.id, currency: o.currency, amountMinor: amountDueMinor(o, receivedOn) }));
}

/** `selectableTotalsMinor` is in the items' currency, and is always empty on `CURRENCY_MISMATCH`. */
export type SettlementResult =
  | { ok: true; settledIds: string[]; totalMinor: number }
  | { ok: false; reason: "NOT_A_SELECTABLE_TOTAL" | "CURRENCY_MISMATCH"; selectableTotalsMinor: number[] };

/**
 * Whole-obligation settlement over items in payment order (outstanding oldest first, then any future periods). A receipt must equal the
 * running total of the first k items for some k of at least 1: several months can be settled together, but nothing is ever split, so a
 * partial amount, an amount between totals and an amount beyond the last total are all refused, with the totals that would be accepted.
 */
export function settleReceipt(items: readonly SettlementItem[], receiptMinor: number, receiptCurrency: Currency): SettlementResult {
  if (!Number.isInteger(receiptMinor) || receiptMinor < 0) throw new RangeError(`The receipt must be a whole number of minor units, got ${receiptMinor}`);
  items.forEach((item) => assertPositiveMinor(item.amountMinor, `Amount of ${item.id}`));

  const totals: number[] = [];
  items.reduce((running, item) => {
    totals.push(running + item.amountMinor);
    return running + item.amountMinor;
  }, 0);

  // Mixed currencies, or a receipt in a currency other than the items': refused with NO totals. The totals are in the items' currency,
  // so offering them for a receipt in another one would read as amounts in the wrong unit.
  const currencies = new Set(items.map((item) => item.currency));
  if (currencies.size > 1 || (currencies.size === 1 && !currencies.has(receiptCurrency))) {
    return { ok: false, reason: "CURRENCY_MISMATCH", selectableTotalsMinor: [] };
  }

  const k = totals.indexOf(receiptMinor);
  if (k === -1) return { ok: false, reason: "NOT_A_SELECTABLE_TOTAL", selectableTotalsMinor: totals };
  return { ok: true, settledIds: items.slice(0, k + 1).map((item) => item.id), totalMinor: receiptMinor };
}
