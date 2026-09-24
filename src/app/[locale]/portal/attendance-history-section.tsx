"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import type { AttendanceRow } from "@/lib/portal/attendance-rows";
import type { AttendanceTotals } from "@/lib/students/attendance-history";
import { loadMoreAttendance } from "./attendance-history-actions";

/**
 * The student's attendance history as its own section: a DEFINED total (check-ins + staff-added days + any legacy
 * adjustments, from the whole ledger - never the length of what is loaded), the entries newest first, and a
 * "show older attendance" control that loads further pages in a stable order until the start of the history.
 *
 * Accessibility: a labelled region, a real list, `<time>` elements, a native button (keyboard and screen-reader
 * operable), a polite live region that announces how many entries were loaded, and focus moved to the first newly
 * loaded entry so a keyboard user continues reading where the new content begins. Signs are never conveyed by
 * colour alone.
 *
 * The parent gives this component a `key` that changes when a new attendance arrives, so the list restarts from
 * the fresh first page instead of leaving a gap between it and older pages loaded earlier.
 */
export function AttendanceHistorySection({
  organizationId,
  initialRows,
  initialCursor,
  totals,
  creditedClasses,
}: {
  organizationId: string;
  initialRows: AttendanceRow[];
  initialCursor: string | null;
  totals: AttendanceTotals;
  /** Legacy head-start credit still counted toward promotion (CUMULATIVE tracks only); shown apart from attendance. */
  creditedClasses: number;
}) {
  const t = useTranslations("portal.attendanceHistory");
  const [rows, setRows] = useState(initialRows);
  const [cursor, setCursor] = useState(initialCursor);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const [focusId, setFocusId] = useState<string | null>(null);
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    if (!focusId) return;
    listRef.current?.querySelector<HTMLElement>(`[data-row-id="${focusId}"]`)?.focus();
    setFocusId(null);
  }, [focusId, rows]);

  async function loadMore() {
    if (!cursor || loading) return;
    setLoading(true);
    setFailed(false);
    const result = await loadMoreAttendance(organizationId, cursor);
    setLoading(false);
    if (!result.ok) {
      setFailed(true);
      return;
    }
    const known = new Set(rows.map((row) => row.id));
    const fresh = result.rows.filter((row) => !known.has(row.id));
    setRows((current) => [...current, ...fresh]);
    setCursor(result.nextCursor);
    setAnnouncement(t("loadedMore", { count: fresh.length }));
    if (fresh.length > 0) setFocusId(fresh[0].id);
  }

  return (
    <Card>
      <CardHeader className="border-b">
        <CardTitle id="attendance-history-heading">{t("heading")}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 pt-4">
        <section aria-labelledby="attendance-history-heading" className="flex flex-col gap-3">
          {totals.entryCount === 0 ? (
            <EmptyState message={t("empty")} />
          ) : (
            <>
              <div className="flex flex-col gap-0.5 text-sm">
                <p className="font-medium">{t("total", { count: totals.total })}</p>
                <p className="text-muted-foreground">
                  {t("breakdown", { checkIns: totals.checkIns, staffDays: totals.staffDays })}
                </p>
                {totals.otherAdjustments.count > 0 && (
                  <p className="text-muted-foreground">
                    {t("otherAdjustments", { count: totals.otherAdjustments.count, net: totals.otherAdjustments.net })}
                  </p>
                )}
                {creditedClasses > 0 && <p className="text-muted-foreground">{t("credits", { count: creditedClasses })}</p>}
                <p className="text-muted-foreground">{t("showing", { shown: rows.length, total: totals.entryCount })}</p>
              </div>

              <ul ref={listRef} aria-label={t("listLabel")} className="flex flex-col divide-y divide-border">
                {rows.map((row) => (
                  <li key={row.id} data-row-id={row.id} tabIndex={-1} className="flex flex-col gap-0.5 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring">
                    <div className="flex items-center justify-between gap-2">
                      <time dateTime={row.iso} className="font-medium tabular-nums">
                        {row.whenLabel}
                      </time>
                      <span className="tabular-nums" aria-label={`${row.delta > 0 ? "+" : ""}${row.delta}`}>
                        {row.delta > 0 ? `+${row.delta}` : row.delta}
                      </span>
                    </div>
                    <span className="text-muted-foreground">
                      {row.className ? `${t(`kind.${row.kind}`)} · ${row.className}` : t(`kind.${row.kind}`)}
                    </span>
                    {row.reason && <span className="text-muted-foreground italic">{row.reason}</span>}
                  </li>
                ))}
              </ul>

              <p role="status" aria-live="polite" className="sr-only">
                {announcement}
              </p>

              {failed && (
                <p role="alert" className="text-sm text-destructive">
                  {t("loadError")}
                </p>
              )}

              {cursor ? (
                <Button type="button" variant="outline" onClick={loadMore} disabled={loading} aria-busy={loading}>
                  {loading ? t("loading") : t("loadMore")}
                </Button>
              ) : (
                rows.length > 0 && <p className="text-sm text-muted-foreground">{t("allLoaded")}</p>
              )}
            </>
          )}
        </section>
      </CardContent>
    </Card>
  );
}
