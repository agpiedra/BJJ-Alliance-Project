import { prisma } from "@/lib/prisma";
import type { Currency, PaymentStatus } from "@/generated/prisma/client";

export type PaymentHistoryEntry = {
  id: string;
  year: number;
  month: number;
  status: PaymentStatus;
  planName: string;
  amount: number | null;
  /** The currency `amount` was recorded in (the row's own snapshot). */
  currency: Currency;
  notes: string | null;
  /**
   * Stage 9 A8 rule 11, only after the switch and only for months from S on: `billed` where the ledger's own monthly charge for
   * that month exists, otherwise `handled` ("handled by the new system"). Null for every other row. Never inferred from the row.
   */
  newSystem: "billed" | "handled" | null;
};

/**
 * Plain function — NOT a "use server" action, deliberately kept out of any
 * file a Client Component imports from. Same two reasons as
 * `get-promotion-history.ts`'s `getPromotionHistory`:
 *
 * 1. Security: trusts `studentId` alone with no session/scope check of its
 *    own — safe only because `page.tsx` (the sole caller) has already
 *    resolved and scope-checked the student via `getStudentForStaff` first.
 * 2. Build correctness: imports Prisma (Node-only); kept out of any module a
 *    Client Component also imports from to avoid Turbopack trying to bundle
 *    Prisma's runtime for the browser.
 */
export async function getPaymentHistory(
  studentId: string,
  organizationId: string,
  /** The effective activation's S, or null while the legacy system is authoritative (then every `newSystem` is null). */
  ledgerStart: { year: number; month: number } | null = null,
): Promise<PaymentHistoryEntry[]> {
  const fromStart = (p: { year: number; month: number }) =>
    ledgerStart !== null && (p.year > ledgerStart.year || (p.year === ledgerStart.year && p.month >= ledgerStart.month));
  const charged = ledgerStart
    ? new Set(
        (
          await prisma.duesObligation.findMany({
            // O4: a cancelled charge was never billed.
            where: { organizationId, studentId, type: "MONTHLY", cancelledAt: null, OR: [{ coverageYear: { gt: ledgerStart.year } }, { coverageYear: ledgerStart.year, coverageMonth: { gte: ledgerStart.month } }] },
            select: { coverageYear: true, coverageMonth: true },
          })
        ).map((o) => `${o.coverageYear}-${o.coverageMonth}`),
      )
    : new Set<string>();
  const periods = await prisma.paymentPeriod.findMany({
    where: { studentId, organizationId },
    orderBy: [{ year: "desc" }, { month: "desc" }],
    select: {
      id: true,
      year: true,
      month: true,
      status: true,
      amount: true,
      currency: true,
      notes: true,
      // Read through the payment's own planId, with NO `active` filter: a
      // deactivated plan must stay fully readable on every past record.
      plan: { select: { name: true } },
    },
  });

  return periods.map((period) => ({
    id: period.id,
    year: period.year,
    month: period.month,
    status: period.status,
    planName: period.plan.name,
    // Same Decimal->number conversion Task 1's recordPayment established
    // for this field — a plain JS number, not a decimal.js instance.
    amount: period.amount?.toNumber() ?? null,
    currency: period.currency,
    notes: period.notes,
    newSystem: !fromStart(period) ? null : charged.has(`${period.year}-${period.month}`) ? "billed" : "handled",
  }));
}
