import { prisma } from "@/lib/prisma";

/**
 * MULTI_ACADEMY_AND_KIDS_BELTS.md Phase 3d — same ±1000 ceiling and
 * reasoning as adjustment-actions.ts's DELTA_LIMIT: the largest legitimate
 * single grant/correction imaginable (backfilling a belt's worth of
 * classes) is well inside this bound, and without one an out-of-int4 value
 * reaches Prisma as an unhandled 500 instead of a graceful field error.
 */
export const CREDIT_DELTA_LIMIT = 1000;

/**
 * Sums every `PromotionCredit` row scoped to the student's CURRENT belt
 * period (`beltAwardedAtAnchor` matching the `beltAwardedAt` passed in) —
 * never the student's whole history. A credit granted for a since-superseded
 * belt period has a different anchor and is excluded by this query alone;
 * see PromotionCredit's own schema doc comment for why that's sufficient
 * (no separate "consumed" flag or delete needed).
 *
 * Raw `prisma`, not `getScopedDb` — matches attendance-summary.ts's own
 * `prisma.attendanceRecord.aggregate` convention: this takes `organizationId`
 * directly rather than a full `AccessContext`, and the guard is satisfied by
 * `organizationId` appearing directly in `where`.
 */
export async function sumPromotionCredits(
  studentId: string,
  organizationId: string,
  beltAwardedAt: Date,
): Promise<number> {
  const agg = await prisma.promotionCredit.aggregate({
    where: { studentId, organizationId, beltAwardedAtAnchor: beltAwardedAt },
    _sum: { classesGranted: true },
  });
  return agg._sum.classesGranted ?? 0;
}
