/** Colón amounts throughout Pagos are whole numbers in this app's seed/mock
 * data (no fractional colones shown anywhere) — plain grouped digits with a
 * "₡" prefix, not `Intl`'s `currency` style (which pulls in a currency
 * symbol placement and fraction-digit convention this app doesn't want to
 * inherit unreviewed). */
export function formatColones(amount: number, locale: string): string {
  const formatted = new Intl.NumberFormat(locale === "es" ? "es-CR" : "en-US", {
    maximumFractionDigits: 0,
  }).format(amount);
  return `₡ ${formatted}`;
}
