import type { TenantContext } from "@/lib/tenant/types";
import { branchScopeWhere } from "@/lib/tenant/context";
import { getScopedDb } from "@/lib/tenant/scoped-client";
import { listDuesFactsForStudents, type DuesOutstandingFact } from "@/lib/dues/ledger/dues-facts";
import { orderOldestFirst } from "@/lib/dues/settlement";
import { todayIn } from "@/lib/dues/ledger/common";
import type { CalendarDate } from "@/lib/dues/calendar";
import type { LedgerDeps } from "@/lib/dues/ledger/activation";

/**
 * Ordinary payment-entry UI brief §1/§2.1: a thin, read-only wrapper around the shared `listDuesFactsForStudents`
 * read model, scoped to ONE student and pre-filtered to what this UI actually offers for selection — PACKAGE
 * excluded (not selectable by `recordDuesPaymentWithSubmissionIdentity`'s own underlying writer) and already-settled
 * rows excluded (nothing left to pay). Not "use server": a plain module, exactly like `dues-facts.ts` itself.
 */

export type PayableObligation = DuesOutstandingFact & { type: "MONTHLY" | "SIGNUP"; settled: false };

export type PaymentEntryOutstandingResult =
  | { ok: true; obligations: PayableObligation[] }
  | { ok: false; error: "notActive" | "invalid" | "notFound" };

/** `debtItemPriority`'s own documented duplicate (brief §1 — `record-payment.ts:263`'s exact one-line rule: a
 * same-month SIGNUP sorts ahead of a MONTHLY). Kept in sync by the brief's own cross-check test, not by import —
 * `resolveMonthlyDebtItemsInTx`'s copy is module-private and not exported. */
function localDebtItemPriority(o: { type: "MONTHLY" | "SIGNUP" }): number {
  return o.type === "SIGNUP" ? 0 : 1;
}

/**
 * The oldest-first GLOBAL list (brief §2.1) across every currency combined — never grouped or filtered by currency
 * for selection purposes. Callers display currency sub-groupings on top of this same list for READABILITY only.
 */
export function orderPayableOldestFirst(obligations: readonly PayableObligation[]): PayableObligation[] {
  const refs = obligations.map((o) => ({ id: o.obligationId, coverage: { year: o.coverageYear, month: o.coverageMonth }, type: o.type }));
  const ordered = orderOldestFirst(refs, localDebtItemPriority);
  const byId = new Map(obligations.map((o) => [o.obligationId, o]));
  return ordered.map((r) => byId.get(r.id)!);
}

/** True when the student's payable obligations span more than one currency (brief §1/§2.1's documented limitation —
 * this writer cannot settle a currency-scoped subset independently, so the UI must say so plainly rather than offer
 * a selection the server is guaranteed to refuse). */
export function isMixedCurrency(obligations: readonly PayableObligation[]): boolean {
  return new Set(obligations.map((o) => o.currency)).size > 1;
}

export async function listPayableObligations(context: TenantContext, studentId: string, deps: LedgerDeps = {}): Promise<PaymentEntryOutstandingResult> {
  if (typeof studentId !== "string" || studentId.trim() === "") return { ok: false, error: "invalid" };
  const result = await listDuesFactsForStudents(context, [studentId], undefined, deps);
  if (!result.ok) return { ok: false, error: result.error };
  const facts = result.facts[0];
  if (!facts) return { ok: false, error: "notFound" };
  const obligations = facts.outstanding.filter((o): o is PayableObligation => o.type !== "PACKAGE" && o.settled === false);
  return { ok: true, obligations };
}

export type PaymentEntryStudent = { id: string; firstName: string; lastName: string; homeAcademyId: string; homeAcademyName: string };

/**
 * Point 6's correction: `payments/page.tsx`'s own `students` prop (fed to `RecordPaymentForm`/`PaymentsTable`) comes
 * from `listCurrentPaymentStatus`, which filters `status: "ACTIVE"` (`list-current-status.ts:65`) — appropriate for
 * the LEGACY current-period flow, wrong here. This writer settles real `DuesObligation`/`DuesPayment` rows, which do
 * not depend on a student's current billing-eligibility status; an inactive or archived student can still owe real,
 * unsettled debt. This is a DEDICATED, unfiltered (by status) tenant/branch-scoped picker query for this UI only —
 * `listCurrentPaymentStatus`/the legacy picker are completely unchanged, since they legitimately only need active
 * students for their own flow.
 */
export async function listStudentsForPaymentEntry(context: TenantContext): Promise<PaymentEntryStudent[]> {
  const scope = branchScopeWhere(context);
  const students = await getScopedDb(context).student.findMany({
    where: { ...(scope.academyId ? { homeAcademyId: scope.academyId } : {}) },
    select: { id: true, firstName: true, lastName: true, homeAcademyId: true, homeAcademy: { select: { name: true } } },
    orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
  });
  return students.map((s) => ({ id: s.id, firstName: s.firstName, lastName: s.lastName, homeAcademyId: s.homeAcademyId, homeAcademyName: s.homeAcademy.name }));
}

/**
 * Point 7's correction: the UI's default `receivedOn` and its backdated-date disclaimer must use the student's own
 * BRANCH-local date (the same `todayIn(branch.timezone, ...)` the engine itself judges D4's 30-day limit and every
 * fee grace-deadline against — `record-payment.ts:561`), never the owner's own browser clock, which can disagree at
 * a local-midnight boundary if the owner is in a different timezone than the branch. Returns `null` for a student
 * outside the caller's own tenant/branch scope — the same silent-exclusion disclosure rule `listDuesFactsForStudents`
 * already applies, never a distinct error that would leak existence.
 */
export async function getStudentBranchLocalToday(context: TenantContext, studentId: string, now: Date = new Date()): Promise<CalendarDate | null> {
  // `getScopedDb` only auto-injects `organizationId` — branch scope is a separate, OPTIONAL layer every caller
  // composes itself (`branchScopeWhere`'s own doc comment), exactly like `listStudentsForPaymentEntry` above.
  // Omitting it here would leak an out-of-branch DIRECTOR's target academy's timezone.
  const scope = branchScopeWhere(context);
  const student = await getScopedDb(context).student.findFirst({
    where: { id: studentId, ...(scope.academyId ? { homeAcademyId: scope.academyId } : {}) },
    select: { homeAcademy: { select: { timezone: true } } },
  });
  if (!student) return null;
  return todayIn(student.homeAcademy.timezone, now);
}
