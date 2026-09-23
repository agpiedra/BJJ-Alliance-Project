import "dotenv/config";
import { getTestPrismaClient } from "../helpers/test-db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { requireEnv } from "../../src/lib/env";
import { digestLookupSecret } from "../../src/lib/crypto";
import { toAttendanceDate } from "../../src/lib/scheduling/zone";
import { adultRankId } from "../helpers/belt-ranks";
import { ALLIANCE_ATTENDANCE_CONFIG, ALLIANCE_PER_INTERVAL_CONFIG } from "../helpers/promotion-config";
import type { AttendanceMatchSource } from "../../src/generated/prisma/client";

const { getAtBeltSummary } = await import("../../src/lib/students/attendance-summary");

/**
 * docs/PROMOTION_PROGRESS_PROPOSAL.md - the academy's decided rule: a student
 * gets at most ONE qualifying attendance per America/Costa_Rica calendar day, no
 * matter how many classes, entry channels, retries or replays; and only days
 * whose FIRST qualifying attendance is at/after the last award count toward the
 * next stripe. Every AttendanceRecord row is still kept (history), the daily
 * contribution is what these tests count.
 *
 * Runs under TZ=Pacific/Kiritimati (vitest.integration.config.ts), so a UTC-date
 * or server-local-date shortcut in the implementation would fail here.
 */

const prisma = getTestPrismaClient();
const pepper = requireEnv("CODE_PEPPER");

const cleanupStudentIds: string[] = [];
const cleanupAcademyIds: string[] = [];

let organizationId: string;
let academyId: string;
let classes: { early: string; late: string; striking: string };

async function makeStudent(overrides: { currentStripes?: number; progressBaselineAt: Date }) {
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
  const student = await prisma.student.create({
    data: {
      homeAcademyId: academyId,
      organizationId,
      firstName: "ProgressDays",
      lastName: "Student",
      phone: "88880000",
      email: `progress-days-${suffix}@example.com`,
      currentRankId: adultRankId("WHITE"),
      currentStripes: overrides.currentStripes ?? 0,
      progressBaselineAt: overrides.progressBaselineAt,
      codeHash: digestLookupSecret(`progress-days-${suffix}`, pepper),
    },
  });
  cleanupStudentIds.push(student.id);
  return student;
}

/** One physical attendance. `date` is derived exactly the way the real writers derive it. */
async function attend(
  studentId: string,
  occurredAt: Date,
  opts: {
    classSessionId?: string | null;
    matchSource?: AttendanceMatchSource;
    delta?: number;
    type?: "CHECKIN" | "ADJUSTMENT";
    date?: Date;
  } = {},
) {
  return prisma.attendanceRecord.create({
    data: {
      studentId,
      academyId,
      organizationId,
      classSessionId: opts.classSessionId === undefined ? classes.early : opts.classSessionId,
      occurredAt,
      date: opts.date ?? toAttendanceDate(occurredAt),
      type: opts.type ?? "CHECKIN",
      delta: opts.delta ?? 1,
      source: "KIOSK",
      matchSource: opts.matchSource ?? "AUTO",
    },
  });
}

async function perInterval(studentId: string) {
  return getAtBeltSummary(studentId, organizationId, ALLIANCE_PER_INTERVAL_CONFIG);
}

// 06:00 Costa Rica = 12:00 UTC (UTC-6, no DST).
const cr = (iso: string) => new Date(`${iso}-06:00`);

beforeAll(async () => {
  const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
  organizationId = escazu.organizationId;
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
  const academy = await prisma.academy.create({
    data: { name: `Progress Days ${suffix}`, slug: `progress-days-${suffix}`, kioskTokenHash: `pd-hash-${suffix}`, organizationId },
  });
  academyId = academy.id;
  cleanupAcademyIds.push(academy.id);
  const make = (name: string, dayOfWeek: "TUESDAY" | "SATURDAY", startTime: string, counts: boolean) =>
    prisma.classSession.create({
      data: { academyId, organizationId, dayOfWeek, startTime, durationMinutes: 60, name, type: counts ? "GI" : "STRIKING", countsTowardPromotion: counts },
    });
  const [early, late, striking] = await Promise.all([
    make("Morning GI", "TUESDAY", "06:00", true),
    make("Evening GI", "TUESDAY", "20:00", true),
    make("Striking", "SATURDAY", "09:00", false),
  ]);
  classes = { early: early.id, late: late.id, striking: striking.id };
});

afterAll(async () => {
  if (cleanupStudentIds.length > 0) {
    await prisma.promotionCredit.deleteMany({ where: { studentId: { in: cleanupStudentIds } } });
    await prisma.attendanceRecord.deleteMany({ where: { studentId: { in: cleanupStudentIds } } });
    await prisma.student.deleteMany({ where: { id: { in: cleanupStudentIds } } });
  }
  if (cleanupAcademyIds.length > 0) {
    await prisma.classSession.deleteMany({ where: { academyId: { in: cleanupAcademyIds } } });
    await prisma.academy.deleteMany({ where: { id: { in: cleanupAcademyIds } } });
  }
});

describe("one qualifying attendance per Costa Rica calendar day", () => {
  it("two classes on the same day contribute 1, and both rows stay in the history", async () => {
    const student = await makeStudent({ progressBaselineAt: cr("2026-03-01T00:00:00") });
    await attend(student.id, cr("2026-03-10T06:00:00"), { classSessionId: classes.early });
    await attend(student.id, cr("2026-03-10T20:00:00"), { classSessionId: classes.late });

    const summary = await perInterval(student.id);
    expect(summary.atBeltCount).toBe(1);
    // Recorded participation is preserved: lifetime is the physical record count.
    expect(summary.lifetimeCount).toBe(2);
  });

  it("a day is the CR day, not the UTC date: 06:00 and 20:30 CR on one day are one day even though they straddle UTC midnight", async () => {
    const student = await makeStudent({ progressBaselineAt: cr("2026-03-01T00:00:00") });
    // 20:30 CR on Mar 10 is 02:30 UTC on Mar 11 - a different UTC date, the same CR day.
    await attend(student.id, cr("2026-03-10T06:00:00"), { classSessionId: classes.early });
    await attend(student.id, cr("2026-03-10T20:30:00"), { classSessionId: classes.late });
    expect((await perInterval(student.id)).atBeltCount).toBe(1);
  });

  it("two different CR days that share a UTC date are two days", async () => {
    const student = await makeStudent({ progressBaselineAt: cr("2026-03-01T00:00:00") });
    // 21:00 CR Mar 10 = 03:00 UTC Mar 11; 09:00 CR Mar 11 = 15:00 UTC Mar 11 - one UTC date, two CR days.
    await attend(student.id, cr("2026-03-10T21:00:00"), { classSessionId: classes.late });
    await attend(student.id, cr("2026-03-11T09:00:00"), { classSessionId: classes.early });
    expect((await perInterval(student.id)).atBeltCount).toBe(2);
  });

  it("insertion order never matters: the earlier occurrence decides which interval the day belongs to", async () => {
    // Award (baseline) at 10:00 CR on Mar 10. A 06:00 class that day is BEFORE the award; a 15:00 class is after.
    for (const order of ["early-first", "late-first"] as const) {
      const student = await makeStudent({ progressBaselineAt: cr("2026-03-10T10:00:00") });
      const before = () => attend(student.id, cr("2026-03-10T06:00:00"), { classSessionId: classes.early });
      const after = () => attend(student.id, cr("2026-03-10T15:00:00"), { classSessionId: classes.late });
      if (order === "early-first") {
        await before();
        await after();
      } else {
        await after();
        await before();
      }
      // The day already had a qualifying attendance before the award, so the promotion does not clear the limit:
      // checking in again after it adds 0 to the new interval.
      expect((await perInterval(student.id)).atBeltCount, order).toBe(0);
    }
  });

  it("a check-in before the award is the completed interval's; the next qualifying day is the new interval's 1", async () => {
    const student = await makeStudent({ progressBaselineAt: cr("2026-03-10T10:00:00") });
    await attend(student.id, cr("2026-03-10T06:00:00"), { classSessionId: classes.early }); // before the award
    expect((await perInterval(student.id)).atBeltCount).toBe(0);
    await attend(student.id, cr("2026-03-10T15:00:00"), { classSessionId: classes.late }); // same day, after: still 0
    expect((await perInterval(student.id)).atBeltCount).toBe(0);
    await attend(student.id, cr("2026-03-11T06:00:00"), { classSessionId: classes.early }); // next qualifying day
    expect((await perInterval(student.id)).atBeltCount).toBe(1);
  });

  it("the first qualifying attendance after the award counts as 1 when nothing qualified earlier that day", async () => {
    const student = await makeStudent({ progressBaselineAt: cr("2026-03-10T06:00:00") });
    await attend(student.id, cr("2026-03-10T15:00:00"), { classSessionId: classes.late });
    await attend(student.id, cr("2026-03-10T18:00:00"), { classSessionId: classes.early });
    expect((await perInterval(student.id)).atBeltCount).toBe(1);
  });

  it("late-recorded attendance from before the award stays in history and adds nothing to the new interval", async () => {
    const student = await makeStudent({ progressBaselineAt: cr("2026-03-10T22:00:00") });
    // The award happened at 22:00. A tablet replay lands afterwards for a 20:55 class - occurredAt is the class time.
    await attend(student.id, cr("2026-03-10T20:55:00"), { classSessionId: classes.late });
    const summary = await perInterval(student.id);
    expect(summary.atBeltCount).toBe(0);
    expect(summary.lifetimeCount).toBe(1);
  });

  it("only qualifying rows count: unmatched taps, non-counting classes and non-positive deltas contribute nothing", async () => {
    const student = await makeStudent({ progressBaselineAt: cr("2026-03-01T00:00:00") });
    await attend(student.id, cr("2026-03-03T06:00:00"), { classSessionId: null, matchSource: "UNMATCHED" });
    await attend(student.id, cr("2026-03-04T09:00:00"), { classSessionId: classes.striking });
    await attend(student.id, cr("2026-03-05T06:00:00"), { classSessionId: null, type: "ADJUSTMENT", delta: -3 });
    expect((await perInterval(student.id)).atBeltCount).toBe(0);
  });

  it("an unmatched tap starts counting once reassigned to a counting class, and never counts twice with another class that day", async () => {
    const student = await makeStudent({ progressBaselineAt: cr("2026-03-01T00:00:00") });
    const tap = await attend(student.id, cr("2026-03-10T06:00:00"), { classSessionId: null, matchSource: "UNMATCHED" });
    await attend(student.id, cr("2026-03-10T20:00:00"), { classSessionId: classes.late });
    expect((await perInterval(student.id)).atBeltCount).toBe(1);
    await prisma.attendanceRecord.update({ where: { id: tap.id }, data: { classSessionId: classes.early, matchSource: "STAFF_CORRECTED" } });
    expect((await perInterval(student.id)).atBeltCount).toBe(1);
  });

  it("a staff-added attendance day (no class) is one day and shares the limit with a kiosk check-in", async () => {
    const student = await makeStudent({ progressBaselineAt: cr("2026-03-01T00:00:00") });
    await attend(student.id, cr("2026-03-10T06:00:00"), { classSessionId: classes.early });
    await attend(student.id, cr("2026-03-10T12:00:00"), { classSessionId: null, type: "ADJUSTMENT" });
    expect((await perInterval(student.id)).atBeltCount).toBe(1);
  });
});

describe("PER_INTERVAL summary", () => {
  it("an imported 3-stripe student with no history starts at 0 of 30 (not 120), and the first day counts as 1", async () => {
    const student = await makeStudent({ currentStripes: 3, progressBaselineAt: cr("2026-03-01T00:00:00") });
    let summary = await perInterval(student.id);
    expect(summary).toMatchObject({ atBeltCount: 0, target: 30, remainingAttendance: 30, isEligible: false, nextTarget: "STRIPE" });
    await attend(student.id, cr("2026-03-02T06:00:00"));
    summary = await perInterval(student.id);
    expect(summary).toMatchObject({ atBeltCount: 1, target: 30, remainingAttendance: 29 });
  });

  it("legacy credits are never counted, while the same student under CUMULATIVE still sees them", async () => {
    const student = await makeStudent({ progressBaselineAt: cr("2026-03-01T00:00:00") });
    await prisma.promotionCredit.create({
      data: {
        studentId: student.id,
        academyId,
        organizationId,
        beltAwardedAtAnchor: student.beltAwardedAt,
        classesGranted: 45,
        reason: "legacy head start",
      },
    });
    expect((await perInterval(student.id)).atBeltCount).toBe(0);
    const legacy = await getAtBeltSummary(student.id, organizationId, ALLIANCE_ATTENDANCE_CONFIG);
    expect(legacy.atBeltCount).toBe(45);
  });

  it("at the threshold: eligible, remaining 0, and the count can keep growing without an overflowing fraction", async () => {
    const student = await makeStudent({ progressBaselineAt: cr("2026-01-01T00:00:00") });
    for (let i = 0; i < 32; i++) {
      await attend(student.id, new Date(cr("2026-01-05T06:00:00").getTime() + i * 24 * 3600_000));
    }
    const summary = await perInterval(student.id);
    expect(summary).toMatchObject({ atBeltCount: 32, target: 30, remainingAttendance: 0, isEligible: true, nextTarget: "STRIPE" });
    // The recalculated threshold-reaching date is the day of the 30th qualifying day: Jan 5 + 29 days.
    expect(summary.reachedOn).toBe("2026-02-03");
  });

  it("the reached-on date is absent while below the threshold", async () => {
    const student = await makeStudent({ progressBaselineAt: cr("2026-03-01T00:00:00") });
    await attend(student.id, cr("2026-03-02T06:00:00"));
    expect((await perInterval(student.id)).reachedOn).toBeNull();
  });
});
