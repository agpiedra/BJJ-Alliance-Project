/**
 * Formats a plain (year, month) pair — NOT a real timestamp — as a localized
 * "Month YYYY" string, e.g. "January 2026" / "enero de 2026". Every caller
 * builds the pair from a Prisma `PaymentPeriod`'s `year`/`month` columns
 * (`students/[id]/page.tsx`'s payment-history table) or a locale-independent
 * `"YYYY-MM"` string (`dashboard/page.tsx`'s overdue-payments panel) — never
 * from any actual instant, so there is no "real" wall-clock timezone to
 * convert from.
 *
 * The underlying `Date` is built via `Date.UTC(year, month - 1, 1)`
 * specifically so it can be read back with `timeZone: "UTC"` here. This is
 * the ONE deliberate exception to `format-date.ts`'s "always pass
 * `America/Costa_Rica`" rule: that rule is for REAL timestamps, where
 * `"UTC"` would be the bug. Here the marker was constructed at UTC midnight
 * on purpose, so `"UTC"` is what reads it back exactly as constructed —
 * `"America/Costa_Rica"` (or, worse, no `timeZone` at all, which falls back
 * to whatever zone the server process happens to be running in) would shift
 * the marker backward into the previous day, and for the 1st of the month
 * that rolls it into the PREVIOUS month — reproduced concretely under
 * `TZ=America/Costa_Rica`: a `{year: 2026, month: 1}` period rendered as
 * "diciembre de 2025" instead of "enero de 2026" (Phase 6 final review
 * finding I-3).
 */
export function formatMonthYear(year: number, month: number, locale: string): string {
  return new Intl.DateTimeFormat(locale === "es" ? "es-CR" : "en-US", {
    timeZone: "UTC",
    year: "numeric",
    month: "long",
  }).format(new Date(Date.UTC(year, month - 1, 1)));
}
