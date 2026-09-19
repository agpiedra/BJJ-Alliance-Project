import { getTranslations } from "next-intl/server";
import { Card, CardContent } from "@/components/ui/card";
import { StatRow, StatTile } from "@/components/ui/stat-tile";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "cn";
import { resolvePlatformOverview, getPlatformWeeklyAttendanceTrend } from "@/lib/tenant/platform-lookups";
import { WeeklyAttendanceChart } from "../(staff)/dashboard/weekly-attendance-chart";

export const dynamic = "force-dynamic";

const WEEKLY_CHART_WINDOW_WEEKS = 8;

export default async function PlatformOverviewPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const t = await getTranslations("platform.overview");

  const [overview, trend] = await Promise.all([
    resolvePlatformOverview(),
    getPlatformWeeklyAttendanceTrend(WEEKLY_CHART_WINDOW_WEEKS),
  ]);

  return (
    <>
      <header>
        <h1 className="text-2xl font-bold">{t("heading")}</h1>
      </header>

      {overview.pendingCount > 0 && (
        <Card>
          <CardContent className="flex flex-wrap items-center justify-between gap-3">
            <p>{t("pendingCallout", { count: overview.pendingCount })}</p>
            <a href={`/${locale}/platform/organizations/pending`} className={cn(buttonVariants({ size: "sm" }))}>
              {t("pendingCalloutLink")}
            </a>
          </CardContent>
        </Card>
      )}

      <StatRow>
        <StatTile label={t("stats.active")} value={overview.countsByStatus.ACTIVE} />
        <StatTile label={t("stats.pending")} value={overview.countsByStatus.PENDING} />
        <StatTile label={t("stats.suspended")} value={overview.countsByStatus.SUSPENDED} />
        <StatTile label={t("stats.cancelled")} value={overview.countsByStatus.CANCELLED} />
        <StatTile label={t("stats.totalStudents")} value={overview.totalStudents} />
        <StatTile label={t("stats.newThisMonth")} value={overview.newOrganizationsThisMonth} />
      </StatRow>

      <Card>
        <CardContent>
          <h2 className="mb-3 text-sm font-semibold">{t("attendanceTrend.heading")}</h2>
          <WeeklyAttendanceChart
            data={trend}
            emptyMessage={t("attendanceTrend.empty")}
            countLabel={t("attendanceTrend.countLabel")}
          />
        </CardContent>
      </Card>
    </>
  );
}
