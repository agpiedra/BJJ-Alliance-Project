import "dotenv/config";
import { afterAll, describe, expect, it } from "vitest";
import { DateTime } from "luxon";
import { PrismaClient } from "../../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { requireEnv } from "../../src/lib/env";
import { digestLookupSecret, hashSecret } from "../../src/lib/crypto";
import { toAttendanceDate, ZONE } from "../../src/lib/scheduling/zone";
import type { StaffSession } from "../../src/lib/auth/session";
import type { AnalyticsFilters } from "../../src/lib/analytics/filters";

const { getRetentionList, getWeeklyAttendanceTrend } = await import("../../src/lib/analytics/retention");

const adapter = new PrismaPg({ connectionString: requireEnv("DATABASE_URL") });
const prisma = new PrismaClient({ adapter });
const pepper = requireEnv("CODE_PEPPER");

// A fixed range/reference date for every test in this file, entirely
// independent of the real wall clock — same reasoning as
// headline-tiles.test.ts / locations-analytics.test.ts. `RANGE_TO` is the
// "as of" instant `getRetentionList` measures days-since-last-attendance
// against.
const RANGE_FROM = DateTime.fromISO("2026-08-01", { zone: ZONE }).startOf("day");
const RANGE_TO = DateTime.fromISO("2026-08-30", { zone: ZONE }).endOf("day");

const cleanupStudentIds: string[] = [];
const cleanupAcademyIds: string[] = [];

async function cleanup() {
  if (cleanupStudentIds.length > 0) {
    await prisma.attendanceRecord.deleteMany({ where: { studentId: { in: cleanupStudentIds } } });
    await prisma.student.deleteMany({ where: { id: { in: cleanupStudentIds } } });
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

async function makeStudent(
  academyId: string,
  overrides?: { firstName?: string; lastName?: string; phone?: string; status?: "PENDING" | "ACTIVE" | "ARCHIVED" },
) {
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
  const student = await prisma.student.create({
    data: {
      homeAcademyId: academyId,
      firstName: overrides?.firstName ?? "RetentionTest",
      lastName: overrides?.lastName ?? `Student-${suffix}`,
      phone: overrides?.phone ?? "88880000",
      email: `retention-${suffix}@example.com`,
      status: overrides?.status ?? "ACTIVE",
      joinedAt: RANGE_FROM.minus({ years: 1 }).toJSDate(),
      codeHash: digestLookupSecret(`retention-${suffix}`, pepper),
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

describe("getRetentionList", () => {
  afterAll(cleanup);

  it("buckets students into 30/60/90 correctly against filters.to, with phone and lastSeenAt", async () => {
    const academy = await makeAcademy("retention-buckets");

    const at35 = await makeStudent(academy.id, { firstName: "At35", phone: "10000001" });
    await makeCheckin(at35.id, academy.id, RANGE_TO.minus({ days: 35 }));

    const at65 = await makeStudent(academy.id, { firstName: "At65", phone: "10000002" });
    await makeCheckin(at65.id, academy.id, RANGE_TO.minus({ days: 65 }));

    const at95 = await makeStudent(academy.id, { firstName: "At95", phone: "10000003" });
    await makeCheckin(at95.id, academy.id, RANGE_TO.minus({ days: 95 }));

    const admin: StaffSession = { userId: "x", role: "ADMIN", academyIds: "ALL" };
    const filters: AnalyticsFilters = { from: RANGE_FROM, to: RANGE_TO, academyId: null };

    const entries = await getRetentionList(admin, filters);

    const entry35 = entries.find((e) => e.studentId === at35.id);
    const entry65 = entries.find((e) => e.studentId === at65.id);
    const entry95 = entries.find((e) => e.studentId === at95.id);

    expect(entry35).toBeDefined();
    expect(entry35!.bucket).toBe("30");
    expect(entry35!.phone).toBe("10000001");
    expect(entry35!.lastSeenAt?.getTime()).toBe(RANGE_TO.minus({ days: 35 }).toJSDate().getTime());

    expect(entry65).toBeDefined();
    expect(entry65!.bucket).toBe("60");

    expect(entry95).toBeDefined();
    expect(entry95!.bucket).toBe("90");
  });

  it("a student with zero attendance ever appears with lastSeenAt null, bucket 90", async () => {
    const academy = await makeAcademy("retention-never-attended");
    const student = await makeStudent(academy.id, { firstName: "NeverAttended" });

    const admin: StaffSession = { userId: "x", role: "ADMIN", academyIds: "ALL" };
    const filters: AnalyticsFilters = { from: RANGE_FROM, to: RANGE_TO, academyId: null };

    const entries = await getRetentionList(admin, filters);
    const entry = entries.find((e) => e.studentId === student.id);

    expect(entry).toBeDefined();
    expect(entry!.lastSeenAt).toBeNull();
    expect(entry!.bucket).toBe("90");
  });

  it("a recently-active student (within 30 days of filters.to) never appears", async () => {
    const academy = await makeAcademy("retention-recently-active");
    const student = await makeStudent(academy.id, { firstName: "RecentlyActive" });
    await makeCheckin(student.id, academy.id, RANGE_TO.minus({ days: 5 }));

    const admin: StaffSession = { userId: "x", role: "ADMIN", academyIds: "ALL" };
    const filters: AnalyticsFilters = { from: RANGE_FROM, to: RANGE_TO, academyId: null };

    const entries = await getRetentionList(admin, filters);
    expect(entries.find((e) => e.studentId === student.id)).toBeUndefined();
  });

  it("a PENDING student never appears, even with no attendance ever", async () => {
    const academy = await makeAcademy("retention-pending-excluded");
    const student = await makeStudent(academy.id, { firstName: "PendingOne", status: "PENDING" });

    const admin: StaffSession = { userId: "x", role: "ADMIN", academyIds: "ALL" };
    const filters: AnalyticsFilters = { from: RANGE_FROM, to: RANGE_TO, academyId: null };

    const entries = await getRetentionList(admin, filters);
    expect(entries.find((e) => e.studentId === student.id)).toBeUndefined();
  });

  it("an ARCHIVED student never appears, even with old attendance", async () => {
    const academy = await makeAcademy("retention-archived-excluded");
    const student = await makeStudent(academy.id, { firstName: "ArchivedOne", status: "ARCHIVED" });
    await makeCheckin(student.id, academy.id, RANGE_TO.minus({ days: 95 }));

    const admin: StaffSession = { userId: "x", role: "ADMIN", academyIds: "ALL" };
    const filters: AnalyticsFilters = { from: RANGE_FROM, to: RANGE_TO, academyId: null };

    const entries = await getRetentionList(admin, filters);
    expect(entries.find((e) => e.studentId === student.id)).toBeUndefined();
  });

  it("scopes to filters.academyId — a student at a different academy never appears", async () => {
    const academyOne = await makeAcademy("retention-scope-one");
    const academyTwo = await makeAcademy("retention-scope-two");
    const studentOne = await makeStudent(academyOne.id, { firstName: "ScopeOne" });
    const studentTwo = await makeStudent(academyTwo.id, { firstName: "ScopeTwo" });

    const admin: StaffSession = { userId: "x", role: "ADMIN", academyIds: "ALL" };
    const filters: AnalyticsFilters = { from: RANGE_FROM, to: RANGE_TO, academyId: academyOne.id };

    const entries = await getRetentionList(admin, filters);
    expect(entries.find((e) => e.studentId === studentOne.id)).toBeDefined();
    expect(entries.find((e) => e.studentId === studentTwo.id)).toBeUndefined();
  });

  it("a DIRECTOR only ever sees their own academy, even if handed a filter naming another one", async () => {
    const academyOne = await makeAcademy("retention-director-scope-one");
    const academyTwo = await makeAcademy("retention-director-scope-two");
    const studentOne = await makeStudent(academyOne.id, { firstName: "DirScopeOne" });
    const studentTwo = await makeStudent(academyTwo.id, { firstName: "DirScopeTwo" });

    const director: StaffSession = { userId: "x", role: "DIRECTOR", academyIds: [academyOne.id] };

    const ownScope = await getRetentionList(director, {
      from: RANGE_FROM,
      to: RANGE_TO,
      academyId: academyOne.id,
    });
    expect(ownScope.find((e) => e.studentId === studentOne.id)).toBeDefined();

    // A hand-built filter naming the OTHER academy (as if
    // `resolveAnalyticsFilters` had somehow been bypassed) still resolves to
    // nothing for this DIRECTOR — `academyScopeWhere(session)` is applied
    // independently of `filters.academyId`, never trusted alone, so the two
    // conflicting `homeAcademyId` conditions AND together to zero rows
    // (same behavior `getHeadlineTiles` already establishes).
    const forgedScope = await getRetentionList(director, {
      from: RANGE_FROM,
      to: RANGE_TO,
      academyId: academyTwo.id,
    });
    expect(forgedScope.find((e) => e.studentId === studentOne.id)).toBeUndefined();
    expect(forgedScope.find((e) => e.studentId === studentTwo.id)).toBeUndefined();
  });

  it("sorts worst-first: bucket 90 before 60 before 30", async () => {
    const academy = await makeAcademy("retention-sort-order");
    const at30 = await makeStudent(academy.id, { firstName: "Sort30" });
    await makeCheckin(at30.id, academy.id, RANGE_TO.minus({ days: 35 }));
    const at60 = await makeStudent(academy.id, { firstName: "Sort60" });
    await makeCheckin(at60.id, academy.id, RANGE_TO.minus({ days: 65 }));
    const at90 = await makeStudent(academy.id, { firstName: "Sort90" });
    await makeCheckin(at90.id, academy.id, RANGE_TO.minus({ days: 95 }));

    const admin: StaffSession = { userId: "x", role: "ADMIN", academyIds: "ALL" };
    const filters: AnalyticsFilters = { from: RANGE_FROM, to: RANGE_TO, academyId: academy.id };

    const entries = await getRetentionList(admin, filters);
    expect(entries.map((e) => e.studentId)).toEqual([at90.id, at60.id, at30.id]);
  });

  it("an INSTRUCTOR session is rejected entirely (self-enforced role gate)", async () => {
    const instructor: StaffSession = { userId: "x", role: "INSTRUCTOR", academyIds: [] };
    const filters: AnalyticsFilters = { from: RANGE_FROM, to: RANGE_TO, academyId: null };

    await expect(getRetentionList(instructor, filters)).rejects.toThrow("FORBIDDEN");
  });
});

describe("getWeeklyAttendanceTrend", () => {
  afterAll(cleanup);

  it("buckets attendances into CR-timezone (Monday-start) weeks over the filtered range, including zero-count weeks", async () => {
    const academy = await makeAcademy("retention-weekly-trend");
    const student = await makeStudent(academy.id);

    // A 22:30 CR check-in — well past 18:00, so a naive UTC-day slice would
    // push this into the next UTC calendar day; a naive UTC *week* bucketing
    // could push it into the wrong week entirely near a week boundary. This
    // instant is a Tuesday in CR, deliberately not a weekend, to make a
    // naive week-shift detectable.
    const tuesdayLateNight = DateTime.fromISO("2026-08-04T22:30:00", { zone: ZONE }); // Tuesday
    await makeCheckin(student.id, academy.id, tuesdayLateNight);
    await makeCheckin(student.id, academy.id, tuesdayLateNight.plus({ days: 1 })); // Wednesday, same week
    await makeCheckin(student.id, academy.id, tuesdayLateNight.plus({ weeks: 1 })); // next week

    const from = DateTime.fromISO("2026-08-03", { zone: ZONE }).startOf("day"); // Monday
    const to = DateTime.fromISO("2026-08-17", { zone: ZONE }).endOf("day"); // three weeks span

    const admin: StaffSession = { userId: "x", role: "ADMIN", academyIds: "ALL" };
    // Scoped to this test's own private academy — otherwise, under vitest's
    // cross-file parallelism, other integration files' own fixtures (many
    // sharing this exact Aug-2026 date window) would inflate these exact
    // per-week counts (same reasoning as this suite's other academy-scoped
    // tests).
    const filters: AnalyticsFilters = { from, to, academyId: academy.id };

    const trend = await getWeeklyAttendanceTrend(admin, filters);

    const weekOne = DateTime.fromISO("2026-08-03", { zone: ZONE }).startOf("week").toISODate();
    const weekTwo = DateTime.fromISO("2026-08-10", { zone: ZONE }).startOf("week").toISODate();
    const weekThree = DateTime.fromISO("2026-08-17", { zone: ZONE }).startOf("week").toISODate();

    expect(trend.map((w) => w.weekStart)).toEqual([weekOne, weekTwo, weekThree]);
    expect(trend.find((w) => w.weekStart === weekOne)?.count).toBe(2);
    expect(trend.find((w) => w.weekStart === weekTwo)?.count).toBe(1);
    expect(trend.find((w) => w.weekStart === weekThree)?.count).toBe(0);
  });

  it("scopes to filters.academyId — attendances at a different academy are excluded", async () => {
    const academyOne = await makeAcademy("retention-trend-scope-one");
    const academyTwo = await makeAcademy("retention-trend-scope-two");
    const studentOne = await makeStudent(academyOne.id);
    const studentTwo = await makeStudent(academyTwo.id);

    await makeCheckin(studentOne.id, academyOne.id, RANGE_FROM.plus({ days: 2 }));
    await makeCheckin(studentTwo.id, academyTwo.id, RANGE_FROM.plus({ days: 2 }));

    const admin: StaffSession = { userId: "x", role: "ADMIN", academyIds: "ALL" };
    const filters: AnalyticsFilters = { from: RANGE_FROM, to: RANGE_TO, academyId: academyOne.id };

    const trend = await getWeeklyAttendanceTrend(admin, filters);
    const total = trend.reduce((sum, w) => sum + w.count, 0);
    expect(total).toBe(1);
  });

  it("an INSTRUCTOR session is rejected entirely (self-enforced role gate)", async () => {
    const instructor: StaffSession = { userId: "x", role: "INSTRUCTOR", academyIds: [] };
    const filters: AnalyticsFilters = { from: RANGE_FROM, to: RANGE_TO, academyId: null };

    await expect(getWeeklyAttendanceTrend(instructor, filters)).rejects.toThrow("FORBIDDEN");
  });
});
