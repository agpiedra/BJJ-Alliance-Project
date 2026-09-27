/**
 * Exact conversion between the money strings the database stores and the integer minor units the calculation library uses.
 *
 * Every dues amount is `Decimal(10, 2)`, for USD and CRC alike, so the minor-unit exponent is 2 for both (colones are DISPLAYED without
 * cents elsewhere, but they are stored, and priced, with them). Conversion works on the fixed-scale STRING only: digits are read, never
 * multiplied. There is no `Number(x) * 100` (1.15 * 100 is 114.99999999999999), no `Math.round`, and no repair of a value that is not
 * exactly a canonical amount: it is refused. The largest amount, 99,999,999.99, is 9,999,999,999 minor units, well inside 2^53.
 */

/** The column's own maximum, Decimal(10, 2): 99,999,999.99. */
export const MAX_MINOR_UNITS = 9_999_999_999;

const CANONICAL = /^(0|[1-9][0-9]{0,7})\.[0-9]{2}$/;

/** A canonical two-decimal amount ("100.00", "0.05", "25000.50") as integer minor units. Anything else throws `RangeError`. */
export function decimalToMinor(text: string): number {
  if (typeof text !== "string" || !CANONICAL.test(text)) {
    throw new RangeError(`Not a canonical two-decimal amount between 0.00 and 99999999.99: ${JSON.stringify(text)}`);
  }
  const minor = Number(text.replace(".", "")); // at most 10 digits: exact
  if (!Number.isSafeInteger(minor) || minor > MAX_MINOR_UNITS) throw new RangeError(`Amount out of range: ${text}`);
  return minor;
}

/** Integer minor units as a canonical two-decimal amount. Throws `RangeError` for a negative, fractional or out-of-range number. */
export function minorToDecimal(minor: number): string {
  if (!Number.isInteger(minor) || minor < 0 || minor > MAX_MINOR_UNITS) {
    throw new RangeError(`Minor units must be a whole number from 0 to ${MAX_MINOR_UNITS}, got ${minor}`);
  }
  const digits = String(minor).padStart(3, "0");
  return `${digits.slice(0, -2)}.${digits.slice(-2)}`;
}

/**
 * A value read from a `Decimal(10, 2)` column (a Prisma `Decimal`). More than two decimals cannot come from that column, so it throws
 * instead of rounding: a wrong-scale value is a bug to surface, not to repair.
 */
export function columnToMinor(value: { toFixed(digits?: number): string; decimalPlaces(): number }): number {
  if (value.decimalPlaces() > 2) throw new RangeError(`A Decimal(10, 2) column cannot hold ${value.toFixed()} (more than two decimals)`);
  return decimalToMinor(value.toFixed(2));
}
