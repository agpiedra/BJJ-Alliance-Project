import { prisma } from "@/lib/prisma";
import { DateTime } from "luxon";
import { StudentStatus } from "@/generated/prisma/client";
import { getScopedDb } from "@/lib/tenant/scoped-client";
import { getAtBeltSummary } from "@/lib/students/attendance-summary";
import { MissingTimeAnchorError } from "@/lib/promotion/engine";
import { writeAward } from "@/lib/promotion/award";
import type { SystemJobContext } from "@/lib/tenant/types";
import type { ResolvedTrackConfig } from "@/lib/promotion/config";
import type { Track } from "@/generated/prisma/client";

export interface AutomationRunResult {
  organizationId: string;
  awardedStudentIds: string[];
  skippedConflict: number;
  errors: Array<{ studentId: string; error: string }>;
}

/** Spec: "each job processes bounded batches." A parameter, not a constant, so the drain behavior is testable at a small n. */
export const DEFAULT_BATCH_SIZE = 50;

/**
 * MULTI_ACADEMY_AND_KIDS_BELTS.md Phase 2c-iii. Called once per ACTIVE
 * organization by the cron route. Only ever awards STRIPE targets — belt
 * awards require a human confirm even with requiresCoachApproval off
 * (spec) — so a BELT-eligible student is simply never a candidate here;
 * they still appear in `listPromotionQueue` (which never filters on
 * requiresCoachApproval) for a director to confirm manually. This also
 * means the next-rank catalog lookup (and its InvalidPromotionConfigError
 * guard in award.ts) never runs from this path — not an invariant
 * something else maintains, just a fact of this function's own control
 * flow: the candidate filter below never selects a BELT target.
 *
 * Idempotency is persistence-backed, not an in-memory per-run guard (a
 * retry is a fresh process, so an in-memory guard proves nothing): no
 * student who already has an `AUTO`-sourced `Promotion` since the start of
 * TODAY in the ORGANIZATION's own timezone (never the app-wide `ZONE`
 * constant — this is the one job that is genuinely multi-org) is a
 * candidate.
 *
 * Candidates are ordered by `beltAwardedAt` ascending — the
 * persistence-backed proxy for "longest waiting," since eligibility itself
 * carries no timestamp anywhere. Combined with the idempotency filter, a
 * bounded batch drains correctly even across same-day reruns: run 1's
 * awards become idempotency-excluded, so run 2's query naturally surfaces
 * the next slice instead of reprocessing the same head forever.
 * `beltAwardedAt` is `@default(now())`, non-null, confirmed in
 * schema.prisma — Postgres sorts `NULL`s last on `ASC`, which would starve
 * exactly the students this ordering exists to protect if the column were
 * ever nullable.
 *
 * Shares `writeAward` with `awardPromotion` — sharing the write shares its
 * concurrency guard too: a `{ok:false, error:"conflict"}` here means the
 * student's state moved between candidate selection and this write (a
 * concurrent manual confirm, another run, an adjustment). Skipped cleanly,
 * counted, never logged as an error and never retried within this run —
 * the student remains a legitimate candidate for the next run.
 */
export async function runAutomaticStripeAwardsForOrganization(
  organizationId: string,
  batchSize: number = DEFAULT_BATCH_SIZE,
): Promise<AutomationRunResult> {
  const job: SystemJobContext = { kind: "system-job", organizationId, jobName: "promotion-auto-award" };
  const result: AutomationRunResult = { organizationId, awardedStudentIds: [], skippedConflict: 0, errors: [] };

  const [org, configRows] = await Promise.all([
    prisma.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { timezone: true, status: true } }),
    prisma.promotionConfig.findMany({
      where: { organizationId },
      select: { track: true, mode: true, requiresCoachApproval: true },
    }),
  ]);

  if (org.status !== "ACTIVE") return result; // spec: "Skip non-active organizations."

  const autoTracks = configRows.filter((c) => !c.requiresCoachApproval).map((c) => c.track);
  if (autoTracks.length === 0) return result;

  const configByTrack = new Map<Track, ResolvedTrackConfig>(configRows.map((c) => [c.track, { mode: c.mode }]));

  const startOfToday = DateTime.now().setZone(org.timezone).startOf("day").toJSDate();

  const candidates = await getScopedDb(job).student.findMany({
    where: { status: StudentStatus.ACTIVE, track: { in: autoTracks } },
    orderBy: { beltAwardedAt: "asc" },
    select: { id: true, homeAcademyId: true, organizationId: true },
  });
  if (candidates.length === 0) return result;

  const alreadyAwardedToday = await prisma.promotion.findMany({
    where: {
      organizationId,
      source: "AUTO",
      awardedAt: { gte: startOfToday },
      studentId: { in: candidates.map((c) => c.id) },
    },
    select: { studentId: true },
  });
  const alreadyAwardedIds = new Set(alreadyAwardedToday.map((p) => p.studentId));

  for (const student of candidates) {
    if (result.awardedStudentIds.length >= batchSize) break;
    if (alreadyAwardedIds.has(student.id)) continue;

    let summary;
    try {
      summary = await getAtBeltSummary(student.id, organizationId, configByTrack);
    } catch (error) {
      if (error instanceof MissingTimeAnchorError) continue; // per-student data gap, not a batch failure.
      result.errors.push({ studentId: student.id, error: error instanceof Error ? error.message : String(error) });
      continue;
    }

    if (summary.nextTarget !== "STRIPE" || !summary.isEligible) continue;

    const fromRankId = summary.currentRankId;
    const fromStripes = summary.currentStripes;

    const writeResult = await writeAward({
      studentId: student.id,
      homeAcademyId: student.homeAcademyId,
      organizationId: student.organizationId,
      fromRankId,
      fromStripes,
      toRankId: fromRankId,
      toStripes: fromStripes + 1,
      before: { belt: summary.currentBelt, stripes: fromStripes },
      after: { belt: summary.currentBelt, stripes: fromStripes + 1 },
      source: "AUTO",
      awardedById: null,
      notes: null,
    });

    if (writeResult.ok) {
      result.awardedStudentIds.push(student.id);
    } else {
      result.skippedConflict++;
    }
  }

  return result;
}
