import { DateTime } from "luxon";
import { ZONE } from "@/lib/scheduling/zone";
import type { StaffSession } from "@/lib/auth/session";

/**
 * The default headline-metrics window (spec's own words: "active-window
 * threshold, default 30 days") — also this page's fallback date range when
 * no/invalid `from`/`to` search params are present.
 */
export const DEFAULT_RANGE_DAYS = 30;

export interface AnalyticsFilters {
  from: DateTime;
  to: DateTime;
  /**
   * `null` means "don't narrow further than the session's own scope" — an
   * ADMIN session with no `academy` param or `academy=ambas`, AND every
   * non-ADMIN (DIRECTOR/INSTRUCTOR) session, regardless of how many
   * academies they're assigned to. A non-ADMIN session is never widened by
   * this: every panel's query function independently ANDs in
   * `academyScopeWhere(session)` regardless of `academyId`, so `null` here
   * simply defers entirely to that session-level scope rather than
   * redundantly (and, for a multi-academy DIRECTOR, incorrectly) re-pinning
   * to a single academy.
   */
  academyId: string | null;
}

export interface AnalyticsSearchParams {
  from?: string;
  to?: string;
  academy?: string;
}

function parseDateParam(value: string | undefined): DateTime | null {
  if (!value) return null;
  const parsed = DateTime.fromISO(value, { zone: ZONE });
  return parsed.isValid ? parsed : null;
}

/**
 * Resolves `/dashboard/analytics`'s URL search params
 * (`?from=&to=&academy=`) into a concrete date range + academy scope. Every
 * panel in this phase reads filters through this single resolver rather than
 * parsing search params itself, so they always agree on what "the selected
 * range/academy" means.
 *
 * Pure given its inputs — no `new Date()`/DB call inside, mirroring the
 * `isOverdue`/`currentCrDateParts()` split (`src/lib/payments/overdue.ts`,
 * `src/lib/payments/get-current-period.ts`): production callers omit
 * `today` and get the real CR-zoned instant; tests inject a fixed one so the
 * 30-day-default logic never fights the wall clock.
 *
 * `from`/`to` must BOTH parse as real dates or the whole pair falls back to
 * the last-`DEFAULT_RANGE_DAYS`-days-ending-today default — a half-valid
 * range (one real date, one garbage) is rejected outright rather than
 * guessed at, the same "don't trust a malformed filter, degrade gracefully
 * rather than throw" posture this app already takes with other search-param
 * parsing (see `students/page.tsx`'s `parseBelt`/`parseStatus`).
 *
 * `academy` is only ever honored for ADMIN, whose session scope is
 * unrestricted — a DIRECTOR/INSTRUCTOR-shaped session always resolves to
 * `academyId: null` regardless of what `academy` they pass, the same "a
 * client-submitted scope override is silently ignored for non-ADMIN"
 * precedent `listStudents` established
 * (`src/app/[locale]/(staff)/students/actions.ts`'s `filters.academyId` handling) —
 * taken one step further here: rather than re-pinning to `academyIds[0]`
 * (which would silently drop any additional `StaffAssignment` a DIRECTOR
 * with more than one academy has), `academyId: null` lets their full
 * session-level scope apply via `academyScopeWhere(session)`, the same
 * `{ in: [...] }` fragment `listStudents` itself relies on. `academy=ambas`,
 * or its absence, resolves ADMIN to `academyId: null` the same way —
 * "every academy in scope".
 */
export function resolveAnalyticsFilters(
  session: StaffSession,
  searchParams: AnalyticsSearchParams,
  today: DateTime = DateTime.now().setZone(ZONE),
): AnalyticsFilters {
  const parsedFrom = parseDateParam(searchParams.from);
  const parsedTo = parseDateParam(searchParams.to);
  const bothValid = parsedFrom !== null && parsedTo !== null;

  const to = (bothValid ? parsedTo : today).endOf("day");
  const from = (bothValid ? parsedFrom : to.minus({ days: DEFAULT_RANGE_DAYS })).startOf("day");

  let academyId: string | null;
  if (session.role === "ADMIN") {
    const requested = searchParams.academy;
    academyId = !requested || requested === "ambas" ? null : requested;
  } else {
    // DIRECTOR/INSTRUCTOR: never gets the picker (spec's "Locations
    // (admin only)" line), so whatever `academy` they pass is ignored —
    // `null` here defers entirely to the session's own scope
    // (`academyScopeWhere(session)`, applied independently by every panel's
    // query function), rather than pinning to just their FIRST assignment
    // and silently dropping any others.
    academyId = null;
  }

  return { from, to, academyId };
}
