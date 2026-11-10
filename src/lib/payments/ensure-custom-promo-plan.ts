import { prisma } from "@/lib/prisma";
import { Prisma } from "@/generated/prisma/client";
import { CUSTOM_PROMO_PLAN_NAMES, customPromoPlanNameFor } from "@/lib/payments/custom-promo-plan-name";
import { isLockTimeout, lockOrganizationGateWithTimeout, PAGE_LOAD_GATE_TIMEOUT_MS } from "@/lib/dues/activation-gate";

/**
 * Idempotent "ensure this academy has a custom-promo plan". Safe to call on
 * every Pagos page render (Server Component, no caching): once the plan exists
 * a call is a single read.
 *
 * The plan is looked up under EVERY language's name first, so an academy whose
 * row was made in the other language (or before the name followed the
 * organization's language) keeps that row instead of gaining a second promo
 * plan. Only when none exists is one created, named from
 * `Organization.defaultLocale` — the same rule as the default monthly plan.
 * The `@@unique([academyId, name])` constraint settles a concurrent first
 * render: the loser re-reads the winner's row.
 *
 * Stage 9 rule 7 (page-load writer): the create takes the organization gate first, with a short wait. Once the ledger is
 * active, or when the wait runs out, nothing is created and this returns null; the page renders anyway (callers ignore the
 * return value).
 */
export async function ensureCustomPromoPlan(organizationId: string, academyId: string): Promise<{ id: string; name: string } | null> {
  const select = { id: true, name: true } as const;
  const find = () =>
    prisma.paymentPlan.findFirst({
      where: { organizationId, academyId, name: { in: [...CUSTOM_PROMO_PLAN_NAMES] } },
      select,
    });

  const existing = await find();
  if (existing) return existing;

  try {
    return await prisma.$transaction(async (tx) => {
      const gate = await lockOrganizationGateWithTimeout(tx, organizationId, PAGE_LOAD_GATE_TIMEOUT_MS);
      if (!gate || gate.active) return null;
      const { defaultLocale } = await tx.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { defaultLocale: true } });
      return tx.paymentPlan.create({
        data: { academyId, organizationId, name: customPromoPlanNameFor(defaultLocale) },
        select,
      });
    });
  } catch (error) {
    if (isLockTimeout(error)) return null;
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const raced = await find();
      if (raced) return raced;
    }
    throw error;
  }
}
