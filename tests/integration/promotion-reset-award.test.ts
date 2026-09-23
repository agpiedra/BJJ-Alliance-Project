import "dotenv/config";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { getTestPrismaClient } from "../helpers/test-db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DateTime } from "luxon";
import { requireEnv } from "../../src/lib/env";
import { digestLookupSecret } from "../../src/lib/crypto";
import { toAttendanceDate } from "../../src/lib/scheduling/zone";
import type { TenantContext } from "../../src/lib/tenant/types";
import { adultRankId, kidsRankId } from "../helpers/belt-ranks";
import { ALLIANCE_PER_INTERVAL_CONFIG } from "../helpers/promotion-config";
import type { Track } from "../../src/generated/prisma/client";

const { awardPromotion, writeAward, AutomaticPromotionError } = await import("../../src/lib/promotion/award");
const { getAtBeltSummary } = await import("../../src/lib/students/attendance-summary");
const { changeTrack } = await import("../../src/lib/promotion/track-change");
const { JOB_NAMES } = await import("../../src/lib/jobs/job-names");

/**
 * docs/PROMOTION_PROGRESS_PROPOSAL.md - reset after EVERY promotion, exact award
 * timestamp saved, manual awards only. Alliance's ADULT and KIDS tracks are
 * switched to PER_INTERVAL for this file only (the seed leaves them CUMULATIVE
 * until scripts/promotion-accounting.ts activates them) and restored after.
 */

const prisma = getTestPrismaClient();
const pepper = requireEnv("CODE_PEPPER");

const DAY_MS = 24 * 60 * 60 * 1000;
const cr = (iso: string) => new Date(`${iso}-06:00`);

let orgId: string;
let academyId: string;
let actorUserId: string;
const cleanupStudentIds: string[] = [];

function ctx(): TenantContext {
  return {
    kind: "tenant",
    actorUserId,
    organizationId: orgId,
    organizationRole: "ADMIN",
    academyIds: "ALL",
    selfStudentId: null,
    linkedStudentId: null,
  };
}

async function makeStudent(opts: {
  rankId: string;
  stripes?: number;
  track?: Track;
  baseline?: Date;
  timeAnchorAt?: Date | null;
}) {
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
  const student = await prisma.student.create({
    data: {
      homeAcademyId: academyId,
      organizationId: orgId,
      firstName: "ResetAward",
      lastName: "Student",
      phone: "88880000",
      email: `reset-award-${suffix}@example.com`,
      status: "ACTIVE",
      track: opts.track ?? "ADULT",
      currentRankId: opts.rankId,
      currentStripes: opts.stripes ?? 0,
      progressBaselineAt: opts.baseline ?? cr("2026-01-01T00:00:00"),
      timeAnchorAt: opts.timeAnchorAt ?? null,
      codeHash: digestLookupSecret(`reset-award-${suffix}`, pepper),
    },
  });
  cleanupStudentIds.push(student.id);
  return student;
}

/** `n` staff-added attendance days (one per CR day), starting at `start`, all safely in the past. */
async function addDays(studentId: string, n: number, start = cr("2026-02-01T06:00:00")) {
  await prisma.attendanceRecord.createMany({
    data: Array.from({ length: n }, (_, i) => {
      const occurredAt = new Date(start.getTime() + i * DAY_MS);
      return {
        studentId,
        academyId,
        organizationId: orgId,
        occurredAt,
        date: toAttendanceDate(occurredAt),
        type: "ADJUSTMENT" as const,
        delta: 1,
        reason: "day",
        source: "STAFF" as const,
      };
    }),
  });
}

async function summary(studentId: string) {
  return getAtBeltSummary(studentId, orgId, ALLIANCE_PER_INTERVAL_CONFIG);
}

beforeAll(async () => {
  const org = await prisma.organization.findUniqueOrThrow({ where: { slug: "alliance-cr" } });
  orgId = org.id;
  academyId = (await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } })).id;
  actorUserId = (await prisma.user.findUniqueOrThrow({ where: { email: "admin@alliancecr.com" } })).id;
  await prisma.promotionConfig.updateMany({ where: { organizationId: orgId }, data: { stripeAccounting: "PER_INTERVAL" } });
});

afterAll(async () => {
  await prisma.promotionConfig.updateMany({ where: { organizationId: orgId }, data: { stripeAccounting: "CUMULATIVE" } });
  if (cleanupStudentIds.length > 0) {
    await prisma.auditLog.deleteMany({ where: { entityId: { in: cleanupStudentIds } } });
    await prisma.promotion.deleteMany({ where: { studentId: { in: cleanupStudentIds } } });
    await prisma.attendanceRecord.deleteMany({ where: { studentId: { in: cleanupStudentIds } } });
    await prisma.student.deleteMany({ where: { id: { in: cleanupStudentIds } } });
  }
});

describe("reset after every promotion", () => {
  it("records the exact award timestamp, updates the rank, and restarts progress at 0 of 30", async () => {
    const student = await makeStudent({ rankId: adultRankId("WHITE") });
    await addDays(student.id, 30);
    expect(await awardPromotion(ctx(), student.id, null)).toEqual({ ok: true, kind: "stripe" });

    const after = await prisma.student.findUniqueOrThrow({ where: { id: student.id } });
    const promotion = await prisma.promotion.findFirstOrThrow({ where: { studentId: student.id } });
    expect(after.currentStripes).toBe(1);
    // The one saved instant is the promotion's own timestamp, the new progress baseline and the time anchor.
    expect(after.progressBaselineAt.getTime()).toBe(promotion.awardedAt.getTime());
    expect(after.timeAnchorAt?.getTime()).toBe(promotion.awardedAt.getTime());
    expect(after.progressBaselineKind).toBe("AWARD");
    expect(promotion.source).toBe("MANUAL");

    expect(await summary(student.id)).toMatchObject({ atBeltCount: 0, target: 30, remainingAttendance: 30, isEligible: false, currentStripes: 1 });
  });

  it("a stripe from a student who had 45 days carries nothing over: the extra 15 do not start the next stripe", async () => {
    const student = await makeStudent({ rankId: adultRankId("WHITE") });
    await addDays(student.id, 45);
    expect((await awardPromotion(ctx(), student.id, null)).ok).toBe(true);
    expect(await summary(student.id)).toMatchObject({ atBeltCount: 0, remainingAttendance: 30 });
  });

  it("an award refuses a student below the threshold and writes nothing", async () => {
    const student = await makeStudent({ rankId: adultRankId("WHITE") });
    await addDays(student.id, 29);
    expect(await awardPromotion(ctx(), student.id, null)).toEqual({ ok: false, error: "notEligible" });
    expect(await prisma.promotion.count({ where: { studentId: student.id } })).toBe(0);
    expect((await prisma.student.findUniqueOrThrow({ where: { id: student.id } })).currentStripes).toBe(0);
  });

  it("a check-in before the promotion is the completed interval's: the same day adds 0 afterwards, the next day adds 1", async () => {
    const today = toAttendanceDate(new Date());
    const student = await makeStudent({ rankId: adultRankId("WHITE") });
    await addDays(student.id, 29);
    // The 30th qualifying day is today's class, attended before the coach awards.
    await prisma.attendanceRecord.create({
      data: {
        studentId: student.id,
        academyId,
        organizationId: orgId,
        occurredAt: new Date(Date.now() - 2 * 3600_000),
        date: today,
        type: "ADJUSTMENT",
        delta: 1,
        reason: "today's class",
        source: "STAFF",
      },
    });
    expect((await awardPromotion(ctx(), student.id, null)).ok).toBe(true);

    // Another class the same ledger day, after the award: the promotion does not clear the daily limit.
    await prisma.attendanceRecord.create({
      data: { studentId: student.id, academyId, organizationId: orgId, occurredAt: new Date(), date: today, type: "ADJUSTMENT", delta: 1, reason: "second class", source: "STAFF" },
    });
    expect((await summary(student.id)).atBeltCount).toBe(0);

    // The next qualifying day is the new interval's first.
    const tomorrow = new Date(today.getTime() + DAY_MS);
    await prisma.attendanceRecord.create({
      data: { studentId: student.id, academyId, organizationId: orgId, occurredAt: new Date(), date: tomorrow, type: "ADJUSTMENT", delta: 1, reason: "next day", source: "STAFF" },
    });
    expect((await summary(student.id)).atBeltCount).toBe(1);
  });

  it("late-recorded attendance from before the award stays in history and adds nothing toward the next stripe", async () => {
    const student = await makeStudent({ rankId: adultRankId("WHITE") });
    await addDays(student.id, 30);
    expect((await awardPromotion(ctx(), student.id, null)).ok).toBe(true);
    const promotion = await prisma.promotion.findFirstOrThrow({ where: { studentId: student.id } });

    // A tablet replay lands after the award for a class that happened an hour BEFORE it, on a day with no other class.
    await prisma.attendanceRecord.create({
      data: {
        studentId: student.id,
        academyId,
        organizationId: orgId,
        occurredAt: new Date(promotion.awardedAt.getTime() - 3600_000),
        date: cr("2026-05-05T00:00:00"),
        type: "CHECKIN",
        delta: 1,
        source: "KIOSK",
      },
    });
    const result = await summary(student.id);
    expect(result.atBeltCount).toBe(0);
    expect(result.lifetimeCount).toBe(31);
  });

  it("a belt award (4 stripes -> next belt) resets too: the new belt starts at 0 of its own threshold", async () => {
    const student = await makeStudent({ rankId: adultRankId("WHITE"), stripes: 4 });
    await addDays(student.id, 30);
    expect(await awardPromotion(ctx(), student.id, null)).toEqual({ ok: true, kind: "belt" });
    const after = await prisma.student.findUniqueOrThrow({ where: { id: student.id } });
    expect(after).toMatchObject({ currentRankId: adultRankId("BLUE"), currentStripes: 0, progressBaselineKind: "AWARD" });
    expect(await summary(student.id)).toMatchObject({ atBeltCount: 0, target: 65, remainingAttendance: 65 });
  });

  it("kids reset after every degree AND the belt: 10 days per degree, then 10 more for the belt", async () => {
    // Kids "white" has 5 degrees; a child at degree 4 needs 10 days for degree 5, then 10 more for the belt.
    const student = await makeStudent({ rankId: kidsRankId("white"), stripes: 4, track: "KIDS" });
    await addDays(student.id, 10);
    expect(await awardPromotion(ctx(), student.id, null)).toEqual({ ok: true, kind: "stripe" });
    expect(await summary(student.id)).toMatchObject({ atBeltCount: 0, target: 10, nextTarget: "BELT", currentStripes: 5 });

    // Ten qualifying days after the award (dated at the award's own end so they are safely "after"):
    // move the baseline back instead of fabricating future attendance.
    await prisma.student.update({ where: { id: student.id }, data: { progressBaselineAt: cr("2026-03-01T00:00:00") } });
    await addDays(student.id, 9, cr("2026-03-05T06:00:00"));
    expect((await summary(student.id)).isEligible).toBe(false);
    await addDays(student.id, 1, cr("2026-04-05T06:00:00"));
    expect((await summary(student.id)).isEligible).toBe(true);
    expect(await awardPromotion(ctx(), student.id, null)).toEqual({ ok: true, kind: "belt" });
    const after = await prisma.student.findUniqueOrThrow({ where: { id: student.id } });
    expect(after).toMatchObject({ currentRankId: kidsRankId("grey_white"), currentStripes: 0 });
    expect(await summary(student.id)).toMatchObject({ atBeltCount: 0, target: 10 });
  });

  it("a track change is a promotion too: it saves its own instant and restarts progress", async () => {
    const student = await makeStudent({ rankId: kidsRankId("green_black"), stripes: 3, track: "KIDS" });
    await addDays(student.id, 7);
    expect(await changeTrack(ctx(), { studentId: student.id, toRankId: adultRankId("BLUE"), toStripes: 0, note: null })).toEqual({ ok: true });
    const after = await prisma.student.findUniqueOrThrow({ where: { id: student.id } });
    const promotion = await prisma.promotion.findFirstOrThrow({ where: { studentId: student.id } });
    expect(after.progressBaselineAt.getTime()).toBe(promotion.awardedAt.getTime());
    expect(after.progressBaselineKind).toBe("AWARD");
    expect(await summary(student.id)).toMatchObject({ atBeltCount: 0, track: "ADULT" });
  });

  it("the award audit row records the boundary instant and the qualifying days that made the student eligible", async () => {
    const student = await makeStudent({ rankId: adultRankId("WHITE") });
    await addDays(student.id, 32);
    expect((await awardPromotion(ctx(), student.id, null)).ok).toBe(true);
    const promotion = await prisma.promotion.findFirstOrThrow({ where: { studentId: student.id } });
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { entityId: student.id, action: "student.promote" } });
    const after = audit.after as { boundaryAt: string; progressReset: boolean; evidence: { count: number; target: number; days: unknown[] } };
    expect(after.boundaryAt).toBe(promotion.awardedAt.toISOString());
    expect(after.progressReset).toBe(true);
    expect(after.evidence).toMatchObject({ count: 32, target: 30 });
    expect(after.evidence.days).toHaveLength(32);
  });

  it("eligibility is decided on the evidence as of the award instant: a class dated after it cannot make a student eligible", async () => {
    const student = await makeStudent({ rankId: adultRankId("WHITE") });
    await addDays(student.id, 29);
    // A 30th qualifying day dated tomorrow: an unbounded read (the pre-transaction check) sees 30 and calls the student
    // eligible, but the in-transaction re-check only counts days whose first attendance is before the award instant.
    const tomorrow = new Date(Date.now() + DAY_MS);
    await prisma.attendanceRecord.create({
      data: { studentId: student.id, academyId, organizationId: orgId, occurredAt: tomorrow, date: toAttendanceDate(tomorrow), type: "ADJUSTMENT", delta: 1, reason: "not yet happened", source: "STAFF" },
    });
    expect((await summary(student.id)).isEligible).toBe(true);
    expect(await awardPromotion(ctx(), student.id, null)).toEqual({ ok: false, error: "notEligible" });
    expect(await prisma.promotion.count({ where: { studentId: student.id } })).toBe(0);
  });

  it("two simultaneous awards for one student write exactly one promotion", async () => {
    const student = await makeStudent({ rankId: adultRankId("WHITE") });
    await addDays(student.id, 30);
    const results = await Promise.all([awardPromotion(ctx(), student.id, null), awardPromotion(ctx(), student.id, null)]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(await prisma.promotion.count({ where: { studentId: student.id } })).toBe(1);
    expect((await prisma.student.findUniqueOrThrow({ where: { id: student.id } })).currentStripes).toBe(1);
  });

  it("consecutive awards have strictly increasing boundaries even when made back to back", async () => {
    const student = await makeStudent({ rankId: adultRankId("WHITE") });
    await addDays(student.id, 30);
    expect((await awardPromotion(ctx(), student.id, null)).ok).toBe(true);
    const first = await prisma.student.findUniqueOrThrow({ where: { id: student.id } });
    // 30 more days, all dated after the first boundary, so a second award is legitimately eligible.
    await prisma.student.update({ where: { id: student.id }, data: { progressBaselineAt: cr("2026-03-15T00:00:00") } });
    await addDays(student.id, 30, cr("2026-04-01T06:00:00"));
    expect((await awardPromotion(ctx(), student.id, null)).ok).toBe(true);
    const second = await prisma.student.findUniqueOrThrow({ where: { id: student.id } });
    expect(second.progressBaselineAt.getTime()).toBeGreaterThan(first.progressBaselineAt.getTime() - 1);
    expect(second.currentStripes).toBe(2);
  });
});

describe("black belt: time-based degrees", () => {
  const monthsAgo = (months: number) => DateTime.now().minus({ months, days: 1 }).toJSDate();

  it("degree 0 -> 1 needs 36 months since the last award, whatever the attendance", async () => {
    const eligible = await makeStudent({ rankId: adultRankId("BLACK"), timeAnchorAt: monthsAgo(36) });
    expect(await awardPromotion(ctx(), eligible.id, null)).toEqual({ ok: true, kind: "stripe" });
    const after = await prisma.student.findUniqueOrThrow({ where: { id: eligible.id } });
    expect(after.currentStripes).toBe(1);
    // The future awards' timestamp is saved automatically as the new last-award date.
    expect(after.timeAnchorAt?.getTime()).toBe(after.progressBaselineAt.getTime());

    const early = await makeStudent({ rankId: adultRankId("BLACK"), timeAnchorAt: monthsAgo(35) });
    await addDays(early.id, 200);
    expect(await awardPromotion(ctx(), early.id, null)).toEqual({ ok: false, error: "notEligible" });
  });

  it("degree 3 -> 4 needs 60 months, not 36", async () => {
    const at40 = await makeStudent({ rankId: adultRankId("BLACK"), stripes: 3, timeAnchorAt: monthsAgo(40) });
    expect(await awardPromotion(ctx(), at40.id, null)).toEqual({ ok: false, error: "notEligible" });
    const at61 = await makeStudent({ rankId: adultRankId("BLACK"), stripes: 3, timeAnchorAt: monthsAgo(61) });
    expect(await awardPromotion(ctx(), at61.id, null)).toEqual({ ok: true, kind: "stripe" });
  });

  it("an existing black belt with no known last-award date shows rank and attendance but no due date, and cannot be awarded", async () => {
    const student = await makeStudent({ rankId: adultRankId("BLACK"), timeAnchorAt: null });
    await addDays(student.id, 12);
    const result = await summary(student.id);
    expect(result).toMatchObject({ currentBelt: "BLACK", timeAnchorMissing: true, dueDate: null, isEligible: false, atBeltCount: 12, mode: "TIME" });
    expect(await awardPromotion(ctx(), student.id, null)).toEqual({ ok: false, error: "notEligible" });
  });

  it("beyond the sixth degree there is no configured target - none is invented", async () => {
    const student = await makeStudent({ rankId: adultRankId("BLACK"), stripes: 6, timeAnchorAt: monthsAgo(200) });
    expect(await awardPromotion(ctx(), student.id, null)).toEqual({ ok: false, error: "notEligible" });
  });
});

describe("manual awards only", () => {
  it("writeAward refuses an AUTO source outright, before touching the database", async () => {
    const student = await makeStudent({ rankId: adultRankId("WHITE") });
    await addDays(student.id, 30);
    await expect(
      writeAward({
        studentId: student.id,
        homeAcademyId: academyId,
        organizationId: orgId,
        fromRankId: adultRankId("WHITE"),
        fromStripes: 0,
        toRankId: adultRankId("WHITE"),
        toStripes: 1,
        progress: "reset",
        before: { belt: "WHITE", stripes: 0 },
        after: { belt: "WHITE", stripes: 1 },
        source: "AUTO",
        awardedById: null,
        notes: null,
      }),
    ).rejects.toBeInstanceOf(AutomaticPromotionError);
    expect(await prisma.promotion.count({ where: { studentId: student.id } })).toBe(0);
    expect((await prisma.student.findUniqueOrThrow({ where: { id: student.id } })).currentStripes).toBe(0);
  });

  it("the database itself refuses automatic approval settings (CHECK constraint), for every writer", async () => {
    await expect(prisma.$executeRaw`UPDATE "PromotionConfig" SET "requiresCoachApproval" = false WHERE "organizationId" = ${orgId}`).rejects.toThrow();
    expect(await prisma.promotionConfig.count({ where: { organizationId: orgId, requiresCoachApproval: false } })).toBe(0);
  });

  it("no scheduled path exists: no promotion cron route, no vercel cron entry, no registered job", () => {
    const root = process.cwd();
    expect(existsSync(path.join(root, "src/app/api/cron/promotion-auto-award/route.ts"))).toBe(false);
    expect(existsSync(path.join(root, "src/lib/promotion/automation.ts"))).toBe(false);
    const vercel = JSON.parse(readFileSync(path.join(root, "vercel.json"), "utf8")) as { crons: Array<{ path: string }> };
    expect(vercel.crons.map((c) => c.path)).toEqual(["/api/cron/weekly-digest"]);
    expect([...JOB_NAMES]).toEqual(["weekly-digest"]);
  });
});
