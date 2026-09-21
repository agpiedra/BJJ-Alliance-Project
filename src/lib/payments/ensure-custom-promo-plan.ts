import { prisma } from "@/lib/prisma";
import { Prisma } from "@/generated/prisma/client";
import { CUSTOM_PROMO_PLAN_NAMES, customPromoPlanNameFor } from "@/lib/payments/custom-promo-plan-name";

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
 */
export async function ensureCustomPromoPlan(
  organizationId: string,
  academyId: string,
): Promise<{ id: string; name: string }> {
  const select = { id: true, name: true } as const;
  const find = () =>
    prisma.paymentPlan.findFirst({
      where: { organizationId, academyId, name: { in: [...CUSTOM_PROMO_PLAN_NAMES] } },
      select,
    });

  const existing = await find();
  if (existing) return existing;

  const { defaultLocale } = await prisma.organization.findUniqueOrThrow({
    where: { id: organizationId },
    select: { defaultLocale: true },
  });
  try {
    return await prisma.paymentPlan.create({
      data: { academyId, organizationId, name: customPromoPlanNameFor(defaultLocale) },
      select,
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const raced = await find();
      if (raced) return raced;
    }
    throw error;
  }
}
