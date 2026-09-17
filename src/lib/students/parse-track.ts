import { Track } from "@/generated/prisma/client";

/**
 * MULTI_ACADEMY_AND_KIDS_BELTS.md Phase 3c-iii: the roster's track filter is
 * a URL search param, validated server-side — same rule 3c-i already
 * established for the roster's other filters, "never trust what came in on
 * the request." `undefined` means Todos (no filter), and is also the
 * fallback for anything unrecognized — never one of the two real tracks.
 *
 * Kept in its own dependency-free module (not inline in `students/page.tsx`)
 * so it can be unit-tested directly: that page transitively imports
 * `@/lib/prisma`, which requires `DATABASE_URL` at module load and cannot
 * be imported from a plain unit test.
 */
export function parseTrack(value: string | undefined): Track | undefined {
  return value === Track.KIDS || value === Track.ADULT ? value : undefined;
}
