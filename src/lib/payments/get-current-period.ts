import { DateTime } from "luxon";
import { prisma } from "@/lib/prisma";
import { ZONE } from "@/lib/scheduling/zone";
import type { PaymentStatus } from "@/generated/prisma/client";

export type CurrentPaymentPeriod = {
  year: number;
  month: number;
  status: PaymentStatus;
  planId: string;
  planName: string;
  amount: number | null;
} | null;

/**
 * Today's CR-zoned calendar date, as plain parts — the shape both this
 * module's own query and `isOverdue` (`@/lib/payments/overdue`) need. Always
 * derived from the CURRENT instant via Luxon + `ZONE`
 * (`America/Costa_Rica`), never the server's own system clock/timezone
 * directly — same discipline as every other wall-clock read in this
 * codebase (see `src/lib/scheduling/zone.ts`).
 */
export function currentCrDateParts(): { year: number; month: number; day: number } {
  const now = DateTime.now().setZone(ZONE);
  return { year: now.year, month: now.month, day: now.day };
}

/**
 * Resolves a student's `PaymentPeriod` for the CURRENT CR calendar month, or
 * `null` if nobody has recorded one yet this month. Callers combine this
 * with `isOverdue` (`@/lib/payments/overdue`) — a `null` result here is not
 * itself "overdue"; that additionally depends on how far into the month
 * `currentCrDateParts()` says it already is.
 *
 * Plain function — NOT a "use server" action, and deliberately kept out of
 * any file a Client Component imports from, matching
 * `get-promotion-history.ts` / `attendance-summary.ts`'s established split:
 * this trusts `studentId` alone with no session/scope check of its own, so
 * it's safe only because every caller (roster/detail/portal pages) has
 * already resolved and scope-checked the student before calling this.
 *
 * `today` is optional/defaulted exactly like `perform-check-in.ts`'s
 * `now?: Date` — every current production caller (roster/detail/portal
 * pages) omits it and gets a fresh `currentCrDateParts()` read, unchanged
 * from before this parameter existed. It exists so `list-overdue.ts` (Phase
 * 6 Task 3) can inject a fixed "today" in tests without fighting the real
 * wall clock, while still resolving the SAME year/month this module always
 * has — the alternative (a second, test-only period-lookup implementation)
 * is exactly the kind of drift this codebase has been burned by before (see
 * that module's own doc comment).
 */
export async function getCurrentPaymentPeriod(
  studentId: string,
  today: { year: number; month: number } = currentCrDateParts(),
): Promise<CurrentPaymentPeriod> {
  const { year, month } = today;

  const period = await prisma.paymentPeriod.findUnique({
    where: { studentId_year_month: { studentId, year, month } },
    select: {
      year: true,
      month: true,
      status: true,
      planId: true,
      amount: true,
      plan: { select: { name: true } },
    },
  });

  if (!period) return null;

  return {
    year: period.year,
    month: period.month,
    status: period.status,
    planId: period.planId,
    planName: period.plan.name,
    // Same Decimal->number conversion Task 1's recordPayment already
    // established for this field (see payment-actions.ts) — a plain JS
    // number is what every caller here (roster badge, portal card) wants,
    // not a decimal.js instance.
    amount: period.amount?.toNumber() ?? null,
  };
}
