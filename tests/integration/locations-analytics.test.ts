import "dotenv/config";
import { afterAll, describe, expect, it } from "vitest";
import { DateTime } from "luxon";
import { PrismaClient } from "../../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { requireEnv } from "../../src/lib/env";
import { digestLookupSecret, hashSecret } from "../../src/lib/crypto";
import { toAttendanceDate, ZONE } from "../../src/lib/scheduling/zone";
import { currentCrDateParts } from "../../src/lib/payments/get-current-period";
import type { StaffSession } from "../../src/lib/auth/session";
import type { AnalyticsFilters } from "../../src/lib/analytics/filters";

const { getLocationComparison, getCrossTraining } = await import("../../src/lib/analytics/locations");

const adapter = new PrismaPg({ connectionString: requireEnv("DATABASE_URL") });
const prisma = new PrismaClient({ adapter });
const pepper = requireEnv("CODE_PEPPER");

// A fixed range for every test in this file, entirely independent of the
// real wall clock — same reasoning as headline-tiles.test.ts /
// class-popularity.test.ts.
const RANGE_FROM = DateTime.fromISO("2026-08-01", { zone: ZONE }).startOf("day");
const RANGE_TO = DateTime.fromISO("2026-08-30", { zone: ZONE }).endOf("day");
const LONG_AGO = DateTime.fromISO("2020-01-01", { zone: ZONE }).toJSDate();

const cleanupStudentIds: string[] = [];
const cleanupClassSessionIds: string[] = [];
const cleanupAcademyIds: string[] = [];
const cleanupUserIds: string[] = [];
const cleanupPlanIds: string[] = [];

async function cleanup() {
  if (cleanupStudentIds.length > 0) {
    await prisma.paymentPeriod.deleteMany({ where: { studentId: { in: cleanupStudentIds } } });
    await prisma.attendanceRecord.deleteMany({ where: { studentId: { in: cleanupStudentIds } } });
    await prisma.student.deleteMany({ where: { id: { in: cleanupStudentIds } } });
  }
  if (cleanupClassSessionIds.length > 0) {
    await prisma.classSession.deleteMany({ where: { id: { in: cleanupClassSessionIds } } });
  }
  if (cleanupPlanIds.length > 0) {
    await prisma.paymentPlan.deleteMany({ where: { id: { in: cleanupPlanIds } } });
  }
  if (cleanupAcademyIds.length > 0) {
    await prisma.academy.deleteMany({ where: { id: { in: cleanupAcademyIds } } });
  }
  if (cleanupUserIds.length > 0) {
    await prisma.staffAssignment.deleteMany({ where: { userId: { in: cleanupUserIds } } });
    await prisma.user.deleteMany({ where: { id: { in: cleanupUserIds } } });
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

async function makePlan(academyId: string) {
  const plan = await prisma.paymentPlan.create({
    data: { academyId, name: `Locations Plan ${Date.now()}-${Math.floor(Math.random() * 1_000_000)}` },
  });
  cleanupPlanIds.push(plan.id);
  return plan;
}

async function makeRecorder() {
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
  const user = await prisma.user.create({
    data: {
      email: `locations-recorder-${suffix}@example.com`,
      passwordHash: await hashSecret("irrelevant-password-123"),
      role: "ADMIN",
    },
  });
  cleanupUserIds.push(user.id);
  return user;
}

async function makeClassSession(academyId: string) {
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
  const session = await prisma.classSession.create({
    data: {
      academyId,
      dayOfWeek: "MONDAY",
      startTime: "18:00",
      durationMinutes: 60,
      name: `Locations Class ${suffix}`,
      type: "GI",
    },
  });
  cleanupClassSessionIds.push(session.id);
  return session;
}

async function makeStudent(academyId: string, overrides?: { firstName?: string; lastName?: string }) {
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
  const student = await prisma.student.create({
    data: {
      homeAcademyId: academyId,
      firstName: overrides?.firstName ?? "LocationsTest",
      lastName: overrides?.lastName ?? `Student-${suffix}`,
      phone: "88880000",
      email: `locations-${suffix}@example.com`,
      status: "ACTIVE",
      joinedAt: LONG_AGO,
      codeHash: digestLookupSecret(`locations-${suffix}`, pepper),
    },
  });
  cleanupStudentIds.push(student.id);
  return student;
}

async function makeCheckin(studentId: string, academyId: string, occurredAt: DateTime) {
  const at = occurredAt.toJSDate();
  await prisma.attendanceRecord.create({
    data: {
      studentId,
      academyId,
      occurredAt: at,
      date: toAttendanceDate(at),
      type: "CHECKIN",
      delta: 1,
      source: "STAFF",
    },
  });
}

async function makePaymentPeriod(
  studentId: string,
  academyId: string,
  planId: string,
  recordedById: string,
  status: "PAID" | "PENDING" | "PROMO" | "EXEMPT",
) {
  const { year, month } = currentCrDateParts();
  await prisma.paymentPeriod.create({
    data: { studentId, academyId, planId, recordedById, year, month, status },
  });
}

describe("getLocationComparison", () => {
  afterAll(cleanup);

  it("computes independent, correct rows per real academy, including avgPerClass", async () => {
    const academyOne = await makeAcademy("locations-compare-one");
    const academyTwo = await makeAcademy("locations-compare-two");
    const plan = await makePlan(academyOne.id);
    const planTwo = await makePlan(academyTwo.id);
    const recorder = await makeRecorder();

    // Academy one: 2 classes, 2 active students (3 attendances total, so
    // avgPerClass = 3 / 2 = 1.5), payment health 50% (1 of 2 paid).
    await makeClassSession(academyOne.id);
    await makeClassSession(academyOne.id);
    const a1 = await makeStudent(academyOne.id);
    const a2 = await makeStudent(academyOne.id);
    await makeCheckin(a1.id, academyOne.id, RANGE_FROM.plus({ days: 2 }));
    await makeCheckin(a1.id, academyOne.id, RANGE_FROM.plus({ days: 3 }));
    await makeCheckin(a2.id, academyOne.id, RANGE_FROM.plus({ days: 4 }));
    await makePaymentPeriod(a1.id, academyOne.id, plan.id, recorder.id, "PAID");
    await makePaymentPeriod(a2.id, academyOne.id, plan.id, recorder.id, "PENDING");

    // Academy two: 1 class, 1 active student (3 attendances, avgPerClass =
    // 3 / 1 = 3), payment health 100% (1 of 1 paid) — deliberately different
    // profile from academy one.
    await makeClassSession(academyTwo.id);
    const b1 = await makeStudent(academyTwo.id);
    await makeCheckin(b1.id, academyTwo.id, RANGE_FROM.plus({ days: 1 }));
    await makeCheckin(b1.id, academyTwo.id, RANGE_FROM.plus({ days: 2 }));
    await makeCheckin(b1.id, academyTwo.id, RANGE_FROM.plus({ days: 3 }));
    await makePaymentPeriod(b1.id, academyTwo.id, planTwo.id, recorder.id, "PAID");

    const admin: StaffSession = { userId: "x", role: "ADMIN", academyIds: "ALL" };
    const filters: AnalyticsFilters = { from: RANGE_FROM, to: RANGE_TO, academyId: null };

    const rows = await getLocationComparison(admin, filters);
    const rowOne = rows.find((r) => r.academyId === academyOne.id);
    const rowTwo = rows.find((r) => r.academyId === academyTwo.id);

    expect(rowOne).toBeDefined();
    expect(rowOne!.academyName).toBe(academyOne.name);
    expect(rowOne!.activeStudents).toBe(2);
    expect(rowOne!.totalAttendances).toBe(3);
    expect(rowOne!.avgPerClass).toBe(1.5);
    expect(rowOne!.paymentHealthPercent).toBe(50);

    expect(rowTwo).toBeDefined();
    expect(rowTwo!.academyName).toBe(academyTwo.name);
    expect(rowTwo!.activeStudents).toBe(1);
    expect(rowTwo!.totalAttendances).toBe(3);
    expect(rowTwo!.avgPerClass).toBe(3);
    expect(rowTwo!.paymentHealthPercent).toBe(100);
  });

  it("an academy with no ClassSession rows gets avgPerClass 0, never a division-by-zero error", async () => {
    const academy = await makeAcademy("locations-no-classes");
    const student = await makeStudent(academy.id);
    await makeCheckin(student.id, academy.id, RANGE_FROM.plus({ days: 1 }));

    const admin: StaffSession = { userId: "x", role: "ADMIN", academyIds: "ALL" };
    const filters: AnalyticsFilters = { from: RANGE_FROM, to: RANGE_TO, academyId: academy.id };

    const rows = await getLocationComparison(admin, filters);
    expect(rows).toHaveLength(1);
    expect(rows[0].avgPerClass).toBe(0);
  });

  it("a DIRECTOR session is rejected entirely — this panel is admin-only, not narrowed", async () => {
    const academy = await makeAcademy("locations-director-rejected");
    const director: StaffSession = { userId: "x", role: "DIRECTOR", academyIds: [academy.id] };
    const filters: AnalyticsFilters = { from: RANGE_FROM, to: RANGE_TO, academyId: academy.id };

    await expect(getLocationComparison(director, filters)).rejects.toThrow("FORBIDDEN");
  });

  it("an INSTRUCTOR session is rejected entirely (self-enforced role gate)", async () => {
    const instructor: StaffSession = { userId: "x", role: "INSTRUCTOR", academyIds: [] };
    const filters: AnalyticsFilters = { from: RANGE_FROM, to: RANGE_TO, academyId: null };

    await expect(getLocationComparison(instructor, filters)).rejects.toThrow("FORBIDDEN");
  });
});

describe("getCrossTraining", () => {
  afterAll(cleanup);

  it("a student whose AttendanceRecord.academyId differs from their homeAcademyId appears with the correct visit count and academy names", async () => {
    const home = await makeAcademy("cross-training-home");
    const visited = await makeAcademy("cross-training-visited");
    const student = await makeStudent(home.id, { firstName: "Cross", lastName: "Trainer" });

    // Two visits to the OTHER academy, inside the range.
    await makeCheckin(student.id, visited.id, RANGE_FROM.plus({ days: 1 }));
    await makeCheckin(student.id, visited.id, RANGE_FROM.plus({ days: 5 }));
    // One check-in outside the range — must not be counted.
    await makeCheckin(student.id, visited.id, RANGE_FROM.minus({ days: 10 }));

    const admin: StaffSession = { userId: "x", role: "ADMIN", academyIds: "ALL" };
    const filters: AnalyticsFilters = { from: RANGE_FROM, to: RANGE_TO, academyId: null };

    const entries = await getCrossTraining(admin, filters);
    const entry = entries.find((e) => e.studentId === student.id);

    expect(entry).toBeDefined();
    expect(entry!.studentName).toBe("Cross Trainer");
    expect(entry!.homeAcademyName).toBe(home.name);
    expect(entry!.visitedAcademyName).toBe(visited.name);
    expect(entry!.visitCount).toBe(2);
  });

  it("a student who only ever checked in at their own home academy never appears", async () => {
    const academy = await makeAcademy("cross-training-home-only");
    const student = await makeStudent(academy.id, { firstName: "Home", lastName: "Only" });
    await makeCheckin(student.id, academy.id, RANGE_FROM.plus({ days: 1 }));
    await makeCheckin(student.id, academy.id, RANGE_FROM.plus({ days: 2 }));

    const admin: StaffSession = { userId: "x", role: "ADMIN", academyIds: "ALL" };
    const filters: AnalyticsFilters = { from: RANGE_FROM, to: RANGE_TO, academyId: null };

    const entries = await getCrossTraining(admin, filters);
    expect(entries.find((e) => e.studentId === student.id)).toBeUndefined();
  });

  it("a DIRECTOR session is rejected entirely — this panel is admin-only, not narrowed", async () => {
    const academy = await makeAcademy("cross-training-director-rejected");
    const director: StaffSession = { userId: "x", role: "DIRECTOR", academyIds: [academy.id] };
    const filters: AnalyticsFilters = { from: RANGE_FROM, to: RANGE_TO, academyId: academy.id };

    await expect(getCrossTraining(director, filters)).rejects.toThrow("FORBIDDEN");
  });

  it("an INSTRUCTOR session is rejected entirely (self-enforced role gate)", async () => {
    const instructor: StaffSession = { userId: "x", role: "INSTRUCTOR", academyIds: [] };
    const filters: AnalyticsFilters = { from: RANGE_FROM, to: RANGE_TO, academyId: null };

    await expect(getCrossTraining(instructor, filters)).rejects.toThrow("FORBIDDEN");
  });
});
