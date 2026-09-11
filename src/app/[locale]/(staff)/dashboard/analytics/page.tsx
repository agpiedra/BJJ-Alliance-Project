import { DateTime } from "luxon";
import { getLocale, getTranslations } from "next-intl/server";
import { requireStaffSession } from "@/lib/auth/session";
import { prisma } from "@/lib/prisma";
import { ZONE } from "@/lib/scheduling/zone";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { FilterBar, FilterBarSelect } from "@/components/ui/filter-bar";
import { Input } from "@/components/ui/input";
import { StatRow, StatTile, type StatTileProps } from "@/components/ui/stat-tile";
import { cn } from "cn";
import {
  resolveAnalyticsFilters,
  computeQuickRange,
  QUICK_RANGE_KEYS,
  type AnalyticsSearchParams,
  type AnalyticsFilters,
  type QuickRangeKey,
} from "@/lib/analytics/filters";
import {
  getHeadlineTiles,
  previousEquivalentRange,
  computeTileDelta,
  type TileDeltaPolarity,
} from "@/lib/analytics/headline-tiles";
import {
  getClassPopularity,
  countWeekdayOccurrences,
  computeTrendPercent,
  computeBiggestMovers,
  computeAtRiskClasses,
} from "@/lib/analytics/class-popularity";
import { getBeltDistribution, getProgressionPlanningList, getPromotionsInRange } from "@/lib/analytics/progression";
import { getLocationComparison, getCrossTraining } from "@/lib/analytics/locations";
import { getRetentionList, getWeeklyAttendanceTrend } from "@/lib/analytics/retention";
import { ExportCsvButton } from "./export-csv-button";
import { ClassPopularityPanel } from "./class-popularity-panel";
import { ProgressionPanel } from "./progression-panel";
import { LocationsPanel } from "./locations-panel";
import { RetentionPanel } from "./retention-panel";

// Same reasoning as the roster/dashboard pages: every panel here reflects
// staff/student data that can change without a redeploy, so this page must
// never be statically frozen at build time.
export const dynamic = "force-dynamic";

// §4.3's "Clases en riesgo": "classes under 4 attendances in the period".
// Defined once here (not duplicated as a literal in the client panel) and
// passed down as a plain prop alongside the already-derived rows.
const AT_RISK_THRESHOLD = 4;

/** §4.3's "8 stat tiles... each with a comparison line vs. the previous
 * period" — one row per tile: which of `HeadlineTiles`' fields, and whether
 * an increase is the good direction (`computeTileDelta`'s `polarity`). */
const TILE_POLARITY = {
  enrolled: "higherIsBetter",
  active: "higherIsBetter",
  inactive: "lowerIsBetter",
  newThisMonth: "higherIsBetter",
  lost: "lowerIsBetter",
  totalAttendances: "higherIsBetter",
  avgAttendancesPerActive: "higherIsBetter",
  paymentHealthPercent: "higherIsBetter",
} as const satisfies Record<string, TileDeltaPolarity>;

export default async function AnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<AnalyticsSearchParams>;
}) {
  // ADMIN/DIRECTOR only (spec's "Locations (admin only)" line aside, the
  // page as a whole is director-level) — INSTRUCTOR gets neither the nav
  // link (see dashboard/page.tsx) nor a working direct-URL visit.
  const session = await requireStaffSession(["ADMIN", "DIRECTOR"]);
  const params = await searchParams;
  // Captured once and threaded through both `resolveAnalyticsFilters` and
  // `computeQuickRange` below, rather than each defaulting to its own
  // `DateTime.now()` a few lines apart — so the quick-range "active" check
  // (comparing `filters.from`/`to` against a freshly computed preset) can
  // never mismatch by a few milliseconds around a day boundary.
  const now = DateTime.now().setZone(ZONE);
  const filters = resolveAnalyticsFilters(session, params, now);

  // Every query function in this module self-enforces the same ADMIN/
  // DIRECTOR gate against `session` independently of this page — this call
  // can never surface a result an INSTRUCTOR shouldn't see, even if this
  // page's own gate above were ever bypassed or miscopied.
  const locale = await getLocale();
  const previousFilters: AnalyticsFilters = {
    ...previousEquivalentRange({ from: filters.from, to: filters.to }),
    academyId: filters.academyId,
  };
  const [
    tiles,
    previousTiles,
    classPopularity,
    planningList,
    beltDistribution,
    promotionsInRange,
    retentionList,
    weeklyTrend,
  ] = await Promise.all([
    getHeadlineTiles(session, filters),
    // §4.3 Task 2: "each with a comparison line vs. the previous period" —
    // reuses `getHeadlineTiles` itself against `previousEquivalentRange`
    // (already exported by headline-tiles.ts) rather than a second,
    // drifting computation of what "the previous period" means.
    getHeadlineTiles(session, previousFilters),
    getClassPopularity(session, filters, locale),
    getProgressionPlanningList(session, filters),
    getBeltDistribution(session, filters),
    getPromotionsInRange(session, filters),
    getRetentionList(session, filters),
    getWeeklyAttendanceTrend(session, filters),
  ]);

  // ADMIN-only panel (spec's "Locations (admin only)" heading) — skip
  // fetching this data entirely for a DIRECTOR session rather than
  // fetch-and-hide; `getLocationComparison`/`getCrossTraining` would reject
  // a DIRECTOR anyway (this is the one panel in the phase where DIRECTOR is
  // rejected outright, not narrowed), so this check only saves the query.
  const [locationComparison, crossTraining] =
    session.role === "ADMIN"
      ? await Promise.all([getLocationComparison(session, filters), getCrossTraining(session, filters)])
      : [[], []];

  // §4.3 Task 3/5: BarList + "Detalle por clase" both derive from the same
  // `getClassPopularity` result — `sessionsInRange`/`trendPercent` are
  // computed here (not inside the "use client" panel) because
  // `class-popularity.ts` also exports `getClassPopularity`, which
  // transitively imports `@/lib/prisma`; importing any VALUE export of that
  // module into a client component would bundle Prisma into the browser
  // build. Same reasoning `planningListRows`/`promotionsInRangeRows` below
  // already follow for Luxon `DateTime` fields (plain data crosses the
  // Server -> Client boundary, not live library instances/functions).
  const classPopularityRows = classPopularity.map((row) => ({
    ...row,
    sessionsInRange: countWeekdayOccurrences(row.dayOfWeek, filters.from, filters.to),
    trendPercent: computeTrendPercent(row.attendances, row.previousAttendances),
  }));
  const growthEntries = computeBiggestMovers(classPopularity);
  const atRiskRows = computeAtRiskClasses(classPopularity, AT_RISK_THRESHOLD);

  // `projectedDate`/`awardedAt` are Luxon `DateTime` instances — not
  // plain-serializable across the Server -> Client Component boundary, so
  // they're converted to ISO strings here (see progression-panel.tsx's own
  // comment on its row prop types).
  const planningListRows = planningList.map((row) => ({
    ...row,
    projectedDate: row.projectedDate?.toISO() ?? null,
  }));
  const promotionsInRangeRows = promotionsInRange.map((row) => ({
    ...row,
    awardedAt: row.awardedAt.toISO()!,
  }));
  // `lastSeenAt` is a plain `Date | null` here (not a Luxon `DateTime`), but
  // it still crosses the Server -> Client boundary as an ISO string — the
  // same discipline every other timestamp-bearing row in this page follows,
  // rather than assuming a native `Date` is a special case.
  const retentionListRows = retentionList.map((entry) => ({
    ...entry,
    lastSeenAt: entry.lastSeenAt ? entry.lastSeenAt.toISOString() : null,
  }));

  // Only ADMIN gets the academy picker (spec's "Locations (admin only)"
  // line) — a DIRECTOR's session is already fully scoped to their own
  // academy by resolveAnalyticsFilters, matching the roster page's own
  // ADMIN-only academy switcher.
  const academies =
    session.role === "ADMIN"
      ? await prisma.academy.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } })
      : [];

  const t = await getTranslations("dashboard.analytics");
  const intlLocale = locale === "es" ? "es-CR" : "en-US";

  const csvRows = [
    { metric: t("tiles.enrolled"), value: tiles.enrolled },
    { metric: t("tiles.active"), value: tiles.active },
    { metric: t("tiles.inactive"), value: tiles.inactive },
    { metric: t("tiles.newThisMonth"), value: tiles.newThisMonth },
    { metric: t("tiles.lost"), value: tiles.lost },
    { metric: t("tiles.totalAttendances"), value: tiles.totalAttendances },
    { metric: t("tiles.avgAttendancesPerActive"), value: tiles.avgAttendancesPerActive.toFixed(1) },
    { metric: t("tiles.paymentHealthPercent"), value: `${tiles.paymentHealthPercent}%` },
  ];

  /** §4.3 Task 2: a `StatTile`'s `delta` prop, built from the current vs.
   * previous-period values — `undefined` (no line rendered) when nothing
   * changed, matching dashboard/page.tsx's own weekly-attendance delta
   * convention. */
  function tileDelta(
    current: number,
    previous: number,
    polarity: TileDeltaPolarity,
    formatOptions?: Intl.NumberFormatOptions,
  ): StatTileProps["delta"] {
    const result = computeTileDelta(current, previous, polarity);
    if (!result) return undefined;
    const formatted = new Intl.NumberFormat(intlLocale, { signDisplay: "exceptZero", ...formatOptions }).format(
      result.diff,
    );
    return { direction: result.direction, label: t("tiles.deltaVsPrevious", { value: formatted }) };
  }

  // §4.3 Task 1: quick-range segmented control. Plain <a href> links (this
  // app's established GET-form filtering pattern, e.g. students/page.tsx) —
  // no client-side state: "active" is decided here by comparing the
  // already-resolved `filters.from`/`to` against each preset's own computed
  // dates, the same range `resolveAnalyticsFilters` would land on if that
  // preset's link were followed.
  const quickRanges = QUICK_RANGE_KEYS.map((key: QuickRangeKey) => {
    const range = computeQuickRange(key, now);
    const linkParams = new URLSearchParams({ from: range.from, to: range.to });
    if (session.role === "ADMIN" && filters.academyId) {
      linkParams.set("academy", filters.academyId);
    }
    return {
      key,
      label: t(`filters.quickRange.${key}`),
      href: `?${linkParams.toString()}`,
      active: filters.from.toISODate() === range.from && filters.to.toISODate() === range.to,
    };
  });

  return (
    <main className="flex flex-col gap-6 p-4 sm:p-6">
      <header className="flex flex-col gap-1">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex flex-col gap-1">
            <p className="font-mono text-[10.5px] tracking-[.11em] text-muted-foreground uppercase">
              {t("eyebrow")}
            </p>
            <h1>{t("heading")}</h1>
          </div>
          <ExportCsvButton rows={csvRows} filename="analytics-headline-tiles.csv" />
        </div>
        <p className="text-sm text-muted-foreground">
          {t("sub", { active: tiles.active, attendances: tiles.totalAttendances })}
        </p>
      </header>

      <Card>
        <div className="flex flex-col gap-3 border-b border-border px-4 py-3">
          <span className="font-mono text-[10.5px] tracking-[.11em] text-muted-foreground uppercase">
            {t("filters.quickRange.label")}
          </span>
          <div
            role="group"
            aria-label={t("filters.quickRange.label")}
            className="inline-flex w-fit overflow-hidden rounded-lg border border-border"
          >
            {quickRanges.map((range, index) => (
              <a
                key={range.key}
                href={range.href}
                role="button"
                aria-pressed={range.active}
                className={cn(
                  "px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground aria-pressed:bg-muted aria-pressed:font-medium aria-pressed:text-foreground",
                  index > 0 && "border-l border-border",
                )}
              >
                {range.label}
              </a>
            ))}
          </div>
        </div>

        <form method="get">
          <FilterBar className="border-b-0">
            <label htmlFor="analytics-from" className="flex flex-col gap-1 text-sm">
              <span>{t("filters.from")}</span>
              <Input
                id="analytics-from"
                type="date"
                name="from"
                defaultValue={filters.from.toISODate() ?? ""}
                className="w-auto"
              />
            </label>
            <label htmlFor="analytics-to" className="flex flex-col gap-1 text-sm">
              <span>{t("filters.to")}</span>
              <Input
                id="analytics-to"
                type="date"
                name="to"
                defaultValue={filters.to.toISODate() ?? ""}
                className="w-auto"
              />
            </label>
            {session.role === "ADMIN" && (
              <label htmlFor="analytics-academy" className="flex flex-col gap-1 text-sm">
                <span>{t("filters.academy")}</span>
                <FilterBarSelect id="analytics-academy" name="academy" defaultValue={filters.academyId ?? "ambas"}>
                  <option value="ambas">{t("filters.bothAcademies")}</option>
                  {academies.map((academy) => (
                    <option key={academy.id} value={academy.id}>
                      {academy.name}
                    </option>
                  ))}
                </FilterBarSelect>
              </label>
            )}
            <Button type="submit" variant="outline" size="sm">
              {t("filters.submit")}
            </Button>
          </FilterBar>
        </form>
      </Card>

      {/* §4.3 Task 2: 8 stat tiles, 4x2, each with a vs.-previous-period
          comparison line. */}
      <div className="flex flex-col gap-1">
        <StatRow columns={4}>
          <StatTile
            label={t("tiles.enrolled")}
            value={tiles.enrolled}
            delta={tileDelta(tiles.enrolled, previousTiles.enrolled, TILE_POLARITY.enrolled)}
          />
          <StatTile
            label={t("tiles.active")}
            value={tiles.active}
            delta={tileDelta(tiles.active, previousTiles.active, TILE_POLARITY.active)}
          />
          <StatTile
            label={t("tiles.inactive")}
            value={tiles.inactive}
            delta={tileDelta(tiles.inactive, previousTiles.inactive, TILE_POLARITY.inactive)}
          />
          <StatTile
            label={t("tiles.newThisMonth")}
            value={tiles.newThisMonth}
            delta={tileDelta(tiles.newThisMonth, previousTiles.newThisMonth, TILE_POLARITY.newThisMonth)}
          />
          <StatTile
            label={t("tiles.lost")}
            value={tiles.lost}
            delta={tileDelta(tiles.lost, previousTiles.lost, TILE_POLARITY.lost)}
          />
          <StatTile
            label={t("tiles.totalAttendances")}
            value={tiles.totalAttendances}
            delta={tileDelta(tiles.totalAttendances, previousTiles.totalAttendances, TILE_POLARITY.totalAttendances)}
          />
          <StatTile
            label={t("tiles.avgAttendancesPerActive")}
            value={tiles.avgAttendancesPerActive.toFixed(1)}
            delta={tileDelta(
              tiles.avgAttendancesPerActive,
              previousTiles.avgAttendancesPerActive,
              TILE_POLARITY.avgAttendancesPerActive,
              { maximumFractionDigits: 1, minimumFractionDigits: 1 },
            )}
          />
          <StatTile
            label={t("tiles.paymentHealthPercent")}
            value={`${tiles.paymentHealthPercent}%`}
            // `previousTiles.paymentHealthPercent` always equals the current
            // value (getHeadlineTiles pins this one field to the CURRENT
            // calendar month regardless of the filter range — see its own
            // doc comment) — the diff is therefore always 0 and this line
            // never renders, by design, not a bug in tileDelta.
            delta={tileDelta(
              tiles.paymentHealthPercent,
              previousTiles.paymentHealthPercent,
              TILE_POLARITY.paymentHealthPercent,
            )}
          />
        </StatRow>
        <p className="text-xs text-muted-foreground">{t("tiles.totalAttendancesCaption")}</p>
      </div>

      <ClassPopularityPanel
        rows={classPopularityRows}
        growthEntries={growthEntries}
        atRiskRows={atRiskRows}
        atRiskThreshold={AT_RISK_THRESHOLD}
      />

      <ProgressionPanel
        planningList={planningListRows}
        beltDistribution={beltDistribution}
        promotionsInRange={promotionsInRangeRows}
      />

      {session.role === "ADMIN" && (
        <LocationsPanel comparison={locationComparison} crossTraining={crossTraining} />
      )}

      <RetentionPanel entries={retentionListRows} weeklyTrend={weeklyTrend} />
    </main>
  );
}
