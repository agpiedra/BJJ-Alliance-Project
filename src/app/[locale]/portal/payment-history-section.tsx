"use client";

import { useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  DataTable,
  DataTableBody,
  DataTableCell,
  DataTableHead,
  DataTableHeaderCell,
  DataTableHeaderRow,
  DataTableRow,
} from "@/components/ui/data-table";
import { formatMoney } from "@/lib/payments/format-money";
import { getOwnPaymentHistoryPage } from "./payment-history-actions";
import type { PortalPaymentHistoryRow } from "@/lib/dues/payment-history-queries";

/**
 * STUDENT-PORTAL-LEDGER-INTEGRATION-BRIEF.md §3.1/§3.3/§6: the portal's own ledger-history section — new
 * content, nothing existing to replace (§3.1). Reuses `[id]/payment-history-section.tsx`'s own proven
 * reconciliation pattern verbatim (requirement 6): "load more" preserves already-loaded rows on a failed fetch,
 * offers a dedicated retry, discards a response that lands after a newer request fired, and resyncs local state
 * when a parent re-render hands this component refreshed server props while a request is still in flight.
 *
 * Deliberately NO `studentId`/`organizationId`-identity reconciliation trigger the staff version has: there is
 * only ever "my own" history here, so an identity change is not a concept this component needs to detect — only
 * `initialRows`/`initialCursor`/`initialFailed` changing (a fresh server render, e.g. after a revalidation)
 * matters, and that alone is what the comparison below watches.
 *
 * Renders `PortalPaymentHistoryRow` — the student-facing allowlisted shape, which has NO `notes` field at all
 * (decided excluded, brief §5.1/§8) — never the staff `PaymentHistoryRow`. There is structurally no `row.notes`
 * to render here, unlike the staff component.
 */
export function PortalPaymentHistorySection({
  organizationId,
  initialRows,
  initialCursor,
  initialFailed,
  locale,
}: {
  organizationId: string;
  initialRows: PortalPaymentHistoryRow[];
  initialCursor: string | null;
  initialFailed: boolean;
  locale: string;
}) {
  const t = useTranslations("students");
  const [rows, setRows] = useState<PortalPaymentHistoryRow[]>(initialRows);
  const [cursor, setCursor] = useState<string | null>(initialCursor);
  const [failed, setFailed] = useState(initialFailed);
  const [loading, setLoading] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState(false);
  const requestRef = useRef(0);

  const lastSyncedProps = useRef({ initialRows, initialCursor, initialFailed });
  const prevProps = lastSyncedProps.current;
  if (prevProps.initialRows !== initialRows || prevProps.initialCursor !== initialCursor || prevProps.initialFailed !== initialFailed) {
    lastSyncedProps.current = { initialRows, initialCursor, initialFailed };
    requestRef.current++;
    setRows(initialRows);
    setCursor(initialCursor);
    setFailed(initialFailed);
    setLoadMoreError(false);
    setLoading(false);
  }

  // Shared by BOTH "load more" (cursor set — append) and the initial-failure retry (no cursor — replace, same
  // first-page-read shape the server component itself uses). One generation guard, one dedup flag, for both.
  async function fetchPage(pageCursor: string | undefined) {
    if (loading) return;
    const requestId = ++requestRef.current;
    setLoading(true);
    if (pageCursor) setLoadMoreError(false);
    try {
      const page = await getOwnPaymentHistoryPage(organizationId, pageCursor);
      if (requestRef.current !== requestId) return;
      if (!page.ok) {
        if (pageCursor) setLoadMoreError(true);
        else setFailed(true);
        return;
      }
      if (pageCursor) {
        setRows((prev) => {
          const seen = new Set(prev.map((r) => r.id));
          return [...prev, ...page.rows.filter((r) => !seen.has(r.id))];
        });
      } else {
        setRows(page.rows);
        setFailed(false);
      }
      setCursor(page.nextCursor);
    } catch {
      if (requestRef.current !== requestId) return;
      if (pageCursor) setLoadMoreError(true);
      else setFailed(true);
    } finally {
      if (requestRef.current === requestId) setLoading(false);
    }
  }

  function loadMore() {
    if (!cursor) return;
    void fetchPage(cursor);
  }
  // STUDENT-PORTAL-LEDGER-INTEGRATION-BRIEF.md §6 review fix: the initial server-side read can genuinely fail
  // (a transient DB error) with no "load more" cursor to retry from — this re-runs the SAME first-page read the
  // server component itself performs (`getOwnPaymentHistoryPage` with no cursor), so a failed initial load is
  // never a dead end. `loading`-gated the same way `loadMore` already is — no duplicate-click bypass.
  function retryInitial() {
    void fetchPage(undefined);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("ledger.history.heading")}</CardTitle>
      </CardHeader>
      <CardContent>
        {failed ? (
          <div className="flex items-center gap-2">
            <p className="text-muted-foreground">{t("ledger.history.unavailable")}</p>
            <Button type="button" variant="outline" size="sm" onClick={retryInitial} disabled={loading}>
              {loading ? t("ledger.history.loading") : t("ledger.history.retry")}
            </Button>
          </div>
        ) : rows.length === 0 ? (
          <p className="text-muted-foreground">{t("ledger.history.empty")}</p>
        ) : (
          <>
            <DataTable>
              <DataTableHead>
                <DataTableHeaderRow>
                  <DataTableHeaderCell>{t("ledger.history.columnDate")}</DataTableHeaderCell>
                  <DataTableHeaderCell>{t("ledger.history.columnAmount")}</DataTableHeaderCell>
                  <DataTableHeaderCell>{t("ledger.history.columnMethod")}</DataTableHeaderCell>
                  <DataTableHeaderCell>{t("ledger.history.columnSettlements")}</DataTableHeaderCell>
                </DataTableHeaderRow>
              </DataTableHead>
              <DataTableBody>
                {rows.map((row) => (
                  <DataTableRow key={row.id}>
                    <DataTableCell>
                      <div className="flex items-center gap-2 whitespace-nowrap">
                        {`${row.receivedOn.year}-${String(row.receivedOn.month).padStart(2, "0")}-${String(row.receivedOn.day).padStart(2, "0")}`}
                        {row.reversedAt && <Badge variant="outline">{t("ledger.history.reversed")}</Badge>}
                      </div>
                    </DataTableCell>
                    <DataTableCell>
                      <div className="flex flex-col">
                        <span>{formatMoney(Number(row.tenderAmount), row.tenderCurrency, locale)}</span>
                        {/* Stored cross-currency evidence — snapshotted at settlement time, read as stored, never
                            recomputed against the (possibly since-corrected) live quote. No `notes` line here:
                            `PortalPaymentHistoryRow` has no such field, structurally. */}
                        {row.conversion && (
                          <span className="text-[11px] text-muted-foreground">
                            @ {row.conversion.appliedRateValue} ({row.conversion.appliedRateQuoteDate.year}-
                            {String(row.conversion.appliedRateQuoteDate.month).padStart(2, "0")}-
                            {String(row.conversion.appliedRateQuoteDate.day).padStart(2, "0")}, rev{" "}
                            {row.conversion.appliedRateRevision}, {row.conversion.appliedRoundingRule})
                          </span>
                        )}
                      </div>
                    </DataTableCell>
                    <DataTableCell>{row.method}</DataTableCell>
                    <DataTableCell>
                      <div className="flex flex-col gap-1">
                        {row.settlements.map((s) => (
                          <div key={s.id} className="flex flex-col whitespace-nowrap">
                            <span>
                              {s.coverageYear}-{String(s.coverageMonth).padStart(2, "0")} {s.obligationType} —{" "}
                              {s.lateFee
                                ? t("ledger.history.principalAndFee", {
                                    principal: formatMoney(Number(s.principalAmount), s.currency, locale),
                                    fee: formatMoney(Number(s.lateFee.amount), s.currency, locale),
                                    total: formatMoney(Number(s.totalAmount), s.currency, locale),
                                  })
                                : formatMoney(Number(s.totalAmount), s.currency, locale)}
                            </span>
                            {s.lateFee?.removalKind && (
                              <span className="text-[11px] text-muted-foreground">
                                {t("ledger.history.feeCurrentState", { state: t(`ledger.history.removalKind.${s.lateFee.removalKind}`) })}
                              </span>
                            )}
                          </div>
                        ))}
                      </div>
                    </DataTableCell>
                  </DataTableRow>
                ))}
              </DataTableBody>
            </DataTable>
            {cursor && (
              <div className="mt-3 flex items-center gap-2">
                <Button type="button" variant="outline" size="sm" onClick={loadMore} disabled={loading}>
                  {loading ? t("ledger.history.loading") : t("ledger.history.loadMore")}
                </Button>
                {loadMoreError && (
                  <>
                    <span className="text-sm text-destructive">{t("ledger.history.unavailable")}</span>
                    <Button type="button" variant="outline" size="sm" onClick={loadMore}>
                      {t("ledger.history.retry")}
                    </Button>
                  </>
                )}
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
