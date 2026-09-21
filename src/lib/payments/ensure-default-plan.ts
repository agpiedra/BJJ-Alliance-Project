import { prisma } from "@/lib/prisma";
import { defaultPlanNameFor } from "@/lib/payments/default-plan-name";

/**
 * An organization that can't record a single payment on its first day is the
 * owner lockout's cousin: `approveOrganization()` created an academy and no
 * plans, so a new customer's Pagos page had nothing to pick. This gives a new
 * academy its ordinary monthly plan — named by the organization's language
 * (`defaultPlanNameFor`), with no price, since the app cannot know what the
 * academy charges; the director sets `defaultAmount` on the plans page.
 *
 * Idempotent, keyed on `@@unique([academyId, name])` like
 * `ensureCustomPromoPlan`. `update: {}` on purpose: it must never resurrect a
 * plan a director deliberately deactivated or overwrite one they edited.
 * Called when an academy is CREATED (approval, and "add a location") —
 * not on every render, so a renamed default plan doesn't grow a duplicate.
 * `db` lets a creator run it inside its own transaction, so the academy and
 * its plan commit or roll back together.
 */
export async function ensureDefaultPlan(
  organizationId: string,
  academyId: string,
  locale: string,
  db: Pick<typeof prisma, "paymentPlan"> = prisma,
): Promise<{ id: string; name: string }> {
  const name = defaultPlanNameFor(locale);
  return db.paymentPlan.upsert({
    where: { academyId_name: { academyId, name }, organizationId },
    update: {},
    create: { academyId, organizationId, name },
    select: { id: true, name: true },
  });
}
