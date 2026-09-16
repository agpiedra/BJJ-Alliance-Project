import type { PromotionMode, Track } from "../../src/generated/prisma/client";

/**
 * MULTI_ACADEMY_AND_KIDS_BELTS.md Phase 2c-i: `getAtBeltSummary` now takes a
 * pre-resolved `configByTrack` map (see resolvePromotionConfigMap's own doc
 * comment on the N+1 this avoids) instead of looking one up internally.
 * Alliance's real seeded ADULT config is always ATTENDANCE (prisma/seed.ts) —
 * this literal matches it directly rather than round-tripping
 * resolvePromotionConfigMap in every test file that calls getAtBeltSummary,
 * the same reasoning tests/helpers/belt-ranks.ts already uses for the
 * deterministic seeded rank ids.
 */
export const ALLIANCE_ATTENDANCE_CONFIG: Map<Track, { mode: PromotionMode }> = new Map([
  ["ADULT", { mode: "ATTENDANCE" }],
]);
