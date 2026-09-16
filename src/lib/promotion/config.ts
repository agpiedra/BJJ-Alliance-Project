import { prisma } from "@/lib/prisma";
import { getScopedDb } from "@/lib/tenant/scoped-client";
import type { AccessContext, TenantContext } from "@/lib/tenant/types";
import type { PromotionMode, Track } from "@/generated/prisma/client";

export interface ResolvedTrackConfig {
  mode: PromotionMode;
}

/**
 * MULTI_ACADEMY_AND_KIDS_BELTS.md Phase 2c-i: one query per organization —
 * at most one row per Track (today ADULT only; KIDS once Phase 3 seeds it)
 * — never one per student. `getAtBeltSummary` needs a track's active mode
 * for every student it evaluates; a lookup inside that per-student function
 * would be an N+1 on every list surface (the promotion queue, the roster
 * page, the dashboard) — 300 extra queries on a real roster, invisible at
 * Alliance's seeded 25 students. Callers that evaluate many students in one
 * request must resolve this ONCE up front and pass the same map to every
 * `getAtBeltSummary` call.
 */
export interface NextRank {
  id: string;
  code: string;
  labelEs: string;
  labelEn: string;
}

/**
 * MULTI_ACADEMY_AND_KIDS_BELTS.md Phase 2c-ii: the real, organization-
 * configured catalog lookup that replaces eligibility.ts's old hardcoded
 * `BELT_ORDER` array. Returns `null` when no rank exists at `order + 1` —
 * `isTerminal` and "a rank exists at the next order" are two independently
 * edited facts kept aligned only by `validateTrackConfig` at config-update
 * time, not by a database constraint, so a gap is a real possibility, not
 * a defensive-programming exercise. Callers decide how to handle `null`:
 * `award.ts` (a write path) throws `InvalidPromotionConfigError`;
 * `dashboard/page.tsx` (a read/display path) degrades gracefully instead —
 * a broken catalog shouldn't take down the whole dashboard for every
 * viewer over one row's display text.
 */
export async function resolveNextRank(
  context: AccessContext,
  track: Track,
  currentOrder: number,
): Promise<NextRank | null> {
  return getScopedDb(context).beltRank.findFirst({
    where: { track, order: currentOrder + 1 },
    select: { id: true, code: true, labelEs: true, labelEn: true },
  });
}

export async function resolvePromotionConfigMap(organizationId: string): Promise<Map<Track, ResolvedTrackConfig>> {
  const rows = await prisma.promotionConfig.findMany({
    where: { organizationId },
    select: { track: true, mode: true },
  });
  return new Map(rows.map((row) => [row.track, { mode: row.mode }]));
}

/**
 * Not wired to a caller yet — Phase 4 builds the director-facing config
 * screen that calls `updateTrackConfig`. Listed in
 * `scripts/pending-callers.ts` in the meantime; see that file for why this
 * isn't a `check:guard-usage` concern (this is domain logic, not a security
 * guard with nothing exercising it).
 */

export interface RankForValidation {
  id: string;
  code: string;
  order: number;
  isTerminal: boolean;
  maxStripes: number;
  attendancesPerStripe: number | null;
  attendancesForExam: number | null;
  monthsPerStripe: number | null;
  monthsForExam: number | null;
  stripeColors: string[];
  visibleStripeSlots: number;
}

/**
 * Pure validation over the FULL resolved rank set for one track, plus that
 * track's active mode. Returns human-readable error strings; empty means
 * valid. Deliberately takes the already-merged rank list rather than a
 * partial patch — `updateTrackConfig` is responsible for resolving "what the
 * rank set looks like after this update" before calling this, so validation
 * always sees the real, complete picture a switch would leave behind.
 *
 * A terminal rank (BLACK, today) is always exempt from the exam-threshold
 * fields — there is no belt beyond it, ever. It is exempt from the
 * per-stripe fields too only when maxStripes is 0 (Alliance's seeded BLACK
 * has no degrees at all); a terminal rank tracked with real degrees (e.g.
 * black belt 1st-6th) still needs a per-stripe threshold, or it would be
 * frozen at zero progress forever (2b's engine has the same rule — see
 * src/lib/promotion/engine.ts's resolveNextTarget).
 */
export function validateTrackConfig(ranks: RankForValidation[], mode: PromotionMode): string[] {
  const errors: string[] = [];

  if (ranks.length === 0) {
    return ["A track must have at least one rank."];
  }

  const sorted = [...ranks].sort((a, b) => a.order - b.order);
  const seenOrders = new Set<number>();
  const seenCodes = new Set<string>();
  const needsAttendance = mode === "ATTENDANCE" || mode === "HYBRID";
  const needsTime = mode === "TIME" || mode === "HYBRID";

  sorted.forEach((rank, index) => {
    if (seenCodes.has(rank.code)) {
      errors.push(`Duplicate rank code "${rank.code}".`);
    }
    seenCodes.add(rank.code);

    if (seenOrders.has(rank.order)) {
      errors.push(`Duplicate rank order ${rank.order}.`);
    }
    seenOrders.add(rank.order);

    if (rank.order !== index + 1) {
      errors.push(
        `Rank orders must be contiguous starting at 1 — expected ${rank.code} at order ${index + 1}, found ${rank.order}.`,
      );
    }

    if (!Number.isInteger(rank.maxStripes) || rank.maxStripes < 0) {
      errors.push(`${rank.code}: maxStripes must be a non-negative integer.`);
    }

    if (rank.stripeColors.length !== rank.maxStripes) {
      errors.push(
        `${rank.code}: stripeColors must have exactly maxStripes (${rank.maxStripes}) entries, found ${rank.stripeColors.length}.`,
      );
    }

    if (!Number.isInteger(rank.visibleStripeSlots) || rank.visibleStripeSlots <= 0) {
      errors.push(`${rank.code}: visibleStripeSlots must be a positive integer.`);
    }

    // A terminal rank never has an exam threshold — there is no belt beyond
    // it, ever, regardless of maxStripes. But a terminal rank with real
    // degrees (e.g. black belt tracked 1st-6th degree, maxStripes > 0) still
    // needs a per-stripe threshold to progress through them: exempting it
    // from attendancesPerStripe/monthsPerStripe too would freeze it at zero
    // progress forever. Only a terminal rank with maxStripes === 0 (nothing
    // to progress through at all, e.g. Alliance's seeded BLACK) is exempt
    // from the stripe fields as well.
    const needsStripeField = !rank.isTerminal || rank.maxStripes > 0;
    const needsExamField = !rank.isTerminal;

    if (needsAttendance && needsStripeField) {
      if (rank.attendancesPerStripe === null || rank.attendancesPerStripe <= 0) {
        errors.push(`${rank.code}: attendancesPerStripe must be a positive number when mode is ${mode}.`);
      }
    }
    if (needsAttendance && needsExamField) {
      if (rank.attendancesForExam === null || rank.attendancesForExam <= 0) {
        errors.push(`${rank.code}: attendancesForExam must be a positive number when mode is ${mode}.`);
      }
    }

    if (needsTime && needsStripeField) {
      if (rank.monthsPerStripe === null || rank.monthsPerStripe <= 0) {
        errors.push(`${rank.code}: monthsPerStripe must be a positive number when mode is ${mode}.`);
      }
    }
    if (needsTime && needsExamField) {
      if (rank.monthsForExam === null || rank.monthsForExam <= 0) {
        errors.push(`${rank.code}: monthsForExam must be a positive number when mode is ${mode}.`);
      }
    }
  });

  const terminalRanks = sorted.filter((rank) => rank.isTerminal);
  if (terminalRanks.length !== 1) {
    errors.push(`Exactly one rank must be isTerminal — found ${terminalRanks.length}.`);
  } else if (terminalRanks[0].id !== sorted[sorted.length - 1].id) {
    errors.push("The terminal rank must be the highest-order rank.");
  }

  return errors;
}

export class TrackConfigError extends Error {
  constructor(public readonly errors: string[]) {
    super(errors.join("; "));
    this.name = "TrackConfigError";
  }
}

export interface RankUpdate {
  id: string;
  maxStripes?: number;
  attendancesPerStripe?: number | null;
  attendancesForExam?: number | null;
  monthsPerStripe?: number | null;
  monthsForExam?: number | null;
  stripeColors?: string[];
  visibleStripeSlots?: number;
}

export interface TrackConfigUpdate {
  mode?: PromotionMode;
  requiresCoachApproval?: boolean;
  ranks?: RankUpdate[];
}

/**
 * Validates and applies a config change for one (organizationId, track),
 * then writes it. Only fields present in `update`/`update.ranks[i]` are
 * touched — a rank field left out of the patch keeps its current value
 * rather than being nulled, so switching `mode` alone never erases the
 * other mode's numbers (Phase 2a design fix 2: "nullable should mean 'never
 * configured,' not 'not currently used'").
 *
 * Refuses a `maxStripes` reduction below any student's current degree
 * count on that rank — shrinking the ceiling out from under students who
 * already hold more stripes than the new maximum would silently strand
 * their real progress.
 *
 * Writes BeltRank + PromotionConfig + the AuditLog row in ONE transaction
 * via the raw `prisma` client, not `getScopedDb(context).$transaction` —
 * AuditLog is deliberately outside the scoped wrapper's reach (see
 * `scoped-client.ts`'s own module doc comment), so a transaction that must
 * include an AuditLog row alongside tenant-owned writes has to use the raw
 * client and pin `organizationId` on every clause by hand. Same pattern
 * `src/app/[locale]/(staff)/dashboard/promotion-actions.ts`'s
 * `confirmPromotion` already uses for the same reason.
 */
export async function updateTrackConfig(
  context: TenantContext,
  track: Track,
  update: TrackConfigUpdate,
): Promise<void> {
  const organizationId = context.organizationId;
  const scoped = getScopedDb(context);

  const [config, existingRanks] = await Promise.all([
    scoped.promotionConfig.findUniqueOrThrow({ where: { organizationId_track: { organizationId, track } } }),
    scoped.beltRank.findMany({ where: { track }, orderBy: { order: "asc" } }),
  ]);

  const patchesById = new Map((update.ranks ?? []).map((rank) => [rank.id, rank]));
  const resolvedMode = update.mode ?? config.mode;

  const resolvedRanks: RankForValidation[] = existingRanks.map((rank) => {
    const patch = patchesById.get(rank.id);
    return {
      id: rank.id,
      code: rank.code,
      order: rank.order,
      isTerminal: rank.isTerminal,
      maxStripes: patch?.maxStripes ?? rank.maxStripes,
      attendancesPerStripe:
        patch && "attendancesPerStripe" in patch ? (patch.attendancesPerStripe ?? null) : rank.attendancesPerStripe,
      attendancesForExam:
        patch && "attendancesForExam" in patch ? (patch.attendancesForExam ?? null) : rank.attendancesForExam,
      monthsPerStripe: patch && "monthsPerStripe" in patch ? (patch.monthsPerStripe ?? null) : rank.monthsPerStripe,
      monthsForExam: patch && "monthsForExam" in patch ? (patch.monthsForExam ?? null) : rank.monthsForExam,
      stripeColors: patch?.stripeColors ?? rank.stripeColors,
      visibleStripeSlots: patch?.visibleStripeSlots ?? rank.visibleStripeSlots,
    };
  });

  const errors = validateTrackConfig(resolvedRanks, resolvedMode);
  if (errors.length > 0) {
    throw new TrackConfigError(errors);
  }

  for (const rank of resolvedRanks) {
    const existing = existingRanks.find((r) => r.id === rank.id)!;
    if (rank.maxStripes < existing.maxStripes) {
      const affected = await scoped.student.count({
        where: { currentRankId: rank.id, currentStripes: { gt: rank.maxStripes } },
      });
      if (affected > 0) {
        throw new TrackConfigError([
          `Cannot reduce ${rank.code}'s maxStripes to ${rank.maxStripes}: ${affected} student(s) currently hold more degrees than that.`,
        ]);
      }
    }
  }

  await prisma.$transaction(async (tx) => {
    for (const rank of resolvedRanks) {
      if (!patchesById.has(rank.id)) continue;
      await tx.beltRank.update({
        where: { organizationId_id: { organizationId, id: rank.id } },
        data: {
          maxStripes: rank.maxStripes,
          attendancesPerStripe: rank.attendancesPerStripe,
          attendancesForExam: rank.attendancesForExam,
          monthsPerStripe: rank.monthsPerStripe,
          monthsForExam: rank.monthsForExam,
          stripeColors: rank.stripeColors,
          visibleStripeSlots: rank.visibleStripeSlots,
        },
      });
    }

    if (update.mode !== undefined || update.requiresCoachApproval !== undefined) {
      await tx.promotionConfig.update({
        where: { organizationId_track: { organizationId, track } },
        data: {
          ...(update.mode !== undefined ? { mode: update.mode } : {}),
          ...(update.requiresCoachApproval !== undefined ? { requiresCoachApproval: update.requiresCoachApproval } : {}),
        },
      });
    }

    await tx.auditLog.create({
      data: {
        actorId: context.actorUserId,
        organizationId,
        action: "promotion-config.update",
        entityType: "PromotionConfig",
        entityId: config.id,
        before: { mode: config.mode, requiresCoachApproval: config.requiresCoachApproval },
        after: {
          mode: resolvedMode,
          requiresCoachApproval: update.requiresCoachApproval ?? config.requiresCoachApproval,
        },
      },
    });
  });
}
