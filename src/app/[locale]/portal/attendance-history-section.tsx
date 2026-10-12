"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { DateTime } from "luxon";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import type { AttendanceRow } from "@/lib/portal/attendance-rows";
import type { AttendanceMonthTotals, AttendanceTotals } from "@/lib/students/attendance-history";
import { ZONE } from "@/lib/scheduling/zone";
import { loadMoreAttendance } from "./attendance-history-actions";

/** Either the real, server-computed monthly totals, or an explicit "couldn't load" state — never a false 0. */
export type MonthlyAttendanceStat = { ok: true; totals: AttendanceMonthTotals } | { ok: false };

function monthKeyOf(iso: string): string {
  const dt = DateTime.fromISO(iso, { zone: "utc" }).setZone(ZONE);
  return `${dt.year}-${dt.month}`;
}

/**
 * The student's attendance history as its own section: a DEFINED total (check-ins + staff-added days + any legacy
 * adjustments, from the whole ledger - never the length of what is loaded), the entries grouped by month newest
 * first (cosmetic client-side grouping of already-paginated rows - no new read), a this-month/last-month stat row
 * from the server's own date-ranged read (never derived from loaded rows - a user who hasn't scrolled back far
 * enough must never see an undercounted total), and a "show older attendance" control that loads further pages in
 * a stable order until the start of the history.
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
  monthlyStats,
}: {
  organizationId: string;
  initialRows: AttendanceRow[];
  initialCursor: string | null;
  totals: AttendanceTotals;
  /** Legacy head-start credit still counted toward promotion (CUMULATIVE tracks only); shown apart from attendance. */
  creditedClasses: number;
  monthlyStats: { thisMonth: MonthlyAttendanceStat; lastMonth: MonthlyAttendanceStat };
}) {
  const t = useTranslations("portal.attendanceHistory");
  const locale = useLocale();
  const [rows, setRows] = useState(initialRows);
  const [cursor, setCursor] = useState(initialCursor);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const [focusId, setFocusId] = useState<string | null>(null);
  const groupsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!focusId) return;
    groupsRef.current?.querySelector<HTMLElement>(`[data-row-id="${focusId}"]`)?.focus();
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

  // Cosmetic grouping only: rows arrive newest-first from the server, so a month can never reappear after a gap
  // - each group becomes its own `<ul>`, preceded by a sibling heading (never an `<li>` INSIDE the list, which
  // would be indistinguishable from a real entry to both `getAllByRole("listitem")` and a screen reader's list
  // item count). A single-month history (every existing test fixture, and the common case) renders exactly one
  // `<ul>`, so `getByRole("list", { name: ... })`'s single-match assumption is unaffected.
  const monthGroups = useMemo(() => {
    const monthFormatter = new Intl.DateTimeFormat(locale === "es" ? "es-CR" : "en-US", { month: "long", year: "numeric", timeZone: ZONE });
    const out: Array<{ key: string; label: string; rows: AttendanceRow[] }> = [];
    for (const row of rows) {
      const key = monthKeyOf(row.iso);
      const current = out[out.length - 1];
      if (current && current.key === key) {
        current.rows.push(row);
      } else {
        const label = monthFormatter.format(DateTime.fromISO(row.iso, { zone: "utc" }).toJSDate());
        out.push({ key, label: label.charAt(0).toUpperCase() + label.slice(1), rows: [row] });
      }
    }
    return out;
  }, [rows, locale]);

  function monthStatText(stat: MonthlyAttendanceStat, labelKey: "thisMonth" | "lastMonth"): string {
    if (!stat.ok) return t("monthStats.unavailable");
    return t(`monthStats.${labelKey}`, { count: stat.totals.total });
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
              <div className="flex flex-wrap gap-4 text-sm" data-testid="attendance-month-stats">
                <p className={monthlyStats.thisMonth.ok ? "font-medium" : "text-muted-foreground"}>{monthStatText(monthlyStats.thisMonth, "thisMonth")}</p>
                <p className={monthlyStats.lastMonth.ok ? "font-medium" : "text-muted-foreground"}>{monthStatText(monthlyStats.lastMonth, "lastMonth")}</p>
              </div>

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

              <div ref={groupsRef} className="flex flex-col gap-3">
                {monthGroups.map((group) => (
                  <div key={group.key} className="flex flex-col gap-1">
                    {monthGroups.length > 1 && <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{group.label}</p>}
                    <ul aria-label={t("listLabel")} className="flex flex-col divide-y divide-border">
                      {group.rows.map((row) => (
                        <li
                          key={row.id}
                          data-row-id={row.id}
                          tabIndex={-1}
                          className="flex flex-col gap-0.5 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
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
                  </div>
                ))}
              </div>

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
