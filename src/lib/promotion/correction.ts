import { StudentStatus } from "@/generated/prisma/client";
import { isAcademyInTenantScope } from "@/lib/tenant/context";
import { getScopedDb } from "@/lib/tenant/scoped-client";
import { writeAward } from "@/lib/promotion/award";
import type { TenantContext } from "@/lib/tenant/types";

export interface CorrectionInput {
  studentId: string;
  toRankId: string;
  toStripes: number;
  /** Explicit override — omitted means "leave beltAwardedAt as it is," never "set it to now." */
  beltAwardedAt?: Date;
  /** Explicit override, `null` explicitly clears it — omitted means "leave timeAnchorAt as it is." */
  timeAnchorAt?: Date | null;
  note: string;
}

export type CorrectionResult =
  | { ok: true }
  | { ok: false; error: "notFound" | "notActive" | "invalidTarget" | "noteRequired" | "conflict" };

/**
 * MULTI_ACADEMY_AND_KIDS_BELTS.md Phase 2d: "ADMIN/DIRECTOR may manually
 * promote or correct a mistaken promotion with a required note... Correction
 * workflows must explicitly determine the resulting anchors. Do not infer
 * them silently."
 *
 * Deliberately NOT `awardPromotion` with a bypass flag: a correction doesn't
 * compute "the next eligible target" from the engine at all — the staff
 * member picks the exact resulting rank/stripes/anchors themselves, which is
 * a genuinely different operation (explicit override vs. computed
 * advancement), matching `PromotionSource.CORRECTION` being its own value
 * distinct from `MANUAL`. What IS shared is the one thing that actually
 * carries risk: `writeAward`'s transactional write and its from-state
 * concurrency guard. Never eligibility-gated — that's the entire point of a
 * correction.
 */
export async function correctPromotion(context: TenantContext, input: CorrectionInput): Promise<CorrectionResult> {
  if (!input.note.trim()) {
    return { ok: false, error: "noteRequired" };
  }

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

  const toRank = await getScopedDb(context).beltRank.findFirst({
    where: { id: input.toRankId, track: student.track },
    select: { code: true, maxStripes: true },
  });
  if (!toRank || input.toStripes < 0 || input.toStripes > toRank.maxStripes) {
    return { ok: false, error: "invalidTarget" };
  }

  const studentUpdate: { beltAwardedAt?: Date; timeAnchorAt?: Date | null } = {};
  if (input.beltAwardedAt !== undefined) studentUpdate.beltAwardedAt = input.beltAwardedAt;
  if (input.timeAnchorAt !== undefined) studentUpdate.timeAnchorAt = input.timeAnchorAt;

  const result = await writeAward({
    studentId: student.id,
    homeAcademyId: student.homeAcademyId,
    organizationId: student.organizationId,
    fromRankId: student.currentRankId,
    fromStripes: student.currentStripes,
    toRankId: input.toRankId,
    toStripes: input.toStripes,
    studentUpdate,
    // A correction fixes a mistaken record - it is not a promotion, so it never
    // restarts progress. Any anchors it changes are the coach's explicit choice
    // above (this is also how an existing black belt's real last-award date is supplied).
    progress: "keep",
    before: {
      belt: student.currentRank.code,
      stripes: student.currentStripes,
      ...(input.beltAwardedAt !== undefined ? { beltAwardedAtChanged: true } : {}),
      ...(input.timeAnchorAt !== undefined ? { timeAnchorAtChanged: true } : {}),
    },
    after: { belt: toRank.code, stripes: input.toStripes },
    source: "CORRECTION",
    awardedById: context.actorUserId,
    notes: input.note,
  });

  if (!result.ok) return { ok: false, error: "conflict" };
  return { ok: true };
}
