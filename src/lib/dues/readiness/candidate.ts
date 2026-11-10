import { DateTime } from "luxon";
import { assertYearMonth, compareYearMonth, type YearMonth } from "@/lib/dues/calendar";
import { nextMonthIn } from "@/lib/dues/config-input";

/** Stage 9 A1, P = 10 (approved 2026-11-10): the switch may run until the FIRST branch reaches local 00:00 on day P + 1 of S. */
export const SWITCH_WINDOW_DAYS = 10;

/**
 * Stage 9 A1 (approved 2026-11-10), from the branches' own timezones only — due and grace days play no part:
 * - `approvalDeadline`: approval is accepted only BEFORE the first branch reaches local 00:00 on the 1st of S;
 * - `opensAt`: the switch may run from the moment the LAST branch reaches local 00:00 on the 1st of S;
 * - `closesAt`: until (exclusive) the FIRST branch reaches local 00:00 on day `SWITCH_WINDOW_DAYS + 1` of S.
 * Null with no branch or an unknown timezone: nothing can be decided, so the callers refuse.
 */
export function activationWindow(s: YearMonth, timezones: readonly string[]): { approvalDeadline: Date; opensAt: Date; closesAt: Date } | null {
  if (timezones.length === 0) return null;
  const at = (day: number, zone: string) => DateTime.fromObject({ year: s.year, month: s.month, day }, { zone });
  const firsts = timezones.map((z) => at(1, z));
  const closes = timezones.map((z) => at(SWITCH_WINDOW_DAYS + 1, z));
  if ([...firsts, ...closes].some((d) => !d.isValid)) return null;
  const ms = (ds: DateTime[]) => ds.map((d) => d.toMillis());
  return {
    approvalDeadline: new Date(Math.min(...ms(firsts))),
    opensAt: new Date(Math.max(...ms(firsts))),
    closesAt: new Date(Math.min(...ms(closes))),
  };
}

/**
 * The candidate start month S: pure rules, no database (so they are unit-tested without one).
 */

/** The same rule as the ledger's `isValidCoverageMonth` (a calendar month in the schema's 2000-2100 range), restated here so
 * this read-only module never imports a writer module. */
export function isCandidateMonth(month: YearMonth): boolean {
  try {
    assertYearMonth(month);
  } catch {
    return false;
  }
  return month.year >= 2000 && month.year <= 2100;
}

/** `?s=YYYY-MM` → a candidate month, or null when it is malformed or outside `isCandidateMonth`. */
export function parseCandidateParam(raw: string): YearMonth | null {
  const match = /^([0-9]{4})-([0-9]{2})$/.exec(raw);
  if (!match) return null;
  const month = { year: Number(match[1]), month: Number(match[2]) };
  return isCandidateMonth(month) ? month : null;
}

/**
 * The default candidate when none is given: D15 (start on the 1st of the NEXT month), using the existing `nextMonthIn` rule
 * (the month after the current one in a BRANCH's timezone, never the server's). Branches disagree only around a month boundary:
 * one is still in M (next = M+1) while another is already in M+1 (next = M+2). The LATEST is used, so the default is a month
 * that has not begun in any branch (M+1 would already be under way in the second one). With no branches, UTC is used. `now` is
 * the caller's clock (the readiness screen passes its snapshot's own database time).
 */
export function defaultCandidateMonth(timezones: readonly string[], now: Date): { month: YearMonth; branchesDisagree: boolean } {
  const months = (timezones.length > 0 ? timezones : ["UTC"]).map((zone) => nextMonthIn(zone, now));
  const latest = months.reduce((a, b) => (compareYearMonth(b, a) > 0 ? b : a));
  return { month: latest, branchesDisagree: months.some((m) => compareYearMonth(m, latest) !== 0) };
}
