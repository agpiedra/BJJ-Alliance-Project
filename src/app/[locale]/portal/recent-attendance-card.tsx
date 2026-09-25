import { useTranslations } from "next-intl";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import type { AttendanceRow } from "@/lib/portal/attendance-rows";
import { ViewFullHistoryLink } from "./view-history-link";

/** How many of the newest entries Home shows; the full history (defined total, older entries, load more) is the Attendance view. */
export const RECENT_ATTENDANCE_COUNT = 5;

/**
 * A short "recent attendance" list for Home, from the same first page of the student's ledger as the Attendance view (nothing is
 * counted or filtered differently). It links to the Attendance view for the full history.
 */
export function RecentAttendanceCard({ rows }: { rows: AttendanceRow[] }) {
  const t = useTranslations("portal");
  const tHistory = useTranslations("portal.attendanceHistory");
  const recent = rows.slice(0, RECENT_ATTENDANCE_COUNT);

  return (
    <Card data-testid="portal-recent-attendance">
      <CardHeader className="border-b">
        <CardTitle>{t("recent.heading")}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2 pt-4">
        {recent.length === 0 ? (
          <EmptyState message={tHistory("empty")} />
        ) : (
          <>
            <ul aria-label={tHistory("listLabel")} className="flex flex-col divide-y divide-border">
              {recent.map((row) => (
                <li key={row.id} className="flex flex-col gap-0.5 py-2 text-sm first:pt-0">
                  <div className="flex items-center justify-between gap-2">
                    <time dateTime={row.iso} className="font-medium tabular-nums">
                      {row.whenLabel}
                    </time>
                    <span className="tabular-nums" aria-label={`${row.delta > 0 ? "+" : ""}${row.delta}`}>
                      {row.delta > 0 ? `+${row.delta}` : row.delta}
                    </span>
                  </div>
                  <span className="text-muted-foreground">{row.className ? `${tHistory(`kind.${row.kind}`)} · ${row.className}` : tHistory(`kind.${row.kind}`)}</span>
                  {row.reason && <span className="text-muted-foreground italic">{row.reason}</span>}
                </li>
              ))}
            </ul>
            <div>
              <ViewFullHistoryLink>{t("recent.viewAll")}</ViewFullHistoryLink>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
