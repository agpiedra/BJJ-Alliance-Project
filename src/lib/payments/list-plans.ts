import { prisma } from "@/lib/prisma";
import { NOT_PACKAGE_PLAN } from "@/lib/dues/package-plans";

export type SelectablePlan = {
  id: string;
  name: string;
  academyId: string;
  /** What this plan normally costs, or null when it has no standard price. */
  defaultAmount: number | null;
};

/**
 * The plans a director may pick for a NEW payment: active ones only. This is
 * the one place that rule lives — the Pagos page and the student page both
 * used to carry their own inline copy of this query. A deactivated plan
 * vanishes from every picker here, yet stays fully readable on every past
 * record, because history reads a plan through the payment's own `planId`
 * relation, never through this list.
 *
 * Package plans (multi-month terms, see `dues/package-plans.ts`) are never listed: the legacy flow records one month against one plan.
 *
 * Plain function, not a server action: it trusts its arguments and is called
 * only from pages that have already scoped `academyIds` to the session.
 */
export async function listSelectablePlans(organizationId: string, academyIds: string[]): Promise<SelectablePlan[]> {
  const plans = await prisma.paymentPlan.findMany({
    where: { organizationId, academyId: { in: academyIds }, active: true, ...NOT_PACKAGE_PLAN },
    orderBy: { name: "asc" },
    select: { id: true, name: true, academyId: true, defaultAmount: true },
  });
  return plans.map((plan) => ({ ...plan, defaultAmount: plan.defaultAmount?.toNumber() ?? null }));
}

export type ManagedPlan = SelectablePlan & {
  description: string | null;
  active: boolean;
  /** How many payment records sit on this plan — why "delete" doesn't exist. */
  paymentCount: number;
  /** A multi-month package plan (owner-configured; never offered to the legacy payment flow). */
  isPackage: boolean;
};

/** Every plan for the management page — active AND deactivated — with how
 * much history each one carries. Package plans are the owner's: a caller that is not an owner passes `includePackages: false`. */
export async function listPlansForManagement(
  organizationId: string,
  academyIds: string[],
  { includePackages = true }: { includePackages?: boolean } = {},
): Promise<ManagedPlan[]> {
  const plans = await prisma.paymentPlan.findMany({
    where: { organizationId, academyId: { in: academyIds }, ...(includePackages ? {} : NOT_PACKAGE_PLAN) },
    orderBy: [{ active: "desc" }, { name: "asc" }],
    select: {
      id: true,
      name: true,
      academyId: true,
      description: true,
      defaultAmount: true,
      active: true,
      _count: { select: { paymentPeriods: true, terms: { where: { monthsCovered: { gt: 1 } } } } },
    },
  });
  return plans.map(({ _count, ...plan }) => ({
    ...plan,
    defaultAmount: plan.defaultAmount?.toNumber() ?? null,
    paymentCount: _count.paymentPeriods,
    isPackage: _count.terms > 0,
  }));
}
