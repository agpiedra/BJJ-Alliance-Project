import { DateTime } from "luxon";
import { prisma } from "@/lib/prisma";
import { ZONE } from "@/lib/scheduling/zone";
import { CUSTOM_PROMO_PLAN_NAME } from "@/lib/payments/custom-promo-plan-name";
import { isUniqueConstraintError } from "@/lib/prisma-errors";
import { Prisma, type PaymentMethod, type PaymentStatus } from "@/generated/prisma/client";

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
  organizationId: true,
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
  organizationId: string;
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

/**
 * A recurring custom-promotion row carries its TERMS forward (plan, amount,
 * promo fields) unconditionally, but "was this month actually settled" must
 * not — and what distinguishes a true waiver from a real, collectable charge
 * is the AMOUNT, never the `status` label. The custom-promo panel's own copy
 * says so directly: "Monto acordado (₡) ... 0 para exonerar por completo" —
 * `0` is what means "fully waived", regardless of whether the director filed
 * that waiver as `PAID`, `PROMO`, or `EXEMPT`. A recurring row with a real,
 * non-zero agreed amount (e.g. a discounted-but-real ₡22,500/month
 * arrangement, however it was labeled) means SOME month someone actually
 * collected that amount; it does not mean every future month is pre-settled
 * too — an earlier fix only closed this for `status: PAID` and left the
 * identical hole open for `PROMO`/`EXEMPT` (which are additionally
 * never-overdue and offer no "Marcar pagado" action at all, so a real-amount
 * promo recorded as `PROMO` would have been uncollectable forever). Any
 * non-zero amount materializes next month as `PENDING`, so the director is
 * still prompted to actually collect it, and `isOverdue`/the Pagos stat row
 * don't silently treat an uncollected month as current.
 */
function carriedStatusFor(period: { status: PaymentStatus; amount: { toNumber(): number } | null }): PaymentStatus {
  const isWaiver = (period.amount?.toNumber() ?? 0) === 0;
  return isWaiver ? period.status : "PENDING";
}

/** Prisma `where` fragment for "strictly before `{year, month}`" — used to
 * find the most recent PRIOR period without assuming it's exactly last
 * calendar month (see `findCarryForwardCandidate`'s doc comment). */
function beforeMonth(today: { year: number; month: number }) {
  return { OR: [{ year: { lt: today.year } }, { year: today.year, month: { lt: today.month } }] };
}

/**
 * The single most recent `PaymentPeriod` row for a student strictly before
 * `today`, regardless of how many months back that is — NOT "exactly last
 * calendar month". A student whose payment period simply never got resolved
 * for one or more intervening months (a holiday closure, an inactive
 * student, a portal never opened) must not have their recurring promo
 * silently die just because nobody happened to query that gap month.
 *
 * Deliberately still "most recent row of ANY kind", not "most recent row
 * with `promoRecurring: true`": if a director explicitly cancels the
 * recurrence (edits a later month's row to uncheck "repetir" or moves the
 * student onto a different plan), THAT edit becomes the most recent row and
 * correctly fails the `promoRecurring`/plan check below, stopping the
 * chain — searching further back for the last `promoRecurring: true` row
 * instead would perversely revive a promo the director just turned off.
 */
async function findCarryForwardCandidate(studentId: string, today: { year: number; month: number }) {
  return prisma.paymentPeriod.findFirst({
    where: { studentId, ...beforeMonth(today) },
    orderBy: [{ year: "desc" }, { month: "desc" }],
    select: CURRENT_PERIOD_SELECT,
  });
}

function qualifiesForCarryForward(candidate: { promoRecurring: boolean; plan: { name: string } } | null): boolean {
  return !!candidate && candidate.promoRecurring && candidate.plan.name === CUSTOM_PROMO_PLAN_NAME;
}

/**
 * Materializes THIS month's carried-forward row from `candidate` (the prior
 * qualifying period) and audits the write — `action: "payment.carryForward"`,
 * distinct from `recordPayment`'s `"payment.record"` since no staff member
 * actually acted this month; the actor is whoever originally set the
 * recurring promo running (`candidate.recordedById`), the same attribution
 * the row's other carried fields already use.
 *
 * Uses `create` + catch-unique-violation (the exact pattern
 * `perform-check-in.ts` already established for this codebase, via
 * `isUniqueConstraintError`) rather than an `upsert`'s `update: {}` no-op:
 * an upsert can't distinguish "I just created this row" from "it already
 * existed and I no-op'd", so it can't tell whether writing an audit row is
 * warranted. `create` can — a unique-constraint failure means a concurrent
 * caller (or a real `recordPayment` call) won the race, so this returns
 * that row WITHOUT auditing a creation it didn't perform.
 *
 * The `create` + its `auditLog.create` are wrapped in ONE `$transaction`,
 * matching `recordPayment`'s own upsert+audit atomicity — a failure on the
 * audit insert alone rolls back the `PaymentPeriod` row too, rather than
 * leaving a committed-but-unaudited financial row behind (which would
 * otherwise surface as an unhandled 500 to whatever page, including a
 * student's own portal, triggered this read). This composes fine with the
 * catch-P2002 fallback below: a unique-violation inside the transaction
 * rolls the whole transaction back (nothing partially committed either
 * way), and the fallback re-fetch runs against `prisma` once the rejected
 * transaction has already unwound.
 */
async function materializeCarryForward(
  studentId: string,
  today: { year: number; month: number },
  candidate: RawPeriod,
): Promise<RawPeriod | null> {
  const status = carriedStatusFor(candidate);
  try {
    const created = await prisma.$transaction(async (tx) => {
      const created = await tx.paymentPeriod.create({
        data: {
          studentId,
          academyId: candidate.academyId,
          organizationId: candidate.organizationId,
          year: today.year,
          month: today.month,
          planId: candidate.planId,
          status,
          amount: candidate.amount?.toNumber() ?? null,
          method: candidate.method,
          notes: candidate.notes,
          promoName: candidate.promoName,
          promoReason: candidate.promoReason,
          promoRecurring: true,
          // Attributed to whoever set up the recurring promo, not a system
          // user — this row was never actually re-entered by a human this
          // month, so there is no "who recorded this month" to record beyond
          // "whoever set the recurring promo running in the first place".
          recordedById: candidate.recordedById,
        },
        select: CURRENT_PERIOD_SELECT,
      });

      await tx.auditLog.create({
        data: {
          actorId: candidate.recordedById,
          academyId: candidate.academyId,
          action: "payment.carryForward",
          entityType: "PaymentPeriod",
          entityId: created.id,
          before: Prisma.DbNull,
          after: {
            status: created.status,
            planId: created.planId,
            amount: created.amount?.toNumber() ?? null,
            method: created.method,
            promoName: created.promoName,
            promoReason: created.promoReason,
            promoRecurring: created.promoRecurring,
          },
        },
      });

      return created;
    });

    return created;
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error;
    return prisma.paymentPeriod.findUnique({
      where: { studentId_year_month: { studentId, year: today.year, month: today.month } },
      select: CURRENT_PERIOD_SELECT,
    });
  }
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
 * already resolved and scope-checked the student before calling this. A
 * student's OWN portal page-view can, as a result, trigger the
 * carry-forward INSERT below for their own row — an accepted, deterministic
 * side effect (it writes exactly the row a director would have entered
 * anyway), not a privilege issue: they can't influence its content, and the
 * academy/actor on the write are the ORIGINAL promo's, never the viewer's.
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
 * When no row exists yet for the current month, this looks at the most
 * recent PRIOR period (`findCarryForwardCandidate` — not necessarily last
 * calendar month, see its own doc comment) and, if it's a recurring
 * custom-promotion row, lazily materializes THIS month's row with the same
 * TERMS (never blindly the same `status` — see `carriedStatusFor`) — so a
 * director who ticked "repeat every month" never has to re-enter it, and
 * every caller of this function (roster, dashboard overdue list, student
 * detail, portal, the Pagos page) sees the carried-forward status
 * automatically and consistently.
 *
 * Single-student form — callers resolving MANY students at once (the Pagos
 * page) should use `getCurrentPaymentPeriodsForStudents` below instead of
 * calling this in a loop, to avoid one round trip (up to three statements)
 * per student.
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

  const candidate = await findCarryForwardCandidate(studentId, today);
  if (!qualifiesForCarryForward(candidate)) return null;

  const materialized = await materializeCarryForward(studentId, today, candidate as RawPeriod);
  return materialized ? toCurrentPeriod(materialized) : null;
}

/**
 * Batched sibling of `getCurrentPaymentPeriod` for resolving MANY students'
 * current period at once (the Pagos page's "Estado del mes" — REDESIGN_
 * BRIEF.md §6.3) — a per-student `Promise.all(students.map(getCurrentPayment
 * Period))` was the original shape here, but that is exactly the N+1 (now
 * up to 3 statements, including a conditional WRITE, per student) pattern
 * `headline-tiles.ts` already identified and fixed for a read-only case; at
 * ~200 active students that is up to ~600 concurrent statements on every
 * Pagos page load. This cuts that to at most two `findMany` ROUND TRIPS
 * (regardless of student count) plus one write per student who actually
 * needs carry-forward — a real reduction in query COUNT, though not a
 * literal constant-cost query at the SQL level: Prisma's `distinct` here
 * compiles to a client-side/window-function dedupe rather than Postgres
 * `DISTINCT ON` (that needs the `nativeDistinct` preview feature, not
 * enabled in this schema), so the second query still scans every missing
 * student's full history, not just their latest row.
 *
 * 1. One `findMany` for every student's CURRENT-month row.
 * 2. For students still missing one, one `findMany` with
 *    `distinct: ["studentId"]` (Prisma's supported "latest row per group"
 *    pattern) to get each of THEIR single most-recent prior rows in one
 *    round trip — never per-student.
 * 3. `materializeCarryForward` only for the (typically small) subset that
 *    actually qualifies — bounded by how many recurring promos exist, not
 *    by how many students were asked about.
 *
 * Never a second implementation of the carry-forward RULES themselves —
 * `carriedStatusFor`/`qualifiesForCarryForward`/`materializeCarryForward`
 * are shared verbatim with the single-student function above.
 */
export async function getCurrentPaymentPeriodsForStudents(
  studentIds: string[],
  today: { year: number; month: number } = currentCrDateParts(),
): Promise<Map<string, CurrentPaymentPeriod>> {
  const result = new Map<string, CurrentPaymentPeriod>();
  if (studentIds.length === 0) return result;
  const { year, month } = today;

  const currentRows = await prisma.paymentPeriod.findMany({
    where: { studentId: { in: studentIds }, year, month },
    select: { studentId: true, ...CURRENT_PERIOD_SELECT },
  });
  for (const row of currentRows) {
    result.set(row.studentId, toCurrentPeriod(row));
  }

  const missingIds = studentIds.filter((id) => !result.has(id));
  if (missingIds.length === 0) return result;

  const candidates = await prisma.paymentPeriod.findMany({
    where: { studentId: { in: missingIds }, ...beforeMonth(today) },
    orderBy: [{ studentId: "asc" }, { year: "desc" }, { month: "desc" }],
    distinct: ["studentId"],
    select: { studentId: true, ...CURRENT_PERIOD_SELECT },
  });

  const qualifying = candidates.filter(qualifiesForCarryForward);
  await Promise.all(
    qualifying.map(async (candidate) => {
      const materialized = await materializeCarryForward(candidate.studentId, today, candidate as RawPeriod);
      if (materialized) result.set(candidate.studentId, toCurrentPeriod(materialized));
    }),
  );

  // Every requested id gets an explicit entry — `null` (not simply absent)
  // for a student with no current row and no qualifying carry-forward
  // candidate — so callers can rely on `.get(id)` alone to mean "no period
  // this month" without a separate `.has(id)` check.
  for (const id of studentIds) {
    if (!result.has(id)) result.set(id, null);
  }

  return result;
}
