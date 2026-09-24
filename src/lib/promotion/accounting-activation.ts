import { createHash } from "node:crypto";
import { DateTime } from "luxon";
import { Prisma, type Track } from "@/generated/prisma/client";
import type { prisma } from "@/lib/prisma";
import { ZONE } from "@/lib/scheduling/zone";
import { evaluateStudentProgress } from "@/lib/students/attendance-summary";
import { listContributingDays } from "@/lib/promotion/progress-days";
import { evaluatePromotion, InvalidPromotionConfigError, type EngineResult } from "@/lib/promotion/engine";
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
 *     what they will see AFTER activation - computed with the same engine and the
 *     proposed configuration, not assumed - and flags everything that changes. It
 *     writes nothing and returns a `reportId`: a hash of the material outcomes.
 *  2. `activateAccounting` - validates and applies in ONE serializable transaction.
 *     It takes an advisory lock for the organization (two activations cannot both
 *     succeed or baseline twice) and row locks on the organization's students,
 *     promotion configs and belt ranks (an award, correction, track change or
 *     config edit in flight either finishes first and is seen, or waits), REBUILDS
 *     the report inside the transaction, and applies only if its id equals the one
 *     the reviewer approved. Nothing can change between "checked" and "applied".
 *
 * Activation never edits attendance, promotions, credits or `beltAwardedAt`, and
 * never invents a historical promotion: it records the system tracking baseline
 * (`progressBaselineKind = SYSTEM_BASELINE`) at the activation instant, so every
 * student of a flipped track starts at 0 with their entered rank and degrees
 * unchanged. A track that is already PER_INTERVAL is not touched. Legacy credits
 * stay in the table, unread. Historical AUTO promotions stay too.
 */

/** Everything the report reads: the guarded client, or a transaction on it. */
type ReportClient = Pick<
  typeof prisma,
  "organization" | "promotionConfig" | "beltRank" | "student" | "attendanceRecord" | "promotionCredit" | "promotion" | "$queryRaw"
>;
type Db = typeof prisma;

/** What a student will see once activation has run. */
export type AfterState =
  | "in_progress"
  | "eligible"
  | "time_pending"
  | "time_anchor_missing"
  | "not_configured"
  | "manual"
  | "none"
  | "config_error";

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
  /**
   * What the student will see after activation. For a track already on PER_INTERVAL this is simply what they
   * see now (they are not touched). For a track being flipped it is the engine's own result under the
   * interval rule and the PROPOSED catalog: attendance ranks start at 0, and a time-based rank is evaluated
   * from its known last-award date - eligible, pending with a due date, or "date needed".
   */
  after: {
    count: number;
    target: number | null;
    eligible: boolean;
    state: AfterState;
    /** ISO instant the next degree is due (time-based ranks with a known last-award date), else null. */
    dueDate: string | null;
  };
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
    /** Eligible today (under the accounting their track is on) who will NOT be eligible after activation. */
    eligibleTodayResettingToZero: number;
    /** Eligible after activation (e.g. a black belt already past its due date), of the students being flipped. */
    eligibleAfterActivation: number;
    studentsWithLegacyCredits: number;
    legacyCreditClasses: number;
    /** Arbitrary attendance adjustments (delta other than +1): retained as history, ignored by the new rule. */
    nonUnitAdjustmentRows: number;
    extraSameDayRows: number;
    blackBeltsWithoutLastAwardDate: number;
    blackBeltsWithDueDate: number;
    automaticPromotionsInHistory: number;
  };
  students: ImpactStudentRow[];
  /** Hash of the material outcomes above; `activateAccounting` must be given this exact value. */
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

interface StateInput {
  nextTarget: EngineResult["nextTarget"];
  isEligible: boolean;
  hasDueDate: boolean;
  timeAnchorMissing: boolean;
  notConfigured: boolean;
}

function afterState(input: StateInput, mode: string): AfterState {
  if (input.nextTarget === "NONE") return "none";
  if (mode === "MANUAL") return "manual";
  if (input.notConfigured) return "not_configured";
  if (input.timeAnchorMissing) return "time_anchor_missing";
  if (input.isEligible) return "eligible";
  return input.hasDueDate ? "time_pending" : "in_progress";
}

export async function buildImpactReport(db: ReportClient, organizationSlug: string): Promise<ImpactReport> {
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
  const configByTrack = new Map<Track, ResolvedTrackConfig>(
    configs.map((c) => [c.track, { mode: c.mode, accounting: c.stripeAccounting }]),
  );
  const adultMode = configs.find((c) => c.track === "ADULT")?.mode;

  const black = await db.beltRank.findFirst({
    where: { organizationId, track: "ADULT", code: "BLACK" },
    select: { maxStripes: true, progressionMode: true, stripeIntervalMonths: true, stripeColors: true },
  });
  // The black-belt catalog belongs to the ADULT track: it is completed only when that track is itself being
  // activated. An ADULT track already on PER_INTERVAL keeps whatever catalog it has (an owner may have tuned it),
  // even while KIDS is activated - nothing is proposed for it and nothing is written.
  const adultIsLegacy = configByTrack.get("ADULT")?.accounting === "CUMULATIVE";
  const proposed = black && !adultIsLegacy ? black : proposedBlackRank(adultMode);
  const blackNeedsUpdate =
    !!black &&
    adultIsLegacy &&
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
      currentRank: {
        select: {
          code: true,
          isTerminal: true,
          maxStripes: true,
          attendancesPerStripe: true,
          attendancesForExam: true,
          monthsPerStripe: true,
          monthsForExam: true,
          progressionMode: true,
          stripeIntervalMonths: true,
        },
      },
    },
    orderBy: { id: "asc" },
  });

  const evaluationDate = DateTime.now().setZone(ZONE);
  const rows: ImpactStudentRow[] = [];
  for (const student of students) {
    const trackConfig = configByTrack.get(student.track);
    if (!trackConfig) continue;
    const { summary } = await evaluateStudentProgress(db, student.id, organizationId, configByTrack);
    // How many physical qualifying rows since the belt date collapse under one-per-day?
    const days = await listContributingDays(db, { studentId: student.id, organizationId, from: student.beltAwardedAt });
    const legacyRows = await db.attendanceRecord.count({
      where: { studentId: student.id, organizationId, voidedAt: null, occurredAt: { gte: student.beltAwardedAt }, delta: { gt: 0 } },
    });
    const isBlack = student.currentRank.code === "BLACK" && student.track === "ADULT";
    const alreadyActive = trackConfig.accounting === "PER_INTERVAL";

    let after: ImpactStudentRow["after"];
    if (alreadyActive) {
      // Not touched by the activation: what they see now is what they will see.
      after = {
        count: summary.atBeltCount,
        target: summary.target,
        eligible: summary.isEligible,
        state: afterState(
          {
            nextTarget: summary.nextTarget,
            isEligible: summary.isEligible,
            hasDueDate: summary.dueDate !== null,
            timeAnchorMissing: summary.timeAnchorMissing,
            notConfigured: summary.notConfigured,
          },
          summary.mode,
        ),
        dueDate: summary.dueDate ? summary.dueDate.toISOString() : null,
      };
    } else {
      // Evaluate exactly as the app will after activation: interval accounting, count 0, the PROPOSED black-belt
      // catalog where the activation completes it, and the student's known last-award date.
      const rank = student.currentRank;
      const override = isBlack && blackNeedsUpdate ? proposed : null;
      const mode = (override ? override.progressionMode : rank.progressionMode) ?? trackConfig.mode;
      try {
        const result = evaluatePromotion({
          mode,
          accounting: "PER_INTERVAL",
          currentStripes: student.currentStripes,
          maxStripes: override ? override.maxStripes : rank.maxStripes,
          isTerminal: rank.isTerminal,
          hasNextRank: !rank.isTerminal,
          attendancesPerStripe: rank.attendancesPerStripe,
          attendancesForExam: rank.attendancesForExam,
          promotionRelevantAttendance: 0,
          monthsPerStripe: rank.monthsPerStripe,
          monthsForExam: rank.monthsForExam,
          stripeIntervalMonths: override ? override.stripeIntervalMonths : rank.stripeIntervalMonths,
          timeAnchorAt: student.timeAnchorAt ? DateTime.fromJSDate(student.timeAnchorAt, { zone: ZONE }) : null,
          evaluationDate,
        });
        after = {
          count: 0,
          target: result.target,
          eligible: result.isEligible,
          state: afterState(
            {
              nextTarget: result.nextTarget,
              isEligible: result.isEligible,
              hasDueDate: result.dueDate !== null,
              timeAnchorMissing: result.timeAnchorMissing,
              notConfigured: result.notConfigured,
            },
            mode,
          ),
          dueDate: result.dueDate ? result.dueDate.toUTC().toISO() : null,
        };
      } catch (error) {
        if (!(error instanceof InvalidPromotionConfigError)) throw error;
        after = { count: 0, target: null, eligible: false, state: "config_error", dueDate: null };
      }
    }

    rows.push({
      studentId: student.id,
      status: student.status,
      track: student.track,
      accounting: trackConfig.accounting,
      rank: student.currentRank.code,
      stripes: student.currentStripes,
      today: {
        count: summary.atBeltCount,
        target: summary.target,
        remaining: summary.remainingAttendance,
        eligible: summary.isEligible,
        creditedClasses: summary.creditedClasses,
      },
      after,
      extraSameDayRows: Math.max(0, legacyRows - days.length),
      lastAwardDateNeeded: after.state === "time_anchor_missing",
    });
  }

  const [credits, nonUnit, autoPromotions] = await Promise.all([
    db.promotionCredit.aggregate({ where: { organizationId }, _count: true, _sum: { classesGranted: true } }),
    db.attendanceRecord.count({ where: { organizationId, voidedAt: null, type: "ADJUSTMENT", NOT: { delta: 1 } } }),
    db.promotion.count({ where: { organizationId, source: "AUTO" } }),
  ]);
  const studentsWithCredits = await db.promotionCredit.groupBy({ by: ["studentId"], where: { organizationId } });

  const flipped = rows.filter((r) => r.accounting === "CUMULATIVE");
  const totals: ImpactReport["totals"] = {
    students: rows.length,
    eligibleTodayResettingToZero: flipped.filter((r) => r.today.eligible && !r.after.eligible).length,
    eligibleAfterActivation: flipped.filter((r) => r.after.eligible).length,
    studentsWithLegacyCredits: studentsWithCredits.length,
    legacyCreditClasses: credits._sum.classesGranted ?? 0,
    nonUnitAdjustmentRows: nonUnit,
    extraSameDayRows: rows.reduce((sum, r) => sum + r.extraSameDayRows, 0),
    blackBeltsWithoutLastAwardDate: flipped.filter((r) => r.after.state === "time_anchor_missing").length,
    blackBeltsWithDueDate: flipped.filter((r) => r.after.dueDate !== null).length,
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
  // The id binds the approval to the MATERIAL OUTCOMES: who is affected, what they see today and what they will
  // see after (state, eligibility, target, due date), the configuration being applied, and the totals - not the
  // running attendance counts, which move every day. A student becoming eligible, a black belt's date being
  // supplied, a credit appearing, a config or catalog edit, or a track already changing accounting all change it,
  // so a stale review is refused rather than applied.
  const reviewed = {
    organizationId,
    tracks: body.tracks,
    blackBeltCatalog: body.blackBeltCatalog,
    totals: { ...totals, extraSameDayRows: undefined },
    students: rows.map((r) => [
      r.studentId, r.track, r.accounting, r.rank, r.stripes,
      r.today.eligible, r.today.creditedClasses,
      r.after.state, r.after.eligible, r.after.target, r.after.dueDate,
    ]),
  };
  const reportId = createHash("sha256").update(JSON.stringify(reviewed)).digest("hex").slice(0, 16);
  return { ...body, reportId };
}

export type ActivationResult =
  | { ok: true; studentsBaselined: number; tracksActivated: Track[]; blackBeltCatalogUpdated: boolean; baselineAt: Date }
  | { ok: false; error: "reportMismatch" | "alreadyActive" | "noStudentsOrTracks" | "conflict" };

/**
 * "The transaction failed because of a write conflict, a serialization failure or a deadlock". Prisma reports it as
 * P2034 from a model query, but as P2010 (raw query failed) carrying the database's own SQLSTATE 40001 / 40P01 when
 * it comes from one of this transaction's raw statements - both mean "a concurrent change, re-run the report".
 */
function isSerializationFailure(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const { code, meta } = error as { code?: unknown; meta?: { driverAdapterError?: { cause?: { originalCode?: unknown; kind?: unknown } } } };
  if (code === "P2034") return true;
  const cause = meta?.driverAdapterError?.cause;
  return code === "P2010" && (cause?.originalCode === "40001" || cause?.originalCode === "40P01" || cause?.kind === "TransactionWriteConflict");
}

/**
 * Validates and applies the activation the given report described, atomically.
 *
 * One SERIALIZABLE transaction: (1) an advisory lock keyed by the organization serializes concurrent
 * activations, so a second one waits and then finds the tracks already flipped (`alreadyActive`) instead of
 * baselining a second time; (2) row locks on the organization's students, promotion configs and belt ranks make
 * any award, correction, track change or config edit in flight finish first (and be seen) or wait until this
 * commits; (3) the report is REBUILT inside the transaction and its id compared with the approved one, so nothing
 * that changed after review can slip through; (4) only then are the tracks flipped, every student of a flipped
 * track baselined, the black-belt catalog completed and one audit row written. A serialization failure (a
 * concurrent change the locks do not cover, such as new attendance) is reported as `conflict`: re-run the report.
 */
export async function activateAccounting(
  db: Db,
  args: { organizationSlug: string; reportId: string; activatedByUserId: string | null; at?: Date },
): Promise<ActivationResult> {
  try {
    return await db.$transaction(
      async (tx): Promise<ActivationResult> => {
        const organization = await tx.organization.findUniqueOrThrow({ where: { slug: args.organizationSlug }, select: { id: true } });
        const organizationId = organization.id;

        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`promotion-accounting:${organizationId}`}))::text AS locked`;
        await tx.$queryRaw`SELECT "id" FROM "PromotionConfig" WHERE "organizationId" = ${organizationId} ORDER BY "id" FOR UPDATE`;
        await tx.$queryRaw`SELECT "id" FROM "BeltRank" WHERE "organizationId" = ${organizationId} ORDER BY "id" FOR UPDATE`;
        await tx.$queryRaw`SELECT "id" FROM "Student" WHERE "organizationId" = ${organizationId} ORDER BY "id" FOR UPDATE`;

        // Everything below is evaluated on the state this transaction now holds locks on.
        const report = await buildImpactReport(tx, args.organizationSlug);
        if (report.tracks.length === 0) return { ok: false, error: "noStudentsOrTracks" };
        if (report.tracks.every((t) => t.accounting === "PER_INTERVAL")) return { ok: false, error: "alreadyActive" };
        if (report.reportId !== args.reportId) return { ok: false, error: "reportMismatch" };

        const baselineAt = args.at ?? new Date();
        const blackNeedsUpdate = report.blackBeltCatalog?.needsUpdate ?? false;
        const adultMode = report.tracks.find((t) => t.track === "ADULT")?.mode;
        // Only tracks still on the legacy accounting change. A track already on PER_INTERVAL keeps its real
        // award baselines: re-baselining it would silently wipe genuine progress.
        const tracksToFlip = report.tracks.filter((t) => t.accounting === "CUMULATIVE").map((t) => t.track);

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
              tracksActivated: tracksToFlip,
              reportId: report.reportId,
              baselineAt: baselineAt.toISOString(),
              studentsBaselined: baselined.count,
              blackBeltCatalogUpdated: blackNeedsUpdate,
              totals: report.totals,
            } as Prisma.InputJsonValue,
          },
        });

        return { ok: true, studentsBaselined: baselined.count, tracksActivated: tracksToFlip, blackBeltCatalogUpdated: blackNeedsUpdate, baselineAt };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, maxWait: 30_000, timeout: 120_000 },
    );
  } catch (error) {
    if (isSerializationFailure(error)) return { ok: false, error: "conflict" };
    throw error;
  }
}
