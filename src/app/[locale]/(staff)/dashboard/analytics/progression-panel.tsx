"use client";

import { useLocale, useTranslations } from "next-intl";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { BeltGraphic } from "@/components/belt-graphic/belt-graphic";
import { formatTimestampInAcademyZone } from "@/lib/format-date";
import type { BeltDistributionRow, ProgressionPlanningRow, PromotionInRangeRow } from "@/lib/analytics/progression";
import { ExportCsvButton } from "./export-csv-button";

// `projectedDate`/`awardedAt` are Luxon `DateTime` instances in the lib
// layer — not plain-serializable across the Server -> Client Component
// boundary, so `page.tsx` converts them to ISO strings before handing rows
// to this component (same reasoning `filters.from.toISODate()` already
// applies for the date-range inputs above).
export type ProgressionPlanningPanelRow = Omit<ProgressionPlanningRow, "projectedDate"> & {
  projectedDate: string | null;
};
export type PromotionInRangePanelRow = Omit<PromotionInRangeRow, "awardedAt"> & { awardedAt: string };

/**
 * Progression panel (Phase 7 §4 Task 3): three sub-panels sharing one
 * section — planning list, belt distribution, promotions in range. `rows`
 * are server-fetched (the page's own `requireStaffSession(["ADMIN",
 * "DIRECTOR"])` + each `progression.ts` function's self-enforced role gate
 * are the real access control — this component just renders whatever it's
 * handed).
 */
export function ProgressionPanel({
  planningList,
  beltDistribution,
  promotionsInRange,
}: {
  planningList: ProgressionPlanningPanelRow[];
  beltDistribution: BeltDistributionRow[];
  promotionsInRange: PromotionInRangePanelRow[];
}) {
  return (
    <section className="flex flex-col gap-8">
      <PlanningListPanel rows={planningList} />
      <BeltDistributionPanel rows={beltDistribution} />
      <PromotionsInRangePanel rows={promotionsInRange} />
    </section>
  );
}

function PlanningListPanel({ rows }: { rows: ProgressionPlanningPanelRow[] }) {
  const t = useTranslations("dashboard.analytics.progression.planningList");
  const tBelt = useTranslations("belt");
  const locale = useLocale();

  const formatProjectedDate = (iso: string | null) =>
    iso ? (formatTimestampInAcademyZone(new Date(iso), locale) ?? "—") : "—";

  const csvRows = rows.map((row) => ({
    [t("csv.name")]: `${row.firstName} ${row.lastName}`,
    [t("csv.belt")]: `${tBelt(row.currentBelt)} ${row.currentStripes}`,
    [t("csv.atBeltCount")]: row.atBeltCount,
    [t("csv.remainingToNextStripe")]: row.remainingToNextStripe ?? "—",
    [t("csv.projectedDate")]: formatProjectedDate(row.projectedDate),
  }));

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-medium">{t("heading")}</h2>
        <ExportCsvButton rows={csvRows} filename="analytics-progression-planning-list.csv" />
      </div>

      {rows.length === 0 ? (
        <p className="text-muted-foreground">{t("empty")}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b">
                <th className="py-2 pr-4">{t("table.name")}</th>
                <th className="py-2 pr-4">{t("table.belt")}</th>
                <th className="py-2 pr-4">{t("table.atBeltCount")}</th>
                <th className="py-2 pr-4">{t("table.remainingToNextStripe")}</th>
                <th className="py-2 pr-4">{t("table.projectedDate")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.studentId} className="border-b">
                  <td className="py-2 pr-4">
                    {row.firstName} {row.lastName}
                  </td>
                  <td className="py-2 pr-4">
                    <BeltGraphic belt={row.currentBelt} stripes={row.currentStripes} />
                  </td>
                  <td className="py-2 pr-4">{row.atBeltCount}</td>
                  <td className="py-2 pr-4">{row.remainingToNextStripe ?? "—"}</td>
                  <td className="py-2 pr-4">{formatProjectedDate(row.projectedDate)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/**
 * A bar chart (spec leaves the chart type open) — five categories with a
 * strict order (belt progression), which a bar chart's fixed x-axis
 * communicates more directly than a pie's arbitrary wedge ordering, and
 * stays readable even when one belt's count dwarfs the others (a common
 * shape here: far more WHITE than BLACK).
 */
function BeltDistributionPanel({ rows }: { rows: BeltDistributionRow[] }) {
  const t = useTranslations("dashboard.analytics.progression.beltDistribution");
  const tBelt = useTranslations("belt");

  const chartRows = rows.map((row) => ({ ...row, label: tBelt(row.belt) }));
  const csvRows = rows.map((row) => ({
    [t("csv.belt")]: tBelt(row.belt),
    [t("csv.count")]: row.count,
  }));

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-medium">{t("heading")}</h2>
        <ExportCsvButton rows={csvRows} filename="analytics-progression-belt-distribution.csv" />
      </div>

      <div className="h-72 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={chartRows} margin={{ top: 8, right: 8, bottom: 8, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis dataKey="label" />
            <YAxis allowDecimals={false} />
            <Tooltip />
            <Bar dataKey="count" name={t("chart.count")} fill="#2563eb" />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function PromotionsInRangePanel({ rows }: { rows: PromotionInRangePanelRow[] }) {
  const t = useTranslations("dashboard.analytics.progression.promotionsInRange");
  const tBelt = useTranslations("belt");
  const locale = useLocale();

  const csvRows = rows.map((row) => ({
    [t("csv.date")]: formatTimestampInAcademyZone(new Date(row.awardedAt), locale) ?? "",
    [t("csv.name")]: `${row.firstName} ${row.lastName}`,
    [t("csv.change")]: `${tBelt(row.fromBelt)} ${row.fromStripes} -> ${tBelt(row.toBelt)} ${row.toStripes}`,
  }));

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-medium">{t("heading")}</h2>
        <ExportCsvButton rows={csvRows} filename="analytics-progression-promotions.csv" />
      </div>

      {rows.length === 0 ? (
        <p className="text-muted-foreground">{t("empty")}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {rows.map((row) => (
            <li key={row.promotionId} className="flex flex-wrap items-baseline gap-x-2 border-b py-2 text-sm">
              <span className="text-muted-foreground">
                {formatTimestampInAcademyZone(new Date(row.awardedAt), locale)}
              </span>
              <span className="font-medium">
                {row.firstName} {row.lastName}
              </span>
              <span>
                {tBelt(row.fromBelt)} {row.fromStripes} → {tBelt(row.toBelt)} {row.toStripes}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
