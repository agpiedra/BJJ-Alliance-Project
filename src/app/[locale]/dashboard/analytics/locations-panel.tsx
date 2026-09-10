"use client";

import { useTranslations } from "next-intl";
import type { LocationComparisonRow, CrossTrainingEntry } from "@/lib/analytics/locations";
import { ExportCsvButton } from "./export-csv-button";

/**
 * Locations panel (Phase 7 §4 Task 4, "Locations (admin only)") — side-by-
 * side per-academy comparison plus a cross-training list. `rows`/`entries`
 * are server-fetched (the page only fetches/renders this panel for an ADMIN
 * session — `getLocationComparison`/`getCrossTraining`'s own self-enforced
 * ADMIN-only gate is the real access control, this component just renders
 * whatever it's handed).
 */
export function LocationsPanel({
  comparison,
  crossTraining,
}: {
  comparison: LocationComparisonRow[];
  crossTraining: CrossTrainingEntry[];
}) {
  return (
    <section className="flex flex-col gap-8">
      <LocationComparisonPanel rows={comparison} />
      <CrossTrainingPanel entries={crossTraining} />
    </section>
  );
}

function LocationComparisonPanel({ rows }: { rows: LocationComparisonRow[] }) {
  const t = useTranslations("dashboard.analytics.locations.comparison");

  const csvRows = rows.map((row) => ({
    [t("csv.academy")]: row.academyName,
    [t("csv.activeStudents")]: row.activeStudents,
    [t("csv.totalAttendances")]: row.totalAttendances,
    [t("csv.avgPerClass")]: row.avgPerClass.toFixed(1),
    [t("csv.paymentHealthPercent")]: `${row.paymentHealthPercent}%`,
  }));

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-medium">{t("heading")}</h2>
        <ExportCsvButton rows={csvRows} filename="analytics-locations-comparison.csv" />
      </div>

      {rows.length === 0 ? (
        <p className="text-muted-foreground">{t("empty")}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b">
                <th className="py-2 pr-4">{t("table.academy")}</th>
                <th className="py-2 pr-4">{t("table.activeStudents")}</th>
                <th className="py-2 pr-4">{t("table.totalAttendances")}</th>
                <th className="py-2 pr-4">{t("table.avgPerClass")}</th>
                <th className="py-2 pr-4">{t("table.paymentHealthPercent")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.academyId} className="border-b">
                  <td className="py-2 pr-4 font-medium">{row.academyName}</td>
                  <td className="py-2 pr-4">{row.activeStudents}</td>
                  <td className="py-2 pr-4">{row.totalAttendances}</td>
                  <td className="py-2 pr-4">{row.avgPerClass.toFixed(1)}</td>
                  <td className="py-2 pr-4">{row.paymentHealthPercent}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function CrossTrainingPanel({ entries }: { entries: CrossTrainingEntry[] }) {
  const t = useTranslations("dashboard.analytics.locations.crossTraining");

  const csvRows = entries.map((entry) => ({
    [t("csv.student")]: entry.studentName,
    [t("csv.homeAcademy")]: entry.homeAcademyName,
    [t("csv.visitedAcademy")]: entry.visitedAcademyName,
    [t("csv.visitCount")]: entry.visitCount,
  }));

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-medium">{t("heading")}</h2>
        <ExportCsvButton rows={csvRows} filename="analytics-locations-cross-training.csv" />
      </div>

      {entries.length === 0 ? (
        <p className="text-muted-foreground">{t("empty")}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {entries.map((entry) => (
            <li
              key={`${entry.studentId}-${entry.visitedAcademyName}`}
              className="flex flex-wrap items-baseline gap-x-2 border-b py-2 text-sm"
            >
              <span className="font-medium">{entry.studentName}</span>
              <span className="text-muted-foreground">
                {t("summary", {
                  home: entry.homeAcademyName,
                  visited: entry.visitedAcademyName,
                  count: entry.visitCount,
                })}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
