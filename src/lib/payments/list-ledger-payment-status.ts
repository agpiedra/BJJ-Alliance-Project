import { branchScopeWhere } from "@/lib/tenant/context";
import { getScopedDb } from "@/lib/tenant/scoped-client";
import type { TenantContext } from "@/lib/tenant/types";
import { listRosterPaymentFacts, toRosterLedgerDisplay, type RosterLedgerEntry } from "@/lib/dues/roster-payment-facts-queries";
import { summarizeLedgerOverdue, type LedgerOverdueSummary } from "@/lib/dues/ledger-overdue-summary";

export interface LedgerPaymentRow {
  studentId: string;
  firstName: string;
  lastName: string;
  homeAcademyId: string;
  homeAcademyName: string;
  entry: RosterLedgerEntry;
}

export interface LedgerPaymentStatusResult {
  rows: LedgerPaymentRow[];
  summary: LedgerOverdueSummary;
}

export const EMPTY_LEDGER_PAYMENT_STATUS: LedgerPaymentStatusResult = {
  rows: [],
  summary: { monthlyPastGraceCount: 0, monthlyPastGraceNote: "", signupPastDueCount: 0, signupPastDueNote: "", unknownCount: 0 },
};

/**
 * REMAINING-LEDGER-CONSUMERS-BRIEF.md §2.4 (PR 5): the ledger-backed replacement for `listCurrentPaymentStatus`'s
 * reads — the SAME population/scope that function already queries (`status: "ACTIVE"`, narrowed by
 * `branchScopeWhere`) — this page's status table has no population-extension decision like the dashboard/digest's
 * Decision 2; §2.4 only replaces WHICH fact is shown per student, never WHO is shown. Reuses `listRosterPaymentFacts`/
 * `toRosterLedgerDisplay` exactly as the roster/dashboard/contact-list already do (never a new query), and
 * `summarizeLedgerOverdue` (the SAME two-count aggregation Decision 1 already approved, `src/lib/dues/
 * ledger-overdue-summary.ts`) for this page's own stat-row replacement — reusing an already-approved fact/label,
 * not inventing a new metric (§2.4: "an engineering/visual decision, not a new fact"). ONE `listRosterPaymentFacts`
 * call serves both the per-row display AND the stat-row summary — never two separate reads for the same page load.
 *
 * A failed read for the student's own entry stays `{ kind: "unavailable" }` (never "paid"/"no debt"/healthy) — the
 * same fail-closed state the roster/dashboard/contact-list already render. `now` is the ONE captured instant the
 * caller resolved for this page load (branch-local "today" is then resolved per-student inside
 * `listRosterPaymentFacts` itself, via `todayIn`).
 */
export async function listLedgerPaymentStatus(context: TenantContext, now: Date): Promise<LedgerPaymentStatusResult> {
  const scope = branchScopeWhere(context);
  const students = await getScopedDb(context).student.findMany({
    where: {
      status: "ACTIVE",
      ...(scope.academyId ? { homeAcademyId: scope.academyId } : {}),
    },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      status: true,
      homeAcademyId: true,
      homeAcademy: { select: { name: true } },
    },
    orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
  });
  if (students.length === 0) return EMPTY_LEDGER_PAYMENT_STATUS;

  const { byStudentId } = await listRosterPaymentFacts(context, students.map((s) => s.id), now);

  const rows: LedgerPaymentRow[] = students.map((student) => {
    const fact = byStudentId.get(student.id);
    const entry: RosterLedgerEntry = fact?.ok
      ? { kind: "ledger", display: toRosterLedgerDisplay(fact.facts, fact.todayIso) }
      : { kind: "unavailable" };
    return {
      studentId: student.id,
      firstName: student.firstName,
      lastName: student.lastName,
      homeAcademyId: student.homeAcademyId,
      homeAcademyName: student.homeAcademy.name,
      entry,
    };
  });

  // Every student here is ACTIVE by the query's own `where` above, so the identity function for `tStatus` is never
  // actually invoked with a non-"ACTIVE" status — unlike the dashboard/digest's extended population, this page's
  // own names/notes are discarded either way (the stat row shows counts only, matching Decision 1's tile shape).
  const summary = summarizeLedgerOverdue(students, byStudentId, (status) => status);

  return { rows, summary };
}
