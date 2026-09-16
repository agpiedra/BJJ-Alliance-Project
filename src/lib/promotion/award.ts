import { prisma } from "@/lib/prisma";
import { StudentStatus, type PromotionSource, type Prisma } from "@/generated/prisma/client";
import { isAcademyInTenantScope } from "@/lib/tenant/context";
import { getScopedDb } from "@/lib/tenant/scoped-client";
import { getAtBeltSummary } from "@/lib/students/attendance-summary";
import { resolvePromotionConfigMap, resolveNextRank } from "@/lib/promotion/config";
import { InvalidPromotionConfigError } from "@/lib/promotion/engine";
import type { TenantContext } from "@/lib/tenant/types";

export type AwardResult =
  | { ok: true; kind: "stripe" | "belt" }
  | { ok: false; error: "notFound" | "notActive" | "notEligible" | "conflict" };

/**
 * Thrown inside the transaction purely to roll it back when the scoped
 * `updateMany` below matched no row — never surfaces to the caller, caught
 * immediately after the transaction and turned into `{ok:false,
 * error:"conflict"}`. Same sentinel-error convention as
 * `src/app/[locale]/(staff)/students/[id]/actions.ts`'s `StudentWriteMissError`.
 */
class PromotionConflictError extends Error {
  constructor() {
    super("PROMOTION_CONFLICT");
    this.name = "PromotionConflictError";
  }
}

export interface WriteAwardParams {
  studentId: string;
  homeAcademyId: string;
  organizationId: string;
  fromRankId: string;
  fromStripes: number;
  toRankId: string;
  toStripes: number;
  /**
   * Whatever else the caller wants written onto `Student` beyond
   * `currentRankId`/`currentStripes` — explicit, never inferred inside
   * `writeAward` itself (Phase 2d: "correction workflows must explicitly
   * determine the resulting anchors; do not infer them silently"). A
   * regular belt award passes `{ beltAwardedAt: new Date() }`; a stripe
   * award passes `{}`; a manual correction passes whatever anchors the
   * staff member explicitly chose.
   */
  studentUpdate?: { beltAwardedAt?: Date; timeAnchorAt?: Date | null };
  /** Caller-supplied audit snapshots — open-ended so a correction can record anchors alongside belt/stripes, without forcing every caller into that richer shape. */
  before: Prisma.InputJsonValue;
  after: Prisma.InputJsonValue;
  source: PromotionSource;
  awardedById: string | null;
  notes: string | null;
}

/**
 * MULTI_ACADEMY_AND_KIDS_BELTS.md Phase 2c-iii: the ONE transactional writer
 * both `awardPromotion` (manual, TenantContext) and
 * `src/lib/promotion/automation.ts` (AUTO, SystemJobContext) call — sharing
 * the write means sharing its concurrency guard too, not just its shape.
 * Each caller does its OWN read/validate/eligibility resolution first (a
 * staff HTTP action and a batch cron job have genuinely different calling
 * shapes), then hands this fully-resolved, already-decided write down.
 *
 * `result.count !== 1` here means the student's state moved between the
 * caller's read and this write — a concurrent manual confirm, another
 * automation run, or an adjustment. Returned as `{ok:false,
 * error:"conflict"}`, never thrown: for `awardPromotion` that surfaces to
 * the requesting staff member; for automation it means "skip, state moved
 * under us" — not an error to log and not a candidate to retry within the
 * same run (see automation.ts's own doc comment).
 */
export async function writeAward(params: WriteAwardParams): Promise<{ ok: true } | { ok: false; error: "conflict" }> {
  try {
    await prisma.$transaction(async (tx) => {
      await tx.promotion.create({
        data: {
          studentId: params.studentId,
          academyId: params.homeAcademyId,
          organizationId: params.organizationId,
          fromRankId: params.fromRankId,
          fromStripes: params.fromStripes,
          toRankId: params.toRankId,
          toStripes: params.toStripes,
          source: params.source,
          awardedById: params.awardedById,
          notes: params.notes || null,
        },
      });

      // Scoped by id AND the exact from-state this promotion transitions
      // out of (finding I-2) — a concurrent award/adjustment that already
      // changed the student's rank/stripes makes this match zero rows.
      // `status: ACTIVE` closes the N-1 stale-archive/pending race the same
      // way. Postgres re-evaluates this WHERE predicate after the winning
      // transaction's row lock releases, so a losing concurrent call
      // matches zero rows — that's what closes the race, not a lock this
      // code has to manage.
      const result = await tx.student.updateMany({
        where: {
          id: params.studentId,
          status: StudentStatus.ACTIVE,
          currentRankId: params.fromRankId,
          currentStripes: params.fromStripes,
        },
        data: {
          currentRankId: params.toRankId,
          currentStripes: params.toStripes,
          ...params.studentUpdate,
        },
      });

      if (result.count !== 1) {
        throw new PromotionConflictError();
      }

      await tx.auditLog.create({
        data: {
          actorId: params.awardedById,
          academyId: params.homeAcademyId,
          action: "student.promote",
          entityType: "Student",
          entityId: params.studentId,
          before: params.before,
          after: params.after,
        },
      });
    });
  } catch (error) {
    if (error instanceof PromotionConflictError) {
      return { ok: false, error: "conflict" };
    }
    throw error;
  }

  return { ok: true };
}

/**
 * MULTI_ACADEMY_AND_KIDS_BELTS.md Phase 2c-ii: the spec's "centralized
 * server-side award function." Every entry point that can award a
 * promotion calls this, and only this — `promotion-actions.ts`'s
 * `confirmPromotion` today, Phase 2d's student-detail-page card later. No
 * parallel award path, no duplicated threshold math (spec: "It is an entry
 * point, not a second system").
 *
 * `studentId` is the only caller-supplied value that drives the decision;
 * everything else (current rank, stripes, eligibility) is read fresh here,
 * never trusted from a queue snapshot or a client payload — the whole point
 * is that eligibility is recomputed at the moment of award.
 *
 * Two reads, deliberately not one (finding I-1's history): Read A is scope/
 * status only. Read B (inside getAtBeltSummary) is the SINGLE source of
 * truth for both the eligibility decision and the from-state the
 * transaction below writes against — pairing Read A's rank/stripes with a
 * separate progress read once let a concurrent write regress a student's
 * stripe count and write a false permanent record.
 */
export async function awardPromotion(
  context: TenantContext,
  studentId: string,
  notes: string | null,
): Promise<AwardResult> {
  const student = await getScopedDb(context).student.findUnique({
    where: { id: studentId },
    select: { id: true, homeAcademyId: true, organizationId: true, status: true },
  });
  if (!student || !isAcademyInTenantScope(context, student.homeAcademyId)) {
    return { ok: false, error: "notFound" };
  }

  // Final whole-branch review finding N-1: PENDING/ARCHIVED must never be
  // promoted. This check alone doesn't close the race — the transaction's
  // own `status: ACTIVE` WHERE clause below does that.
  if (student.status !== StudentStatus.ACTIVE) {
    return { ok: false, error: "notActive" };
  }

  // Read B: single source of truth for both the eligibility decision AND
  // the from-state below. A single-student call, so resolving the config
  // map here (rather than once per batch, like promotion-queue.ts) costs
  // exactly one query either way.
  const configByTrack = await resolvePromotionConfigMap(context.organizationId);
  const summary = await getAtBeltSummary(student.id, configByTrack);

  if (summary.nextTarget === "NONE" || !summary.isEligible) {
    return { ok: false, error: "notEligible" };
  }

  const kind: "stripe" | "belt" = summary.nextTarget === "STRIPE" ? "stripe" : "belt";
  const fromRankId = summary.currentRankId;
  const fromStripes = summary.currentStripes;

  let toRankId: string;
  let toStripes: number;
  let toBeltCode: string;
  if (kind === "stripe") {
    toRankId = fromRankId;
    toStripes = fromStripes + 1;
    toBeltCode = summary.currentBelt;
  } else {
    // Real catalog lookup — the org's actual configured order, not
    // eligibility.ts's old hardcoded BELT_ORDER array.
    const nextRank = await resolveNextRank(context, summary.track, summary.currentRankOrder);
    if (!nextRank) {
      // `isTerminal` and "a rank exists at order+1" are two independently
      // edited facts — only validateTrackConfig keeps them aligned, and
      // that's a config-update-time check, not a database constraint. A
      // gap in order, a catalog whose highest rank was never flagged
      // terminal, or a hand-edited row can all produce this. A real
      // org-level catalog defect — never silently write a wrong
      // promotion or crash on a null dereference.
      throw new InvalidPromotionConfigError(
        `awardPromotion: engine reported a BELT target for rank ${summary.currentBelt} (track ${summary.track}, order ${summary.currentRankOrder}), but no rank exists at order ${summary.currentRankOrder + 1}.`,
      );
    }
    toRankId = nextRank.id;
    toStripes = 0;
    toBeltCode = nextRank.code;
  }

  const result = await writeAward({
    studentId: student.id,
    homeAcademyId: student.homeAcademyId,
    organizationId: student.organizationId,
    fromRankId,
    fromStripes,
    toRankId,
    toStripes,
    studentUpdate: kind === "belt" ? { beltAwardedAt: new Date() } : {},
    before: { belt: summary.currentBelt, stripes: fromStripes },
    after: { belt: toBeltCode, stripes: toStripes },
    source: "MANUAL",
    awardedById: context.actorUserId,
    notes,
  });
  if (!result.ok) {
    return { ok: false, error: "conflict" };
  }

  return { ok: true, kind };
}
