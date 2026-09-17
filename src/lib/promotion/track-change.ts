import { StudentStatus, type Track } from "@/generated/prisma/client";
import { isAcademyInTenantScope } from "@/lib/tenant/context";
import { getScopedDb } from "@/lib/tenant/scoped-client";
import { writeAward } from "@/lib/promotion/award";
import type { TenantContext } from "@/lib/tenant/types";

export interface TrackChangeInput {
  studentId: string;
  toRankId: string;
  toStripes: number;
  /**
   * Required exactly when there's no preselected destination (the same
   * condition `resolveDefaultTrackChangeRankId` gates on) — optional only
   * on the standard green_black -> adult blue path. If the operator had to
   * pick a destination themselves, they should say why: someone reading
   * this student's history in two years will want to know why a kid left
   * the kids track from yellow, not just that they did.
   */
  note: string | null;
}

export type TrackChangeResult =
  | { ok: true }
  | { ok: false; error: "notFound" | "notActive" | "invalidTarget" | "noteRequired" | "conflict" };

function otherTrack(track: Track): Track {
  return track === "ADULT" ? "KIDS" : "ADULT";
}

/** Same condition `resolveDefaultTrackChangeRankId` gates its preselection on — kept as one predicate so the note rule and the preselection rule can never drift apart. */
function isStandardTrackChangePath(currentTrack: Track, currentRankCode: string): boolean {
  return currentTrack === "KIDS" && currentRankCode === "green_black";
}

/**
 * MULTI_ACADEMY_AND_KIDS_BELTS.md: "from green_black a student moves to the
 * adult blue belt, not white" — but ONLY from green_black. Any other kids
 * rank (or any adult->kids change) gets no preselection at all: "the
 * default just shouldn't be wrong" means no default is safer than a wrong
 * one, not that there's always one. Pure and UI-framework-free so it's
 * testable without rendering the student-detail page.
 */
export function resolveDefaultTrackChangeRankId(
  currentTrack: Track,
  currentRankCode: string,
  destinationRankOptions: { id: string; code: string }[],
): string | null {
  if (!isStandardTrackChangePath(currentTrack, currentRankCode)) return null;
  return destinationRankOptions.find((rank) => rank.code === "BLUE")?.id ?? null;
}

/**
 * MULTI_ACADEMY_AND_KIDS_BELTS.md Phase 3c-ii: "Changing an existing
 * student's track requires explicit selection of the destination rank,
 * degree count, and anchor policy... Never infer anchors silently."
 *
 * Its own function, not a flag on `correctPromotion` or `awardPromotion` —
 * `correctPromotion`'s destination-rank lookup is hard-scoped to
 * `track: student.track` (by design: a correction never leaves the
 * student's current track), so it structurally cannot express a track
 * change. The destination track is always "the other one" — derived here,
 * never accepted from the caller — since only two tracks exist and a track
 * "change" that lands back on the student's current track isn't one.
 *
 * Shares `writeAward` as the one transactional writer (same concurrency
 * guard as every other award path), tagged with its own `PromotionSource`
 * (`TRACK_CHANGE`, distinct from `CORRECTION` — a track change is a
 * deliberate, expected transition, not a mistake being corrected) and its
 * own audit action (`student.trackChange`, distinct from the default
 * `student.promote`).
 *
 * `beltAwardedAt` is set to now, same as any other belt award — a track
 * change puts the student on a brand-new belt, so the cumulative-attendance
 * rule (`Alliance counts promotion-relevant attendance since
 * Student.beltAwardedAt`) should restart counting from this moment, exactly
 * as it would for a same-track belt promotion.
 */
export async function changeTrack(context: TenantContext, input: TrackChangeInput): Promise<TrackChangeResult> {
  const student = await getScopedDb(context).student.findUnique({
    where: { id: input.studentId },
    select: {
      id: true,
      homeAcademyId: true,
      organizationId: true,
      status: true,
      track: true,
      currentRankId: true,
      currentStripes: true,
      currentRank: { select: { code: true } },
    },
  });
  if (!student || !isAcademyInTenantScope(context, student.homeAcademyId)) {
    return { ok: false, error: "notFound" };
  }
  if (student.status !== StudentStatus.ACTIVE) {
    return { ok: false, error: "notActive" };
  }

  // Same principle as the preselection rule: the happy path (green_black ->
  // adult blue) is frictionless, the off-path case is documented. An
  // operator who had to pick a destination themselves should say why.
  if (!isStandardTrackChangePath(student.track, student.currentRank.code) && !input.note?.trim()) {
    return { ok: false, error: "noteRequired" };
  }

  const toTrack = otherTrack(student.track);

  const toRank = await getScopedDb(context).beltRank.findFirst({
    where: { id: input.toRankId, track: toTrack },
    select: { code: true, maxStripes: true },
  });
  if (!toRank || input.toStripes < 0 || input.toStripes > toRank.maxStripes) {
    return { ok: false, error: "invalidTarget" };
  }

  const result = await writeAward({
    studentId: student.id,
    homeAcademyId: student.homeAcademyId,
    organizationId: student.organizationId,
    fromRankId: student.currentRankId,
    fromStripes: student.currentStripes,
    toRankId: input.toRankId,
    toStripes: input.toStripes,
    studentUpdate: { track: toTrack, beltAwardedAt: new Date() },
    before: { belt: student.currentRank.code, stripes: student.currentStripes, track: student.track },
    after: { belt: toRank.code, stripes: input.toStripes, track: toTrack },
    source: "TRACK_CHANGE",
    awardedById: context.actorUserId,
    notes: input.note,
    auditAction: "student.trackChange",
  });

  if (!result.ok) return { ok: false, error: "conflict" };
  return { ok: true };
}
