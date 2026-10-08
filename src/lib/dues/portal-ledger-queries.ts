import { prisma } from "@/lib/prisma";
import { inactiveLedgerActivation, type LedgerDeps } from "@/lib/dues/ledger/activation";
import { getOwnDuesFacts, type DuesFactsForStudent, type DuesEligibilityFact, type PortalSelfContext } from "@/lib/dues/ledger/dues-facts";
import { todayIn } from "@/lib/dues/ledger/common";

// Re-exported so every other new portal file (the page, the "load more" action) can import `PortalSelfContext`
// from HERE instead of from `dues/ledger/dues-facts` directly — keeping this file the ONE new ledger-adjacent
// importer the whole portal surface needs, matching §2.7's "route every ledger-adjacent read through the
// existing wrapper" convention. Type-only; erased at compile time either way.
export type { PortalSelfContext };

/**
 * STUDENT-PORTAL-LEDGER-INTEGRATION-BRIEF.md §3: the portal's own ledger-adjacent read wrapper — the SELF-mode
 * counterpart to `roster-payment-facts-queries.ts`'s staff/branch-mode wrapper, following the identical "neither
 * page imports dues/ledger directly" convention (§2.7). A plain module, never `"use server"`. Registered in
 * `tests/unit/dues-ledger-not-exposed.test.ts`'s `AUTHORIZED_CALLERS` because it imports `dues-facts.ts`/
 * `ledger/common.ts` directly — the portal page and its "load more" action both route through this file (and
 * `@/lib/dues/payment-history-queries`, already authorized) instead of importing `dues/ledger` themselves.
 */

export type { DuesFactsForStudent, DuesEligibilityFact };

export type OwnPaymentFact =
  | { ok: true; facts: DuesFactsForStudent; todayIso: string; currentPeriod: { year: number; month: number } }
  | { ok: false };

/**
 * The self-mode counterpart to `listRosterPaymentFacts` — always exactly one student (the caller's own linked
 * record), so no chunking or concurrency limiting is needed. Resolves the student's own branch-local "today" via
 * the SAME `todayIn` resolution `dues-facts.ts` uses internally, never a second, drifting clock read, and reports
 * it both as an ISO string (display use) and as a `{year,month}` pair (the "current period" the eligibility
 * notice's suppression predicate, below, needs).
 */
export async function getOwnPaymentFacts(context: PortalSelfContext, now: Date, deps: LedgerDeps = {}): Promise<OwnPaymentFact> {
  let timezone: string;
  try {
    const student = await prisma.student.findFirst({
      where: { id: context.linkedStudentId, organizationId: context.organizationId },
      select: { homeAcademy: { select: { timezone: true } } },
    });
    if (!student) return { ok: false };
    timezone = student.homeAcademy.timezone;
  } catch {
    return { ok: false };
  }

  let facts: DuesFactsForStudent | null;
  try {
    const activation = deps.activation ?? inactiveLedgerActivation;
    facts = await getOwnDuesFacts(context, undefined, { ...deps, activation, now: () => now });
  } catch {
    return { ok: false };
  }
  if (!facts) return { ok: false };

  const today = todayIn(timezone, now);
  const todayIso = `${today.year}-${String(today.month).padStart(2, "0")}-${String(today.day).padStart(2, "0")}`;
  return { ok: true, facts, todayIso, currentPeriod: { year: today.year, month: today.month } };
}

export type EligibilityNoticeKey = "notRecorded" | "noAssignment" | "unconfirmed";

/**
 * STUDENT-PORTAL-LEDGER-INTEGRATION-BRIEF.md §5.2: the structural suppression rule plus the outcome-by-outcome
 * notice mapping, both decided in the brief and reused verbatim here — never re-derived inside a component.
 * Returns a translation KEY, not rendered copy, so the exact approved strings stay centralized in
 * messages/*.json (`students.ledger.eligibilityNotice.<key>`) rather than duplicated into this pure function.
 *
 * Suppression predicate (revision 5/6 — exact two facts, never "any obligation"): a current-period MONTHLY
 * obligation (settled OR unsettled — existence is what matters, never `outstandingAmountMinor > 0`) OR a
 * current-period `coverage` row of any kind. A bare SIGNUP satisfies neither: it is simply excluded by the
 * `type === "MONTHLY"` filter below, exactly as the brief requires (enrollment-charge.ts writes SIGNUP with zero
 * DuesCoverage rows and no guaranteed same-month MONTHLY).
 */
export function resolveEligibilityNoticeKey(facts: DuesFactsForStudent, currentPeriod: { year: number; month: number }): EligibilityNoticeKey | null {
  const hasCurrentMonthly = facts.outstanding.some(
    (o) => o.type === "MONTHLY" && o.coverageYear === currentPeriod.year && o.coverageMonth === currentPeriod.month,
  );
  const hasCurrentCoverage = facts.coverage.some((c) => c.year === currentPeriod.year && c.month === currentPeriod.month);
  if (hasCurrentMonthly || hasCurrentCoverage) return null;

  switch (facts.eligibility.outcome) {
    case "RESOLVED":
      return null;
    case "NOT_ELIGIBLE":
      return "notRecorded";
    case "NO_ASSIGNMENT":
      return "noAssignment";
    case "UNDECIDABLE":
    case "MISSING_CONFIGURATION":
    case "OBSERVED_DISCREPANCY":
      return "unconfirmed";
  }
}
