"use client";

import { useLocale, useTranslations } from "next-intl";
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { formatTimestampInAcademyZone } from "@/lib/format-date";
import type { RetentionEntry } from "@/lib/analytics/retention";
import { ExportCsvButton } from "./export-csv-button";

// `lastSeenAt` is a plain `Date | null` in the lib layer, but `page.tsx`
// still converts it to an ISO string before handing rows to this "use
// client" component — the same Server -> Client boundary discipline
// `progression-panel.tsx`'s `projectedDate`/`awardedAt` already follow,
// applied here too rather than assumed safe just because `Date` (unlike a
// Luxon `DateTime`) happens to serialize.
export type RetentionEntryPanelRow = Omit<RetentionEntry, "lastSeenAt"> & { lastSeenAt: string | null };

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

  return (
    <section className="flex flex-col gap-8">
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-medium">{t("list.heading")}</h2>
          <ExportCsvButton rows={csvRows} filename="analytics-retention.csv" />
        </div>

        {entries.length === 0 ? (
          <p className="text-muted-foreground">{t("list.empty")}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b">
                  <th className="py-2 pr-4">{t("list.table.name")}</th>
                  <th className="py-2 pr-4">{t("list.table.phone")}</th>
                  <th className="py-2 pr-4">{t("list.table.lastSeenAt")}</th>
                  <th className="py-2 pr-4">{t("list.table.bucket")}</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry) => (
                  <tr key={entry.studentId} className="border-b">
                    <td className="py-2 pr-4 font-medium">{entry.name}</td>
                    <td className="py-2 pr-4">{entry.phone}</td>
                    <td className="py-2 pr-4">{formatLastSeen(entry.lastSeenAt)}</td>
                    <td className="py-2 pr-4">{tBucket(entry.bucket)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="flex flex-col gap-3">
        <h2 className="text-lg font-medium">{t("trend.heading")}</h2>
        <p className="text-xs text-muted-foreground">{t("trend.caption")}</p>
        <div className="h-72 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={weeklyTrend} margin={{ top: 8, right: 8, bottom: 8, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="weekStart" />
              <YAxis allowDecimals={false} />
              <Tooltip />
              <Line type="monotone" dataKey="count" name={t("trend.chart.count")} stroke="#2563eb" />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>
    </section>
  );
}
