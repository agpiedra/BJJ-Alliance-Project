import type { PaymentStatus } from "@/generated/prisma/client";

/**
 * The day-of-month (in the academy's timezone) after which an unpaid
 * (missing or `PENDING`) `PaymentPeriod` for the current month counts as
 * overdue. Grace period for the first few days of a new month before staff
 * have had a chance to record that month's dues.
 */
export const DEFAULT_OVERDUE_CUTOFF_DAY = 5;

/**
 * Pure predicate: is a student's payment period overdue?
 *
 * `period` is `null` when no `PaymentPeriod` row exists yet for the
 * student/year/month in question (nobody has recorded anything for this
 * month). `today.day` is a plain day-of-month — deliberately not a full
 * `DateTime` — so this stays trivially pure/testable; the caller resolves
 * the real "today" via Luxon's CR zone (`src/lib/scheduling/zone.ts`) before
 * calling this.
 *
 * Only a missing row or an explicit `PENDING` status can ever be overdue.
 * `PAID`, `PROMO`, and `EXEMPT` are never overdue regardless of the day —
 * they represent a settled state, not something outstanding.
 */
export function isOverdue(
  period: { status: PaymentStatus } | null,
  today: { day: number },
  cutoffDay: number = DEFAULT_OVERDUE_CUTOFF_DAY,
): boolean {
  if (today.day <= cutoffDay) return false;
  return !period || period.status === "PENDING";
}
