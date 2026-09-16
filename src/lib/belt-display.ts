/**
 * MULTI_ACADEMY_AND_KIDS_BELTS.md Phase 3b — the ONE shared derivation
 * between BeltGraphic and BeltBar (spec: "Do not maintain separate
 * tape-counting implementations"). A kids belt can hold up to 11 degrees,
 * but the physical bar only ever shows `visibleStripeSlots` (4) tapes —
 * new tapes replace older ones, so this is a rolling window over the
 * earned stripeColors, not a raw slice.
 *
 * Validates degrees/visibleStripeSlots defensively: a malformed value here
 * must never produce unexpected tapes (negative array length, etc.).
 */
export interface TapeRank {
  stripeColors: string[];
  maxStripes: number;
  visibleStripeSlots: number;
}

export function visibleTapes(rank: TapeRank, degrees: number): string[] {
  if (!Number.isInteger(degrees) || degrees <= 0) return [];
  const slots =
    Number.isInteger(rank.visibleStripeSlots) && rank.visibleStripeSlots > 0 ? rank.visibleStripeSlots : 4;
  const earned = rank.stripeColors.slice(0, Math.min(degrees, rank.maxStripes));
  return earned.slice(-slots);
}
