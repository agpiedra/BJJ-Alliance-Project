import "dotenv/config";
import { getTestPrismaClient } from "../helpers/test-db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { requireEnv } from "../../src/lib/env";
import { digestLookupSecret } from "../../src/lib/crypto";
import { toAttendanceDate } from "../../src/lib/scheduling/zone";
import type { Track } from "../../src/generated/prisma/client";

const { prisma: appPrisma } = await import("../../src/lib/prisma");
const { seedOrganizationDefaults } = await import("../../src/lib/organizations/seed-defaults");
const { buildImpactReport, activateAccounting } = await import("../../src/lib/promotion/accounting-activation");
const { resolvePromotionConfigMap } = await import("../../src/lib/promotion/config");
const { getAtBeltSummary } = await import("../../src/lib/students/attendance-summary");

/**
 * docs/PROMOTION_PROGRESS_PROPOSAL.md - an EXISTING organization moves to the
 * decided accounting only through a read-only impact report followed by a
 * report-bound activation. A new organization starts on it already.
 */
const prisma = getTestPrismaClient();
const pepper = requireEnv("CODE_PEPPER");
const DAY_MS = 24 * 3600_000;

let orgId: string;
let slug: string;
let academyId: string;
let actorId: string;
let ids: { eligible: string; credited: string; black: string; sameDay: string };

async function makeStudent(label: string, rankCode: string, track: Track, stripes: number) {
  const rank = await prisma.beltRank.findFirstOrThrow({ where: { organizationId: orgId, track, code: rankCode } });
  return prisma.student.create({
    data: {
      homeAcademyId: academyId,
      organizationId: orgId,
      firstName: label,
      lastName: "Activation",
      phone: "88880000",
      email: `${label}-${orgId}@example.com`,
      status: "ACTIVE",
      track,
      currentRankId: rank.id,
      currentStripes: stripes,
      beltAwardedAt: new Date("2026-01-01T12:00:00Z"),
      codeHash: digestLookupSecret(`${label}-${orgId}`, pepper),
    },
  });
}

async function addRows(studentId: string, days: number, perDay = 1) {
  const rows = [];
  for (let d = 0; d < days; d++) {
    for (let k = 0; k < perDay; k++) {
      const occurredAt = new Date(new Date("2026-02-01T12:00:00Z").getTime() + d * DAY_MS + k * 3600_000);
      rows.push({
        studentId, academyId, organizationId: orgId, occurredAt, date: toAttendanceDate(occurredAt),
        type: "ADJUSTMENT" as const, delta: 1, reason: "fixture", source: "STAFF" as const,
      });
    }
  }
  await prisma.attendanceRecord.createMany({ data: rows });
}

async function counts() {
  return {
    attendance: await prisma.attendanceRecord.count({ where: { organizationId: orgId } }),
    promotions: await prisma.promotion.count({ where: { organizationId: orgId } }),
    credits: await prisma.promotionCredit.count({ where: { organizationId: orgId } }),
    audits: await prisma.auditLog.count({ where: { organizationId: orgId } }),
    students: await prisma.student.findMany({ where: { organizationId: orgId }, select: { id: true, beltAwardedAt: true, currentStripes: true, progressBaselineAt: true }, orderBy: { id: "asc" } }),
  };
}

beforeAll(async () => {
  slug = `activation-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
  const org = await prisma.organization.create({ data: { slug, name: "Activation Test Org", status: "ACTIVE" } });
  orgId = org.id;
  await appPrisma.$transaction(async (tx) => {
    await seedOrganizationDefaults(tx, orgId, "ATTENDANCE");
  });
  actorId = (await prisma.user.findUniqueOrThrow({ where: { email: "admin@alliancecr.com" } })).id;
  academyId = (await prisma.academy.create({ data: { organizationId: orgId, name: "Activation Academy", slug: `${slug}-a`, kioskTokenHash: `${slug}-hash` } })).id;

  // Reproduce an EXISTING organization: the legacy accounting and the old, unconfigured black belt.
  await prisma.promotionConfig.updateMany({ where: { organizationId: orgId }, data: { stripeAccounting: "CUMULATIVE" } });
  await prisma.beltRank.updateMany({
    where: { organizationId: orgId, track: "ADULT", code: "BLACK" },
    data: { maxStripes: 0, progressionMode: null, stripeIntervalMonths: [], stripeColors: [] },
  });

  const eligible = await makeStudent("eligible", "WHITE", "ADULT", 0);
  await addRows(eligible.id, 30); // 30 classes since the belt date: eligible today under the old rule
  const credited = await makeStudent("credited", "BLUE", "ADULT", 0);
  await prisma.promotionCredit.create({
    data: { studentId: credited.id, academyId, organizationId: orgId, beltAwardedAtAnchor: credited.beltAwardedAt, classesGranted: 45, reason: "legacy head start" },
  });
  const black = await makeStudent("black", "BLACK", "ADULT", 0);
  const sameDay = await makeStudent("sameday", "WHITE", "ADULT", 0);
  await addRows(sameDay.id, 4, 3); // 4 days, 3 classes each: 12 rows, 4 contributions
  ids = { eligible: eligible.id, credited: credited.id, black: black.id, sameDay: sameDay.id };
});

afterAll(async () => {
  await prisma.auditLog.deleteMany({ where: { organizationId: orgId } });
  await prisma.attendanceRecord.deleteMany({ where: { organizationId: orgId } });
  await prisma.promotionCredit.deleteMany({ where: { organizationId: orgId } });
  await prisma.promotion.deleteMany({ where: { organizationId: orgId } });
  await prisma.student.deleteMany({ where: { organizationId: orgId } });
  await prisma.academy.deleteMany({ where: { organizationId: orgId } });
  await prisma.beltRank.deleteMany({ where: { organizationId: orgId } });
  await prisma.promotionConfig.deleteMany({ where: { organizationId: orgId } });
  await prisma.organizationBranding.deleteMany({ where: { organizationId: orgId } });
  await prisma.organization.deleteMany({ where: { id: orgId } });
});

describe("a brand-new organization", () => {
  it("starts on the decided accounting: PER_INTERVAL on both tracks, manual awards only, black belt time-based with the configured intervals", async () => {
    const fresh = await prisma.organization.create({ data: { slug: `${slug}-fresh`, name: "Fresh Org", status: "ACTIVE" } });
    try {
      await appPrisma.$transaction(async (tx) => {
        await seedOrganizationDefaults(tx, fresh.id, "ATTENDANCE");
      });
      const configs = await prisma.promotionConfig.findMany({ where: { organizationId: fresh.id } });
      expect(configs.map((c) => [c.track, c.stripeAccounting, c.requiresCoachApproval]).sort()).toEqual([
        ["ADULT", "PER_INTERVAL", true],
        ["KIDS", "PER_INTERVAL", true],
      ]);
      const black = await prisma.beltRank.findFirstOrThrow({ where: { organizationId: fresh.id, code: "BLACK" } });
      expect(black).toMatchObject({ maxStripes: 6, progressionMode: "TIME", stripeIntervalMonths: [36, 36, 36, 60, 60, 60] });
      const kidsWhite = await prisma.beltRank.findFirstOrThrow({ where: { organizationId: fresh.id, track: "KIDS", code: "white" } });
      expect(kidsWhite).toMatchObject({ attendancesPerStripe: 10, attendancesForExam: 10 });
    } finally {
      await prisma.beltRank.deleteMany({ where: { organizationId: fresh.id } });
      await prisma.promotionConfig.deleteMany({ where: { organizationId: fresh.id } });
      await prisma.organizationBranding.deleteMany({ where: { organizationId: fresh.id } });
      await prisma.organization.deleteMany({ where: { id: fresh.id } });
    }
  });
});

/** A throwaway "existing" organization: legacy accounting and the old, unconfigured black belt. */
async function makeLegacyOrg(label: string, adultMode: "ATTENDANCE" | "MANUAL") {
  const orgSlug = `${slug}-${label}`;
  const org = await prisma.organization.create({ data: { slug: orgSlug, name: `Legacy ${label}`, status: "ACTIVE" } });
  await appPrisma.$transaction(async (tx) => {
    await seedOrganizationDefaults(tx, org.id, adultMode);
  });
  await prisma.promotionConfig.updateMany({ where: { organizationId: org.id }, data: { stripeAccounting: "CUMULATIVE" } });
  await prisma.beltRank.updateMany({
    where: { organizationId: org.id, track: "ADULT", code: "BLACK" },
    data: { maxStripes: 0, progressionMode: null, stripeIntervalMonths: [], stripeColors: [] },
  });
  const academy = await prisma.academy.create({ data: { organizationId: org.id, name: `A ${label}`, slug: `${orgSlug}-a`, kioskTokenHash: `${orgSlug}-h` } });
  return { org, academy, orgSlug };
}

async function dropOrg(orgId: string) {
  await prisma.auditLog.deleteMany({ where: { organizationId: orgId } });
  await prisma.attendanceRecord.deleteMany({ where: { organizationId: orgId } });
  await prisma.student.deleteMany({ where: { organizationId: orgId } });
  await prisma.academy.deleteMany({ where: { organizationId: orgId } });
  await prisma.beltRank.deleteMany({ where: { organizationId: orgId } });
  await prisma.promotionConfig.deleteMany({ where: { organizationId: orgId } });
  await prisma.organizationBranding.deleteMany({ where: { organizationId: orgId } });
  await prisma.organization.deleteMany({ where: { id: orgId } });
}

describe("activation edge cases", () => {
  it("a MANUAL adult track keeps its black belt manual: activation does not make black belts time-eligible", async () => {
    const { org, orgSlug } = await makeLegacyOrg("manual", "MANUAL");
    try {
      const report = await buildImpactReport(appPrisma, orgSlug);
      expect((report.blackBeltCatalog?.proposed as { progressionMode: unknown }).progressionMode).toBeNull();
      const result = await activateAccounting(appPrisma, { organizationSlug: orgSlug, reportId: report.reportId, activatedByUserId: actorId });
      expect(result.ok).toBe(true);
      const black = await prisma.beltRank.findFirstOrThrow({ where: { organizationId: org.id, code: "BLACK" } });
      expect(black).toMatchObject({ maxStripes: 6, progressionMode: null, stripeIntervalMonths: [36, 36, 36, 60, 60, 60] });
    } finally {
      await dropOrg(org.id);
    }
  });

  it("a track that is already PER_INTERVAL keeps its real award baselines; only the legacy track is re-baselined", async () => {
    const { org, academy, orgSlug } = await makeLegacyOrg("mixed", "ATTENDANCE");
    try {
      // ADULT already on the decided accounting, with a genuine award baseline; KIDS still legacy.
      await prisma.promotionConfig.updateMany({ where: { organizationId: org.id, track: "ADULT" }, data: { stripeAccounting: "PER_INTERVAL" } });
      const adultRank = await prisma.beltRank.findFirstOrThrow({ where: { organizationId: org.id, track: "ADULT", code: "WHITE" } });
      const kidsRank = await prisma.beltRank.findFirstOrThrow({ where: { organizationId: org.id, track: "KIDS", code: "white" } });
      const awardAt = new Date("2026-05-01T15:00:00Z");
      const mk = (label: string, rankId: string, track: Track, extra: object) =>
        prisma.student.create({
          data: {
            homeAcademyId: academy.id, organizationId: org.id, firstName: label, lastName: "Mixed", phone: "88880000",
            email: `${label}-${org.id}@example.com`, status: "ACTIVE", track, currentRankId: rankId,
            codeHash: digestLookupSecret(`${label}-${org.id}`, pepper), ...extra,
          },
        });
      const adult = await mk("adult", adultRank.id, "ADULT", { progressBaselineAt: awardAt, progressBaselineKind: "AWARD" });
      const kid = await mk("kid", kidsRank.id, "KIDS", {});

      const report = await buildImpactReport(appPrisma, orgSlug);
      // The already-active track is reported as what it is, and is not counted as "eligible today resetting to zero".
      expect(report.students.find((s) => s.studentId === adult.id)?.accounting).toBe("PER_INTERVAL");
      const at = new Date("2026-09-24T15:00:00Z");
      const result = await activateAccounting(appPrisma, { organizationSlug: orgSlug, reportId: report.reportId, activatedByUserId: actorId, at });
      expect(result).toMatchObject({ ok: true, studentsBaselined: 1, tracksActivated: ["KIDS"] });

      const adultAfter = await prisma.student.findUniqueOrThrow({ where: { id: adult.id } });
      expect(adultAfter.progressBaselineAt.getTime()).toBe(awardAt.getTime()); // untouched
      expect(adultAfter.progressBaselineKind).toBe("AWARD");
      const kidAfter = await prisma.student.findUniqueOrThrow({ where: { id: kid.id } });
      expect(kidAfter.progressBaselineAt.getTime()).toBe(at.getTime());
      expect(kidAfter.progressBaselineKind).toBe("SYSTEM_BASELINE");
    } finally {
      await dropOrg(org.id);
    }
  });
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const monthsAgo = (months: number) => new Date(Date.now() - months * 30.5 * DAY_MS);

async function mkStudent(orgId: string, academyId: string, label: string, track: Track, rankCode: string, stripes: number, extra: object = {}) {
  const rank = await prisma.beltRank.findFirstOrThrow({ where: { organizationId: orgId, track, code: rankCode } });
  return prisma.student.create({
    data: {
      homeAcademyId: academyId, organizationId: orgId, firstName: label, lastName: "Edge", phone: "88880000",
      email: `${label}-${orgId}@example.com`, status: "ACTIVE", track, currentRankId: rank.id, currentStripes: stripes,
      codeHash: digestLookupSecret(`${label}-${orgId}`, pepper), ...extra,
    },
  });
}

describe("activation is atomic: validated and applied in one transaction", () => {
  it("two simultaneous activations of the same reviewed report: exactly one applies, baselines are set once", async () => {
    const { org, academy, orgSlug } = await makeLegacyOrg("race", "ATTENDANCE");
    try {
      await mkStudent(org.id, academy.id, "r1", "ADULT", "WHITE", 0);
      await mkStudent(org.id, academy.id, "r2", "KIDS", "white", 0);
      const report = await buildImpactReport(appPrisma, orgSlug);
      const at1 = new Date("2026-09-24T15:00:00Z");
      const at2 = new Date("2026-09-24T16:00:00Z");
      const results = await Promise.all([
        activateAccounting(appPrisma, { organizationSlug: orgSlug, reportId: report.reportId, activatedByUserId: actorId, at: at1 }),
        activateAccounting(appPrisma, { organizationSlug: orgSlug, reportId: report.reportId, activatedByUserId: actorId, at: at2 }),
      ]);
      const winners = results.filter((r) => r.ok);
      expect(winners).toHaveLength(1);
      const loser = results.find((r) => !r.ok)!;
      expect(loser.ok === false && ["alreadyActive", "conflict"].includes(loser.error)).toBe(true);
      const winnerAt = (winners[0] as { baselineAt: Date }).baselineAt;
      // Baselines were written once, by the winner: never reset a second time by the loser.
      const students = await prisma.student.findMany({ where: { organizationId: org.id } });
      expect(students.every((s) => s.progressBaselineAt.getTime() === winnerAt.getTime())).toBe(true);
      expect(await prisma.auditLog.count({ where: { organizationId: org.id, action: "promotion-accounting.activate" } })).toBe(1);
    } finally {
      await dropOrg(org.id);
    }
  });

  it("an award/correction in flight cannot slip past the review: activation waits for it, then refuses (nothing applied)", async () => {
    const { org, academy, orgSlug } = await makeLegacyOrg("inflight", "ATTENDANCE");
    try {
      const student = await mkStudent(org.id, academy.id, "f1", "ADULT", "WHITE", 0);
      const report = await buildImpactReport(appPrisma, orgSlug);
      // Another connection is mid-change to a student (as an award would be) and commits after activation started.
      const holder = prisma.$transaction(
        async (tx) => {
          await tx.student.update({ where: { id: student.id }, data: { currentStripes: 2 } });
          await sleep(1500);
        },
        { timeout: 15_000 },
      );
      await sleep(400);
      const activation = await Promise.all([holder, activateAccounting(appPrisma, { organizationSlug: orgSlug, reportId: report.reportId, activatedByUserId: actorId })]).then((r) => r[1]);
      expect(activation.ok).toBe(false);
      expect(activation.ok === false && ["reportMismatch", "conflict"].includes(activation.error)).toBe(true);
      expect((await prisma.promotionConfig.findMany({ where: { organizationId: org.id } })).every((c) => c.stripeAccounting === "CUMULATIVE")).toBe(true);
      expect(await prisma.auditLog.count({ where: { organizationId: org.id, action: "promotion-accounting.activate" } })).toBe(0);
    } finally {
      await dropOrg(org.id);
    }
  });

  it("a configuration edit in flight cannot slip past the review either", async () => {
    const { org, academy, orgSlug } = await makeLegacyOrg("cfg", "ATTENDANCE");
    try {
      await mkStudent(org.id, academy.id, "c1", "ADULT", "WHITE", 0);
      const report = await buildImpactReport(appPrisma, orgSlug);
      const holder = prisma.$transaction(
        async (tx) => {
          await tx.promotionConfig.updateMany({ where: { organizationId: org.id, track: "ADULT" }, data: { stripeAccounting: "PER_INTERVAL" } });
          await sleep(1500);
        },
        { timeout: 15_000 },
      );
      await sleep(400);
      const activation = await Promise.all([holder, activateAccounting(appPrisma, { organizationSlug: orgSlug, reportId: report.reportId, activatedByUserId: actorId })]).then((r) => r[1]);
      expect(activation.ok).toBe(false);
      expect(await prisma.auditLog.count({ where: { organizationId: org.id, action: "promotion-accounting.activate" } })).toBe(0);
    } finally {
      await dropOrg(org.id);
    }
  });
});

describe("the impact report matches what actually happens after activation", () => {
  it("evaluates black belts with the PROPOSED configuration and known dates: eligible, due date, or date needed - and activation agrees", async () => {
    const { org, academy, orgSlug } = await makeLegacyOrg("black", "ATTENDANCE");
    try {
      const overdue = await mkStudent(org.id, academy.id, "b-overdue", "ADULT", "BLACK", 0, { timeAnchorAt: monthsAgo(40) }); // 36 months needed
      const pending = await mkStudent(org.id, academy.id, "b-pending", "ADULT", "BLACK", 0, { timeAnchorAt: monthsAgo(10) });
      const fourth = await mkStudent(org.id, academy.id, "b-fourth", "ADULT", "BLACK", 3, { timeAnchorAt: monthsAgo(40) }); // 3 -> 4 needs 60
      const unknown = await mkStudent(org.id, academy.id, "b-unknown", "ADULT", "BLACK", 0, { timeAnchorAt: null });

      const report = await buildImpactReport(appPrisma, orgSlug);
      const after = (id: string) => report.students.find((s) => s.studentId === id)!.after;
      expect(after(overdue.id)).toMatchObject({ state: "eligible", eligible: true });
      expect(after(overdue.id).dueDate).not.toBeNull();
      expect(after(pending.id)).toMatchObject({ state: "time_pending", eligible: false });
      expect(after(pending.id).dueDate).not.toBeNull();
      expect(after(fourth.id)).toMatchObject({ state: "time_pending", eligible: false });
      expect(after(unknown.id)).toMatchObject({ state: "time_anchor_missing", eligible: false, dueDate: null });
      expect(report.totals).toMatchObject({ eligibleAfterActivation: 1, blackBeltsWithoutLastAwardDate: 1, blackBeltsWithDueDate: 3 });

      const result = await activateAccounting(appPrisma, { organizationSlug: orgSlug, reportId: report.reportId, activatedByUserId: actorId });
      expect(result.ok).toBe(true);
      // What the report said is what the app now shows.
      const configs = await resolvePromotionConfigMap(org.id);
      for (const s of [overdue, pending, fourth, unknown]) {
        const summary = await getAtBeltSummary(s.id, org.id, configs);
        expect(summary.isEligible, s.email).toBe(after(s.id).eligible);
        expect(summary.dueDate?.toISOString() ?? null, s.email).toBe(after(s.id).dueDate);
        expect(summary.timeAnchorMissing, s.email).toBe(after(s.id).state === "time_anchor_missing");
      }
    } finally {
      await dropOrg(org.id);
    }
  });

  it("approval is bound to those outcomes: supplying a black belt's date after review makes the reviewed id stale", async () => {
    const { org, academy, orgSlug } = await makeLegacyOrg("bound", "ATTENDANCE");
    try {
      const unknown = await mkStudent(org.id, academy.id, "bd-unknown", "ADULT", "BLACK", 0, { timeAnchorAt: null });
      const report = await buildImpactReport(appPrisma, orgSlug);
      await prisma.student.update({ where: { id: unknown.id }, data: { timeAnchorAt: monthsAgo(50) } }); // now eligible after activation
      const refused = await activateAccounting(appPrisma, { organizationSlug: orgSlug, reportId: report.reportId, activatedByUserId: actorId });
      expect(refused).toEqual({ ok: false, error: "reportMismatch" });
      const fresh = await buildImpactReport(appPrisma, orgSlug);
      expect(fresh.reportId).not.toBe(report.reportId);
      expect((await activateAccounting(appPrisma, { organizationSlug: orgSlug, reportId: fresh.reportId, activatedByUserId: actorId })).ok).toBe(true);
    } finally {
      await dropOrg(org.id);
    }
  });

  it("approval is bound to WHO gets which outcome, not only to the totals: swapping two black belts' dates keeps every total and still invalidates the id", async () => {
    const { org, academy, orgSlug } = await makeLegacyOrg("swap", "ATTENDANCE");
    try {
      const a = await mkStudent(org.id, academy.id, "s-a", "ADULT", "BLACK", 0, { timeAnchorAt: monthsAgo(40) }); // eligible after activation
      const b = await mkStudent(org.id, academy.id, "s-b", "ADULT", "BLACK", 0, { timeAnchorAt: monthsAgo(10) }); // pending
      const report = await buildImpactReport(appPrisma, orgSlug);
      // Swap: A becomes pending, B becomes eligible. Every total (1 eligible, 2 with a due date) is unchanged.
      await prisma.student.update({ where: { id: a.id }, data: { timeAnchorAt: monthsAgo(10) } });
      await prisma.student.update({ where: { id: b.id }, data: { timeAnchorAt: monthsAgo(40) } });
      const swapped = await buildImpactReport(appPrisma, orgSlug);
      expect(swapped.totals).toEqual(report.totals);
      expect(swapped.reportId).not.toBe(report.reportId);
      expect(await activateAccounting(appPrisma, { organizationSlug: orgSlug, reportId: report.reportId, activatedByUserId: actorId })).toEqual({ ok: false, error: "reportMismatch" });
    } finally {
      await dropOrg(org.id);
    }
  });

  it("a track already on PER_INTERVAL is reported as what those students see now, not reset to 0", async () => {
    const { org, academy, orgSlug } = await makeLegacyOrg("preserve", "ATTENDANCE");
    try {
      await prisma.promotionConfig.updateMany({ where: { organizationId: org.id, track: "ADULT" }, data: { stripeAccounting: "PER_INTERVAL" } });
      const baseline = new Date("2026-01-01T00:00:00Z");
      const adult = await mkStudent(org.id, academy.id, "p-adult", "ADULT", "WHITE", 0, { progressBaselineAt: baseline, progressBaselineKind: "AWARD" });
      const rows = Array.from({ length: 30 }, (_, i) => {
        const occurredAt = new Date(new Date("2026-02-01T12:00:00Z").getTime() + i * DAY_MS);
        return { studentId: adult.id, academyId: academy.id, organizationId: org.id, occurredAt, date: toAttendanceDate(occurredAt), type: "ADJUSTMENT" as const, delta: 1, reason: "d", source: "STAFF" as const };
      });
      await prisma.attendanceRecord.createMany({ data: rows });
      await mkStudent(org.id, academy.id, "p-kid", "KIDS", "white", 0);

      const report = await buildImpactReport(appPrisma, orgSlug);
      const row = report.students.find((s) => s.studentId === adult.id)!;
      expect(row.accounting).toBe("PER_INTERVAL");
      expect(row.after).toMatchObject({ count: 30, eligible: true, state: "eligible" }); // preserved, not reset to 0
      expect(report.totals.eligibleAfterActivation).toBe(0); // only students being flipped are counted
      expect(report.totals.eligibleTodayResettingToZero).toBe(0);
    } finally {
      await dropOrg(org.id);
    }
  });
});

describe("existing organization: report, then reviewed activation", () => {
  it("the impact report is read-only and says who is affected", async () => {
    const before = await counts();
    const report = await buildImpactReport(appPrisma, slug);
    const again = await buildImpactReport(appPrisma, slug);
    expect(await counts()).toEqual(before); // nothing written, no audit row either
    expect(again.reportId).toBe(report.reportId); // stable while the facts do not change

    expect(report.tracks.map((t) => t.accounting)).toEqual(["CUMULATIVE", "CUMULATIVE"]);
    expect(report.totals).toMatchObject({
      students: 4,
      eligibleTodayResettingToZero: 1, // the 30-class student reads 0 afterwards
      studentsWithLegacyCredits: 1,
      legacyCreditClasses: 45,
      blackBeltsWithoutLastAwardDate: 1,
      automaticPromotionsInHistory: 0,
    });
    // 12 rows on 4 days: 8 rows add nothing under the one-per-day rule (kept as history).
    expect(report.totals.extraSameDayRows).toBe(8);
    expect(report.blackBeltCatalog?.needsUpdate).toBe(true);

    const eligibleRow = report.students.find((s) => s.studentId === ids.eligible)!;
    expect(eligibleRow.today).toMatchObject({ count: 30, eligible: true });
    expect(eligibleRow.after).toEqual({ count: 0, target: 30, eligible: false, state: "in_progress", dueDate: null });
    expect(report.students.find((s) => s.studentId === ids.black)?.lastAwardDateNeeded).toBe(true);
  });

  it("refuses an activation that is not bound to a current report, and changes nothing", async () => {
    const before = await counts();
    expect(await activateAccounting(appPrisma, { organizationSlug: slug, reportId: "not-the-report", activatedByUserId: actorId })).toEqual({
      ok: false,
      error: "reportMismatch",
    });
    expect(await counts()).toEqual(before);
    expect((await prisma.promotionConfig.findMany({ where: { organizationId: orgId } })).every((c) => c.stripeAccounting === "CUMULATIVE")).toBe(true);
  });

  it("activates exactly what was reported: every student restarts at 0 from a system baseline, nothing historical is touched", async () => {
    const report = await buildImpactReport(appPrisma, slug);
    const before = await counts();
    const at = new Date("2026-09-24T15:00:00Z");
    const result = await activateAccounting(appPrisma, { organizationSlug: slug, reportId: report.reportId, activatedByUserId: actorId, at });
    expect(result).toMatchObject({ ok: true, studentsBaselined: 4, blackBeltCatalogUpdated: true });

    const after = await counts();
    // History is preserved: attendance, promotions, credits, belt dates and degrees are untouched.
    expect(after.attendance).toBe(before.attendance);
    expect(after.promotions).toBe(before.promotions);
    expect(after.credits).toBe(before.credits);
    expect(after.students.map((s) => [s.id, s.beltAwardedAt.getTime(), s.currentStripes])).toEqual(
      before.students.map((s) => [s.id, s.beltAwardedAt.getTime(), s.currentStripes]),
    );
    // ...while the tracking baseline is the activation instant, recorded as a system baseline, never an award.
    expect(after.students.every((s) => s.progressBaselineAt.getTime() === at.getTime())).toBe(true);
    const student = await prisma.student.findUniqueOrThrow({ where: { id: ids.eligible } });
    expect(student.progressBaselineKind).toBe("SYSTEM_BASELINE");
    expect(await prisma.promotion.count({ where: { organizationId: orgId } })).toBe(0); // no promotion was invented

    expect((await prisma.promotionConfig.findMany({ where: { organizationId: orgId } })).map((c) => c.stripeAccounting)).toEqual(["PER_INTERVAL", "PER_INTERVAL"]);
    const black = await prisma.beltRank.findFirstOrThrow({ where: { organizationId: orgId, code: "BLACK" } });
    expect(black).toMatchObject({ maxStripes: 6, progressionMode: "TIME", stripeIntervalMonths: [36, 36, 36, 60, 60, 60] });

    const audit = await prisma.auditLog.findFirstOrThrow({ where: { organizationId: orgId, action: "promotion-accounting.activate" } });
    expect(audit.actorId).toBe(actorId);
    expect(audit.after).toMatchObject({ accounting: "PER_INTERVAL", reportId: report.reportId, studentsBaselined: 4 });
  });

  it("after activation the eligible student reads 0 of 30, the legacy credit is ignored, extra same-day rows add nothing, and the black belt has no due date yet", async () => {
    const configs = await resolvePromotionConfigMap(orgId);
    const summary = (id: string) => getAtBeltSummary(id, orgId, configs);
    expect(await summary(ids.eligible)).toMatchObject({ atBeltCount: 0, target: 30, isEligible: false, accounting: "PER_INTERVAL" });
    expect(await summary(ids.credited)).toMatchObject({ atBeltCount: 0, isEligible: false });
    expect(await prisma.promotionCredit.count({ where: { studentId: ids.credited } })).toBe(1); // history kept, unread
    expect(await summary(ids.black)).toMatchObject({ timeAnchorMissing: true, dueDate: null, isEligible: false, mode: "TIME" });
  });

  it("a second activation is refused as already active", async () => {
    const report = await buildImpactReport(appPrisma, slug);
    expect(await activateAccounting(appPrisma, { organizationSlug: slug, reportId: report.reportId, activatedByUserId: actorId })).toEqual({
      ok: false,
      error: "alreadyActive",
    });
  });
});
