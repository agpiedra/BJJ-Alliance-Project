"use client";

import { useLocale, useTranslations } from "next-intl";
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { formatTimestampInAcademyZone } from "@/lib/format-date";
import type { RetentionEntry } from "@/lib/analytics/retention";
import { Card, CardHeader, CardTitle, CardAction, CardContent } from "@/components/ui/card";
import { Pill } from "@/components/ui/pill";
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

// `lastSeenAt` is a plain `Date | null` in the lib layer, but `page.tsx`
// still converts it to an ISO string before handing rows to this "use
// client" component — the same Server -> Client boundary discipline
// `progression-panel.tsx`'s `projectedDate`/`awardedAt` already follow,
// applied here too rather than assumed safe just because `Date` (unlike a
// Luxon `DateTime`) happens to serialize.
export type RetentionEntryPanelRow = Omit<RetentionEntry, "lastSeenAt"> & { lastSeenAt: string | null };

const BUCKET_PILL_VARIANT = {
  "30": "warn",
  "60": "warn",
  "90": "bad",
} as const;

/**
 * Retention panel (Phase 7 §4 Task 5) — visible to BOTH ADMIN and DIRECTOR
 * (unlike the locations panel, this one is never admin-only: spec's plain
 * intent is "so the director can actually reach out", and phone numbers are
 * shown with no extra role gate beyond the page's own ADMIN/DIRECTOR check
 * — `getRetentionList`/`getWeeklyAttendanceTrend`'s self-enforced gate is
 * the real access control, this component just renders whatever it's
 * handed).
 *
 * The list is pre-sorted worst-first by `getRetentionList` (bucket "90"
 * before "60" before "30"); this component renders it in that order rather
 * than re-sorting or re-grouping.
 */
export function RetentionPanel({
  entries,
  weeklyTrend,
}: {
  entries: RetentionEntryPanelRow[];
  weeklyTrend: Array<{ weekStart: string; count: number }>;
}) {
  const t = useTranslations("dashboard.analytics.retention");
  const tBucket = useTranslations("dashboard.analytics.retention.list.bucket");
  const locale = useLocale();

  const formatLastSeen = (iso: string | null) =>
    iso ? (formatTimestampInAcademyZone(new Date(iso), locale) ?? "—") : t("list.neverAttended");

  const csvRows = entries.map((entry) => ({
    [t("list.csv.name")]: entry.name,
    [t("list.csv.phone")]: entry.phone,
    [t("list.csv.lastSeenAt")]: formatLastSeen(entry.lastSeenAt),
    [t("list.csv.bucket")]: tBucket(entry.bucket),
  }));

  // Rule 4: never render an empty/flat chart — a selection with no
  // attendance signal at all across the whole 8-week trend gets the empty
  // state instead (this check was previously missing here, unlike the
  // dashboard page's own equivalent `WeeklyAttendanceChart`, which already
  // guards on the same `some(count > 0)` condition).
  const trendHasSignal = weeklyTrend.some((point) => point.count > 0);

  return (
    <section className="flex flex-col gap-4">
      <Card>
        <CardHeader className="border-b">
          <CardTitle>{t("list.heading")}</CardTitle>
          <CardAction>
            <ExportCsvButton rows={csvRows} filename="analytics-retention.csv" />
          </CardAction>
        </CardHeader>
        <CardContent>
          {entries.length === 0 ? (
            <EmptyState message={t("list.empty")} />
          ) : (
            <DataTable>
              <DataTableHead>
                <DataTableHeaderRow>
                  <DataTableHeaderCell>{t("list.table.name")}</DataTableHeaderCell>
                  <DataTableHeaderCell>{t("list.table.phone")}</DataTableHeaderCell>
                  <DataTableHeaderCell>{t("list.table.lastSeenAt")}</DataTableHeaderCell>
                  <DataTableHeaderCell>{t("list.table.bucket")}</DataTableHeaderCell>
                </DataTableHeaderRow>
              </DataTableHead>
              <DataTableBody>
                {entries.map((entry) => (
                  <DataTableRow key={entry.studentId}>
                    <DataTableCell className="font-medium">{entry.name}</DataTableCell>
                    <DataTableCell className="text-muted-foreground">{entry.phone}</DataTableCell>
                    <DataTableCell>{formatLastSeen(entry.lastSeenAt)}</DataTableCell>
                    <DataTableCell>
                      <Pill variant={BUCKET_PILL_VARIANT[entry.bucket]}>{tBucket(entry.bucket)}</Pill>
                    </DataTableCell>
                  </DataTableRow>
                ))}
              </DataTableBody>
            </DataTable>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="border-b">
          <CardTitle>{t("trend.heading")}</CardTitle>
          <CardAction className="text-xs text-muted-foreground">{t("trend.caption")}</CardAction>
        </CardHeader>
        <CardContent>
          {trendHasSignal ? (
            <div className="h-72 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={weeklyTrend} margin={{ top: 8, right: 8, bottom: 8, left: 0 }}>
                  <CartesianGrid strokeDasharray="3 4" stroke="var(--border)" vertical={false} />
                  <XAxis
                    dataKey="weekStart"
                    tick={{ fontSize: 9.5, fill: "var(--muted-foreground)" }}
                    axisLine={{ stroke: "var(--border)" }}
                    tickLine={false}
                  />
                  <YAxis allowDecimals={false} tick={{ fontSize: 9.5, fill: "var(--muted-foreground)" }} />
                  <Tooltip
                    formatter={(value) => [value, t("trend.chart.count")]}
                    contentStyle={{
                      background: "var(--popover)",
                      border: "1px solid var(--border)",
                      borderRadius: 8,
                      fontSize: 12,
                    }}
                  />
                  <Line
                    type="monotone"
                    dataKey="count"
                    name={t("trend.chart.count")}
                    stroke="var(--brand-gold)"
                    strokeWidth={2.4}
                    dot={{ r: 2.8, fill: "var(--card)", stroke: "var(--brand-gold)", strokeWidth: 1.8 }}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <EmptyState message={t("trend.empty")} />
          )}
        </CardContent>
      </Card>
    </section>
  );
}
