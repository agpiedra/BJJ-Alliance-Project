/**
 * MULTI_ACADEMY_AND_KIDS_BELTS.md Phase 2 — every integration test that
 * creates a `Student` or `Promotion` fixture now needs a real
 * `currentRankId`/`fromRankId`/`toRankId` (required FK, no more `currentBelt`
 * enum). The 5 adult ranks are seeded under the shared Alliance organization
 * (`prisma/seed.ts`) at fixed, deterministic ids — this mirrors that same
 * `adultRankId` function so tests never need a DB round trip just to resolve
 * a belt code to its row id.
 *
 * Only valid for fixtures created under the seeded Alliance organization
 * (or any organization/academy nested under it — the ids are global, not
 * per-academy). A test that creates its own fresh scratch ORGANIZATION (not
 * just a scratch academy) and needs a student/promotion under it would need
 * its own BeltRank rows — none of the current test suite does this.
 */
export type BeltCode = "WHITE" | "BLUE" | "PURPLE" | "BROWN" | "BLACK";

export function adultRankId(code: BeltCode): string {
  return `seed-belt-rank-adult-${code.toLowerCase()}`;
}

/**
 * MULTI_ACADEMY_AND_KIDS_BELTS.md Phase 3a — mirrors `adultRankId` for the
 * 13 seeded KIDS ranks (prisma/seed.ts's `kidsRankId`, same id scheme).
 */
export type KidsBeltCode =
  | "white"
  | "grey_white"
  | "grey"
  | "grey_black"
  | "yellow_white"
  | "yellow"
  | "yellow_black"
  | "orange_white"
  | "orange"
  | "orange_black"
  | "green_white"
  | "green"
  | "green_black";

export function kidsRankId(code: KidsBeltCode): string {
  return `seed-belt-rank-kids-${code}`;
}
