import { MAX_MINOR_UNITS } from "@/lib/dues/ledger/minor-units";

/**
 * Currency-conversion brief §3: exact BigInt rational arithmetic, no floating point anywhere. Pure — no Prisma import, so
 * a unit test (or anything else) can import this module without needing `DATABASE_URL`, exactly like `minor-units.ts`.
 */

const RATE_DECIMAL = /^(0|[1-9][0-9]*)(\.([0-9]+))?$/;

// This project's TS target is below ES2020, so BigInt literal syntax (`0n`) is unavailable — plain `BigInt(n)` calls instead.
const BIG_ZERO = BigInt(0);
const BIG_ONE = BigInt(1);
const BIG_TWO = BigInt(2);
const BIG_TEN = BigInt(10);
const BIG_ONE_HUNDRED = BigInt(100);

/** Parses an exact decimal string into an integer numerator and its decimal-place count (value = numerator / 10^decimals). Throws for anything that isn't a positive decimal — the same "refuse to repair, never guess" discipline `minor-units.ts` already uses. */
function parseExactDecimal(text: string): { numerator: bigint; decimals: number } {
  const match = RATE_DECIMAL.exec(text);
  if (!match) throw new RangeError(`Not a positive decimal amount: ${JSON.stringify(text)}`);
  const fraction = match[3] ?? "";
  const numerator = BigInt(match[1] + fraction);
  if (numerator <= BIG_ZERO) throw new RangeError(`Rate must be strictly positive, got ${JSON.stringify(text)}`);
  return { numerator, decimals: fraction.length };
}

/**
 * Rounds the exact rational `numerator / (denominator * multiple)` to the nearest integer — HALFWAY ROUNDS UP (policy,
 * approved) — then multiplies back by `multiple`. Exact BigInt arithmetic throughout: `round_half_up(a/b) = (2a+b) div (2b)`
 * for positive a, b, the standard integer form of "add half, floor" that never touches a floating-point value.
 */
function roundToNearestMultiple(numerator: bigint, denominator: bigint, multiple: bigint): bigint {
  const scaledDenominator = denominator * multiple;
  const q = (numerator * BIG_TWO + scaledDenominator) / (BIG_TWO * scaledDenominator);
  return q * multiple;
}

function assertMinorRange(minor: bigint, label: string): number {
  if (minor < BIG_ZERO || minor > BigInt(MAX_MINOR_UNITS)) throw new RangeError(`${label} out of range: ${minor}`);
  return Number(minor);
}

/**
 * USD (exact minor units, i.e. cents) -> the required CRC amount, in THIS SCHEMA'S OWN minor-unit convention (both
 * currencies are stored `Decimal(10,2)` — `minor-units.ts`'s own doc comment: "colones are DISPLAYED without cents
 * elsewhere, but they are stored, and priced, with them"). "Nearest whole colón" (policy 1) means rounding to the
 * nearest 100 minor units, not the nearest 1 — a CRC minor value is always a multiple of 100 coming out of this function.
 * Multiplies (converting USD -> CRC, brief §3) by the exact rate, rounds ONCE, halfway up, zero tolerance.
 */
export function convertUsdToCrcMinor(usdMinor: number, rateDecimalString: string): number {
  if (!Number.isInteger(usdMinor) || usdMinor < 0) throw new RangeError(`usdMinor must be a non-negative integer, got ${usdMinor}`);
  const rate = parseExactDecimal(rateDecimalString);
  // crcMinor = usdMinor * (rateNumerator / 10^rateDecimals) — the /100 (usdMinor's own cents scale) and the CRC minor
  // scale (also /100) cancel exactly, so the raw ratio is already in CRC MINOR units before rounding.
  const numerator = BigInt(usdMinor) * rate.numerator;
  const denominator = BIG_TEN ** BigInt(rate.decimals);
  return assertMinorRange(roundToNearestMultiple(numerator, denominator, BIG_ONE_HUNDRED), "convertUsdToCrcMinor result");
}

/**
 * CRC (exact minor units) -> the required USD amount, in USD's own natural cent precision. "Nearest cent" (policy 3) means
 * rounding to the nearest 1 minor unit. Divides (converting CRC -> USD, brief §3, policy 5) by the exact rate, rounds
 * ONCE, halfway up, zero tolerance.
 */
export function convertCrcToUsdMinor(crcMinor: number, rateDecimalString: string): number {
  if (!Number.isInteger(crcMinor) || crcMinor < 0) throw new RangeError(`crcMinor must be a non-negative integer, got ${crcMinor}`);
  const rate = parseExactDecimal(rateDecimalString);
  // usdMinor = crcMinor / (rateNumerator / 10^rateDecimals) = crcMinor * 10^rateDecimals / rateNumerator — symmetric to
  // the multiply direction: the two /100 cent/colón scales cancel exactly the same way.
  const numerator = BigInt(crcMinor) * BIG_TEN ** BigInt(rate.decimals);
  const denominator = rate.numerator;
  return assertMinorRange(roundToNearestMultiple(numerator, denominator, BIG_ONE), "convertCrcToUsdMinor result");
}

export type SelectableTotal = { sourceMinor: number; requiredMinor: number };

/**
 * Every candidate exact total (in the source currency, e.g. each valid `settleReceipt` prefix total in USD), converted
 * and rounded per `direction`, plus which required totals (if any) are produced by MORE than one distinct candidate — a
 * genuine ambiguity introduced by rounding alone (two distinct exact totals can round to the same figure) that a caller
 * must refuse rather than guess which candidate a matching tender was meant to settle. Same-currency comparisons never
 * call this at all, so same-currency behavior is completely untouched by its existence.
 */
export function detectAmbiguousRoundedTotals(
  candidates: readonly number[],
  rateDecimalString: string,
  direction: "toCrc" | "toUsd",
): { totals: SelectableTotal[]; ambiguousRequiredMinors: number[] } {
  const convert = direction === "toCrc" ? convertUsdToCrcMinor : convertCrcToUsdMinor;
  const totals = candidates.map((sourceMinor) => ({ sourceMinor, requiredMinor: convert(sourceMinor, rateDecimalString) }));
  const counts = new Map<number, number>();
  for (const t of totals) counts.set(t.requiredMinor, (counts.get(t.requiredMinor) ?? 0) + 1);
  const ambiguousRequiredMinors = [...counts.entries()].filter(([, count]) => count > 1).map(([requiredMinor]) => requiredMinor);
  return { totals, ambiguousRequiredMinors };
}
