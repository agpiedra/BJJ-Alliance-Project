import type { Currency } from "@/generated/prisma/client";
import { addMonths, assertYearMonth, compareYearMonth, type YearMonth } from "@/lib/dues/calendar";

/**
 * Pure coverage, prepayment and package arithmetic. `covered` is every month that already has an obligation or paid coverage (settled
 * or not), passed in by the caller, so "after existing obligations are accounted for" is an input, not a lookup. `from` is the earliest
 * month the caller considers (normally the current billing month).
 *
 * These functions never PROPOSE a covered month and reject a whole proposal that touches one. They cannot stop two concurrent requests
 * that read the same `covered` set: that needs unique coverage rows and transactions in the schema and ledger PRs.
 */

/**
 * A price effective from a month until a later version supersedes it, in minor units of `currency`. A price HISTORY is single-currency:
 * `priceFor` rejects a history whose versions name different currencies, so an amount is never read in the wrong unit.
 */
export interface PriceVersion {
  effectiveFrom: YearMonth;
  amountMinor: number;
  currency: Currency;
}

const index = (m: YearMonth) => m.year * 12 + (m.month - 1);
const plain = (m: YearMonth): YearMonth => ({ year: m.year, month: m.month });

function assertPositiveWhole(value: number, label: string): void {
  if (!Number.isInteger(value) || value <= 0) throw new RangeError(`${label} must be a positive whole number, got ${value}`);
}

function consecutiveMonths(start: YearMonth, count: number): YearMonth[] {
  return Array.from({ length: count }, (_, i) => addMonths(start, i));
}

/** The proposed months that are already covered, in proposed order. */
export function findOverlap(covered: readonly YearMonth[], proposed: readonly YearMonth[]): YearMonth[] {
  const taken = new Set(covered.map(index));
  return proposed.filter((m) => taken.has(index(m))).map(plain);
}

/** The first month at or after `from` with no coverage: where a prepayment or package starts, so future coverage has no gaps. */
export function firstUncoveredMonth(covered: readonly YearMonth[], from: YearMonth): YearMonth {
  assertYearMonth(from);
  const taken = new Set(covered.map(index));
  let month = plain(from);
  while (taken.has(index(month))) month = addMonths(month, 1);
  return month;
}

/** The candidate months that still need an obligation: covered months and repeats within `candidates` are dropped. */
export function monthsToCreate(candidates: readonly YearMonth[], covered: readonly YearMonth[]): YearMonth[] {
  const seen = new Set(covered.map(index));
  const result: YearMonth[] = [];
  for (const m of candidates) {
    if (seen.has(index(m))) continue;
    seen.add(index(m));
    result.push(plain(m));
  }
  return result;
}

/**
 * The price version effective for `month`: the latest whose `effectiveFrom` is on or before it, as `{ amountMinor, currency }`, or null
 * when none is (never a guess). Rejects two versions effective the same month, any non-positive or fractional price, and a history
 * that mixes currencies (checked over ALL versions, not only the one that applies).
 */
export function priceFor(month: YearMonth, versions: readonly PriceVersion[]): { amountMinor: number; currency: Currency } | null {
  assertYearMonth(month);
  if (new Set(versions.map((v) => v.currency)).size > 1) throw new RangeError("A price history must be in a single currency");
  const starts = new Set<number>();
  let best: PriceVersion | null = null;
  for (const v of versions) {
    assertYearMonth(v.effectiveFrom);
    assertPositiveWhole(v.amountMinor, "A price version amount");
    if (starts.has(index(v.effectiveFrom))) throw new RangeError(`Two price versions are effective from ${v.effectiveFrom.year}-${v.effectiveFrom.month}`);
    starts.add(index(v.effectiveFrom));
    if (compareYearMonth(v.effectiveFrom, month) <= 0 && (best === null || compareYearMonth(v.effectiveFrom, best.effectiveFrom) > 0)) best = v;
  }
  return best === null ? null : { amountMinor: best.amountMinor, currency: best.currency };
}

export type PrepaidPlan =
  | { ok: true; currency: Currency; months: { month: YearMonth; amountMinor: number }[]; totalMinor: number }
  | { ok: false; reason: "OVERLAP"; overlapping: YearMonth[] }
  | { ok: false; reason: "NO_PRICE_VERSION"; month: YearMonth };

/** Ordinary prepaid months: `count` consecutive months from the first uncovered one, each priced from ITS OWN effective price version. */
export function planPrepaidMonths(args: { covered: readonly YearMonth[]; from: YearMonth; count: number; versions: readonly PriceVersion[] }): PrepaidPlan {
  assertPositiveWhole(args.count, "The number of prepaid months");
  const months = consecutiveMonths(firstUncoveredMonth(args.covered, args.from), args.count);
  const overlapping = findOverlap(args.covered, months);
  if (overlapping.length > 0) return { ok: false, reason: "OVERLAP", overlapping };
  const priced: { month: YearMonth; amountMinor: number }[] = [];
  let currency: Currency | null = null;
  for (const month of months) {
    const price = priceFor(month, args.versions);
    if (price === null) return { ok: false, reason: "NO_PRICE_VERSION", month };
    currency = price.currency; // one currency for the whole history, enforced by priceFor
    priced.push({ month, amountMinor: price.amountMinor });
  }
  return { ok: true, currency: currency as Currency, months: priced, totalMinor: priced.reduce((sum, p) => sum + p.amountMinor, 0) };
}

export type PackagePlan =
  | { ok: true; coverage: YearMonth[]; currency: Currency; amountMinor: number }
  | { ok: false; reason: "OVERLAP"; overlapping: YearMonth[] };

/**
 * A package: its configured number of consecutive months from the first uncovered month, at the QUOTED package price (the only price
 * input, so a later price change cannot alter it). Any already-covered month in the run rejects the whole package.
 */
export function planPackage(args: { covered: readonly YearMonth[]; from: YearMonth; months: number; currency: Currency; quotedAmountMinor: number }): PackagePlan {
  assertPositiveWhole(args.months, "The package length");
  assertPositiveWhole(args.quotedAmountMinor, "The quoted package price");
  const coverage = consecutiveMonths(firstUncoveredMonth(args.covered, args.from), args.months);
  const overlapping = findOverlap(args.covered, coverage);
  if (overlapping.length > 0) return { ok: false, reason: "OVERLAP", overlapping };
  return { ok: true, coverage, currency: args.currency, amountMinor: args.quotedAmountMinor };
}
