import type { Currency } from "@/generated/prisma/client";

/**
 * Every currency an organization can price in, in the order a picker shows
 * them. The single list forms, schemas and displays share — a new currency is
 * one migration plus one entry in each record below (the `Record<Currency, …>`
 * types make the compiler refuse to build until both are updated).
 */
export const CURRENCIES = ["CRC", "USD"] as const satisfies readonly Currency[];

const SYMBOLS: Record<Currency, string> = { CRC: "₡", USD: "$" };

/**
 * Colones are whole numbers in this app — no fractional colones are shown
 * anywhere — while dollars carry cents. Deliberately not `Intl`'s `currency`
 * style: that pulls in a symbol placement and fraction-digit convention this
 * app doesn't want to inherit unreviewed (and would render "CRC 22,500" or
 * "US$" depending on locale).
 */
const FRACTION_DIGITS: Record<Currency, number> = { CRC: 0, USD: 2 };

export function currencySymbol(currency: Currency): string {
  return SYMBOLS[currency];
}

/**
 * A stored amount as text: the currency's symbol, then the grouped number —
 * "₡ 22,500", "$ 45.00". `currency` is a REQUIRED parameter, never defaulted:
 * amounts are stored as bare decimals, so an amount formatted without knowing
 * its currency is silently wrong. For a recorded payment pass
 * `PaymentPeriod.currency` (the snapshot), not the organization's current one.
 */
export function formatMoney(amount: number, currency: Currency, locale: string): string {
  const digits = FRACTION_DIGITS[currency];
  const formatted = new Intl.NumberFormat(locale === "es" ? "es-CR" : "en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(amount);
  return `${SYMBOLS[currency]} ${formatted}`;
}
