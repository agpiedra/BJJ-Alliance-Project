import type { TenantContext } from "@/lib/tenant/types";
import { listRosterPaymentFacts } from "@/lib/dues/roster-payment-facts-queries";

export interface PaymentHealthResult {
  /** `null` whenever ANY read failed (withheld, §6.2) OR the population is empty — never a computed number
   * alongside the three counts below while either is true. */
  percent: number | null;
  confirmedPaidCount: number;
  /** The denominator actually achieved — ACTIVE-in-scope students whose read succeeded. Equals the full
   * population when `unknownCount` is 0. */
  successfullyCheckedCount: number;
  unknownCount: number;
}

export const EMPTY_PAYMENT_HEALTH: PaymentHealthResult = {
  percent: null,
  confirmedPaidCount: 0,
  successfullyCheckedCount: 0,
  unknownCount: 0,
};

/**
 * REMAINING-LEDGER-CONSUMERS-BRIEF.md §2.2/§6.1 Decision 3 (PR 6): "Current month covered by settled payments"
 * — an ACTIVE-in-scope student counts in the numerator iff they have at least one MONTHLY or PACKAGE obligation
 * whose `coverage` includes their OWN branch-local current month AND that specific obligation is settled
 * (`outstanding[i].settled`). Coverage alone is never sufficient (a `DuesCoverage` row exists from creation
 * time, independent of payment, §3/§4) — this reads `outstanding` for the settlement evidence on the SAME
 * obligation id `coverage` names, never inferring settlement from coverage existing. SIGNUP never contributes:
 * it claims zero `DuesCoverage` rows by shape (`enrollment-charge.ts`), so it can never appear in `coverage`
 * regardless of the `type` filter below — the filter is belt-and-suspenders, not the only guard. Old,
 * unrelated unsettled debt elsewhere never disqualifies an otherwise-qualifying current-month settlement —
 * this only ever looks at coverage rows for the target month, nothing else in `outstanding`. `eligibility`
 * (e.g. `MISSING_CONFIGURATION`) is never read at all: a settled PACKAGE covering this month counts regardless
 * of what the periodic monthly-eligibility check reports, since that check governs NEW obligation creation
 * only, not whether an EXISTING settled one counts (§6.1 worked example S1). Counts each student at most once
 * (`.some(...)`), never per-obligation.
 *
 * Reuses `listRosterPaymentFacts` exactly as the roster/dashboard/contact-list/Pagos status table already do —
 * no new query. A failed per-student read contributes to `unknownCount` only, never folded into
 * `confirmedPaidCount` (§6.2). `now` is the ONE captured instant the caller resolved for this page load;
 * branch-local "today" (and therefore the target month) is resolved per-student inside
 * `listRosterPaymentFacts` itself, via `todayIn` — two students in different timezones can land on different
 * target months from this SAME instant, exactly as intended.
 */
export async function getLedgerPaymentHealth(
  context: TenantContext,
  studentIds: readonly string[],
  now: Date,
): Promise<PaymentHealthResult> {
  if (studentIds.length === 0) return EMPTY_PAYMENT_HEALTH;

  const { byStudentId } = await listRosterPaymentFacts(context, studentIds, now);

  let confirmedPaidCount = 0;
  let unknownCount = 0;
  for (const studentId of studentIds) {
    const fact = byStudentId.get(studentId);
    if (!fact?.ok) {
      unknownCount++;
      continue;
    }
    const targetYear = Number(fact.todayIso.slice(0, 4));
    const targetMonth = Number(fact.todayIso.slice(5, 7));
    const settledQualifyingObligationIds = new Set(
      fact.facts.outstanding
        .filter((o) => o.settled && (o.type === "MONTHLY" || o.type === "PACKAGE"))
        .map((o) => o.obligationId),
    );
    const coveredThisMonthBySettled = fact.facts.coverage.some(
      (c) => c.year === targetYear && c.month === targetMonth && settledQualifyingObligationIds.has(c.obligationId),
    );
    if (coveredThisMonthBySettled) confirmedPaidCount++;
  }

  const successfullyCheckedCount = studentIds.length - unknownCount;
  const percent = unknownCount === 0 ? Math.round((confirmedPaidCount / studentIds.length) * 100) : null;
  return { percent, confirmedPaidCount, successfullyCheckedCount, unknownCount };
}
