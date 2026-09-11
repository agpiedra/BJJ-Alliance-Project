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

export interface PromotionSortRow {
  distance: number;
  lastName: string;
  firstName: string;
}

/**
 * `Array.sort` comparator for the roster's default order. `promotionDistance`
 * can return `Infinity` for two different students (no computable further
 * progress) — `Infinity - Infinity` is `NaN`, not a valid comparator result,
 * so both sides are clamped to `Number.MAX_SAFE_INTEGER` before subtracting.
 * Falls through to the roster's previous default order (lastName, then
 * firstName) so equal-distance rows never reshuffle between reloads.
 */
export function compareByPromotion(a: PromotionSortRow, b: PromotionSortRow): number {
  const clamp = (value: number) => (Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER);
  const diff = clamp(a.distance) - clamp(b.distance);
  if (diff !== 0) return diff;
  const lastNameDiff = a.lastName.localeCompare(b.lastName);
  if (lastNameDiff !== 0) return lastNameDiff;
  return a.firstName.localeCompare(b.firstName);
}
