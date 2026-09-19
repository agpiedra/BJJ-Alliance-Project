import { ADULT_RANKS, KIDS_RANKS, KIDS_BAR } from "@/lib/organizations/default-belt-ranks";
import { prisma } from "@/lib/prisma";
import type { PromotionMode } from "@/generated/prisma/client";

/**
 * The guarded `prisma` export is a `$extends()`-derived client, not the
 * plain base client `Prisma.TransactionClient` describes — extracting the
 * exact callback parameter type Prisma infers for
 * `prisma.$transaction(async (tx) => ...)` is what actually type-checks
 * against every real caller's `tx`, where `Prisma.TransactionClient` does not.
 */
type TransactionClient = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

/**
 * MULTI_ACADEMY_AND_KIDS_BELTS.md — the one place a new organization's
 * default branding row and both belt-rank catalogs get created. Extracted
 * from `register-academy/actions.ts`'s own `registerOrganization()` (Phase
 * 5) verbatim, byte-for-byte, when Phase 6's manual organization creation
 * needed the exact same seeding — "reusing the same idempotent approval
 * path" per the doc, applied here to registration too: two callers, one
 * function, never a second copy of this data.
 *
 * `promotionMode` defaults to `"ATTENDANCE"`, preserving `registerOrganization`'s
 * existing (untouched) behavior exactly; Phase 6's manual-creation form is
 * the only caller that ever passes something else (its own "promotion
 * preset" field — attendance / time-based / manual).
 */
export async function seedOrganizationDefaults(
  tx: TransactionClient,
  organizationId: string,
  promotionMode: PromotionMode = "ATTENDANCE",
): Promise<void> {
  await tx.organizationBranding.create({ data: { organizationId } });

  await tx.beltRank.createMany({
    data: ADULT_RANKS.map((rank) => ({
      organizationId,
      track: "ADULT" as const,
      code: rank.code,
      labelEs: rank.labelEs,
      labelEn: rank.labelEn,
      order: rank.order,
      maxStripes: rank.maxStripes,
      attendancesPerStripe: rank.attendancesPerStripe,
      attendancesForExam: rank.attendancesForExam,
      isTerminal: rank.isTerminal,
      primaryColor: rank.primaryColor,
      barColor: rank.barColor,
      stripeColors: Array.from({ length: rank.maxStripes }, () => "#FFFFFF"),
      visibleStripeSlots: 4,
    })),
  });
  await tx.promotionConfig.create({
    data: { organizationId, track: "ADULT", mode: promotionMode, requiresCoachApproval: true },
  });

  await tx.beltRank.createMany({
    data: KIDS_RANKS.map((rank) => ({
      organizationId,
      track: "KIDS" as const,
      code: rank.code,
      labelEs: rank.labelEs,
      labelEn: rank.labelEn,
      order: rank.order,
      maxStripes: rank.maxStripes,
      attendancesPerStripe: 10,
      attendancesForExam: 10,
      isTerminal: rank.isTerminal,
      primaryColor: rank.primaryColor,
      centerStripeColor: rank.centerStripeColor ?? null,
      barColor: KIDS_BAR,
      stripeColors: rank.stripeColors,
      visibleStripeSlots: 4,
    })),
  });
  await tx.promotionConfig.create({
    data: { organizationId, track: "KIDS", mode: promotionMode, requiresCoachApproval: true },
  });
}
