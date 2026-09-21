import "dotenv/config";
import { getTestPrismaClient } from "../helpers/test-db";
import { afterAll, describe, expect, it } from "vitest";
import { DateTime } from "luxon";
import { requireEnv } from "../../src/lib/env";
import { digestLookupSecret, hashSecret } from "../../src/lib/crypto";
import { toAttendanceDate, ZONE } from "../../src/lib/scheduling/zone";
import { currentCrDateParts } from "../../src/lib/payments/get-current-period";
import type { TenantContext, MembershipRole } from "../../src/lib/tenant/types";
import type { AnalyticsFilters } from "../../src/lib/analytics/filters";

const { getLocationComparison, getCrossTraining } = await import("../../src/lib/analytics/locations");

const prisma = getTestPrismaClient();
const pepper = requireEnv("CODE_PEPPER");

function ctx(role: MembershipRole, academyIds: string[] | "ALL", organizationId: string): TenantContext {
  return {
    kind: "tenant",
    actorUserId: "x",
    organizationId,
    organizationRole: role,
    academyIds,
    selfStudentId: null,
  };
}

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
    await prisma.notification.deleteMany({ where: { userId: { in: cleanupUserIds } } });
    await prisma.user.deleteMany({ where: { id: { in: cleanupUserIds } } });
  }
}

// A private academy per scenario, never the shared seeded Escazú/Escalante
// rows — same reasoning as the other Phase 7 integration test files.
async function makeAcademy(label: string, organizationId?: string) {
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
  const academy = await prisma.academy.create({
    data: {
      name: `${label} ${suffix}`,
      slug: `${label}-${suffix}`,
      kioskTokenHash: `${label}-hash-${suffix}`,
      organization: organizationId
        ? { connect: { id: organizationId } }
        : { create: { slug: `org-${label}-${suffix}`, name: `Org ${label} ${suffix}`, status: "ACTIVE" } },
    },
  });
  cleanupAcademyIds.push(academy.id);
  return academy;
}

async function makePlan(academyId: string, organizationId: string) {
  const plan = await prisma.paymentPlan.create({
    data: { academyId, organizationId, name: `Locations Plan ${Date.now()}-${Math.floor(Math.random() * 1_000_000)}` },
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

async function makeClassSession(academyId: string, organizationId: string) {
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
  const session = await prisma.classSession.create({
    data: {
      academyId,
      organizationId,
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

/**
 * makeAcademy defaults to a FRESH scratch organization (not the shared
 * Alliance org), which has no BeltRank rows at all — this resolves-or-creates
 * the WHITE rank it needs, same pattern as
 * kiosk-check-in-route.test.ts's resolveWhiteRankId.
 */
async function resolveWhiteRankId(organizationId: string): Promise<string> {
  const existing = await prisma.beltRank.findUnique({
    where: { organizationId_track_code: { organizationId, track: "ADULT", code: "WHITE" } },
    select: { id: true },
  });
  if (existing) return existing.id;

  const created = await prisma.beltRank.create({
    data: {
      organizationId,
      track: "ADULT",
      code: "WHITE",
      labelEs: "Blanco",
      labelEn: "White",
      primaryColor: "#F0EBE0",
      barColor: "#111116",
      order: 0,
      maxStripes: 4,
      attendancesPerStripe: 30,
      attendancesForExam: 120,
      stripeColors: ["#000000", "#000000", "#000000", "#000000"],
      visibleStripeSlots: 4,
    },
  });
  return created.id;
}

async function makeStudent(
  academyId: string,
  organizationId: string,
  overrides?: { firstName?: string; lastName?: string },
) {
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
  const currentRankId = await resolveWhiteRankId(organizationId);
  const student = await prisma.student.create({
    data: {
      homeAcademyId: academyId,
      organizationId,
      firstName: overrides?.firstName ?? "LocationsTest",
      lastName: overrides?.lastName ?? `Student-${suffix}`,
      phone: "88880000",
      email: `locations-${suffix}@example.com`,
      currentRankId,
      status: "ACTIVE",
      joinedAt: LONG_AGO,
      codeHash: digestLookupSecret(`locations-${suffix}`, pepper),
    },
  });
  cleanupStudentIds.push(student.id);
  return student;
}

async function makeCheckin(studentId: string, academyId: string, organizationId: string, occurredAt: DateTime) {
  const at = occurredAt.toJSDate();
  await prisma.attendanceRecord.create({
    data: {
      studentId,
      academyId,
      organizationId,
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
  organizationId: string,
  planId: string,
  recordedById: string,
  status: "PAID" | "PENDING" | "PROMO" | "EXEMPT",
) {
  const { year, month } = currentCrDateParts();
  await prisma.paymentPeriod.create({
    data: { studentId, academyId, organizationId, planId, recordedById, currency: "CRC", year, month, status },
  });
}

describe("getLocationComparison", () => {
  afterAll(cleanup);

  it("computes independent, correct rows per real academy, including avgPerClass", async () => {
    const academyOne = await makeAcademy("locations-compare-one");
    // Same organization as academyOne — this test's premise is one ADMIN's
    // "ALL" comparison view spanning both academies, which now means "every
    // academy in ADMIN's own organization" (the 1d fix closing the hole
    // where ADMIN's ALL meant literally every org's academies). Two
    // different scratch orgs (this helper's other, no-arg default) would
    // make academyTwo invisible to an ADMIN scoped to academyOne's org.
    const academyTwo = await makeAcademy("locations-compare-two", academyOne.organizationId);
    const plan = await makePlan(academyOne.id, academyOne.organizationId);
    const planTwo = await makePlan(academyTwo.id, academyTwo.organizationId);
    const recorder = await makeRecorder();

    // Academy one: 2 classes, 2 active students (3 attendances total, so
    // avgPerClass = 3 / 2 = 1.5), payment health 50% (1 of 2 paid).
    await makeClassSession(academyOne.id, academyOne.organizationId);
    await makeClassSession(academyOne.id, academyOne.organizationId);
    const a1 = await makeStudent(academyOne.id, academyOne.organizationId);
    const a2 = await makeStudent(academyOne.id, academyOne.organizationId);
    await makeCheckin(a1.id, academyOne.id, academyOne.organizationId, RANGE_FROM.plus({ days: 2 }));
    await makeCheckin(a1.id, academyOne.id, academyOne.organizationId, RANGE_FROM.plus({ days: 3 }));
    await makeCheckin(a2.id, academyOne.id, academyOne.organizationId, RANGE_FROM.plus({ days: 4 }));
    await makePaymentPeriod(a1.id, academyOne.id, academyOne.organizationId, plan.id, recorder.id, "PAID");
    await makePaymentPeriod(a2.id, academyOne.id, academyOne.organizationId, plan.id, recorder.id, "PENDING");

    // Academy two: 1 class, 1 active student (3 attendances, avgPerClass =
    // 3 / 1 = 3), payment health 100% (1 of 1 paid) — deliberately different
    // profile from academy one.
    await makeClassSession(academyTwo.id, academyTwo.organizationId);
    const b1 = await makeStudent(academyTwo.id, academyTwo.organizationId);
    await makeCheckin(b1.id, academyTwo.id, academyTwo.organizationId, RANGE_FROM.plus({ days: 1 }));
    await makeCheckin(b1.id, academyTwo.id, academyTwo.organizationId, RANGE_FROM.plus({ days: 2 }));
    await makeCheckin(b1.id, academyTwo.id, academyTwo.organizationId, RANGE_FROM.plus({ days: 3 }));
    await makePaymentPeriod(b1.id, academyTwo.id, academyTwo.organizationId, planTwo.id, recorder.id, "PAID");

    const admin = ctx("ADMIN", "ALL", academyOne.organizationId);
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
    const student = await makeStudent(academy.id, academy.organizationId);
    await makeCheckin(student.id, academy.id, academy.organizationId, RANGE_FROM.plus({ days: 1 }));

    const admin = ctx("ADMIN", "ALL", academy.organizationId);
    const filters: AnalyticsFilters = { from: RANGE_FROM, to: RANGE_TO, academyId: academy.id };

    const rows = await getLocationComparison(admin, filters);
    expect(rows).toHaveLength(1);
    expect(rows[0].avgPerClass).toBe(0);
  });

  it("a DIRECTOR session is rejected entirely — this panel is admin-only, not narrowed", async () => {
    const academy = await makeAcademy("locations-director-rejected");
    const director = ctx("DIRECTOR", [academy.id], academy.organizationId);
    const filters: AnalyticsFilters = { from: RANGE_FROM, to: RANGE_TO, academyId: academy.id };

    await expect(getLocationComparison(director, filters)).rejects.toThrow("FORBIDDEN");
  });

  it("an INSTRUCTOR session is rejected entirely (self-enforced role gate)", async () => {
    // organizationId is never touched — requireAdminOnly throws before any
    // DB call, for any non-ADMIN role.
    const instructor = ctx("INSTRUCTOR", [], "irrelevant-org-id");
    const filters: AnalyticsFilters = { from: RANGE_FROM, to: RANGE_TO, academyId: null };

    await expect(getLocationComparison(instructor, filters)).rejects.toThrow("FORBIDDEN");
  });
});

describe("getCrossTraining", () => {
  afterAll(cleanup);

  it("a student whose AttendanceRecord.academyId differs from their homeAcademyId appears with the correct visit count and academy names", async () => {
    const home = await makeAcademy("cross-training-home");
    const visited = await makeAcademy("cross-training-visited", home.organizationId);
    const student = await makeStudent(home.id, home.organizationId, { firstName: "Cross", lastName: "Trainer" });

    // Two visits to the OTHER academy, inside the range.
    await makeCheckin(student.id, visited.id, home.organizationId, RANGE_FROM.plus({ days: 1 }));
    await makeCheckin(student.id, visited.id, home.organizationId, RANGE_FROM.plus({ days: 5 }));
    // One check-in outside the range — must not be counted.
    await makeCheckin(student.id, visited.id, home.organizationId, RANGE_FROM.minus({ days: 10 }));

    const admin = ctx("ADMIN", "ALL", home.organizationId);
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
    const student = await makeStudent(academy.id, academy.organizationId, { firstName: "Home", lastName: "Only" });
    await makeCheckin(student.id, academy.id, academy.organizationId, RANGE_FROM.plus({ days: 1 }));
    await makeCheckin(student.id, academy.id, academy.organizationId, RANGE_FROM.plus({ days: 2 }));

    const admin = ctx("ADMIN", "ALL", academy.organizationId);
    const filters: AnalyticsFilters = { from: RANGE_FROM, to: RANGE_TO, academyId: null };

    const entries = await getCrossTraining(admin, filters);
    expect(entries.find((e) => e.studentId === student.id)).toBeUndefined();
  });

  it("a DIRECTOR session is rejected entirely — this panel is admin-only, not narrowed", async () => {
    const academy = await makeAcademy("cross-training-director-rejected");
    const director = ctx("DIRECTOR", [academy.id], academy.organizationId);
    const filters: AnalyticsFilters = { from: RANGE_FROM, to: RANGE_TO, academyId: academy.id };

    await expect(getCrossTraining(director, filters)).rejects.toThrow("FORBIDDEN");
  });

  it("an INSTRUCTOR session is rejected entirely (self-enforced role gate)", async () => {
    // organizationId is never touched — requireAdminOnly throws before any
    // DB call, for any non-ADMIN role.
    const instructor = ctx("INSTRUCTOR", [], "irrelevant-org-id");
    const filters: AnalyticsFilters = { from: RANGE_FROM, to: RANGE_TO, academyId: null };

    await expect(getCrossTraining(instructor, filters)).rejects.toThrow("FORBIDDEN");
  });
});
