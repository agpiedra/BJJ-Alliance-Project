import { compareDates, compareYearMonth, type CalendarDate, type YearMonth } from "@/lib/dues/calendar";
import type { StudentStatus } from "@/generated/prisma/client";

export interface StatusHistoryRow {
  effectiveOn: CalendarDate;
  /** Deterministic per-student tie-break for a shared `effectiveOn` — assigned under the student lock, never derived from a timestamp (3.2). */
  sequence: number;
  status: StudentStatus;
}

export interface AssignmentRow {
  effectiveYear: number;
  effectiveMonth: number;
  planId: string | null;
  /** The branch the plan belongs to. Ignored when `planId` is null. */
  planAcademyId: string | null;
}

export type EligibilityOutcome =
  | { outcome: "UNDECIDABLE" }
  | { outcome: "NOT_ELIGIBLE" }
  | { outcome: "NO_ASSIGNMENT" }
  | { outcome: "ELIGIBLE"; planId: string };

/**
 * Eligibility-prerequisites brief, section 6.2. A pure function of a student's full `StudentStatusChange` history, their
 * `StudentPlanAssignment` history, the branch (`academyId`), and a target coverage month — answering exactly what the
 * (not-yet-built) monthly job needs. No `now()` anywhere: calling this for the same `month` on two different real dates always
 * returns the same answer (3.1), so a delayed job reaches the same result as an on-time one by construction.
 *
 * Written and unit-tested as a pure function in this PR, but not called from anywhere — same isolation discipline as PR 4a's
 * ledger writers before their caller (registered in `scripts/pending-callers.ts` for the monthly-job PR).
 */
export function eligibleAndAssigned(
  statusHistory: readonly StatusHistoryRow[],
  assignments: readonly AssignmentRow[],
  academyId: string,
  month: YearMonth,
): EligibilityOutcome {
  // G(month): the 1st of `month`. The comparison against a status row's `effectiveOn` is STRICT `<` (3.3) — a status change
  // effective on or after this date can only ever affect the month after `month`, never `month` itself.
  const generationDate: CalendarDate = { year: month.year, month: month.month, day: 1 };

  let latestStatus: StatusHistoryRow | null = null;
  for (const row of statusHistory) {
    if (compareDates(row.effectiveOn, generationDate) >= 0) continue;
    if (latestStatus === null) {
      latestStatus = row;
      continue;
    }
    const byDate = compareDates(row.effectiveOn, latestStatus.effectiveOn);
    if (byDate > 0 || (byDate === 0 && row.sequence > latestStatus.sequence)) latestStatus = row;
  }
  if (latestStatus === null) return { outcome: "UNDECIDABLE" };
  if (latestStatus.status !== "ACTIVE") return { outcome: "NOT_ELIGIBLE" };

  // The assignment cutoff stays `<=` deliberately (6.2): `StudentPlanAssignment` is unique per student per month, so there is
  // no same-period tie to guard against the way there is for a calendar-date status change.
  let latestAssignment: AssignmentRow | null = null;
  for (const row of assignments) {
    if (compareYearMonth({ year: row.effectiveYear, month: row.effectiveMonth }, month) > 0) continue;
    if (
      latestAssignment === null ||
      compareYearMonth({ year: row.effectiveYear, month: row.effectiveMonth }, { year: latestAssignment.effectiveYear, month: latestAssignment.effectiveMonth }) > 0
    ) {
      latestAssignment = row;
    }
  }
  if (latestAssignment === null || latestAssignment.planId === null) return { outcome: "NO_ASSIGNMENT" };
  // Currently unreachable in practice (5.4: nothing changes a student's branch, ever) — a defensive check with no live path to
  // exercise it today, kept so a future branch-transfer feature finds this line rather than a silent wrong answer.
  if (latestAssignment.planAcademyId !== academyId) return { outcome: "NO_ASSIGNMENT" };

  return { outcome: "ELIGIBLE", planId: latestAssignment.planId };
}
