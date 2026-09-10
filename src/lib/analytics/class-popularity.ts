import { DateTime } from "luxon";
import { prisma } from "@/lib/prisma";
import { academyScopeWhere, type StaffSession } from "@/lib/auth/session";
import type { Prisma, DayOfWeek } from "@/generated/prisma/client";
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
   * (`src/app/[locale]/admin/schedule/page.tsx`: `tDay(session.dayOfWeek)`
   * + `session.startTime` + `session.name` as separate columns), composed
   * into one string as `"{translatedDay} {startTime} — {name}"`.
   */
  label: string;
  dayOfWeek: DayOfWeek;
  startTime: string;
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
// invented set of day-name strings). Read directly (not through
// `getTranslations`/`getLocale`) because those require an active Next.js
// request context (middleware-populated `requestLocale`), which this
// function does not have when called from a plain integration test hitting
// the DB directly — matching this codebase's existing split (see
// `format-month.ts`'s `formatMonthYear`, which also takes `locale` as a
// plain string parameter rather than reading request context itself).
const DAY_NAMES: Record<string, Record<DayOfWeek, string>> = {
  es: esMessages.dayOfWeek,
  en: enMessages.dayOfWeek,
};

function translateDayOfWeek(day: DayOfWeek, locale: string): string {
  return (DAY_NAMES[locale] ?? DAY_NAMES[routing.defaultLocale])[day];
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
 * `academyScopeWhere(session)` AND `filters.academyId` combined via an AND
 * array, never spread into one object literal (`ClassSession.academyId` is
 * already the right column — no `homeAcademyId`-style translation needed
 * here, unlike Student).
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
  session: StaffSession,
  filters: AnalyticsFilters,
  locale: string = routing.defaultLocale,
): Promise<ClassPopularityRow[]> {
  if (session.role !== "ADMIN" && session.role !== "DIRECTOR") {
    throw new Error("FORBIDDEN");
  }

  const conditions: Prisma.ClassSessionWhereInput[] = [academyScopeWhere(session)];
  if (filters.academyId) {
    conditions.push({ academyId: filters.academyId });
  }

  const classSessions = await prisma.classSession.findMany({
    where: { AND: conditions },
    select: { id: true, dayOfWeek: true, startTime: true, name: true },
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
      attendances: currentCount,
      previousAttendances: previousCount,
      trend: computeTrend(currentCount, previousCount),
    };
  });

  return rows.sort((a, b) => b.attendances - a.attendances);
}
