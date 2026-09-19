"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { EmptyState } from "@/components/ui/empty-state";
import { Button } from "@/components/ui/button";
import {
  DataTable,
  DataTableHead,
  DataTableHeaderRow,
  DataTableHeaderCell,
  DataTableBody,
  DataTableRow,
  DataTableCell,
} from "@/components/ui/data-table";
// Type-only: class-popularity.ts also exports getClassPopularity/
// getAttendanceByClass, which transitively import @/lib/prisma — a value
// import here would bundle Prisma's client into the browser build. Same
// Server -> Client boundary class-popularity-panel.tsx already applies.
import type { AttendanceByClassRow } from "@/lib/analytics/class-popularity";

/**
 * MULTI_ACADEMY_AND_KIDS_BELTS.md Phase 8 — the Panel companion to
 * WeeklyAttendanceChart, sharing that chart's own fixed window (no range
 * control on Panel — see this phase's own doc note). Deliberately plain
 * divs, not recharts: this codebase's only recharts usage
 * (WeeklyAttendanceChart) is a continuous line/area, and every existing
 * categorical ranking (BarList, used by class-popularity and belt
 * distribution) is already a div/CSS-grid bar — that, extended, is the
 * established convention for "ranked bars," not a new SVG axis. Div bars
 * also sidestep recharts' own category-axis width problem at phone width,
 * which is exactly what "long class names render fully, unrotated and
 * untruncated" (this phase's own acceptance criterion) rules out fighting.
 *
 * Top 10 by default (doc: "do not render 30 bars by default"), with a
 * "ver todas" expansion — the same pattern class-popularity-panel.tsx
 * already uses for its own top-12 BarList, at doc-specified 10 here.
 *
 * Single color (`bg-data` — never `bg-brand-gold`; see globals.css's own
 * comment on that token). Bars scale relative to the largest VISIBLE bar,
 * same convention BarList uses; share% is computed against the total
 * across ALL classes, not just the visible top N, so expanding the list
 * never changes an already-shown bar's own share figure.
 *
 * Accessibility: an explicit table-view toggle (not a hidden sr-only twin
 * nobody can navigate to) gives a keyboard/screen-reader user the exact
 * same class/count/share data a sighted mouse user gets from hovering a
 * bar's native `title` tooltip — never color-only identity.
 */

const TOP_N = 10;

export function AttendanceByClassChart({ rows, emptyMessage }: { rows: AttendanceByClassRow[]; emptyMessage: string }) {
  const t = useTranslations("dashboard.panel.attendanceByClass");
  const [expanded, setExpanded] = useState(false);
  const [viewAsTable, setViewAsTable] = useState(false);

  // Rule 4: never render an empty/all-zero chart.
  const hasSignal = rows.some((row) => row.attendances > 0);
  if (rows.length === 0 || !hasSignal) {
    return <EmptyState message={emptyMessage} />;
  }

  const total = rows.reduce((sum, row) => sum + row.attendances, 0);
  const visibleRows = expanded ? rows : rows.slice(0, TOP_N);
  // Sorted descending on the way in (class-popularity.ts's own contract),
  // so the first visible row is always the max among them.
  const scaleMax = Math.max(1, visibleRows[0]?.attendances ?? 1);
  const shareOf = (attendances: number) => (total > 0 ? Math.round((attendances / total) * 100) : 0);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex justify-end">
        <Button type="button" variant="ghost" size="sm" onClick={() => setViewAsTable((v) => !v)}>
          {t(viewAsTable ? "viewAsChart" : "viewAsTable")}
        </Button>
      </div>

      {viewAsTable ? (
        <DataTable>
          <DataTableHead>
            <DataTableHeaderRow>
              <DataTableHeaderCell>{t("table.class")}</DataTableHeaderCell>
              <DataTableHeaderCell>{t("table.attendances")}</DataTableHeaderCell>
              <DataTableHeaderCell>{t("table.share")}</DataTableHeaderCell>
            </DataTableHeaderRow>
          </DataTableHead>
          <DataTableBody>
            {visibleRows.map((row) => (
              <DataTableRow key={row.classSessionId}>
                <DataTableCell>{row.label}</DataTableCell>
                <DataTableCell className="font-mono tabular-nums">{row.attendances}</DataTableCell>
                <DataTableCell className="font-mono tabular-nums">{shareOf(row.attendances)}%</DataTableCell>
              </DataTableRow>
            ))}
          </DataTableBody>
        </DataTable>
      ) : (
        <div className="flex flex-col gap-3">
          {visibleRows.map((row) => {
            const pct = (row.attendances / scaleMax) * 100;
            const share = shareOf(row.attendances);
            return (
              <div key={row.classSessionId} className="flex flex-col gap-1">
                <span className="text-sm">{row.label}</span>
                <div className="flex items-center gap-2">
                  <div
                    role="img"
                    aria-label={t("shareOfTotal", { percent: share }) + ` — ${row.label}: ${row.attendances}`}
                    title={`${row.label}: ${row.attendances} (${t("shareOfTotal", { percent: share })})`}
                    className="h-2 flex-1 overflow-hidden rounded-sm bg-muted"
                  >
                    <div className="h-full rounded-r-[4px] bg-data" style={{ width: `${pct}%` }} />
                  </div>
                  <span className="w-10 shrink-0 text-right font-mono text-xs tabular-nums text-muted-foreground">
                    {row.attendances}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {rows.length > TOP_N && (
        <Button type="button" variant="ghost" size="sm" onClick={() => setExpanded((v) => !v)} className="self-start">
          {expanded ? t("showLess") : t("showAll", { count: rows.length })}
        </Button>
      )}
    </div>
  );
}
