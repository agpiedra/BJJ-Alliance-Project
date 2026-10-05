import type { TenantContext } from "@/lib/tenant/types";
import { listDuesFactsForStudents, type DuesOutstandingFact } from "@/lib/dues/ledger/dues-facts";
import { orderOldestFirst } from "@/lib/dues/settlement";
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
