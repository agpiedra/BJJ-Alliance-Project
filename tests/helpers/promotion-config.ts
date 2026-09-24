import type { PromotionMode, StripeAccounting, Track } from "../../src/generated/prisma/client";

type TrackConfig = { mode: PromotionMode; accounting: StripeAccounting };

/**
 * MULTI_ACADEMY_AND_KIDS_BELTS.md Phase 2c-i: `getAtBeltSummary` now takes a
 * pre-resolved `configByTrack` map (see resolvePromotionConfigMap's own doc
 * comment on the N+1 this avoids) instead of looking one up internally.
 * Alliance's real seeded ADULT config is always ATTENDANCE (prisma/seed.ts) —
 * this literal matches it directly rather than round-tripping
 * resolvePromotionConfigMap in every test file that calls getAtBeltSummary,
 * the same reasoning tests/helpers/belt-ranks.ts already uses for the
 * deterministic seeded rank ids.
 *
 * Alliance stays CUMULATIVE until scripts/promotion-accounting.ts activates it
 * (docs/PROMOTION_PROGRESS_PROPOSAL.md), so this is the pre-activation rule.
 */
export const ALLIANCE_ATTENDANCE_CONFIG: Map<Track, TrackConfig> = new Map([
  ["ADULT", { mode: "ATTENDANCE", accounting: "CUMULATIVE" }],
]);

/** The academy's decided accounting (one qualifying day per CR day, reset at every award), for both seeded tracks. */
export const ALLIANCE_PER_INTERVAL_CONFIG: Map<Track, TrackConfig> = new Map([
  ["ADULT", { mode: "ATTENDANCE", accounting: "PER_INTERVAL" }],
  ["KIDS", { mode: "ATTENDANCE", accounting: "PER_INTERVAL" }],
]);
