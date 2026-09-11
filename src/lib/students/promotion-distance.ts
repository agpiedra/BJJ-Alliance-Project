export interface PromotionDistanceInput {
  examEligible: boolean;
  remainingToNextStripe: number | null;
}

/**
 * Sort key for REDESIGN_BRIEF.md §4.2's "closest to promotion" default
 * roster order — smaller sorts first. Pure function over the fields
 * `getAtBeltSummary` (`@/lib/students/attendance-summary`) already computes;
 * does not reimplement or alter any belt math (Rule 8).
 *
 * - Already eligible (exam-eligible, or `remainingToNextStripe === 0`) → 0,
 *   so eligible students always lead the queue.
 * - Otherwise the raw remaining count, ascending.
 * - No computable further progress (`remainingToNextStripe` null and not
 *   exam-eligible — e.g. a belt with no exam threshold configured, such as
 *   BLACK) → `Infinity`, sorting last.
 */
export function promotionDistance({ examEligible, remainingToNextStripe }: PromotionDistanceInput): number {
  if (examEligible || remainingToNextStripe === 0) return 0;
  return remainingToNextStripe ?? Infinity;
}
