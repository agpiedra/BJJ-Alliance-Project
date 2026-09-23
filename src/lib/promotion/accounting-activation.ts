import { createHash } from "node:crypto";
import { Prisma, type Track } from "@/generated/prisma/client";
import type { prisma } from "@/lib/prisma";
import { evaluateStudentProgress } from "@/lib/students/attendance-summary";
import { listContributingDays } from "@/lib/promotion/progress-days";
import { ADULT_RANKS } from "@/lib/organizations/default-belt-ranks";
import type { ResolvedTrackConfig } from "@/lib/promotion/config";

/**
 * Moving an EXISTING organization onto the academy's decided accounting
 * (docs/PROMOTION_PROGRESS_PROPOSAL.md: PER_INTERVAL - one qualifying day per
 * Costa Rica day, progress resets at every award, no credits, time-based black
 * belt). A brand-new organization starts on it already; an existing one has
 * history the change would reinterpret, so it moves only through here:
 *
 *  1. `buildImpactReport` - READ-ONLY. Shows, per student, what they see today and
 *     what they will see after, and flags everything that changes. It writes
 *     nothing and returns a `reportId` (a hash of the facts it found).
 *  2. `activateAccounting` - refuses unless the caller passes the `reportId` of a
 *     report generated moments earlier and unchanged since, so what is applied is
 *     exactly what was reviewed. Runs in ONE transaction and audits itself.
 *
 * Activation never edits attendance, promotions, credits or `beltAwardedAt`, and
 * never invents a historical promotion: it records the system tracking baseline
 * (`progressBaselineKind = SYSTEM_BASELINE`) at the activation instant, so every
 * student starts at 0 with their entered rank and degrees unchanged. Legacy
 * credits stay in the table, unread. Historical AUTO promotions stay too.
 */

type Db = typeof prisma;


export interface ImpactStudentRow {
  studentId: string;
  status: string;
  track: Track;
  /** The accounting the student's track is on TODAY. Only CUMULATIVE tracks are changed by an activation. */
  accounting: string;
  rank: string;
  stripes: number;
  /** What the student sees today, under their track's current accounting. */
  today: { count: number; target: number | null; remaining: number | null; eligible: boolean; creditedClasses: number };
  /** After activation: 0 of the interval threshold - or the time-based state for a rank counted by time. */
  after: { count: 0; target: number | null; eligible: false };
  /** Physical attendance rows since the belt date that add nothing under the one-per-day rule (kept as history). */
  extraSameDayRows: number;
  /** Time-based rank with no known last-award date: shows rank and attendance but no due date until one is supplied. */
  lastAwardDateNeeded: boolean;
}

export interface ImpactReport {
  organizationId: string;
  organizationSlug: string;
  tracks: Array<{ track: Track; mode: string; accounting: string; requiresCoachApproval: boolean }>;
  blackBeltCatalog: { current: unknown; proposed: unknown; needsUpdate: boolean } | null;
  totals: {
    students: number;
    /** Eligible for review today under the old rule, who will read 0 after activation. */
    eligibleTodayResettingToZero: number;
    studentsWithLegacyCredits: number;
    legacyCreditClasses: number;
    /** Arbitrary attendance adjustments (delta other than +1): retained as history, ignored by the new rule. */
    nonUnitAdjustmentRows: number;
    extraSameDayRows: number;
    blackBeltsWithoutLastAwardDate: number;
    automaticPromotionsInHistory: number;
  };
  students: ImpactStudentRow[];
  /** Hash of everything above; `activateAccounting` must be given this exact value. */
  reportId: string;
}

/**
 * The black-belt catalog an activation completes. A MANUAL adult track keeps black belt manual too
 * (same rule as seed-defaults for a new organization: under MANUAL nothing is ever eligible).
 */
function proposedBlackRank(adultTrackMode: string | undefined) {
  const black = ADULT_RANKS.find((rank) => rank.code === "BLACK")!;
  return {
    maxStripes: black.maxStripes,
    progressionMode: adultTrackMode === "MANUAL" ? null : (black.progressionMode ?? null),
    stripeIntervalMonths: black.stripeIntervalMonths ?? [],
    stripeColors: Array.from({ length: black.maxStripes }, () => "#FFFFFF"),
  };
}

export async function buildImpactReport(db: Db, organizationSlug: string): Promise<ImpactReport> {
  const organization = await db.organization.findUniqueOrThrow({
    where: { slug: organizationSlug },
    select: { id: true, slug: true },
  });
  const organizationId = organization.id;

  const configs = await db.promotionConfig.findMany({
    where: { organizationId },
    select: { track: true, mode: true, stripeAccounting: true, requiresCoachApproval: true },
    orderBy: { track: "asc" },
  });
  // Each track is evaluated under the accounting it is on today: a track that is already PER_INTERVAL
  // is not a legacy track and is never re-baselined by an activation.
  const legacyByTrack = new Map<Track, ResolvedTrackConfig>(
    configs.map((c) => [c.track, { mode: c.mode, accounting: c.stripeAccounting }]),
  );
  const adultMode = configs.find((c) => c.track === "ADULT")?.mode;

  const black = await db.beltRank.findFirst({
    where: { organizationId, track: "ADULT", code: "BLACK" },
    select: { maxStripes: true, progressionMode: true, stripeIntervalMonths: true, stripeColors: true },
  });
  const proposed = proposedBlackRank(adultMode);
  const blackNeedsUpdate =
    !!black &&
    (black.maxStripes !== proposed.maxStripes ||
      black.progressionMode !== proposed.progressionMode ||
      JSON.stringify(black.stripeIntervalMonths) !== JSON.stringify(proposed.stripeIntervalMonths));

  const students = await db.student.findMany({
    where: { organizationId },
    select: {
      id: true,
      status: true,
      track: true,
      currentStripes: true,
      beltAwardedAt: true,
      timeAnchorAt: true,
      currentRank: { select: { code: true, isTerminal: true } },
    },
    orderBy: { id: "asc" },
  });

  const rows: ImpactStudentRow[] = [];
  for (const student of students) {
    if (!legacyByTrack.has(student.track)) continue;
    const { summary } = await evaluateStudentProgress(db, student.id, organizationId, legacyByTrack);
    // How many physical qualifying rows since the belt date collapse under one-per-day?
    const days = await listContributingDays(db, { studentId: student.id, organizationId, from: student.beltAwardedAt });
    const legacyRows = await db.attendanceRecord.count({
      where: { studentId: student.id, organizationId, occurredAt: { gte: student.beltAwardedAt }, delta: { gt: 0 } },
    });
    const isBlack = student.currentRank.code === "BLACK" && student.track === "ADULT";
    rows.push({
      studentId: student.id,
      status: student.status,
      track: student.track,
      accounting: legacyByTrack.get(student.track)!.accounting,
      rank: student.currentRank.code,
      stripes: student.currentStripes,
      today: {
        count: summary.atBeltCount,
        target: summary.target,
        remaining: summary.remainingAttendance,
        eligible: summary.isEligible,
        creditedClasses: summary.creditedClasses,
      },
      // The target after activation is the one for the student's NEXT target under the interval rule:
      // the exam threshold for a belt, the per-stripe threshold for a stripe, none for a time-based or manual rank.
      after: {
        count: 0,
        target:
          isBlack || summary.mode === "MANUAL" || summary.nextTarget === "NONE"
            ? null
            : (summary.nextTarget === "BELT" ? summary.attendancesForExam : summary.attendancesPerStripe) || null,
        eligible: false,
      },
      extraSameDayRows: Math.max(0, legacyRows - days.length),
      lastAwardDateNeeded: isBlack && student.timeAnchorAt === null,
    });
  }

  const [credits, nonUnit, autoPromotions] = await Promise.all([
    db.promotionCredit.aggregate({ where: { organizationId }, _count: true, _sum: { classesGranted: true } }),
    db.attendanceRecord.count({ where: { organizationId, type: "ADJUSTMENT", NOT: { delta: 1 } } }),
    db.promotion.count({ where: { organizationId, source: "AUTO" } }),
  ]);
  const studentsWithCredits = await db.promotionCredit.groupBy({ by: ["studentId"], where: { organizationId } });

  const totals: ImpactReport["totals"] = {
    students: rows.length,
    eligibleTodayResettingToZero: rows.filter((r) => r.accounting === "CUMULATIVE" && r.today.eligible).length,
    studentsWithLegacyCredits: studentsWithCredits.length,
    legacyCreditClasses: credits._sum.classesGranted ?? 0,
    nonUnitAdjustmentRows: nonUnit,
    extraSameDayRows: rows.reduce((sum, r) => sum + r.extraSameDayRows, 0),
    blackBeltsWithoutLastAwardDate: rows.filter((r) => r.lastAwardDateNeeded).length,
    automaticPromotionsInHistory: autoPromotions,
  };

  const body = {
    organizationId,
    organizationSlug: organization.slug,
    tracks: configs.map((c) => ({
      track: c.track,
      mode: c.mode,
      accounting: c.stripeAccounting,
      requiresCoachApproval: c.requiresCoachApproval,
    })),
    blackBeltCatalog: black ? { current: black, proposed, needsUpdate: blackNeedsUpdate } : null,
    totals,
    students: rows,
  };
  // The id covers what a reviewer signs off on - who is affected and how - not the running
  // attendance counts, which move every day. A student becoming eligible, a credit appearing or a
  // catalog edit DOES change it, so a stale review is refused rather than applied.
  const reviewed = {
    organizationId,
    tracks: body.tracks,
    blackBeltCatalog: body.blackBeltCatalog,
    totals: { ...totals, extraSameDayRows: undefined },
    students: rows.map((r) => [r.studentId, r.track, r.accounting, r.rank, r.stripes, r.today.eligible, r.today.creditedClasses, r.lastAwardDateNeeded]),
  };
  const reportId = createHash("sha256").update(JSON.stringify(reviewed)).digest("hex").slice(0, 16);
  return { ...body, reportId };
}

export type ActivationResult =
  | { ok: true; studentsBaselined: number; tracksActivated: Track[]; blackBeltCatalogUpdated: boolean; baselineAt: Date }
  | { ok: false; error: "reportMismatch" | "alreadyActive" | "noStudentsOrTracks" };

/**
 * Applies the activation the given report described. Everything happens in one
 * transaction: all tracks flip, every student's tracking baseline is recorded,
 * the black-belt catalog is completed if it is still the old shape, and one audit
 * row says who did it against which report.
 */
export async function activateAccounting(
  db: Db,
  args: { organizationSlug: string; reportId: string; activatedByUserId: string | null; at?: Date },
): Promise<ActivationResult> {
  const report = await buildImpactReport(db, args.organizationSlug);
  if (report.reportId !== args.reportId) return { ok: false, error: "reportMismatch" };
  if (report.tracks.length === 0) return { ok: false, error: "noStudentsOrTracks" };
  if (report.tracks.every((t) => t.accounting === "PER_INTERVAL")) return { ok: false, error: "alreadyActive" };

  const organizationId = report.organizationId;
  const baselineAt = args.at ?? new Date();
  const blackNeedsUpdate = report.blackBeltCatalog?.needsUpdate ?? false;
  const adultMode = report.tracks.find((t) => t.track === "ADULT")?.mode;
  // Only tracks still on the legacy accounting change. A track already on PER_INTERVAL keeps its real
  // award baselines: re-baselining it would silently wipe genuine progress.
  const tracksToFlip = report.tracks.filter((t) => t.accounting === "CUMULATIVE").map((t) => t.track);

  const studentsBaselined = await db.$transaction(async (tx) => {
    await tx.promotionConfig.updateMany({
      where: { organizationId, track: { in: tracksToFlip } },
      data: { stripeAccounting: "PER_INTERVAL" },
    });
    const baselined = await tx.student.updateMany({
      where: { organizationId, track: { in: tracksToFlip } },
      data: { progressBaselineAt: baselineAt, progressBaselineKind: "SYSTEM_BASELINE" },
    });
    if (blackNeedsUpdate) {
      await tx.beltRank.updateMany({ where: { organizationId, track: "ADULT", code: "BLACK" }, data: proposedBlackRank(adultMode) });
    }
    await tx.auditLog.create({
      data: {
        actorId: args.activatedByUserId,
        organizationId,
        action: "promotion-accounting.activate",
        entityType: "PromotionConfig",
        entityId: organizationId,
        before: { tracks: report.tracks } as Prisma.InputJsonValue,
        after: {
          accounting: "PER_INTERVAL",
          reportId: report.reportId,
          baselineAt: baselineAt.toISOString(),
          studentsBaselined: baselined.count,
          blackBeltCatalogUpdated: blackNeedsUpdate,
          totals: report.totals,
        } as Prisma.InputJsonValue,
      },
    });
    return baselined.count;
  });

  return {
    ok: true,
    studentsBaselined,
    tracksActivated: tracksToFlip,
    blackBeltCatalogUpdated: blackNeedsUpdate,
    baselineAt,
  };
}
