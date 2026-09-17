import { prisma } from "@/lib/prisma";

export type PromotionCreditHistoryEntry = {
  id: string;
  classesGranted: number;
  reason: string;
  grantedAt: Date;
  grantedByName: string;
  /** True when this row's anchor matches the student's CURRENT
   * beltAwardedAt — i.e. it's still counted by the promotion engine. False
   * means it applied to a since-superseded belt period: kept visible for
   * audit (Phase 3d point 3), but out of scope (point 2's ruling), never
   * deleted. */
  active: boolean;
};

/**
 * Same two reasons as get-promotion-history.ts's own doc comment for being a
 * plain function, not a "use server" action, kept out of the
 * client-imported actions.ts: (1) trusts `studentId` alone, safe only
 * because `page.tsx` already scope-checked it via getStudentForStaff before
 * calling this; (2) imports Prisma (Node-only), so it must stay out of any
 * file a Client Component imports from.
 */
export async function getPromotionCreditHistory(
  studentId: string,
  organizationId: string,
  currentBeltAwardedAt: Date,
): Promise<PromotionCreditHistoryEntry[]> {
  const credits = await prisma.promotionCredit.findMany({
    where: { studentId, organizationId },
    orderBy: { grantedAt: "desc" },
    select: {
      id: true,
      classesGranted: true,
      reason: true,
      grantedAt: true,
      beltAwardedAtAnchor: true,
      grantedBy: { select: { email: true } },
    },
  });

  return credits.map((credit) => ({
    id: credit.id,
    classesGranted: credit.classesGranted,
    reason: credit.reason,
    grantedAt: credit.grantedAt,
    // Same fallback convention as get-promotion-history.ts's awardedByName —
    // User has no display-name field, only email.
    grantedByName: credit.grantedBy?.email ?? "—",
    active: credit.beltAwardedAtAnchor.getTime() === currentBeltAwardedAt.getTime(),
  }));
}
