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
   * `null` means "every academy in the session's scope" — an ADMIN session
   * with no `academy` param or `academy=ambas`. Never `null` for a
   * DIRECTOR/INSTRUCTOR-shaped session (they always resolve to their own
   * single assigned academy).
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
 * their own single assigned academy regardless of what `academy` they pass,
 * the same "a client-submitted scope override is silently ignored for
 * non-ADMIN" precedent `listStudents` established
 * (`src/app/[locale]/students/actions.ts`'s `filters.academyId` handling).
 * `academy=ambas`, or its absence, resolves ADMIN to `academyId: null` —
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
    // (admin only)" line), so whatever `academy` they pass is ignored in
    // favor of their own assigned academy — `academyIds` is a single-entry
    // array for every non-ADMIN staff session this app creates.
    const scoped = Array.isArray(session.academyIds) ? session.academyIds : [];
    academyId = scoped[0] ?? null;
  }

  return { from, to, academyId };
}
