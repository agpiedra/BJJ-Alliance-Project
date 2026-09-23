import { prisma } from "@/lib/prisma";
import { StudentStatus, type PromotionSource, type Track, type Prisma } from "@/generated/prisma/client";
import { isAcademyInTenantScope } from "@/lib/tenant/context";
import { getScopedDb } from "@/lib/tenant/scoped-client";
import { evaluateStudentProgress, getAtBeltSummary } from "@/lib/students/attendance-summary";
import { resolvePromotionConfigMap, resolveNextRank, type ResolvedTrackConfig } from "@/lib/promotion/config";
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

/** Rolls the transaction back when the in-transaction eligibility re-check says the student is no longer eligible. */
class PromotionNotEligibleError extends Error {
  constructor() {
    super("PROMOTION_NOT_ELIGIBLE");
    this.name = "PromotionNotEligibleError";
  }
}

/**
 * Every promotion is awarded by an instructor (academy decision,
 * docs/PROMOTION_PROGRESS_PROPOSAL.md). `PromotionSource.AUTO` remains in the
 * enum only so historical rows stay readable; nothing may write a new one.
 * Enforced here - the single transactional writer - not merely by removing the
 * scheduled job, so no future caller can quietly bring automatic awards back.
 */
export class AutomaticPromotionError extends Error {
  constructor() {
    super("Automatic promotions are not supported: every promotion is awarded by an instructor.");
    this.name = "AutomaticPromotionError";
  }
}

export type AwardTransaction = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

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
   * `currentRankId`/`currentStripes` and the progress fields below — explicit,
   * never inferred inside `writeAward` itself (Phase 2d: "correction workflows
   * must explicitly determine the resulting anchors; do not infer them
   * silently"). A regular belt award passes `{ beltAwardedAt: new Date() }`; a
   * stripe award passes `{}`; a manual correction passes whatever anchors the
   * staff member explicitly chose.
   */
  studentUpdate?: { beltAwardedAt?: Date; timeAnchorAt?: Date | null; track?: Track };
  /**
   * What this write does to the student's PROGRESS interval:
   *  - "reset": a real promotion (award, track change). Progress restarts at 0
   *    from the exact award instant; `progressBaselineAt` and (for time-based
   *    ranks) `timeAnchorAt` are both set to it, and it is saved as the
   *    promotion's own `awardedAt`. The class(es) attended before it belong to
   *    the completed interval - nothing carries over.
   *  - "keep": a correction of a mistaken record. It is not a promotion, so it
   *    never restarts progress (the coach explicitly chooses any anchors).
   */
  progress: "reset" | "keep";
  /**
   * Runs INSIDE the transaction, after the student row is locked and confirmed
   * to still be in the from-state, with the award instant. It re-evaluates
   * eligibility against the evidence as of that instant and returns what to
   * audit - or refuses. This is what makes "eligible" mean eligible at the
   * moment of the write, not at some earlier read.
   */
  verifyEligibility?: (
    tx: AwardTransaction,
    boundaryAt: Date,
  ) => Promise<{ ok: true; evidence: Prisma.InputJsonValue } | { ok: false }>;
  /** Caller-supplied audit snapshots — open-ended so a correction can record anchors alongside belt/stripes, without forcing every caller into that richer shape. */
  before: Prisma.InputJsonValue;
  after: Prisma.InputJsonObject;
  source: PromotionSource;
  awardedById: string | null;
  notes: string | null;
  /** Phase 3c-ii: changeTrack() passes "student.trackChange" so a track change is distinguishable in the audit log from a regular promotion — every other caller relies on the default. */
  auditAction?: string;
}

/**
 * MULTI_ACADEMY_AND_KIDS_BELTS.md Phase 2c-iii: the ONE transactional writer
 * every award path (manual award, correction, track change) calls — sharing the
 * write means sharing its concurrency guard too, not just its shape. Each
 * caller does its OWN read/validate/eligibility resolution first, then hands
 * this fully-resolved, already-decided write down.
 *
 * Order inside the transaction: (1) lock the student row, (2) confirm it is
 * still ACTIVE and in the from-state, (3) choose the award instant while
 * holding the lock, (4) re-verify eligibility as of that instant, (5) write the
 * promotion, the student update and the audit row. `{ok:false, error:"conflict"}`
 * means the student's state moved (a concurrent award or correction); it is
 * returned, never thrown - for `awardPromotion` it surfaces to the requesting
 * staff member.
 *
 * The award instant is chosen by the application clock while the lock is held,
 * and is never earlier than one millisecond after the previous boundary. It is
 * NOT the commit time. A row whose `occurredAt` is before it belongs to the
 * interval being closed even if it commits afterwards (late-recorded
 * attendance stays in history and adds nothing to the next interval).
 */
export async function writeAward(
  params: WriteAwardParams,
): Promise<{ ok: true } | { ok: false; error: "conflict" | "notEligible" }> {
  if (params.source === "AUTO") {
    throw new AutomaticPromotionError();
  }

  try {
    await prisma.$transaction(async (tx) => {
      // (1) + (2): an explicit row lock, so the read below and the writes after it
      // are one atomic step against every other award/correction on this student.
      // Raw SQL is outside the tenant guard, so the organization is pinned by hand.
      const locked = await tx.$queryRaw<
        Array<{ currentRankId: string; currentStripes: number; status: string; progressBaselineAt: Date }>
      >`SELECT "currentRankId", "currentStripes", "status", "progressBaselineAt"
        FROM "Student"
        WHERE "id" = ${params.studentId} AND "organizationId" = ${params.organizationId}
        FOR UPDATE`;
      const row = locked[0];
      if (
        !row ||
        row.status !== StudentStatus.ACTIVE ||
        row.currentRankId !== params.fromRankId ||
        row.currentStripes !== params.fromStripes
      ) {
        throw new PromotionConflictError();
      }

      // (3) The award boundary: now, but strictly after the previous boundary so
      // intervals never overlap or touch, even with clock skew or two awards in
      // the same millisecond.
      const boundaryAt = new Date(Math.max(Date.now(), row.progressBaselineAt.getTime() + 1));

      // (4) Eligibility as of the boundary, from the same transaction.
      let evidence: Prisma.InputJsonValue | undefined;
      if (params.verifyEligibility) {
        const verdict = await params.verifyEligibility(tx, boundaryAt);
        if (!verdict.ok) throw new PromotionNotEligibleError();
        evidence = verdict.evidence;
      }

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
          // The exact saved timestamp of the promotion.
          awardedAt: boundaryAt,
        },
      });

      // Scoped by id AND the exact from-state this promotion transitions
      // out of (finding I-2) — belt and braces with the lock above.
      // `status: ACTIVE` closes the N-1 stale-archive/pending race the same way.
      const result = await tx.student.updateMany({
        where: {
          id: params.studentId,
          organizationId: params.organizationId,
          status: StudentStatus.ACTIVE,
          currentRankId: params.fromRankId,
          currentStripes: params.fromStripes,
        },
        data: {
          currentRankId: params.toRankId,
          currentStripes: params.toStripes,
          ...(params.progress === "reset"
            ? { progressBaselineAt: boundaryAt, progressBaselineKind: "AWARD" as const, timeAnchorAt: boundaryAt }
            : {}),
          ...params.studentUpdate,
        },
      });

      if (result.count !== 1) {
        throw new PromotionConflictError();
      }

      await tx.auditLog.create({
        data: {
          actorId: params.awardedById,
          organizationId: params.organizationId,
          academyId: params.homeAcademyId,
          action: params.auditAction ?? "student.promote",
          entityType: "Student",
          entityId: params.studentId,
          before: params.before,
          after: {
            ...params.after,
            boundaryAt: boundaryAt.toISOString(),
            progressReset: params.progress === "reset",
            ...(evidence !== undefined ? { evidence } : {}),
          },
        },
      });
    });
  } catch (error) {
    if (error instanceof PromotionConflictError) {
      return { ok: false, error: "conflict" };
    }
    if (error instanceof PromotionNotEligibleError) {
      return { ok: false, error: "notEligible" };
    }
    throw error;
  }

  return { ok: true };
}

/**
 * MULTI_ACADEMY_AND_KIDS_BELTS.md Phase 2c-ii: the spec's "centralized
 * server-side award function." Every entry point that can award a
 * promotion calls this, and only this — `promotion-actions.ts`'s
 * `confirmPromotion`, the student-detail-page card. No parallel award path, no
 * duplicated threshold math (spec: "It is an entry point, not a second system").
 *
 * `studentId` is the only caller-supplied value that drives the decision;
 * everything else (current rank, stripes, eligibility) is read fresh here,
 * never trusted from a queue snapshot or a client payload — the whole point
 * is that eligibility is recomputed at the moment of award.
 *
 * Two evaluations, deliberately: the first (before the transaction) resolves
 * which target the student is being promoted to; the second runs INSIDE the
 * transaction under the student row lock (`verifyEligibility`), as of the award
 * instant, and its evidence - the qualifying days that made the student
 * eligible - is what the audit row records. A later correction to attendance
 * never revokes a promotion already written; the coach explicitly corrects an
 * award if it was wrong.
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
  // own row lock and `status: ACTIVE` WHERE clause do that.
  if (student.status !== StudentStatus.ACTIVE) {
    return { ok: false, error: "notActive" };
  }

  // A single-student call, so resolving the config map here (rather than once
  // per batch, like promotion-queue.ts) costs exactly one query either way.
  const configByTrack = await resolvePromotionConfigMap(context.organizationId);
  const summary = await getAtBeltSummary(student.id, context.organizationId, configByTrack);

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
    // A belt award restarts the belt's historical date; both kinds restart progress (writeAward).
    studentUpdate: kind === "belt" ? { beltAwardedAt: new Date() } : {},
    progress: "reset",
    verifyEligibility: (tx, boundaryAt) =>
      verifyEligibilityAt(tx, {
        studentId: student.id,
        organizationId: student.organizationId,
        configByTrack,
        boundaryAt,
        expected: summary.nextTarget,
      }),
    before: { belt: summary.currentBelt, stripes: fromStripes },
    after: { belt: toBeltCode, stripes: toStripes },
    source: "MANUAL",
    awardedById: context.actorUserId,
    notes,
  });
  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  return { ok: true, kind };
}

/**
 * The in-transaction re-check `awardPromotion` hands `writeAward`: evaluates the
 * student as of the award instant (qualifying days strictly before it) and
 * returns the audited evidence. Refuses when the student is no longer eligible
 * for the SAME target that was resolved before the transaction.
 */
async function verifyEligibilityAt(
  tx: AwardTransaction,
  args: {
    studentId: string;
    organizationId: string;
    configByTrack: Map<Track, ResolvedTrackConfig>;
    boundaryAt: Date;
    expected: "STRIPE" | "BELT" | "NONE";
  },
): Promise<{ ok: true; evidence: Prisma.InputJsonValue } | { ok: false }> {
  const { summary, days } = await evaluateStudentProgress(tx, args.studentId, args.organizationId, args.configByTrack, {
    at: args.boundaryAt,
  });
  if (!summary.isEligible || summary.nextTarget !== args.expected) {
    return { ok: false };
  }
  return {
    ok: true,
    evidence: {
      accounting: summary.accounting,
      mode: summary.mode,
      target: summary.target,
      count: summary.atBeltCount,
      baselineAt: summary.progressBaselineAt.toISOString(),
      dueDate: summary.dueDate ? summary.dueDate.toISOString() : null,
      // One entry per qualifying day: the day, and the attendance record that was that day's contribution.
      days: days.map((day) => ({ day: day.day, recordId: day.recordId })),
    },
  };
}
