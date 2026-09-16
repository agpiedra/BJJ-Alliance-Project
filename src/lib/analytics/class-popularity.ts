import { DateTime } from "luxon";
import { createTranslator } from "next-intl";
import { prisma } from "@/lib/prisma";
import { branchScopeWhere } from "@/lib/tenant/context";
import { getScopedDb } from "@/lib/tenant/scoped-client";
import type { TenantContext } from "@/lib/tenant/types";
import type { Prisma, DayOfWeek, ClassType } from "@/generated/prisma/client";
import type { AnalyticsFilters } from "@/lib/analytics/filters";
import { isWithinRange, previousEquivalentRange, type DateRange } from "@/lib/analytics/headline-tiles";
import { routing } from "@/i18n/routing";
import esMessages from "../../../messages/es.json";
import enMessages from "../../../messages/en.json";

export interface ClassPopularityRow {
  classSessionId: string;
  /**
   * A single readable string composed here (not left to the panel to
   * rebuild) since it's the only field carrying the class's name — the
   * `dayOfWeek`/`startTime` fields below are exposed separately for the
   * heatmap's own day/time bucketing, not so a caller can reassemble this.
   * Follows the admin schedule page's day/time/name convention
   * (`src/app/[locale]/(staff)/admin/schedule/page.tsx`: `tDay(session.dayOfWeek)`
   * + `session.startTime` + `session.name` as separate columns), composed
   * into one string as `"{translatedDay} {startTime} — {name}"`.
   */
  label: string;
  dayOfWeek: DayOfWeek;
  startTime: string;
  /** "Modalidad" (§4.3 Detalle-por-clase column) — plain passthrough of the
   * ClassSession's own `type`, not a new query. */
  type: ClassType;
  attendances: number;
  previousAttendances: number;
  trend: "up" | "down" | "flat";
}

/**
 * `current`/`previous` are integer attendance counts (never fractional,
 * never floating-point-noisy), so exact equality is exactly the right
 * tolerance — unlike a computed percentage or ratio, there's no rounding
 * error to guard against here. Equal counts are "flat"; `previous: 0` with
 * `current > 0` is "up" by the same plain comparison, not a percentage
 * change (which would be a divide-by-zero).
 */
export function computeTrend(current: number, previous: number): "up" | "down" | "flat" {
  if (current === previous) return "flat";
  return current > previous ? "up" : "down";
}

// Read straight from the same messages files `src/i18n/request.ts` loads for
// next-intl — the ONE source of truth for day names (never a second,
// invented set of day-name strings). Resolved through next-intl's own
// `createTranslator` (not `getTranslations`/`getLocale`, which require an
// active Next.js request context this function doesn't have when called
// from a plain integration test hitting the DB directly) so the real
// key-resolution engine runs instead of a hand-rolled reimplementation of
// it — matching this codebase's existing split (see `format-month.ts`'s
// `formatMonthYear`, which also takes `locale` as a plain string parameter
// rather than reading request context itself).
const DAY_MESSAGES: Record<string, typeof esMessages> = {
  es: esMessages,
  en: enMessages,
};

function translateDayOfWeek(day: DayOfWeek, locale: string): string {
  // ponytail: only "es"/"en" are ever passed (routing.locales), so this
  // fallback is defensive-only, never actually exercised.
  const messages = DAY_MESSAGES[locale] ?? DAY_MESSAGES[routing.defaultLocale];
  const t = createTranslator({ locale, messages, namespace: "dayOfWeek" });
  return t(day);
}

/**
 * Director/admin class-popularity panel (Phase 7 §4 Task 2) — ADMIN/DIRECTOR
 * only, self-enforced right here, the same discipline `getHeadlineTiles`
 * already applies.
 *
 * Every `ClassSession` in scope is returned, ranked descending by
 * `attendances` — including a class with zero attendances in the current
 * range (spec explicitly wants the low end surfaced, not silently omitted
 * or filtered to a top-N). `active`/inactive class sessions are both
 * included; this task's spec never asked for that filter, and a
 * recently-deactivated class's historical popularity is still meaningful
 * analytics for the range it covers.
 *
 * Scoped the same way `getClassPopularity`'s sibling functions are:
 * `branchScopeWhere(context)` AND `filters.academyId` combined via an AND
 * array, never spread into one object literal (`ClassSession.academyId` is
 * already the right column — no `homeAcademyId`-style translation needed
 * here, unlike Student). Organization scope comes from `getScopedDb`,
 * unconditionally.
 *
 * `attendances`/`previousAttendances` compare the selected range against
 * `previousEquivalentRange` (reused verbatim from `headline-tiles.ts`,
 * never a second drifting "prior period" implementation) — a 30-day range
 * compares to the 30 days immediately before it. Only `type: "CHECKIN"`
 * records count, same distinction `getHeadlineTiles` draws.
 *
 * `locale` defaults to the app's default locale (`routing.defaultLocale`)
 * for `label`'s translated day name; production callers (the analytics
 * page) pass the request's actual locale.
 */
export async function getClassPopularity(
  context: TenantContext,
  filters: AnalyticsFilters,
  locale: string = routing.defaultLocale,
): Promise<ClassPopularityRow[]> {
  if (context.organizationRole !== "ADMIN" && context.organizationRole !== "DIRECTOR") {
    throw new Error("FORBIDDEN");
  }

  const conditions: Prisma.ClassSessionWhereInput[] = [branchScopeWhere(context)];
  if (filters.academyId) {
    conditions.push({ academyId: filters.academyId });
  }

  const classSessions = await getScopedDb(context).classSession.findMany({
    where: { AND: conditions },
    select: { id: true, dayOfWeek: true, startTime: true, name: true, type: true },
  });

  const range: DateRange = { from: filters.from, to: filters.to };
  const previous = previousEquivalentRange(range);

  const classSessionIds = classSessions.map((cs) => cs.id);
  const attendances =
    classSessionIds.length === 0
      ? []
      : await prisma.attendanceRecord.findMany({
          where: {
            classSessionId: { in: classSessionIds },
            type: "CHECKIN",
            occurredAt: { gte: previous.from.toJSDate(), lte: range.to.toJSDate() },
          },
          select: { classSessionId: true, occurredAt: true },
        });

  const attendanceDatesByClassId = new Map<string, Date[]>();
  for (const record of attendances) {
    if (!record.classSessionId) continue;
    const dates = attendanceDatesByClassId.get(record.classSessionId) ?? [];
    dates.push(record.occurredAt);
    attendanceDatesByClassId.set(record.classSessionId, dates);
  }

  const rows: ClassPopularityRow[] = classSessions.map((cs) => {
    const dates = (attendanceDatesByClassId.get(cs.id) ?? []).map((date) => DateTime.fromJSDate(date));
    const currentCount = dates.filter((date) => isWithinRange(date, range)).length;
    const previousCount = dates.filter((date) => isWithinRange(date, previous)).length;

    return {
      classSessionId: cs.id,
      label: `${translateDayOfWeek(cs.dayOfWeek, locale)} ${cs.startTime} — ${cs.name}`,
      dayOfWeek: cs.dayOfWeek,
      startTime: cs.startTime,
      type: cs.type,
      attendances: currentCount,
      previousAttendances: previousCount,
      trend: computeTrend(currentCount, previousCount),
    };
  });

  return rows.sort((a, b) => b.attendances - a.attendances);
}

/**
 * Signed percentage change from `previous` to `current`, rounded to the
 * nearest whole percent — the "real percentage — not an arrow glyph" the
 * Detalle-por-clase trend pill needs (§4.3's own wording). `null` when
 * `previous` is 0 AND `current` is not: a percentage change FROM zero
 * attendances TO some is undefined, so the caller renders "Nuevo" instead of
 * a number rather than a nonsensical/infinite percentage. `previous === 0
 * && current === 0` is the flat/no-change case, not "new" — `getClassPopularity`
 * deliberately includes zero-attendance and inactive class sessions, so a
 * real, reachable 0-to-0 row must render as flat (`0`), not mislabeled as
 * "Nuevo". Deliberately separate from `computeTrend` above (which only
 * classifies direction) rather than changing that function's existing
 * return shape.
 */
export function computeTrendPercent(current: number, previous: number): number | null {
  if (previous === 0) return current === 0 ? 0 : null;
  return Math.round(((current - previous) / previous) * 100);
}

const WEEKDAY_NUMBER: Record<DayOfWeek, number> = {
  MONDAY: 1,
  TUESDAY: 2,
  WEDNESDAY: 3,
  THURSDAY: 4,
  FRIDAY: 5,
  SATURDAY: 6,
  SUNDAY: 7,
};

/**
 * How many times `dayOfWeek` falls inside `[from, to]` (both inclusive) —
 * the "sessions" denominator for the Detalle-por-clase table's "promedio por
 * sesión" column, since a `ClassSession` is a recurring weekly slot, not a
 * single occurrence. A plain day-by-day scan (ponytail: O(range length in
 * days) — fine at this app's scale, a year-long "Año" quick range is ~366
 * iterations; switch to a closed-form weekday-count formula if a much wider
 * range is ever needed) rather than a new query — every input is already in
 * hand (`row.dayOfWeek`, `filters.from`/`filters.to`).
 */
export function countWeekdayOccurrences(dayOfWeek: DayOfWeek, from: DateTime, to: DateTime): number {
  if (to < from) return 0;
  const targetWeekday = WEEKDAY_NUMBER[dayOfWeek];
  let count = 0;
  let cursor = from.startOf("day");
  const end = to.startOf("day");
  while (cursor <= end) {
    if (cursor.weekday === targetWeekday) count++;
    cursor = cursor.plus({ days: 1 });
  }
  return count;
}

export interface ClassGrowthEntry {
  classSessionId: string;
  label: string;
  /** Signed: `attendances - previousAttendances`. */
  diff: number;
}

/**
 * The `limit` classes with the biggest CHANGE in attendances between the
 * previous period and this one, signed — §4.3's "Mayor crecimiento" key/
 * value list. Ranked by absolute movement, not just growth: a class that
 * collapsed is exactly as much "a biggest mover" as one that took off, and
 * the signed `diff` is what tells the caller which (rendered +green/-red).
 * Reuses `getClassPopularity`'s own `attendances`/`previousAttendances`
 * fields — no new query. Rows with no change at all are excluded (nothing to
 * report), and a class with no previous-period data (`previousAttendances:
 * 0`) still participates — its `diff` is simply its full current count.
 */
export function computeBiggestMovers(rows: ClassPopularityRow[], limit = 5): ClassGrowthEntry[] {
  return rows
    .map((row) => ({
      classSessionId: row.classSessionId,
      label: row.label,
      diff: row.attendances - row.previousAttendances,
    }))
    .filter((entry) => entry.diff !== 0)
    .sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff))
    .slice(0, limit);
}

/** §4.3's own wording: "classes under 4 attendances in the period" —
 * "Clases en riesgo". Current-period count only (not previous), reusing the
 * same `getClassPopularity` rows — no new query. */
export function computeAtRiskClasses(rows: ClassPopularityRow[], threshold = 4): ClassPopularityRow[] {
  return rows.filter((row) => row.attendances < threshold);
}
