import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";

/**
 * Package isolation (PR 3). A PACKAGE plan is a `PaymentPlan` whose terms cover more than one month. It is a plan of its own, never a
 * monthly plan that later gained a package price: `config-actions` creates a package plan and its first terms in one transaction and
 * refuses to mix monthly and multi-month terms inside one plan, so the kind of a plan is fixed from its creation.
 *
 * The legacy payment flow records one calendar month against one plan and knows nothing about packages. Every legacy read or write that
 * chooses or accepts a plan therefore excludes package plans through this one definition:
 *  - `listSelectablePlans` (the picker),
 *  - `recordPayment` (server submission of a forged or stale plan id),
 *  - `markPaymentPaid` (its plan fallback),
 *  - `setPlanActive` (the "last active plan" rule, and who may toggle a package plan),
 *  - `updatePlan` (who may edit a package plan).
 * These are the only places legacy code reads the dues tables, and they only ask "does this plan have multi-month terms".
 */
export const NOT_PACKAGE_PLAN = {
  terms: { none: { monthsCovered: { gt: 1 } } },
} satisfies Prisma.PaymentPlanWhereInput;

/** True when the plan is a package plan. Scoped to the organization like every tenant read. */
export async function isPackagePlan(organizationId: string, planId: string): Promise<boolean> {
  return (await prisma.paymentPlanTerms.count({ where: { organizationId, planId, monthsCovered: { gt: 1 } } })) > 0;
}
