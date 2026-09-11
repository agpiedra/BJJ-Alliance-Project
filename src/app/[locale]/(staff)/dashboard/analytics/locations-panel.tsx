"use client";

import { useTranslations } from "next-intl";
import type { LocationComparisonRow, CrossTrainingEntry } from "@/lib/analytics/locations";
import { Card, CardHeader, CardTitle, CardAction, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import {
  DataTable,
  DataTableBody,
  DataTableCell,
  DataTableHead,
  DataTableHeaderCell,
  DataTableHeaderRow,
  DataTableRow,
} from "@/components/ui/data-table";
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
    <section className="grid grid-cols-1 gap-4 lg:grid-cols-[7fr_5fr]">
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
    <Card>
      <CardHeader className="border-b">
        <CardTitle>{t("heading")}</CardTitle>
        <CardAction>
          <ExportCsvButton rows={csvRows} filename="analytics-locations-comparison.csv" />
        </CardAction>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <EmptyState message={t("empty")} />
        ) : (
          <DataTable>
            <DataTableHead>
              <DataTableHeaderRow>
                <DataTableHeaderCell>{t("table.academy")}</DataTableHeaderCell>
                <DataTableHeaderCell className="text-right">{t("table.activeStudents")}</DataTableHeaderCell>
                <DataTableHeaderCell className="text-right">{t("table.totalAttendances")}</DataTableHeaderCell>
                <DataTableHeaderCell className="text-right">{t("table.avgPerClass")}</DataTableHeaderCell>
                <DataTableHeaderCell className="text-right">
                  {t("table.paymentHealthPercent")}
                </DataTableHeaderCell>
              </DataTableHeaderRow>
            </DataTableHead>
            <DataTableBody>
              {rows.map((row) => (
                <DataTableRow key={row.academyId}>
                  <DataTableCell className="font-medium">{row.academyName}</DataTableCell>
                  <DataTableCell className="text-right tabular-nums">{row.activeStudents}</DataTableCell>
                  <DataTableCell className="text-right tabular-nums">{row.totalAttendances}</DataTableCell>
                  <DataTableCell className="text-right tabular-nums">{row.avgPerClass.toFixed(1)}</DataTableCell>
                  <DataTableCell className="text-right tabular-nums">{row.paymentHealthPercent}%</DataTableCell>
                </DataTableRow>
              ))}
            </DataTableBody>
          </DataTable>
        )}
      </CardContent>
    </Card>
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
    <Card>
      <CardHeader className="border-b">
        <CardTitle>{t("heading")}</CardTitle>
        <CardAction>
          <ExportCsvButton rows={csvRows} filename="analytics-locations-cross-training.csv" />
        </CardAction>
      </CardHeader>
      <CardContent>
        {entries.length === 0 ? (
          <EmptyState message={t("empty")} />
        ) : (
          <ul className="flex flex-col divide-y divide-border">
            {entries.map((entry) => (
              <li
                key={`${entry.studentId}-${entry.visitedAcademyName}`}
                className="flex flex-wrap items-baseline gap-x-2 py-2 text-sm first:pt-0 last:pb-0"
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
      </CardContent>
    </Card>
  );
}
