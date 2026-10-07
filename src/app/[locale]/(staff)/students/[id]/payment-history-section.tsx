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
import { getPaymentHistoryPage } from "./payment-history-actions";
import type { PaymentHistoryRow } from "@/lib/dues/payment-history-queries";

/**
 * ROSTER-STUDENT-DETAIL-INTEGRATION-BRIEF.md §2.4/§3 decision 3: the SEPARATE ledger-history section, alongside
 * (never interleaved with) the untouched legacy table. §7's "usable pagination" requirement: "load more" reuses the
 * exact `requestRef` generation-guard + dedicated retry pattern already established by
 * `financial-corrections-section.tsx`'s own `loadMoreFees` — already-loaded rows are preserved on a failed fetch, a
 * dedicated error+retry control appears, and a response that lands after a newer request fired is discarded outright.
 */
export function PaymentHistorySection({
  organizationId,
  studentId,
  initialRows,
  initialCursor,
  initialFailed,
  locale,
}: {
  organizationId: string;
  studentId: string;
  initialRows: PaymentHistoryRow[];
  initialCursor: string | null;
  initialFailed: boolean;
  locale: string;
}) {
  const t = useTranslations("students");
  const [rows, setRows] = useState<PaymentHistoryRow[]>(initialRows);
  const [cursor, setCursor] = useState<string | null>(initialCursor);
  const [loading, setLoading] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState(false);
  const requestRef = useRef(0);

  async function loadMore() {
    if (!cursor || loading) return;
    const requestId = ++requestRef.current;
    setLoading(true);
    setLoadMoreError(false);
    try {
      const page = await getPaymentHistoryPage(organizationId, studentId, cursor);
      if (requestRef.current !== requestId) return;
      if (!page.ok) {
        setLoadMoreError(true);
        return;
      }
      setRows((prev) => {
        const seen = new Set(prev.map((r) => r.id));
        return [...prev, ...page.rows.filter((r) => !seen.has(r.id))];
      });
      setCursor(page.nextCursor);
    } catch {
      if (requestRef.current !== requestId) return;
      setLoadMoreError(true);
    } finally {
      if (requestRef.current === requestId) setLoading(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("ledger.history.heading")}</CardTitle>
      </CardHeader>
      <CardContent>
        {initialFailed ? (
          <p className="text-muted-foreground">{t("ledger.history.unavailable")}</p>
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
                        {row.conversion && (
                          <span className="text-[11px] text-muted-foreground">
                            @ {row.conversion.appliedRateValue} ({row.conversion.appliedRateQuoteDate.year}-
                            {String(row.conversion.appliedRateQuoteDate.month).padStart(2, "0")}-
                            {String(row.conversion.appliedRateQuoteDate.day).padStart(2, "0")})
                          </span>
                        )}
                      </div>
                    </DataTableCell>
                    <DataTableCell>{row.method}</DataTableCell>
                    <DataTableCell>
                      <div className="flex flex-col gap-1">
                        {row.settlements.map((s) => (
                          <div key={s.id} className="whitespace-nowrap">
                            {s.coverageYear}-{String(s.coverageMonth).padStart(2, "0")} {s.obligationType} —{" "}
                            {formatMoney(Number(s.totalAmount), s.currency, locale)}
                            {s.lateFee && s.lateFee.removalKind && (
                              <Badge variant="outline" className="ml-1">
                                {s.lateFee.removalKind}
                              </Badge>
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
