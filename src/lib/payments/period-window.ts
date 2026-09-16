/**
 * Pure predicate for REDESIGN_BRIEF.md Phase 6 §6.3's "period cannot be more
 * than one month in the future" validation. Both `period` and `today` are
 * plain {year, month} pairs so this stays trivially testable — the caller
 * resolves the real "today" via `currentCrDateParts()`
 * (`@/lib/payments/get-current-period`, itself Luxon + `ZONE`-backed), never
 * the server's local clock/timezone directly, matching every other
 * wall-clock read in this codebase.
 */
export function isPeriodMoreThanOneMonthInFuture(
  period: { year: number; month: number },
  today: { year: number; month: number },
): boolean {
  const periodIndex = period.year * 12 + (period.month - 1);
  const todayIndex = today.year * 12 + (today.month - 1);
  return periodIndex - todayIndex > 1;
}
