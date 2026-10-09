"use client";

import { useMemo, useState } from "react";
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
import { EmptyState } from "@/components/ui/empty-state";
import { hasAcademyChoice } from "@/lib/staff-shell/academy-choice";
import { RosterLedgerStatus, RosterLedgerUnavailable } from "../students/roster-ledger-status";
import type { LedgerPaymentRow } from "@/lib/payments/list-ledger-payment-status";

export interface LedgerPaymentsTableProps {
  rows: LedgerPaymentRow[];
  academies: { id: string; name: string }[];
  locale: string;
}

/**
 * REMAINING-LEDGER-CONSUMERS-BRIEF.md §2.4 (PR 5): the ledger-active replacement for `PaymentsTable`'s legacy
 * status table — rendered INSTEAD of it (`payments/page.tsx`'s own ternary), never alongside it, so there is
 * never a second, competing current-status table on this page. Entirely read-only: every write for a
 * ledger-active organization goes through the separate ledger-writer cards already on this page (ordinary
 * entry, package purchase, prepayment, financial corrections — all untouched by this PR); this table has no
 * action column at all, unlike the legacy table's "Marcar pagado"/"Editar" buttons.
 *
 * Reuses `RosterLedgerStatus`/`RosterLedgerUnavailable` (the roster's own already-approved independent-facts
 * display) verbatim for the status cell — never a new display component, never a collapsed boolean. A failed
 * read renders the SAME fail-closed "unavailable" pill the roster/dashboard/contact-list already use, never an
 * empty/healthy cell. Search/academy filtering mirrors the legacy table's own filter bar; the legacy table's
 * status-bucket filter has no ledger equivalent (no promo/exempt fact exists yet, §5) and is intentionally
 * omitted rather than inventing one.
 */
export function LedgerPaymentsTable({ rows, academies, locale }: LedgerPaymentsTableProps) {
  const t = useTranslations("payments.table");
  const tStudents = useTranslations("students");
  const [search, setSearch] = useState("");
  const [academyFilter, setAcademyFilter] = useState("");

  const filteredRows = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return rows.filter((row) => {
      if (academyFilter && row.homeAcademyId !== academyFilter) return false;
      if (needle && !`${row.firstName} ${row.lastName}`.toLowerCase().includes(needle)) return false;
      return true;
    });
  }, [rows, search, academyFilter]);

  return (
    <>
      <FilterBar className="border-b-0 px-0 pb-0">
        <label htmlFor="payments-ledger-search" className="sr-only">
          {t("filters.search")}
        </label>
        <FilterBarSearch
          id="payments-ledger-search"
          type="search"
          placeholder={t("filters.searchPlaceholder")}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        {hasAcademyChoice(academies) && (
          <>
            <label htmlFor="payments-ledger-sede" className="sr-only">
              {t("filters.academy")}
            </label>
            <FilterBarSelect id="payments-ledger-sede" value={academyFilter} onChange={(e) => setAcademyFilter(e.target.value)}>
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
              <DataTableHeaderCell>{t("columns.status")}</DataTableHeaderCell>
            </DataTableHeaderRow>
          </DataTableHead>
          <DataTableBody>
            {filteredRows.map((row) => (
              <DataTableRow key={row.studentId}>
                <DataTableCell className="font-medium">
                  {row.firstName} {row.lastName}
                </DataTableCell>
                <DataTableCell>{row.homeAcademyName}</DataTableCell>
                <DataTableCell>
                  {row.entry.kind === "unavailable" ? (
                    <RosterLedgerUnavailable t={tStudents} />
                  ) : (
                    <RosterLedgerStatus display={row.entry.display} locale={locale} t={tStudents} />
                  )}
                </DataTableCell>
              </DataTableRow>
            ))}
          </DataTableBody>
        </DataTable>
      )}
    </>
  );
}
