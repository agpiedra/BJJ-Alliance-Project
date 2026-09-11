"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { cn } from "cn";
import type { ClassType } from "@/generated/prisma/client";
// Type-only import: `class-popularity.ts` also exports `getClassPopularity`,
// which transitively imports `@/lib/prisma` — a VALUE import of anything
// from that module here would bundle Prisma's client into the browser
// build. `sessionsInRange`/`trendPercent`/`growthEntries`/`atRiskRows` are
// therefore all computed server-side in page.tsx and handed down as plain
// data, the same Server -> Client boundary discipline this file's sibling
// panels already apply to Luxon `DateTime` fields.
import type { ClassGrowthEntry, ClassPopularityRow } from "@/lib/analytics/class-popularity";
import { Card, CardHeader, CardTitle, CardAction, CardContent } from "@/components/ui/card";
import { BarList, type BarListItem } from "@/components/ui/bar-list";
import { Pill } from "@/components/ui/pill";
import { EmptyState } from "@/components/ui/empty-state";
import { Button } from "@/components/ui/button";
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

/** §4.3 Task 3: "BarList, top 12... with a 'Ver las N clases' expand
 * control". The Detalle-por-clase table below is never truncated — a
 * DataTable already scrolls/paginates visually better than a bar list does
 * past a handful of rows, so only the BarList needs the show-more toggle. */
const TOP_BAR_LIST_COUNT = 12;

const CLASS_TYPE_COLOR_CLASS: Record<ClassType, string> = {
  GI: "bg-class-gi",
  NO_GI: "bg-class-nogi",
  STRIKING: "bg-class-strike",
  KIDS: "bg-class-kids",
  OPEN_MAT: "bg-class-open",
  COMPETITION: "bg-class-comp",
};

export type ClassPopularityPanelRow = ClassPopularityRow & {
  /** How many times this weekly slot actually occurred within the selected
   * range — `countWeekdayOccurrences`, computed in page.tsx. Denominator for
   * "promedio por sesión"; `0` renders as "—" (a range shorter than the
   * class's own weekday). */
  sessionsInRange: number;
  /** `computeTrendPercent`, computed in page.tsx. `null` = no previous-
   * period data to compare against ("Nuevo" instead of a percentage). */
  trendPercent: number | null;
};

function ModalityLabel({ type }: { type: ClassType }) {
  const t = useTranslations("classType");
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
      <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", CLASS_TYPE_COLOR_CLASS[type])} />
      {t(type)}
    </span>
  );
}

/**
 * §4.3 Task 5: "tendencia pill with a real percentage — not an arrow glyph."
 * The percentage text itself carries the status (Rule 7: status conveyed by
 * text as well as color), so no separate arrow/word is layered on top of it.
 */
function TrendPill({ percent }: { percent: number | null }) {
  const t = useTranslations("dashboard.analytics.classPopularity");
  if (percent === null) {
    return <Pill variant="plain">{t("trendNew")}</Pill>;
  }
  if (percent === 0) {
    return <Pill variant="plain">{t("trend.flat")}</Pill>;
  }
  const formatted = new Intl.NumberFormat(undefined, { signDisplay: "exceptZero" }).format(percent);
  return <Pill variant={percent > 0 ? "ok" : "bad"}>{`${formatted}%`}</Pill>;
}

/** §4.3 Task 4: "Mayor crecimiento" — key/value list, +green / -red. */
function GrowthList({ entries }: { entries: ClassGrowthEntry[] }) {
  const t = useTranslations("dashboard.analytics.classPopularity.growth");

  return (
    <Card>
      <CardHeader className="border-b">
        <CardTitle>{t("heading")}</CardTitle>
      </CardHeader>
      <CardContent>
        {entries.length === 0 ? (
          <EmptyState message={t("empty")} />
        ) : (
          <ul className="flex flex-col divide-y divide-border">
            {entries.map((entry) => (
              <li
                key={entry.classSessionId}
                className="flex items-center justify-between gap-3 py-2 text-sm first:pt-0 last:pb-0"
              >
                <span className="min-w-0 flex-1 truncate">{entry.label}</span>
                <span
                  className={cn(
                    "shrink-0 font-mono text-xs font-medium tabular-nums",
                    entry.diff > 0 ? "text-ok" : "text-bad",
                  )}
                >
                  {new Intl.NumberFormat(undefined, { signDisplay: "exceptZero" }).format(entry.diff)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

/** §4.3 Task 4: "Clases en riesgo" — classes under the threshold, as Pills. */
function AtRiskList({ rows, threshold }: { rows: ClassPopularityRow[]; threshold: number }) {
  const t = useTranslations("dashboard.analytics.classPopularity.risk");

  return (
    <Card>
      <CardHeader className="border-b">
        <CardTitle>{t("heading")}</CardTitle>
        <CardAction className="text-xs text-muted-foreground">{t("caption", { count: threshold })}</CardAction>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <EmptyState message={t("empty")} />
        ) : (
          <div className="flex flex-wrap gap-2">
            {rows.map((row) => (
              <Pill key={row.classSessionId} variant="warn">
                {row.label} · {row.attendances}
              </Pill>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Class popularity panel (REDESIGN_BRIEF.md §4.3) — BarList (top 12 +
 * expand), the "Mayor crecimiento"/"Clases en riesgo" side column, and the
 * "Detalle por clase" table, all derived from the same `getClassPopularity`
 * result. `rows`/`growthEntries`/`atRiskRows` are server-fetched/derived
 * (the page's own `requireStaffSession(["ADMIN", "DIRECTOR"])` +
 * `getClassPopularity`'s self-enforced role gate are the real access
 * control — this component just renders whatever it's handed).
 */
export function ClassPopularityPanel({
  rows,
  growthEntries,
  atRiskRows,
  atRiskThreshold,
}: {
  rows: ClassPopularityPanelRow[];
  growthEntries: ClassGrowthEntry[];
  atRiskRows: ClassPopularityRow[];
  atRiskThreshold: number;
}) {
  const t = useTranslations("dashboard.analytics.classPopularity");
  const tType = useTranslations("classType");
  const [expanded, setExpanded] = useState(false);

  if (rows.length === 0) {
    return (
      <section className="flex flex-col gap-3">
        <h2 className="font-heading text-lg font-semibold">{t("heading")}</h2>
        <Card>
          <CardContent>
            <EmptyState message={t("empty")} />
          </CardContent>
        </Card>
      </section>
    );
  }

  const visibleRows = expanded ? rows : rows.slice(0, TOP_BAR_LIST_COUNT);
  const barItems: BarListItem[] = visibleRows.map((row) => ({
    key: row.classSessionId,
    label: row.label,
    value: row.attendances,
  }));

  const csvRows = rows.map((row) => ({
    [t("csv.class")]: row.label,
    [t("csv.modality")]: tType(row.type),
    [t("csv.attendances")]: row.attendances,
    [t("csv.previousAttendances")]: row.previousAttendances,
    [t("csv.sessionsAverage")]:
      row.sessionsInRange > 0 ? (row.attendances / row.sessionsInRange).toFixed(1) : "—",
    [t("csv.trend")]: row.trendPercent === null ? t("trendNew") : `${row.trendPercent}%`,
  }));

  return (
    <section className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[7fr_5fr]">
        <Card>
          <CardHeader className="border-b">
            <CardTitle>{t("heading")}</CardTitle>
            <CardAction>
              <ExportCsvButton rows={csvRows} filename="analytics-class-popularity.csv" />
            </CardAction>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <BarList items={barItems} />
            {rows.length > TOP_BAR_LIST_COUNT && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="self-start"
                onClick={() => setExpanded((value) => !value)}
              >
                {expanded ? t("showLess") : t("showAll", { count: rows.length })}
              </Button>
            )}
          </CardContent>
        </Card>

        <div className="flex flex-col gap-4">
          <GrowthList entries={growthEntries} />
          <AtRiskList rows={atRiskRows} threshold={atRiskThreshold} />
        </div>
      </div>

      <Card>
        <CardHeader className="border-b">
          <CardTitle>{t("table.heading")}</CardTitle>
        </CardHeader>
        <CardContent>
          <DataTable>
            <DataTableHead>
              <DataTableHeaderRow>
                <DataTableHeaderCell>{t("table.rank")}</DataTableHeaderCell>
                <DataTableHeaderCell>{t("table.class")}</DataTableHeaderCell>
                <DataTableHeaderCell>{t("table.modality")}</DataTableHeaderCell>
                <DataTableHeaderCell className="text-right">{t("table.attendances")}</DataTableHeaderCell>
                <DataTableHeaderCell className="text-right">
                  {t("table.previousAttendances")}
                </DataTableHeaderCell>
                <DataTableHeaderCell className="text-right">{t("table.sessionsAverage")}</DataTableHeaderCell>
                <DataTableHeaderCell>{t("table.trend")}</DataTableHeaderCell>
              </DataTableHeaderRow>
            </DataTableHead>
            <DataTableBody>
              {rows.map((row, index) => (
                <DataTableRow key={row.classSessionId}>
                  <DataTableCell className="tabular-nums text-muted-foreground">{index + 1}</DataTableCell>
                  <DataTableCell className="font-medium">{row.label}</DataTableCell>
                  <DataTableCell>
                    <ModalityLabel type={row.type} />
                  </DataTableCell>
                  <DataTableCell className="text-right tabular-nums">{row.attendances}</DataTableCell>
                  <DataTableCell className="text-right tabular-nums text-muted-foreground">
                    {row.previousAttendances}
                  </DataTableCell>
                  <DataTableCell className="text-right tabular-nums text-muted-foreground">
                    {row.sessionsInRange > 0 ? (row.attendances / row.sessionsInRange).toFixed(1) : "—"}
                  </DataTableCell>
                  <DataTableCell>
                    <TrendPill percent={row.trendPercent} />
                  </DataTableCell>
                </DataTableRow>
              ))}
            </DataTableBody>
          </DataTable>
        </CardContent>
      </Card>
    </section>
  );
}
