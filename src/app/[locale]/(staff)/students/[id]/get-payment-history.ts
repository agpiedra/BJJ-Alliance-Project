import { prisma } from "@/lib/prisma";
import type { PaymentStatus } from "@/generated/prisma/client";

export type PaymentHistoryEntry = {
  id: string;
  year: number;
  month: number;
  status: PaymentStatus;
  planName: string;
  amount: number | null;
  notes: string | null;
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
export async function getPaymentHistory(studentId: string): Promise<PaymentHistoryEntry[]> {
  const periods = await prisma.paymentPeriod.findMany({
    where: { studentId },
    orderBy: [{ year: "desc" }, { month: "desc" }],
    select: {
      id: true,
      year: true,
      month: true,
      status: true,
      amount: true,
      notes: true,
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
    notes: period.notes,
  }));
}
