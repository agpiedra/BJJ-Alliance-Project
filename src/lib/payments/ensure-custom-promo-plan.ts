import { prisma } from "@/lib/prisma";
import { CUSTOM_PROMO_PLAN_NAME } from "@/lib/payments/custom-promo-plan-name";

export { CUSTOM_PROMO_PLAN_NAME };

/**
 * Idempotent "ensure this academy has a custom-promo plan" upsert, keyed on
 * the existing `@@unique([academyId, name])` constraint — the exact same
 * upsert shape `prisma/seed.ts` already uses for `Mensualidad`/`Promoción`/
 * `Becado`. Safe to call on every Pagos page render (Server Component, no
 * caching) rather than a one-off migration/seed script, since a second call
 * is a no-op `update: {}` against the same row.
 */
export async function ensureCustomPromoPlan(academyId: string): Promise<{ id: string; name: string }> {
  const academy = await prisma.academy.findUniqueOrThrow({ where: { id: academyId }, select: { organizationId: true } });
  return prisma.paymentPlan.upsert({
    where: { academyId_name: { academyId, name: CUSTOM_PROMO_PLAN_NAME } },
    update: {},
    create: { academyId, organizationId: academy.organizationId, name: CUSTOM_PROMO_PLAN_NAME },
    select: { id: true, name: true },
  });
}
