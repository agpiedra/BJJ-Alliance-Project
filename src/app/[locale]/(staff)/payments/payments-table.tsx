"use client";

import { useMemo, useOptimistic, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import {
  DataTable,
  DataTableBody,
  DataTableCell,
  DataTableHead,
  DataTableHeaderCell,
  DataTableHeaderRow,
  DataTableRow,
} from "@/components/ui/data-table";
import { FilterBar, FilterBarSearch, FilterBarSelect } from "@/components/ui/filter-bar";
import { Pill } from "@/components/ui/pill";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { showToast } from "@/components/ui/toast";
import { RecordPaymentForm, type RecordPaymentPlanOption } from "@/components/payments/record-payment-form";
import { markPaymentPaid } from "@/lib/payments/payment-actions";
import { CUSTOM_PROMO_PLAN_NAME } from "@/lib/payments/custom-promo-plan-name";
import { formatMoney } from "@/lib/payments/format-money";
import { formatRecordedBy } from "@/lib/payments/format-recorded-by";
import type { CurrentPaymentRow, PaymentBucket } from "@/lib/payments/list-current-status";

export interface PaymentsTableProps {
  /** 1f-4: bound into `markPaymentPaid`/passed to `RecordPaymentForm` —
   * never read from the ambient session selector. */
  organizationId: string;
  rows: CurrentPaymentRow[];
  plans: RecordPaymentPlanOption[];
  academies: { id: string; name: string }[];
  currentYear: number;
  currentMonth: number;
  canRecordPayments: boolean;
  locale: string;
}

function pillVariantFor(bucket: PaymentBucket): "ok" | "warn" | "bad" | "accent" {
  switch (bucket) {
    case "PAID":
      return "ok";
    case "PENDING":
      return "warn";
    case "OVERDUE":
      return "bad";
    case "PROMO_OR_EXEMPT":
      return "accent";
  }
}

export function PaymentsTable({
  organizationId,
  rows: initialRows,
  plans,
  academies,
  currentYear,
  currentMonth,
  canRecordPayments,
  locale,
}: PaymentsTableProps) {
  const t = useTranslations("payments.table");
  const tPaymentStatus = useTranslations("students.paymentStatus");
  const tMethod = useTranslations("payments.method");
  const router = useRouter();

  // Layered DIRECTLY over the `initialRows` prop, not a mirrored `useState`
  // — a separate `useState(initialRows)` never re-syncs when the prop
  // changes (e.g. after `router.refresh()` re-fetches the real server data,
  // or after the Registrar-pago form's own `revalidatePath` lands), so the
  // table used to keep showing stale/optimistic data indefinitely. With
  // `useOptimistic`, `rows` reflects `initialRows` on every render and only
  // shows the optimistic overlay while a transition is actually pending —
  // once that transition settles, it automatically reverts to whatever
  // `initialRows` currently is (no manual "previousRows" bookkeeping needed
  // for the revert-on-failure case either).
  const [rows, setOptimisticPaid] = useOptimistic(initialRows, (state, studentId: string) =>
    state.map((r) =>
      r.studentId === studentId
        ? { ...r, bucket: "PAID" as const, period: r.period ? { ...r.period, status: "PAID" as const } : r.period }
        : r,
    ),
  );
  // Only the transition-starting function is needed — per-row pending state
  // for disabling a SPECIFIC button is tracked separately via
  // `pendingStudentIds` below (this hook's own `isPending` flag is global to
  // every row's transition, not per-row).
  const [, startMarkPaidTransition] = useTransition();
  const [pendingStudentIds, setPendingStudentIds] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const [bucketFilter, setBucketFilter] = useState<PaymentBucket | "">("");
  const [academyFilter, setAcademyFilter] = useState("");
  const [receiptStudentId, setReceiptStudentId] = useState<string | null>(null);
  const [editStudentId, setEditStudentId] = useState<string | null>(null);

  const filteredRows = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return rows.filter((row) => {
      if (bucketFilter && row.bucket !== bucketFilter) return false;
      if (academyFilter && row.homeAcademyId !== academyFilter) return false;
      if (needle && !`${row.firstName} ${row.lastName}`.toLowerCase().includes(needle)) return false;
      return true;
    });
  }, [rows, search, bucketFilter, academyFilter]);

  function statusLabel(row: CurrentPaymentRow): string {
    if (row.bucket === "OVERDUE") return tPaymentStatus("overdue");
    if (!row.period) return tPaymentStatus("notRecorded");
    return tPaymentStatus(row.period.status);
  }

  function handleMarkPaid(row: CurrentPaymentRow) {
    setPendingStudentIds((prev) => new Set(prev).add(row.studentId));
    // The optimistic update AND the write both live inside the same
    // transition — React reverts `rows` to whatever `initialRows` is as
    // soon as this async callback settles, so a failure needs no manual
    // "restore the previous array" bookkeeping: nothing here ever wrote to
    // `initialRows`, so there is nothing to undo.
    startMarkPaidTransition(async () => {
      setOptimisticPaid(row.studentId);
      const result = await markPaymentPaid(organizationId, row.studentId, currentYear, currentMonth);

      setPendingStudentIds((prev) => {
        const next = new Set(prev);
        next.delete(row.studentId);
        return next;
      });

      if (result.ok) {
        showToast(t("toast.success"), "success");
        // Re-fetches the real Server Component data (amount/method/
        // recordedBy) once the write lands, without a full page reload —
        // `rows` (via `useOptimistic`) picks up the refreshed `initialRows`
        // prop automatically.
        router.refresh();
      } else {
        showToast(t("toast.error"), "error");
      }
    });
  }

  const receiptRow = rows.find((r) => r.studentId === receiptStudentId) ?? null;
  const editRow = rows.find((r) => r.studentId === editStudentId) ?? null;

  return (
    <>
      <FilterBar className="border-b-0 px-0 pb-0">
        <label htmlFor="payments-search" className="sr-only">
          {t("filters.search")}
        </label>
        <FilterBarSearch
          id="payments-search"
          type="search"
          placeholder={t("filters.searchPlaceholder")}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <label htmlFor="payments-estado" className="sr-only">
          {t("filters.status")}
        </label>
        <FilterBarSelect
          id="payments-estado"
          value={bucketFilter}
          onChange={(e) => setBucketFilter(e.target.value as PaymentBucket | "")}
        >
          <option value="">{t("filters.allStatuses")}</option>
          <option value="PAID">{tPaymentStatus("PAID")}</option>
          <option value="PENDING">{tPaymentStatus("PENDING")}</option>
          <option value="OVERDUE">{tPaymentStatus("overdue")}</option>
          <option value="PROMO_OR_EXEMPT">{t("promoOrExempt")}</option>
        </FilterBarSelect>
        {academies.length > 1 && (
          <>
            <label htmlFor="payments-sede" className="sr-only">
              {t("filters.academy")}
            </label>
            <FilterBarSelect id="payments-sede" value={academyFilter} onChange={(e) => setAcademyFilter(e.target.value)}>
              <option value="">{t("filters.bothAcademies")}</option>
              {academies.map((academy) => (
                <option key={academy.id} value={academy.id}>
                  {academy.name}
                </option>
              ))}
            </FilterBarSelect>
          </>
        )}
      </FilterBar>

      {filteredRows.length === 0 ? (
        <EmptyState message={t("empty")} />
      ) : (
        <DataTable>
          <DataTableHead>
            <DataTableHeaderRow>
              <DataTableHeaderCell>{t("columns.student")}</DataTableHeaderCell>
              <DataTableHeaderCell>{t("columns.academy")}</DataTableHeaderCell>
              <DataTableHeaderCell>{t("columns.plan")}</DataTableHeaderCell>
              <DataTableHeaderCell className="text-right">{t("columns.amount")}</DataTableHeaderCell>
              <DataTableHeaderCell>{t("columns.method")}</DataTableHeaderCell>
              <DataTableHeaderCell>{t("columns.recorded")}</DataTableHeaderCell>
              <DataTableHeaderCell>{t("columns.status")}</DataTableHeaderCell>
              <DataTableHeaderCell>
                <span className="sr-only">{t("columns.actions")}</span>
              </DataTableHeaderCell>
            </DataTableHeaderRow>
          </DataTableHead>
          <DataTableBody>
            {filteredRows.map((row) => {
              const isCustomPromo = row.period?.planName === CUSTOM_PROMO_PLAN_NAME;
              const isPending = pendingStudentIds.has(row.studentId);
              return (
                <DataTableRow key={row.studentId}>
                  <DataTableCell className="font-medium">
                    {row.firstName} {row.lastName}
                  </DataTableCell>
                  <DataTableCell>{row.homeAcademyName}</DataTableCell>
                  <DataTableCell>
                    <div>{row.period?.planName ?? t("noPlan")}</div>
                    {isCustomPromo && row.period?.promoName && (
                      <div className="text-[11px] text-muted-foreground">
                        {t("promoPrefix")} · {row.period.promoName}
                      </div>
                    )}
                  </DataTableCell>
                  <DataTableCell className="text-right tabular-nums">
                    {row.period?.amount != null ? formatMoney(row.period.amount, row.period.currency, locale) : "—"}
                  </DataTableCell>
                  <DataTableCell>{row.period?.method ? tMethod(row.period.method) : "—"}</DataTableCell>
                  <DataTableCell className="text-muted-foreground">
                    {row.period ? formatRecordedBy(row.period.recordedAt, row.period.recordedByEmail, locale) : "—"}
                  </DataTableCell>
                  <DataTableCell>
                    <Pill variant={pillVariantFor(row.bucket)}>{statusLabel(row)}</Pill>
                  </DataTableCell>
                  <DataTableCell>
                    {row.bucket === "PAID" && (
                      <Button variant="ghost" size="sm" onClick={() => setReceiptStudentId(row.studentId)}>
                        {t("viewReceipt")}
                      </Button>
                    )}
                    {row.bucket === "PROMO_OR_EXEMPT" &&
                      (canRecordPayments ? (
                        <Button variant="ghost" size="sm" onClick={() => setEditStudentId(row.studentId)}>
                          {t("edit")}
                        </Button>
                      ) : (
                        <Button variant="ghost" size="sm" onClick={() => setReceiptStudentId(row.studentId)}>
                          {t("viewReceipt")}
                        </Button>
                      ))}
                    {(row.bucket === "PENDING" || row.bucket === "OVERDUE") && canRecordPayments && (
                      <Button variant="primary" size="sm" disabled={isPending} onClick={() => handleMarkPaid(row)}>
                        {t("markPaid")}
                      </Button>
                    )}
                  </DataTableCell>
                </DataTableRow>
              );
            })}
          </DataTableBody>
        </DataTable>
      )}

      <Sheet open={receiptRow !== null} onOpenChange={(open) => !open && setReceiptStudentId(null)}>
        <SheetContent>
          {receiptRow?.period && (
            <>
              <SheetHeader>
                <SheetTitle>
                  {receiptRow.firstName} {receiptRow.lastName}
                </SheetTitle>
                <SheetDescription>{receiptRow.homeAcademyName}</SheetDescription>
              </SheetHeader>
              <div className="flex flex-col gap-3 px-4 text-sm">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-muted-foreground">{t("columns.plan")}</span>
                  <span>{receiptRow.period.planName}</span>
                </div>
                {receiptRow.period.promoName && (
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-muted-foreground">{t("receipt.promoName")}</span>
                    <span>{receiptRow.period.promoName}</span>
                  </div>
                )}
                <div className="flex items-center justify-between gap-3">
                  <span className="text-muted-foreground">{t("columns.amount")}</span>
                  <span className="tabular-nums">
                    {receiptRow.period.amount != null ? formatMoney(receiptRow.period.amount, receiptRow.period.currency, locale) : "—"}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-muted-foreground">{t("columns.method")}</span>
                  <span>{receiptRow.period.method ? tMethod(receiptRow.period.method) : "—"}</span>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-muted-foreground">{t("receipt.notes")}</span>
                  <span>{receiptRow.period.notes ?? "—"}</span>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-muted-foreground">{t("receipt.recordedBy")}</span>
                  <span>{formatRecordedBy(receiptRow.period.recordedAt, receiptRow.period.recordedByEmail, locale)}</span>
                </div>
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>

      <Sheet open={editRow !== null} onOpenChange={(open) => !open && setEditStudentId(null)}>
        <SheetContent>
          {editRow?.period && (
            <>
              <SheetHeader>
                <SheetTitle>{t("edit")}</SheetTitle>
                <SheetDescription>
                  {editRow.firstName} {editRow.lastName}
                </SheetDescription>
              </SheetHeader>
              <div className="px-4 pb-4">
                <RecordPaymentForm
                  organizationId={organizationId}
                  students={[
                    {
                      id: editRow.studentId,
                      firstName: editRow.firstName,
                      lastName: editRow.lastName,
                      academyId: editRow.homeAcademyId,
                      academyName: editRow.homeAcademyName,
                    },
                  ]}
                  // The picker offers ACTIVE plans only, but this payment may
                  // already sit on a since-deactivated one; the server allows
                  // keeping it (history is never orphaned), so the sheet has to
                  // offer it too — marked — or the plan field would render blank.
                  plans={
                    plans.some((p) => p.id === editRow.period!.planId)
                      ? plans
                      : [
                          ...plans,
                          {
                            id: editRow.period.planId,
                            name: `${editRow.period.planName} ${t("inactivePlanSuffix")}`,
                            academyId: editRow.homeAcademyId,
                            defaultAmount: null,
                          },
                        ]
                  }
                  lockedStudentId={editRow.studentId}
                  canManagePromotions={canRecordPayments}
                  // An existing payment is corrected in the currency it was recorded in.
                  currency={editRow.period.currency}
                  defaults={{
                    month: `${editRow.period.year}-${String(editRow.period.month).padStart(2, "0")}`,
                    planId: editRow.period.planId,
                    status: editRow.period.status,
                    amount: editRow.period.amount,
                    method: editRow.period.method,
                    notes: editRow.period.notes,
                    promoName: editRow.period.promoName,
                    promoReason: editRow.period.promoReason,
                    promoRecurring: editRow.period.promoRecurring,
                  }}
                  onCancel={() => setEditStudentId(null)}
                  onSuccess={() => {
                    setEditStudentId(null);
                    router.refresh();
                  }}
                />
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>
    </>
  );
}
