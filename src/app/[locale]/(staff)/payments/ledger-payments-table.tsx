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
import { Pill } from "@/components/ui/pill";
import { hasAcademyChoice } from "@/lib/staff-shell/academy-choice";
import { RosterLedgerStatus, RosterLedgerUnavailable } from "../students/roster-ledger-status";
import type { LedgerPaymentRow } from "@/lib/payments/list-ledger-payment-status";
import type { RosterLedgerFlags } from "@/lib/dues/roster-payment-facts-queries";

export interface LedgerPaymentsTableProps {
  rows: LedgerPaymentRow[];
  academies: { id: string; name: string }[];
  locale: string;
}

/**
 * Review fix: `RosterLedgerStatus` (shared with the roster/dashboard/contact-list) renders ONLY currency
 * totals or "No outstanding debt" — it never reads `display.flags`, so this page's own table showed an
 * aggregate dollar figure with no way to tell WHICH obligation type is driving it, and a student with a real
 * pending-conversion receipt or a configuration issue but zero current debt rendered as indistinguishable
 * from a genuinely clean student. Kept local to this file (never touching the shared component, per review
 * instruction) — these are ADDITIVE indicators rendered alongside `RosterLedgerStatus`'s own output, never a
 * replacement for it, so the currency-separated totals and the fee-included-exactly-once display are
 * unaffected either way. `monthlyPastGrace`/`signupPastDue` reuse Decision 1's own two-flag wording (the same
 * `students.ledger.filters.*` keys the dashboard/roster already use for these exact flags) — "bad" (real debt
 * driving the total). `pendingConversion` is deliberately NOT "bad"/"ok": a pending receipt is tender awaiting
 * settlement, never implied to be settled or to offset any debt (§3) — "accent", the sanctioned neutral/
 * informational variant (`pill.tsx`'s own doc comment). `configIssue` is an operational problem, not a debt
 * state — "warn".
 */
const FLAG_INDICATORS: ReadonlyArray<{ key: keyof RosterLedgerFlags; variant: "bad" | "accent" | "warn" }> = [
  { key: "monthlyPastGrace", variant: "bad" },
  { key: "signupPastDue", variant: "bad" },
  { key: "pendingConversion", variant: "accent" },
  { key: "configIssue", variant: "warn" },
];

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
  // Same label source the dashboard's own stat tiles and the roster's own filter checkboxes already use for
  // these exact flags — reused, not re-translated.
  const tLedgerFilters = useTranslations("students.ledger.filters");
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
                    <div className="flex flex-col gap-1">
                      <RosterLedgerStatus display={row.entry.display} locale={locale} t={tStudents} />
                      {FLAG_INDICATORS.filter(({ key }) => row.entry.kind === "ledger" && row.entry.display.flags[key]).map(({ key, variant }) => (
                        <Pill key={key} variant={variant}>
                          {tLedgerFilters(key)}
                        </Pill>
                      ))}
                    </div>
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
