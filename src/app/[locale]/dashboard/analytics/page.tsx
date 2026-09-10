import { getLocale, getTranslations } from "next-intl/server";
import { requireStaffSession } from "@/lib/auth/session";
import { prisma } from "@/lib/prisma";
import { Button } from "@/components/ui/button";
import { resolveAnalyticsFilters, type AnalyticsSearchParams } from "@/lib/analytics/filters";
import { getHeadlineTiles } from "@/lib/analytics/headline-tiles";
import { ExportCsvButton } from "./export-csv-button";

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
  const tiles = await getHeadlineTiles(session, filters);

  // Only ADMIN gets the academy picker (spec's "Locations (admin only)"
  // line) — a DIRECTOR's session is already fully scoped to their own
  // academy by resolveAnalyticsFilters, matching the roster page's own
  // ADMIN-only academy switcher.
  const academies =
    session.role === "ADMIN"
      ? await prisma.academy.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } })
      : [];

  const t = await getTranslations("dashboard.analytics");
  const locale = await getLocale();

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
