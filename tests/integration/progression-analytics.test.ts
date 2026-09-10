import "dotenv/config";
import { afterAll, describe, expect, it } from "vitest";
import { DateTime } from "luxon";
import { PrismaClient } from "../../src/generated/prisma/client";
import type { Belt } from "../../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { requireEnv } from "../../src/lib/env";
import { digestLookupSecret, hashSecret } from "../../src/lib/crypto";
import { toAttendanceDate, ZONE } from "../../src/lib/scheduling/zone";
import type { StaffSession } from "../../src/lib/auth/session";
import type { AnalyticsFilters } from "../../src/lib/analytics/filters";

const { getProgressionPlanningList, getBeltDistribution, getPromotionsInRange, projectThresholdDate } =
  await import("../../src/lib/analytics/progression");

const adapter = new PrismaPg({ connectionString: requireEnv("DATABASE_URL") });
const prisma = new PrismaClient({ adapter });
const pepper = requireEnv("CODE_PEPPER");

const DAY_MS = 24 * 60 * 60 * 1000;

// Fixed "today", entirely independent of the real wall clock — same
// reasoning as headline-tiles.test.ts / class-popularity.test.ts.
const TODAY = DateTime.fromISO("2026-09-10", { zone: ZONE }).endOf("day");
const RANGE_FROM = DateTime.fromISO("2026-08-01", { zone: ZONE }).startOf("day");
const RANGE_TO = TODAY;

const cleanupStudentIds: string[] = [];
const cleanupAcademyIds: string[] = [];
const cleanupUserIds: string[] = [];

async function cleanup() {
  if (cleanupStudentIds.length > 0) {
    await prisma.promotion.deleteMany({ where: { studentId: { in: cleanupStudentIds } } });
    await prisma.attendanceRecord.deleteMany({ where: { studentId: { in: cleanupStudentIds } } });
    await prisma.student.deleteMany({ where: { id: { in: cleanupStudentIds } } });
  }
  if (cleanupUserIds.length > 0) {
    await prisma.promotion.deleteMany({ where: { awardedById: { in: cleanupUserIds } } });
    await prisma.user.deleteMany({ where: { id: { in: cleanupUserIds } } });
  }
  if (cleanupAcademyIds.length > 0) {
    await prisma.academy.deleteMany({ where: { id: { in: cleanupAcademyIds } } });
  }
}

// A private academy per scenario, never the shared seeded Escazú/Escalante
// rows — same reasoning as the other Phase 7 integration test files.
async function makeAcademy(label: string) {
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
  const academy = await prisma.academy.create({
    data: {
      name: `${label} ${suffix}`,
      slug: `${label}-${suffix}`,
      kioskTokenHash: `${label}-hash-${suffix}`,
    },
  });
  cleanupAcademyIds.push(academy.id);
  return academy;
}

async function makeStaffUser(role: "ADMIN") {
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
  const user = await prisma.user.create({
    data: {
      email: `progression-staff-${suffix}@example.com`,
      passwordHash: await hashSecret("irrelevant-password-123"),
      role,
    },
  });
  cleanupUserIds.push(user.id);
  return user;
}

async function makeStudent(
  academyId: string,
  overrides: { currentBelt: Belt; currentStripes: number; beltAwardedAt: Date; lastName?: string },
) {
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
  const student = await prisma.student.create({
    data: {
      homeAcademyId: academyId,
      firstName: "ProgressionTest",
      lastName: overrides.lastName ?? `Student-${suffix}`,
      phone: "88880000",
      email: `progression-${suffix}@example.com`,
      currentBelt: overrides.currentBelt,
      currentStripes: overrides.currentStripes,
      beltAwardedAt: overrides.beltAwardedAt,
      status: "ACTIVE",
      codeHash: digestLookupSecret(`progression-${suffix}`, pepper),
    },
  });
  cleanupStudentIds.push(student.id);
  return student;
}

/**
 * Writes `count` synthetic CHECKIN rows (`classSessionId: null`, always
 * promotion-relevant — see attendance-summary.ts's PROMOTION_RELEVANT
 * comment), one per day starting at `startAt` — same helper shape as
 * promotion-queue.test.ts's `addAttendances`.
 */
async function addAttendances(studentId: string, academyId: string, count: number, startAt: Date) {
  if (count === 0) return;
  const rows = Array.from({ length: count }, (_, i) => {
    const occurredAt = new Date(startAt.getTime() + i * DAY_MS);
    return {
      studentId,
      academyId,
      occurredAt,
      date: toAttendanceDate(occurredAt),
      type: "CHECKIN" as const,
      delta: 1,
      source: "STAFF" as const,
    };
  });
  await prisma.attendanceRecord.createMany({ data: rows });
}

function findRow<T extends { studentId: string }>(rows: T[], studentId: string) {
  return rows.find((r) => r.studentId === studentId);
}

describe("getProgressionPlanningList", () => {
  afterAll(cleanup);

  it("an approaching student with recent attendances gets a real projected date, matching projectThresholdDate", async () => {
    const academy = await makeAcademy("progression-planning");
    // WHITE requires 30 attendancesPerStripe (global default, confirmed by
    // promotion-queue.test.ts) — beltAwardedAt 40 days before "today" and 27
    // attendances (3 short of the next stripe) spread across the following
    // 27 days, all inside the 60-day recent window.
    const beltAwardedAt = TODAY.minus({ days: 40 }).toJSDate();
    const student = await makeStudent(academy.id, { currentBelt: "WHITE", currentStripes: 0, beltAwardedAt });
    await addAttendances(student.id, academy.id, 27, new Date(beltAwardedAt.getTime() + DAY_MS));

    const director: StaffSession = { userId: "x", role: "DIRECTOR", academyIds: [academy.id] };
    const filters: AnalyticsFilters = { from: RANGE_FROM, to: RANGE_TO, academyId: academy.id };

    const rows = await getProgressionPlanningList(director, filters, TODAY);
    const row = findRow(rows, student.id);

    expect(row).toBeDefined();
    expect(row!.remainingToNextStripe).toBe(3);
    expect(row!.recentAttendancesPerWeek).toBeGreaterThan(0);
    expect(row!.projectedDate).not.toBeNull();
    // Cross-checked against the already-unit-tested pure function, using
    // this row's own computed rate — confirms the wiring, not a second
    // independent reimplementation of the projection math.
    const expected = projectThresholdDate(row!.remainingToNextStripe, row!.recentAttendancesPerWeek, TODAY);
    expect(row!.projectedDate!.toISO()).toBe(expected!.toISO());
  });

  it("an approaching student whose attendances all fall outside the recent window gets no projected date", async () => {
    const academy = await makeAcademy("progression-stale");
    // beltAwardedAt and all 27 attendances are well before the 60-day
    // recent-attendance window (which floors at TODAY - 60 days) — remaining
    // is still computed from the FULL history since beltAwardedAt (unfiltered
    // by the recent window, per listApproachingStudents/getAtBeltSummary),
    // but the recent RATE is zero.
    const beltAwardedAt = TODAY.minus({ days: 200 }).toJSDate();
    const student = await makeStudent(academy.id, { currentBelt: "WHITE", currentStripes: 0, beltAwardedAt });
    await addAttendances(student.id, academy.id, 27, new Date(beltAwardedAt.getTime() + DAY_MS));

    const director: StaffSession = { userId: "x", role: "DIRECTOR", academyIds: [academy.id] };
    const filters: AnalyticsFilters = { from: RANGE_FROM, to: RANGE_TO, academyId: academy.id };

    const rows = await getProgressionPlanningList(director, filters, TODAY);
    const row = findRow(rows, student.id);

    expect(row).toBeDefined();
    expect(row!.remainingToNextStripe).toBe(3);
    expect(row!.recentAttendancesPerWeek).toBe(0);
    expect(row!.projectedDate).toBeNull();
  });

  it("an exam-eligible student (remainingToNextStripe: null) is excluded entirely, not merely projected-date-null", async () => {
    const academy = await makeAcademy("progression-exam-eligible");
    const beltAwardedAt = TODAY.minus({ days: 40 }).toJSDate();
    // 4 stripes (max) + attendancesForExam (30) more = 150 total, exactly at
    // the exam threshold — same fixture shape as promotion-queue.test.ts's
    // exam-eligible case.
    const student = await makeStudent(academy.id, { currentBelt: "WHITE", currentStripes: 4, beltAwardedAt });
    await addAttendances(student.id, academy.id, 150, new Date(beltAwardedAt.getTime() + DAY_MS));

    const director: StaffSession = { userId: "x", role: "DIRECTOR", academyIds: [academy.id] };
    const filters: AnalyticsFilters = { from: RANGE_FROM, to: RANGE_TO, academyId: academy.id };

    const rows = await getProgressionPlanningList(director, filters, TODAY);
    expect(findRow(rows, student.id)).toBeUndefined();
  });

  it("an ADMIN's filters.academyId narrows the list to just that academy", async () => {
    const academyOne = await makeAcademy("progression-scope-one");
    const academyTwo = await makeAcademy("progression-scope-two");
    const beltAwardedAt = TODAY.minus({ days: 40 }).toJSDate();
    const studentOne = await makeStudent(academyOne.id, { currentBelt: "WHITE", currentStripes: 0, beltAwardedAt });
    const studentTwo = await makeStudent(academyTwo.id, { currentBelt: "WHITE", currentStripes: 0, beltAwardedAt });
    await addAttendances(studentOne.id, academyOne.id, 27, new Date(beltAwardedAt.getTime() + DAY_MS));
    await addAttendances(studentTwo.id, academyTwo.id, 27, new Date(beltAwardedAt.getTime() + DAY_MS));

    const admin: StaffSession = { userId: "x", role: "ADMIN", academyIds: "ALL" };
    const filters: AnalyticsFilters = { from: RANGE_FROM, to: RANGE_TO, academyId: academyOne.id };

    const rows = await getProgressionPlanningList(admin, filters, TODAY);
    expect(findRow(rows, studentOne.id)).toBeDefined();
    expect(findRow(rows, studentTwo.id)).toBeUndefined();
  });

  it("an INSTRUCTOR session is rejected entirely (self-enforced role gate)", async () => {
    const instructor: StaffSession = { userId: "x", role: "INSTRUCTOR", academyIds: [] };
    const filters: AnalyticsFilters = { from: RANGE_FROM, to: RANGE_TO, academyId: null };

    await expect(getProgressionPlanningList(instructor, filters, TODAY)).rejects.toThrow("FORBIDDEN");
  });
});

describe("getBeltDistribution", () => {
  afterAll(cleanup);

  it("counts ACTIVE students per belt, including a zero-count belt, ordered by belt progression", async () => {
    const academy = await makeAcademy("belt-distribution");
    const beltAwardedAt = TODAY.toJSDate();
    await makeStudent(academy.id, { currentBelt: "WHITE", currentStripes: 0, beltAwardedAt });
    await makeStudent(academy.id, { currentBelt: "WHITE", currentStripes: 1, beltAwardedAt });
    await makeStudent(academy.id, { currentBelt: "BLUE", currentStripes: 0, beltAwardedAt });

    const director: StaffSession = { userId: "x", role: "DIRECTOR", academyIds: [academy.id] };
    const filters: AnalyticsFilters = { from: RANGE_FROM, to: RANGE_TO, academyId: academy.id };

    const rows = await getBeltDistribution(director, filters);

    expect(rows.map((r) => r.belt)).toEqual(["WHITE", "BLUE", "PURPLE", "BROWN", "BLACK"]);
    expect(rows.find((r) => r.belt === "WHITE")!.count).toBe(2);
    expect(rows.find((r) => r.belt === "BLUE")!.count).toBe(1);
    expect(rows.find((r) => r.belt === "PURPLE")!.count).toBe(0);
  });

  it("a DIRECTOR never sees the other academy's students", async () => {
    const academyOne = await makeAcademy("belt-scope-one");
    const academyTwo = await makeAcademy("belt-scope-two");
    const beltAwardedAt = TODAY.toJSDate();
    await makeStudent(academyOne.id, { currentBelt: "BLUE", currentStripes: 0, beltAwardedAt });
    await makeStudent(academyTwo.id, { currentBelt: "BLUE", currentStripes: 0, beltAwardedAt });

    const director: StaffSession = { userId: "x", role: "DIRECTOR", academyIds: [academyOne.id] };
    const filters: AnalyticsFilters = { from: RANGE_FROM, to: RANGE_TO, academyId: academyOne.id };

    const rows = await getBeltDistribution(director, filters);
    expect(rows.find((r) => r.belt === "BLUE")!.count).toBe(1);
  });

  it("an INSTRUCTOR session is rejected entirely (self-enforced role gate)", async () => {
    const instructor: StaffSession = { userId: "x", role: "INSTRUCTOR", academyIds: [] };
    const filters: AnalyticsFilters = { from: RANGE_FROM, to: RANGE_TO, academyId: null };

    await expect(getBeltDistribution(instructor, filters)).rejects.toThrow("FORBIDDEN");
  });
});

describe("getPromotionsInRange", () => {
  afterAll(cleanup);

  it("returns only promotions with awardedAt inside the range, newest first", async () => {
    const academy = await makeAcademy("promotions-range");
    const admin = await makeStaffUser("ADMIN");
    const student = await makeStudent(academy.id, {
      currentBelt: "BLUE",
      currentStripes: 0,
      beltAwardedAt: RANGE_FROM.toJSDate(),
    });

    const inRangeOlder = await prisma.promotion.create({
      data: {
        studentId: student.id,
        academyId: academy.id,
        fromBelt: "WHITE",
        fromStripes: 4,
        toBelt: "BLUE",
        toStripes: 0,
        awardedById: admin.id,
        awardedAt: RANGE_FROM.plus({ days: 5 }).toJSDate(),
      },
    });
    const inRangeNewer = await prisma.promotion.create({
      data: {
        studentId: student.id,
        academyId: academy.id,
        fromBelt: "BLUE",
        fromStripes: 0,
        toBelt: "BLUE",
        toStripes: 1,
        awardedById: admin.id,
        awardedAt: RANGE_FROM.plus({ days: 10 }).toJSDate(),
      },
    });
    await prisma.promotion.create({
      data: {
        studentId: student.id,
        academyId: academy.id,
        fromBelt: "BLUE",
        fromStripes: 1,
        toBelt: "BLUE",
        toStripes: 2,
        awardedById: admin.id,
        // Well before RANGE_FROM — must not appear.
        awardedAt: RANGE_FROM.minus({ days: 30 }).toJSDate(),
      },
    });

    const director: StaffSession = { userId: "x", role: "DIRECTOR", academyIds: [academy.id] };
    const filters: AnalyticsFilters = { from: RANGE_FROM, to: RANGE_TO, academyId: academy.id };

    const rows = await getPromotionsInRange(director, filters);

    expect(rows.map((r) => r.promotionId)).toEqual([inRangeNewer.id, inRangeOlder.id]);
    expect(rows[0].firstName).toBe(student.firstName);
    expect(rows[0].toBelt).toBe("BLUE");
    expect(rows[0].toStripes).toBe(1);
  });

  it("a DIRECTOR never sees the other academy's promotions", async () => {
    const academyOne = await makeAcademy("promotions-scope-one");
    const academyTwo = await makeAcademy("promotions-scope-two");
    const admin = await makeStaffUser("ADMIN");
    const studentOne = await makeStudent(academyOne.id, {
      currentBelt: "BLUE",
      currentStripes: 0,
      beltAwardedAt: RANGE_FROM.toJSDate(),
    });
    const studentTwo = await makeStudent(academyTwo.id, {
      currentBelt: "BLUE",
      currentStripes: 0,
      beltAwardedAt: RANGE_FROM.toJSDate(),
    });
    await prisma.promotion.create({
      data: {
        studentId: studentOne.id,
        academyId: academyOne.id,
        fromBelt: "WHITE",
        fromStripes: 4,
        toBelt: "BLUE",
        toStripes: 0,
        awardedById: admin.id,
        awardedAt: RANGE_FROM.plus({ days: 5 }).toJSDate(),
      },
    });
    await prisma.promotion.create({
      data: {
        studentId: studentTwo.id,
        academyId: academyTwo.id,
        fromBelt: "WHITE",
        fromStripes: 4,
        toBelt: "BLUE",
        toStripes: 0,
        awardedById: admin.id,
        awardedAt: RANGE_FROM.plus({ days: 5 }).toJSDate(),
      },
    });

    const director: StaffSession = { userId: "x", role: "DIRECTOR", academyIds: [academyOne.id] };
    const filters: AnalyticsFilters = { from: RANGE_FROM, to: RANGE_TO, academyId: academyOne.id };

    const rows = await getPromotionsInRange(director, filters);
    expect(rows).toHaveLength(1);
    expect(rows[0].studentId).toBe(studentOne.id);
  });

  it("an INSTRUCTOR session is rejected entirely (self-enforced role gate)", async () => {
    const instructor: StaffSession = { userId: "x", role: "INSTRUCTOR", academyIds: [] };
    const filters: AnalyticsFilters = { from: RANGE_FROM, to: RANGE_TO, academyId: null };

    await expect(getPromotionsInRange(instructor, filters)).rejects.toThrow("FORBIDDEN");
  });
});
