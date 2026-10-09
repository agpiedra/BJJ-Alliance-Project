import { DateTime } from "luxon";
import { prisma } from "@/lib/prisma";
import { branchScopeWhere } from "@/lib/tenant/context";
import { getScopedDb } from "@/lib/tenant/scoped-client";
import type { TenantContext } from "@/lib/tenant/types";
import { currentCrDateParts } from "@/lib/payments/get-current-period";
import { ZONE } from "@/lib/scheduling/zone";
import type { Prisma } from "@/generated/prisma/client";
import type { AnalyticsFilters } from "@/lib/analytics/filters";
import { isLedgerActiveForOrg } from "@/lib/dues/roster-payment-facts-queries";
import { getLedgerPaymentHealth, type PaymentHealthResult } from "@/lib/analytics/payment-health";

/**
 * Review fix (PR 6, gap 3): the ONE ledger instant/activation flag a page composition resolves ONCE and threads
 * through every `getHeadlineTiles`/`getLocationComparison` call it makes — never recomputed per call. Optional:
 * omitted entirely, every existing/independent caller (tests, a future caller with no page boundary of its own)
 * keeps the exact prior default behavior of resolving both fresh, right here, every time.
 */
export interface LedgerInstant {
  ledgerActive: boolean;
  ledgerNow: Date;
}

export interface DateRange {
  from: DateTime;
  to: DateTime;
}

export interface HeadlineTiles {
  enrolled: number;
  active: number;
  inactive: number;
  newThisMonth: number;
  lost: number;
  totalAttendances: number;
  avgAttendancesPerActive: number;
  /** REMAINING-LEDGER-CONSUMERS-BRIEF.md §6.2 Decision 3: `null` whenever any per-student read failed
   * (withheld) OR `enrolled` is 0 (empty population) — never a bare number alongside the three counts below
   * while either is true. The legacy (inactive) path never produces `null` for a nonzero `enrolled` — see
   * `legacyPaymentHealth`'s own doc comment. */
  paymentHealthPercent: number | null;
  paymentHealthConfirmedPaidCount: number;
  /** The denominator actually achieved — ACTIVE-in-scope students whose read succeeded. Equals `enrolled`
   * whenever `paymentHealthUnknownCount` is 0 (always true on the legacy path). */
  paymentHealthSuccessfullyCheckedCount: number;
  paymentHealthUnknownCount: number;
  /** Whether `paymentHealthPercent`/the three counts above reflect the ledger-backed metric (Decision 3) or
   * the legacy `PaymentPeriod`-based one — the caller needs this to pick the right label ("Current month
   * covered by settled payments" vs. "Payment health (current month)"), since the metric's own MEANING
   * changes, not just its data source. */
  paymentHealthLedgerActive: boolean;
  /** See `countEnrolledAtRangeStart`'s own doc comment — the "Inscritos"
   * tile's comparison figure, since `enrolled` itself has no date predicate
   * to diff across two calls. */
  enrolledAtRangeStart: number;
}

/** Is `date` inside `range`, inclusive of both endpoints? */
export function isWithinRange(date: DateTime, range: DateRange): boolean {
  return date >= range.from && date <= range.to;
}

/**
 * A student counts as "active" for a range if any of their attendance dates
 * falls inside it.
 */
export function hasAttendanceInRange(attendanceDates: DateTime[], range: DateRange): boolean {
  return attendanceDates.some((date) => isWithinRange(date, range));
}

/** A student counts as newly enrolled for a range if they joined inside it. */
export function isNewInRange(joinedAt: DateTime, range: DateRange): boolean {
  return isWithinRange(joinedAt, range);
}

/**
 * The same-length period immediately preceding `range` — e.g. for a 30-day
 * range, the 30 days before it. Used to classify a student as "lost"
 * without hardcoding a second range shape independent of whatever range the
 * director actually picked.
 */
export function previousEquivalentRange(range: DateRange): DateRange {
  const durationMs = range.to.diff(range.from).as("milliseconds");
  return { from: range.from.minus({ milliseconds: durationMs }), to: range.from };
}

/**
 * A student is "lost" if they attended at least once in the period
 * immediately before `range` but not at all during `range` itself.
 */
export function wasLost(attendanceDates: DateTime[], range: DateRange): boolean {
  const previous = previousEquivalentRange(range);
  return hasAttendanceInRange(attendanceDates, previous) && !hasAttendanceInRange(attendanceDates, range);
}

/**
 * How many of the (already active-filtered) `students` had already joined
 * by `rangeStart` — the "Inscritos" tile's own §4.3-Task-2 comparison
 * figure. `enrolled` itself has no date predicate at all (a snapshot of
 * however many students are active RIGHT NOW), so diffing it against a
 * second `getHeadlineTiles` call for a different range would just diff the
 * same range-independent number against itself —
 * `paymentHealthPercent` has the identical structural problem (see its own
 * comment inside `getHeadlineTiles`).
 *
 * This is a real, honestly-labeled approximation, not an exact historical
 * headcount: a student who was active as of `rangeStart` but has since left
 * the roster (archived/deactivated by now) is invisible here, since the
 * caller only ever passes in CURRENTLY-active students. `enrolled -
 * countEnrolledAtRangeStart(...)` will always equal `newThisMonth` by
 * construction (both count "joined during the range, still active today"
 * students) — that's expected, not a bug: it's the same fact presented as a
 * comparison line instead of a standalone count.
 */
export function countEnrolledAtRangeStart(
  students: Array<{ joinedAt: DateTime }>,
  rangeStart: DateTime,
): number {
  return students.filter((student) => student.joinedAt <= rangeStart).length;
}

/**
 * Director/admin analytics headline tiles (Phase 7 spec §4). ADMIN/DIRECTOR
 * only — self-enforced right here, the same discipline
 * `listOverdueStudents`/`listApproachingStudents` already apply: a caller
 * that invokes this directly with a forged INSTRUCTOR session is rejected,
 * never left to the page to hide a result it would otherwise discard.
 *
 * Scoped to enrolled (`status: "ACTIVE"`) students, combining BOTH
 * `branchScopeWhere(context)` (translated to `homeAcademyId` — the same
 * translation Phase 2/4/6 already established, since `branchScopeWhere`
 * returns a fragment keyed `academyId` but Student's tenancy column is
 * `homeAcademyId`) AND `filters.academyId` when set. Organization scope
 * comes from `getScopedDb`, unconditionally. The session's own scope
 * is applied independently of `filters.academyId` — never trusted alone —
 * so a DIRECTOR session passed a filter naming a DIFFERENT academy (e.g. a
 * hand-built `AnalyticsFilters` that bypassed `resolveAnalyticsFilters`)
 * still only ever sees their own academy.
 *
 * "Active"/"new"/"lost" are computed against `filters.from`/`filters.to` —
 * whatever range the director selected, not a second hardcoded window.
 * `paymentHealthPercent` is the one exception (this phase's ruling): it
 * always reflects the CURRENT calendar month regardless of the selected
 * range, via one batched `PaymentPeriod` query keyed on the same
 * `studentId_year_month` year/month `getCurrentPaymentPeriod`
 * (`@/lib/payments/get-current-period`) uses per-student elsewhere — never
 * a second, drifting status rule, just batched instead of looped per
 * student (see that query's own comment below for why).
 *
 * Only `type: "CHECKIN"` attendance rows count toward the attendance-based
 * tiles — a manual `ADJUSTMENT` correction (which can carry a negative
 * delta) is not a physical attendance fact, the same distinction
 * `attendance-summary.ts`'s `PROMOTION_RELEVANT` draws for belt progress,
 * applied here to "did this student show up" instead.
 */
export async function getHeadlineTiles(
  context: TenantContext,
  filters: AnalyticsFilters,
  ledgerInstant?: LedgerInstant,
): Promise<HeadlineTiles> {
  if (context.organizationRole !== "ADMIN" && context.organizationRole !== "DIRECTOR") {
    throw new Error("FORBIDDEN");
  }

  const branchScope = branchScopeWhere(context);
  const conditions: Prisma.StudentWhereInput[] = [{ status: "ACTIVE" }];
  if (branchScope.academyId) {
    conditions.push({ homeAcademyId: branchScope.academyId });
  }
  if (filters.academyId) {
    conditions.push({ homeAcademyId: filters.academyId });
  }

  const students = await getScopedDb(context).student.findMany({
    where: { AND: conditions },
    select: { id: true, joinedAt: true },
  });

  const range: DateRange = { from: filters.from, to: filters.to };
  const previous = previousEquivalentRange(range);

  const studentIds = students.map((student) => student.id);
  const attendances =
    studentIds.length === 0
      ? []
      : await prisma.attendanceRecord.findMany({
          where: {
            studentId: { in: studentIds },
            organizationId: context.organizationId,
            type: "CHECKIN",
            voidedAt: null,
            occurredAt: { gte: previous.from.toJSDate(), lte: range.to.toJSDate() },
          },
          select: { studentId: true, occurredAt: true },
        });

  const attendanceDatesByStudentId = new Map<string, DateTime[]>();
  for (const record of attendances) {
    const dates = attendanceDatesByStudentId.get(record.studentId) ?? [];
    dates.push(DateTime.fromJSDate(record.occurredAt));
    attendanceDatesByStudentId.set(record.studentId, dates);
  }

  let active = 0;
  let newThisMonth = 0;
  let lost = 0;
  let totalAttendances = 0;

  for (const student of students) {
    const dates = attendanceDatesByStudentId.get(student.id) ?? [];
    const joinedAt = DateTime.fromJSDate(student.joinedAt);

    if (hasAttendanceInRange(dates, range)) active++;
    if (isNewInRange(joinedAt, range)) newThisMonth++;
    if (wasLost(dates, range)) lost++;
    totalAttendances += dates.filter((date) => isWithinRange(date, range)).length;
  }

  const enrolled = students.length;
  const inactive = enrolled - active;
  const avgAttendancesPerActive = active > 0 ? totalAttendances / active : 0;
  const enrolledAtRangeStart = countEnrolledAtRangeStart(
    students.map((student) => ({ joinedAt: DateTime.fromJSDate(student.joinedAt) })),
    range.from,
  );

  // §2.2/§6.1 Decision 3/§4: ONE captured flag, read once, before the legacy-vs-ledger decision below — same
  // convention every other cutover page/job already established. §6: the legacy reader is never invoked at
  // all once `ledgerActive` — not merely computed and discarded (dashboard/digest/Pagos precedent).
  //
  // Review fix (PR 6, gap 3): a page composing MULTIPLE `getHeadlineTiles`/`getLocationComparison` calls (the
  // current/previous-range pair, one per academy) resolves this ONCE at its own boundary and passes it in as
  // `ledgerInstant` — never recomputed per call, which could otherwise land on different instants (and, right
  // at a month boundary, different branch-local target months) across calls that are supposed to describe the
  // SAME page load. Omitted entirely (every other/independent caller, including every existing test), this
  // resolves exactly as before: freshly, right here, every call.
  const ledgerActive = ledgerInstant ? ledgerInstant.ledgerActive : await isLedgerActiveForOrg(context.organizationId);
  // §4: the one captured instant shared by every ledger read this call makes (today, exactly one —
  // `getLedgerPaymentHealth`'s own `listRosterPaymentFacts` call).
  const ledgerNow = ledgerInstant ? ledgerInstant.ledgerNow : DateTime.now().setZone(ZONE).toJSDate();
  const paymentHealth: PaymentHealthResult = ledgerActive
    ? await getLedgerPaymentHealth(context, studentIds, ledgerNow)
    : await legacyPaymentHealth(studentIds, context.organizationId, enrolled);

  return {
    enrolled,
    active,
    inactive,
    newThisMonth,
    lost,
    totalAttendances,
    avgAttendancesPerActive,
    paymentHealthPercent: paymentHealth.percent,
    paymentHealthConfirmedPaidCount: paymentHealth.confirmedPaidCount,
    paymentHealthSuccessfullyCheckedCount: paymentHealth.successfullyCheckedCount,
    paymentHealthUnknownCount: paymentHealth.unknownCount,
    paymentHealthLedgerActive: ledgerActive,
    enrolledAtRangeStart,
  };
}

/**
 * The INACTIVE path's own calculation, unchanged in VALUE from before this PR (same batched
 * `PaymentPeriod` query, same "PAID or PROMO counts as healthy" rule, same `enrolled > 0 ? round(...) : 0`
 * formula for `percent`) — only wrapped in the shared `PaymentHealthResult` shape so both paths return the
 * same type. Exported (not merely internal) so a test can spy on it directly to prove the active path never
 * calls it — the same precedent `listOverdueStudents`/`listCurrentPaymentStatus` already established in
 * PRs 3-5.
 *
 * `unknownCount` is always 0 here: this legacy batched query has no notion of a per-student read failure
 * (it's one plain `findMany`, not a per-student ledger fact lookup), so `successfullyCheckedCount` always
 * equals `enrolled` and `percent` is never withheld for this path.
 */
export async function legacyPaymentHealth(
  studentIds: string[],
  organizationId: string,
  enrolled: number,
): Promise<PaymentHealthResult> {
  const today = currentCrDateParts();
  // A single batched query, not one `getCurrentPaymentPeriod` call per
  // student (that was a real N+1 — ~200 concurrent single-row queries on a
  // 200-active-student academy, on every load of this `force-dynamic`
  // page, doubled once this function started being called twice for the
  // previous-period comparison). Same lookup key `getCurrentPaymentPeriod`
  // itself uses (`studentId_year_month`'s year/month half) and the same
  // "PAID or PROMO counts as healthy" rule — just batched across every
  // student in scope instead of N round trips.
  const currentPeriods =
    studentIds.length === 0
      ? []
      : await prisma.paymentPeriod.findMany({
          where: { studentId: { in: studentIds }, organizationId, year: today.year, month: today.month },
          select: { studentId: true, status: true },
        });
  const healthyStudentIds = new Set(
    currentPeriods
      .filter((period) => period.status === "PAID" || period.status === "PROMO")
      .map((period) => period.studentId),
  );
  return {
    percent: enrolled > 0 ? Math.round((healthyStudentIds.size / enrolled) * 100) : 0,
    confirmedPaidCount: healthyStudentIds.size,
    successfullyCheckedCount: enrolled,
    unknownCount: 0,
  };
}

export type TileDeltaPolarity = "higherIsBetter" | "lowerIsBetter";

export interface TileDelta {
  direction: "up" | "down";
  diff: number;
}

/**
 * Turns a current/previous pair into `StatTile`'s `delta` shape
 * (REDESIGN_BRIEF.md Phase 3: "green --ok up, red --bad down"). `direction`
 * reflects whether the change is an IMPROVEMENT, not just the raw sign of
 * the diff — for a "lowerIsBetter" metric (inactive, lost) a DECREASE is the
 * good outcome and must render green/"up", the same way a "higherIsBetter"
 * metric's increase does. Returns `undefined` for a zero diff, the same "no
 * comparison line when nothing changed" convention `dashboard/page.tsx`'s
 * own weekly-attendance delta already follows — a flat metric shows no line
 * rather than a misleading no-op arrow.
 *
 * Note: `paymentHealthPercent` is always computed against the CURRENT
 * calendar month regardless of the filter range (see `getHeadlineTiles`'s
 * own doc comment) — calling this with two `getHeadlineTiles` results for
 * different ranges will therefore always see a zero diff for that one field
 * specifically, by design, not a bug in this function.
 */
export function computeTileDelta(
  current: number,
  previous: number,
  polarity: TileDeltaPolarity = "higherIsBetter",
): TileDelta | undefined {
  const diff = current - previous;
  if (diff === 0) return undefined;
  const improved = polarity === "higherIsBetter" ? diff > 0 : diff < 0;
  return { direction: improved ? "up" : "down", diff };
}
