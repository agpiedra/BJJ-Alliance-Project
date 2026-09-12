import { DateTime } from "luxon";
import { prisma } from "@/lib/prisma";
import { ZONE } from "@/lib/scheduling/zone";
import { CUSTOM_PROMO_PLAN_NAME } from "@/lib/payments/custom-promo-plan-name";
import type { PaymentMethod, PaymentStatus } from "@/generated/prisma/client";

export type CurrentPaymentPeriod = {
  id: string;
  year: number;
  month: number;
  status: PaymentStatus;
  planId: string;
  planName: string;
  amount: number | null;
  method: PaymentMethod | null;
  notes: string | null;
  promoName: string | null;
  promoReason: string | null;
  promoRecurring: boolean;
  recordedById: string;
  recordedByEmail: string;
  recordedAt: Date;
} | null;

const CURRENT_PERIOD_SELECT = {
  id: true,
  year: true,
  month: true,
  status: true,
  planId: true,
  academyId: true,
  amount: true,
  method: true,
  notes: true,
  promoName: true,
  promoReason: true,
  promoRecurring: true,
  recordedById: true,
  recordedAt: true,
  plan: { select: { name: true } },
  recordedBy: { select: { email: true } },
} as const;

type RawPeriod = {
  id: string;
  year: number;
  month: number;
  status: PaymentStatus;
  planId: string;
  academyId: string;
  amount: { toNumber(): number } | null;
  method: PaymentMethod | null;
  notes: string | null;
  promoName: string | null;
  promoReason: string | null;
  promoRecurring: boolean;
  recordedById: string;
  recordedAt: Date;
  plan: { name: string };
  recordedBy: { email: string };
};

function toCurrentPeriod(period: RawPeriod): CurrentPaymentPeriod {
  return {
    id: period.id,
    year: period.year,
    month: period.month,
    status: period.status,
    planId: period.planId,
    planName: period.plan.name,
    // Same Decimal->number conversion Task 1's recordPayment already
    // established for this field — a plain JS number is what every caller
    // here (roster badge, portal card) wants, not a decimal.js instance.
    amount: period.amount?.toNumber() ?? null,
    method: period.method,
    notes: period.notes,
    promoName: period.promoName,
    promoReason: period.promoReason,
    promoRecurring: period.promoRecurring,
    recordedById: period.recordedById,
    recordedByEmail: period.recordedBy.email,
    recordedAt: period.recordedAt,
  };
}

/** Previous calendar month relative to `{year, month}`, handling the
 * January -> previous December year rollover. */
function previousMonth(today: { year: number; month: number }): { year: number; month: number } {
  return today.month === 1 ? { year: today.year - 1, month: 12 } : { year: today.year, month: today.month - 1 };
}

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
 *
 * REDESIGN_BRIEF.md Phase 6 §6.3's recurring-promo carry-forward is folded
 * in HERE rather than a second function, per that same doc-comment
 * discipline: "what period is this" must have exactly one implementation.
 * When no row exists yet for the current month, this checks whether the
 * student's most recent PRIOR month has a recurring custom-promotion row
 * (`promoRecurring: true` on the seeded `CUSTOM_PROMO_PLAN_NAME` plan) and,
 * if so, lazily materializes (creates) THIS month's row with the same terms
 * — so a director who ticked "repeat every month" never has to re-enter it,
 * and every caller of this function (roster, dashboard overdue list,
 * student detail, portal, the new Pagos page) sees the carried-forward
 * status automatically and consistently, rather than each one having to
 * remember to ask about carry-forward separately.
 */
export async function getCurrentPaymentPeriod(
  studentId: string,
  today: { year: number; month: number } = currentCrDateParts(),
): Promise<CurrentPaymentPeriod> {
  const { year, month } = today;

  const period = await prisma.paymentPeriod.findUnique({
    where: { studentId_year_month: { studentId, year, month } },
    select: CURRENT_PERIOD_SELECT,
  });

  if (period) return toCurrentPeriod(period);

  const prior = previousMonth(today);
  const priorPeriod = await prisma.paymentPeriod.findUnique({
    where: { studentId_year_month: { studentId, year: prior.year, month: prior.month } },
    select: CURRENT_PERIOD_SELECT,
  });

  if (!priorPeriod || !priorPeriod.promoRecurring || priorPeriod.plan.name !== CUSTOM_PROMO_PLAN_NAME) {
    return null;
  }

  // `upsert` (not `create`) so two concurrent callers racing to materialize
  // the same student/month land on the SAME row via the
  // `@@unique([studentId, year, month])` constraint, rather than one of them
  // throwing a unique-violation — `update: {}` is a deliberate no-op, this
  // never overwrites a row a real `recordPayment` call created in between.
  const materialized = await prisma.paymentPeriod.upsert({
    where: { studentId_year_month: { studentId, year, month } },
    update: {},
    create: {
      studentId,
      academyId: priorPeriod.academyId,
      year,
      month,
      planId: priorPeriod.planId,
      status: priorPeriod.status,
      amount: priorPeriod.amount?.toNumber() ?? null,
      method: priorPeriod.method,
      notes: priorPeriod.notes,
      promoName: priorPeriod.promoName,
      promoReason: priorPeriod.promoReason,
      promoRecurring: true,
      // Attributed to whoever set up the recurring promo, not a system
      // user — this row was never actually re-entered by a human this
      // month, so there is no "who recorded September" to record beyond
      // "whoever set the recurring promo running in the first place".
      recordedById: priorPeriod.recordedById,
    },
    select: CURRENT_PERIOD_SELECT,
  });

  return toCurrentPeriod(materialized);
}
