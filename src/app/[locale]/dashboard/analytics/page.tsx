import { getLocale, getTranslations } from "next-intl/server";
import { requireStaffSession } from "@/lib/auth/session";
import { prisma } from "@/lib/prisma";
import { Button } from "@/components/ui/button";
import { resolveAnalyticsFilters, type AnalyticsSearchParams } from "@/lib/analytics/filters";
import { getHeadlineTiles } from "@/lib/analytics/headline-tiles";
import { getClassPopularity } from "@/lib/analytics/class-popularity";
import { getBeltDistribution, getProgressionPlanningList, getPromotionsInRange } from "@/lib/analytics/progression";
import { getLocationComparison, getCrossTraining } from "@/lib/analytics/locations";
import { ExportCsvButton } from "./export-csv-button";
import { ClassPopularityPanel } from "./class-popularity-panel";
import { ProgressionPanel } from "./progression-panel";
import { LocationsPanel } from "./locations-panel";

// Same reasoning as the roster/dashboard pages: every panel here reflects
// staff/student data that can change without a redeploy, so this page must
// never be statically frozen at build time.
export const dynamic = "force-dynamic";

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
  const filters = resolveAnalyticsFilters(session, params);

  // Every query function in this module self-enforces the same ADMIN/
  // DIRECTOR gate against `session` independently of this page — this call
  // can never surface a result an INSTRUCTOR shouldn't see, even if this
  // page's own gate above were ever bypassed or miscopied.
  const locale = await getLocale();
  const [tiles, classPopularity, planningList, beltDistribution, promotionsInRange] = await Promise.all([
    getHeadlineTiles(session, filters),
    getClassPopularity(session, filters, locale),
    getProgressionPlanningList(session, filters),
    getBeltDistribution(session, filters),
    getPromotionsInRange(session, filters),
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

  // Only ADMIN gets the academy picker (spec's "Locations (admin only)"
  // line) — a DIRECTOR's session is already fully scoped to their own
  // academy by resolveAnalyticsFilters, matching the roster page's own
  // ADMIN-only academy switcher.
  const academies =
    session.role === "ADMIN"
      ? await prisma.academy.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } })
      : [];

  const t = await getTranslations("dashboard.analytics");

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

  return (
    <main className="flex flex-col gap-6 p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">{t("heading")}</h1>
        <a href={`/${locale}/dashboard`} className="underline">
          {t("backToDashboardLink")}
        </a>
      </div>

      <form method="get" className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-sm">{t("filters.from")}</span>
          <input
            type="date"
            name="from"
            defaultValue={filters.from.toISODate() ?? ""}
            className="rounded border px-3 py-2"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-sm">{t("filters.to")}</span>
          <input
            type="date"
            name="to"
            defaultValue={filters.to.toISODate() ?? ""}
            className="rounded border px-3 py-2"
          />
        </label>
        {session.role === "ADMIN" && (
          <label className="flex flex-col gap-1">
            <span className="text-sm">{t("filters.academy")}</span>
            <select
              name="academy"
              defaultValue={filters.academyId ?? "ambas"}
              className="rounded border px-3 py-2"
            >
              <option value="ambas">{t("filters.bothAcademies")}</option>
              {academies.map((academy) => (
                <option key={academy.id} value={academy.id}>
                  {academy.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <Button type="submit" variant="outline">
          {t("filters.submit")}
        </Button>
      </form>

      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-medium">{t("tiles.heading")}</h2>
          <ExportCsvButton rows={csvRows} filename="analytics-headline-tiles.csv" />
        </div>
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
          <Tile label={t("tiles.enrolled")} value={tiles.enrolled} />
          <Tile label={t("tiles.active")} value={tiles.active} />
          <Tile label={t("tiles.inactive")} value={tiles.inactive} />
          <Tile label={t("tiles.newThisMonth")} value={tiles.newThisMonth} />
          <Tile label={t("tiles.lost")} value={tiles.lost} />
          <Tile label={t("tiles.totalAttendances")} value={tiles.totalAttendances} />
          <Tile label={t("tiles.avgAttendancesPerActive")} value={tiles.avgAttendancesPerActive.toFixed(1)} />
          <Tile label={t("tiles.paymentHealthPercent")} value={`${tiles.paymentHealthPercent}%`} />
        </div>
      </section>

      <ClassPopularityPanel rows={classPopularity} />

      <ProgressionPanel
        planningList={planningListRows}
        beltDistribution={beltDistribution}
        promotionsInRange={promotionsInRangeRows}
      />

      {session.role === "ADMIN" && (
        <LocationsPanel comparison={locationComparison} crossTraining={crossTraining} />
      )}
    </main>
  );
}

function Tile({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="flex flex-col gap-1 rounded border p-4">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="text-2xl font-semibold">{value}</span>
    </div>
  );
}
