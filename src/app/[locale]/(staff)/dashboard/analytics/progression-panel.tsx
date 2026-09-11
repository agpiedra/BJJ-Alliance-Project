"use client";

import { useLocale, useTranslations } from "next-intl";
import { BeltGraphic } from "@/components/belt-graphic/belt-graphic";
import { formatTimestampInAcademyZone } from "@/lib/format-date";
import type { BeltDistributionRow, ProgressionPlanningRow, PromotionInRangeRow } from "@/lib/analytics/progression";
import { Card, CardHeader, CardTitle, CardAction, CardContent } from "@/components/ui/card";
import { BarList, type BarListItem } from "@/components/ui/bar-list";
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
import type { Belt } from "@/generated/prisma/client";

// `projectedDate`/`awardedAt` are Luxon `DateTime` instances in the lib
// layer — not plain-serializable across the Server -> Client Component
// boundary, so `page.tsx` converts them to ISO strings before handing rows
// to this component (same reasoning `filters.from.toISODate()` already
// applies for the date-range inputs above).
export type ProgressionPlanningPanelRow = Omit<ProgressionPlanningRow, "projectedDate"> & {
  projectedDate: string | null;
};
export type PromotionInRangePanelRow = Omit<PromotionInRangeRow, "awardedAt"> & { awardedAt: string };

// Same belt -> Tailwind-token map dashboard/page.tsx already established for
// its own belt-distribution BarList (bar-list.tsx's own doc comment names
// "belt distribution" as one of BarList's two exemplar uses) — duplicated
// here rather than imported, since dashboard/page.tsx doesn't export it and
// is explicitly out of scope for this phase to edit.
const BELT_BAR_COLOR_CLASS: Record<Belt, string> = {
  WHITE: "bg-belt-white",
  BLUE: "bg-belt-blue",
  PURPLE: "bg-belt-purple",
  BROWN: "bg-belt-brown",
  BLACK: "bg-belt-black",
};

/**
 * Progression panel (§4.3-adjacent restyle of the analytics page's Phase 7
 * §4 Task 3 panel): three sub-panels sharing one section — planning list,
 * belt distribution, promotions in range. `rows` are server-fetched (the
 * page's own `requireStaffSession(["ADMIN", "DIRECTOR"])` + each
 * `progression.ts` function's self-enforced role gate are the real access
 * control — this component just renders whatever it's handed).
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
    <section className="flex flex-col gap-4">
      <PlanningListPanel rows={planningList} />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[7fr_5fr]">
        <BeltDistributionPanel rows={beltDistribution} />
        <PromotionsInRangePanel rows={promotionsInRange} />
      </div>
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
    <Card>
      <CardHeader className="border-b">
        <CardTitle>{t("heading")}</CardTitle>
        <CardAction>
          <ExportCsvButton rows={csvRows} filename="analytics-progression-planning-list.csv" />
        </CardAction>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <EmptyState message={t("empty")} />
        ) : (
          <DataTable>
            <DataTableHead>
              <DataTableHeaderRow>
                <DataTableHeaderCell>{t("table.name")}</DataTableHeaderCell>
                <DataTableHeaderCell>{t("table.belt")}</DataTableHeaderCell>
                <DataTableHeaderCell className="text-right">{t("table.atBeltCount")}</DataTableHeaderCell>
                <DataTableHeaderCell className="text-right">
                  {t("table.remainingToNextStripe")}
                </DataTableHeaderCell>
                <DataTableHeaderCell>{t("table.projectedDate")}</DataTableHeaderCell>
              </DataTableHeaderRow>
            </DataTableHead>
            <DataTableBody>
              {rows.map((row) => (
                <DataTableRow key={row.studentId}>
                  <DataTableCell className="font-medium">
                    {row.firstName} {row.lastName}
                  </DataTableCell>
                  <DataTableCell>
                    <BeltGraphic belt={row.currentBelt} stripes={row.currentStripes} />
                  </DataTableCell>
                  <DataTableCell className="text-right tabular-nums">{row.atBeltCount}</DataTableCell>
                  <DataTableCell className="text-right tabular-nums text-muted-foreground">
                    {row.remainingToNextStripe ?? "—"}
                  </DataTableCell>
                  <DataTableCell className="text-muted-foreground">
                    {formatProjectedDate(row.projectedDate)}
                  </DataTableCell>
                </DataTableRow>
              ))}
            </DataTableBody>
          </DataTable>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * A `BarList`, in belt-progression order (a strict, meaningful order a
 * ranked-by-count bar list would scramble) — matching dashboard/page.tsx's
 * own belt-distribution treatment (bar-list.tsx's doc comment names "belt
 * distribution" as one of BarList's two intended uses, alongside class
 * popularity), rather than this panel's previous, separate recharts bar
 * chart with a hardcoded `fill="#2563eb"` (Rule 1 violation).
 */
function BeltDistributionPanel({ rows }: { rows: BeltDistributionRow[] }) {
  const t = useTranslations("dashboard.analytics.progression.beltDistribution");
  const tBelt = useTranslations("belt");

  const hasData = rows.some((row) => row.count > 0);
  const barItems: BarListItem[] = rows.map((row) => ({
    key: row.belt,
    label: tBelt(row.belt),
    value: row.count,
    colorClassName: BELT_BAR_COLOR_CLASS[row.belt],
  }));
  const csvRows = rows.map((row) => ({
    [t("csv.belt")]: tBelt(row.belt),
    [t("csv.count")]: row.count,
  }));

  return (
    <Card>
      <CardHeader className="border-b">
        <CardTitle>{t("heading")}</CardTitle>
        <CardAction>
          <ExportCsvButton rows={csvRows} filename="analytics-progression-belt-distribution.csv" />
        </CardAction>
      </CardHeader>
      <CardContent>
        {/* Rule 4: never render an empty chart — an all-zero distribution
            (e.g. a brand-new academy, or a date range with no promotions)
            gets the empty state instead of a technically-non-empty but
            meaningless all-zero bar list. */}
        {hasData ? <BarList items={barItems} /> : <EmptyState message={t("empty")} />}
      </CardContent>
    </Card>
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
    <Card>
      <CardHeader className="border-b">
        <CardTitle>{t("heading")}</CardTitle>
        <CardAction>
          <ExportCsvButton rows={csvRows} filename="analytics-progression-promotions.csv" />
        </CardAction>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <EmptyState message={t("empty")} />
        ) : (
          <ul className="flex flex-col divide-y divide-border">
            {rows.map((row) => (
              <li key={row.promotionId} className="flex flex-wrap items-baseline gap-x-2 py-2 text-sm first:pt-0 last:pb-0">
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
      </CardContent>
    </Card>
  );
}
