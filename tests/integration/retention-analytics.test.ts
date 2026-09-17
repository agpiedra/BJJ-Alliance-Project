import "dotenv/config";
import { getTestPrismaClient } from "../helpers/test-db";
import { afterAll, describe, expect, it } from "vitest";
import { DateTime } from "luxon";
import { requireEnv } from "../../src/lib/env";
import { digestLookupSecret, hashSecret } from "../../src/lib/crypto";
import { toAttendanceDate, ZONE } from "../../src/lib/scheduling/zone";
import type { TenantContext, MembershipRole } from "../../src/lib/tenant/types";
import type { AnalyticsFilters } from "../../src/lib/analytics/filters";
import { adultRankId } from "../helpers/belt-ranks";

const { getRetentionList, getWeeklyAttendanceTrend } = await import("../../src/lib/analytics/retention");

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

// Fixture academies must live inside the real seeded Alliance organization
// (not a fresh scratch one) so admin-wide, org-unscoped queries elsewhere in
// the suite (e.g. promotion-queue.test.ts) don't crash resolving a
// BeltRequirement that only the real org's academies have.
let allianceOrgIdPromise: Promise<string> | null = null;
function getAllianceOrganizationId() {
  allianceOrgIdPromise ??= prisma.organization.findUniqueOrThrow({ where: { slug: "alliance-cr" } }).then((o) => o.id);
  return allianceOrgIdPromise;
}

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
    // PromotionCredit (Phase 3d) references Student with ON DELETE RESTRICT
    // — must go first, or student.deleteMany below fails outright.
    await prisma.promotionCredit.deleteMany({ where: { studentId: { in: cleanupStudentIds } } });
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
      organizationId: await getAllianceOrganizationId(),
    },
  });
  cleanupAcademyIds.push(academy.id);
  return academy;
}

async function makeStudent(
  academyId: string,
  organizationId: string,
  overrides?: { firstName?: string; lastName?: string; phone?: string; status?: "PENDING" | "ACTIVE" | "ARCHIVED" },
) {
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
  const student = await prisma.student.create({
    data: {
      homeAcademyId: academyId,
      organizationId,
      firstName: overrides?.firstName ?? "RetentionTest",
      lastName: overrides?.lastName ?? `Student-${suffix}`,
      phone: overrides?.phone ?? "88880000",
      email: `retention-${suffix}@example.com`,
      currentRankId: adultRankId("WHITE"),
      status: overrides?.status ?? "ACTIVE",
      joinedAt: RANGE_FROM.minus({ years: 1 }).toJSDate(),
      codeHash: digestLookupSecret(`retention-${suffix}`, pepper),
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

describe("getRetentionList", () => {
  afterAll(cleanup);

  it("buckets students into 30/60/90 correctly against filters.to, with phone and lastSeenAt", async () => {
    const academy = await makeAcademy("retention-buckets");

    const at35 = await makeStudent(academy.id, academy.organizationId, { firstName: "At35", phone: "10000001" });
    await makeCheckin(at35.id, academy.id, academy.organizationId, RANGE_TO.minus({ days: 35 }));

    const at65 = await makeStudent(academy.id, academy.organizationId, { firstName: "At65", phone: "10000002" });
    await makeCheckin(at65.id, academy.id, academy.organizationId, RANGE_TO.minus({ days: 65 }));

    const at95 = await makeStudent(academy.id, academy.organizationId, { firstName: "At95", phone: "10000003" });
    await makeCheckin(at95.id, academy.id, academy.organizationId, RANGE_TO.minus({ days: 95 }));

    const admin = ctx("ADMIN", "ALL", academy.organizationId);
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
    const student = await makeStudent(academy.id, academy.organizationId, { firstName: "NeverAttended" });

    const admin = ctx("ADMIN", "ALL", academy.organizationId);
    const filters: AnalyticsFilters = { from: RANGE_FROM, to: RANGE_TO, academyId: null };

    const entries = await getRetentionList(admin, filters);
    const entry = entries.find((e) => e.studentId === student.id);

    expect(entry).toBeDefined();
    expect(entry!.lastSeenAt).toBeNull();
    expect(entry!.bucket).toBe("90");
  });

  it("a recently-active student (within 30 days of filters.to) never appears", async () => {
    const academy = await makeAcademy("retention-recently-active");
    const student = await makeStudent(academy.id, academy.organizationId, { firstName: "RecentlyActive" });
    await makeCheckin(student.id, academy.id, academy.organizationId, RANGE_TO.minus({ days: 5 }));

    const admin = ctx("ADMIN", "ALL", academy.organizationId);
    const filters: AnalyticsFilters = { from: RANGE_FROM, to: RANGE_TO, academyId: null };

    const entries = await getRetentionList(admin, filters);
    expect(entries.find((e) => e.studentId === student.id)).toBeUndefined();
  });

  it("a PENDING student never appears, even with no attendance ever", async () => {
    const academy = await makeAcademy("retention-pending-excluded");
    const student = await makeStudent(academy.id, academy.organizationId, { firstName: "PendingOne", status: "PENDING" });

    const admin = ctx("ADMIN", "ALL", academy.organizationId);
    const filters: AnalyticsFilters = { from: RANGE_FROM, to: RANGE_TO, academyId: null };

    const entries = await getRetentionList(admin, filters);
    expect(entries.find((e) => e.studentId === student.id)).toBeUndefined();
  });

  it("an ARCHIVED student never appears, even with old attendance", async () => {
    const academy = await makeAcademy("retention-archived-excluded");
    const student = await makeStudent(academy.id, academy.organizationId, { firstName: "ArchivedOne", status: "ARCHIVED" });
    await makeCheckin(student.id, academy.id, academy.organizationId, RANGE_TO.minus({ days: 95 }));

    const admin = ctx("ADMIN", "ALL", academy.organizationId);
    const filters: AnalyticsFilters = { from: RANGE_FROM, to: RANGE_TO, academyId: null };

    const entries = await getRetentionList(admin, filters);
    expect(entries.find((e) => e.studentId === student.id)).toBeUndefined();
  });

  it("scopes to filters.academyId — a student at a different academy never appears", async () => {
    const academyOne = await makeAcademy("retention-scope-one");
    const academyTwo = await makeAcademy("retention-scope-two");
    const studentOne = await makeStudent(academyOne.id, academyOne.organizationId, { firstName: "ScopeOne" });
    const studentTwo = await makeStudent(academyTwo.id, academyTwo.organizationId, { firstName: "ScopeTwo" });

    const admin = ctx("ADMIN", "ALL", academyOne.organizationId);
    const filters: AnalyticsFilters = { from: RANGE_FROM, to: RANGE_TO, academyId: academyOne.id };

    const entries = await getRetentionList(admin, filters);
    expect(entries.find((e) => e.studentId === studentOne.id)).toBeDefined();
    expect(entries.find((e) => e.studentId === studentTwo.id)).toBeUndefined();
  });

  it("a DIRECTOR only ever sees their own academy, even if handed a filter naming another one", async () => {
    const academyOne = await makeAcademy("retention-director-scope-one");
    const academyTwo = await makeAcademy("retention-director-scope-two");
    const studentOne = await makeStudent(academyOne.id, academyOne.organizationId, { firstName: "DirScopeOne" });
    const studentTwo = await makeStudent(academyTwo.id, academyTwo.organizationId, { firstName: "DirScopeTwo" });

    const director = ctx("DIRECTOR", [academyOne.id], academyOne.organizationId);

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
    const at30 = await makeStudent(academy.id, academy.organizationId, { firstName: "Sort30" });
    await makeCheckin(at30.id, academy.id, academy.organizationId, RANGE_TO.minus({ days: 35 }));
    const at60 = await makeStudent(academy.id, academy.organizationId, { firstName: "Sort60" });
    await makeCheckin(at60.id, academy.id, academy.organizationId, RANGE_TO.minus({ days: 65 }));
    const at90 = await makeStudent(academy.id, academy.organizationId, { firstName: "Sort90" });
    await makeCheckin(at90.id, academy.id, academy.organizationId, RANGE_TO.minus({ days: 95 }));

    const admin = ctx("ADMIN", "ALL", academy.organizationId);
    const filters: AnalyticsFilters = { from: RANGE_FROM, to: RANGE_TO, academyId: academy.id };

    const entries = await getRetentionList(admin, filters);
    expect(entries.map((e) => e.studentId)).toEqual([at90.id, at60.id, at30.id]);
  });

  it("an INSTRUCTOR session is rejected entirely (self-enforced role gate)", async () => {
    const instructor = ctx("INSTRUCTOR", [], await getAllianceOrganizationId());
    const filters: AnalyticsFilters = { from: RANGE_FROM, to: RANGE_TO, academyId: null };

    await expect(getRetentionList(instructor, filters)).rejects.toThrow("FORBIDDEN");
  });

  // MULTI_ACADEMY_AND_KIDS_BELTS.md Phase 3d follow-up: a credited student
  // with zero real attendance should not be flagged until they've had a
  // genuine opportunity to attend (grace window anchored at joinedAt).
  describe("Phase 3d follow-up: onboarding-credit grace window", () => {
    it("a freshly onboarded credited student (joined recently, zero real attendance) does not appear at all", async () => {
      const academy = await makeAcademy("retention-credit-grace-fresh");
      const student = await makeStudent(academy.id, academy.organizationId, { firstName: "FreshCredited" });
      // Override the fixture's default 1-year-old joinedAt: this student
      // joined 10 days before the report's "as of" date.
      await prisma.student.update({
        where: { id: student.id },
        data: { joinedAt: RANGE_TO.minus({ days: 10 }).toJSDate() },
      });
      await prisma.promotionCredit.create({
        data: {
          studentId: student.id,
          academyId: academy.id,
          organizationId: academy.organizationId,
          beltAwardedAtAnchor: student.beltAwardedAt,
          classesGranted: 20,
          reason: "Onboarding estimate.",
        },
      });

      const admin = ctx("ADMIN", "ALL", academy.organizationId);
      const filters: AnalyticsFilters = { from: RANGE_FROM, to: RANGE_TO, academyId: null };

      const entries = await getRetentionList(admin, filters);
      expect(entries.find((e) => e.studentId === student.id)).toBeUndefined();
    });

    it("the same shape of student DOES appear once 30+ days have passed since joining with still no real attendance", async () => {
      const academy = await makeAcademy("retention-credit-grace-expired");
      const student = await makeStudent(academy.id, academy.organizationId, { firstName: "ExpiredGraceCredited" });
      await prisma.student.update({
        where: { id: student.id },
        data: { joinedAt: RANGE_TO.minus({ days: 40 }).toJSDate() },
      });
      await prisma.promotionCredit.create({
        data: {
          studentId: student.id,
          academyId: academy.id,
          organizationId: academy.organizationId,
          beltAwardedAtAnchor: student.beltAwardedAt,
          classesGranted: 20,
          reason: "Onboarding estimate.",
        },
      });

      const admin = ctx("ADMIN", "ALL", academy.organizationId);
      const filters: AnalyticsFilters = { from: RANGE_FROM, to: RANGE_TO, academyId: null };

      const entries = await getRetentionList(admin, filters);
      const entry = entries.find((e) => e.studentId === student.id);
      expect(entry).toBeDefined();
      // 40 days since joining lands in bucket 30 (escalates gradually), not
      // straight to 90 the instant the grace period ends.
      expect(entry!.bucket).toBe("30");
      expect(entry!.lastSeenAt).toBeNull();
    });

    it("an UNCREDITED student with zero attendance is unaffected by this change — still bucket 90 immediately, joined recently or not", async () => {
      const academy = await makeAcademy("retention-credit-grace-uncredited");
      const student = await makeStudent(academy.id, academy.organizationId, { firstName: "FreshUncredited" });
      await prisma.student.update({
        where: { id: student.id },
        data: { joinedAt: RANGE_TO.minus({ days: 2 }).toJSDate() },
      });
      // Deliberately no PromotionCredit row.

      const admin = ctx("ADMIN", "ALL", academy.organizationId);
      const filters: AnalyticsFilters = { from: RANGE_FROM, to: RANGE_TO, academyId: null };

      const entries = await getRetentionList(admin, filters);
      const entry = entries.find((e) => e.studentId === student.id);
      expect(entry).toBeDefined();
      expect(entry!.bucket).toBe("90");
    });
  });
});

describe("getWeeklyAttendanceTrend", () => {
  afterAll(cleanup);

  it("buckets attendances into CR-timezone (Monday-start) weeks over the filtered range, including zero-count weeks", async () => {
    const academy = await makeAcademy("retention-weekly-trend");
    const student = await makeStudent(academy.id, academy.organizationId);

    // A 22:30 CR check-in — well past 18:00, so a naive UTC-day slice would
    // push this into the next UTC calendar day; a naive UTC *week* bucketing
    // could push it into the wrong week entirely near a week boundary. This
    // instant is a Tuesday in CR, deliberately not a weekend, to make a
    // naive week-shift detectable.
    const tuesdayLateNight = DateTime.fromISO("2026-08-04T22:30:00", { zone: ZONE }); // Tuesday
    await makeCheckin(student.id, academy.id, academy.organizationId, tuesdayLateNight);
    await makeCheckin(student.id, academy.id, academy.organizationId, tuesdayLateNight.plus({ days: 1 })); // Wednesday, same week
    await makeCheckin(student.id, academy.id, academy.organizationId, tuesdayLateNight.plus({ weeks: 1 })); // next week

    const from = DateTime.fromISO("2026-08-03", { zone: ZONE }).startOf("day"); // Monday
    const to = DateTime.fromISO("2026-08-17", { zone: ZONE }).endOf("day"); // three weeks span

    const admin = ctx("ADMIN", "ALL", academy.organizationId);
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
    const studentOne = await makeStudent(academyOne.id, academyOne.organizationId);
    const studentTwo = await makeStudent(academyTwo.id, academyTwo.organizationId);

    await makeCheckin(studentOne.id, academyOne.id, academyOne.organizationId, RANGE_FROM.plus({ days: 2 }));
    await makeCheckin(studentTwo.id, academyTwo.id, academyTwo.organizationId, RANGE_FROM.plus({ days: 2 }));

    const admin = ctx("ADMIN", "ALL", academyOne.organizationId);
    const filters: AnalyticsFilters = { from: RANGE_FROM, to: RANGE_TO, academyId: academyOne.id };

    const trend = await getWeeklyAttendanceTrend(admin, filters);
    const total = trend.reduce((sum, w) => sum + w.count, 0);
    expect(total).toBe(1);
  });

  it("an INSTRUCTOR session is rejected entirely (self-enforced role gate)", async () => {
    const instructor = ctx("INSTRUCTOR", [], await getAllianceOrganizationId());
    const filters: AnalyticsFilters = { from: RANGE_FROM, to: RANGE_TO, academyId: null };

    await expect(getWeeklyAttendanceTrend(instructor, filters)).rejects.toThrow("FORBIDDEN");
  });
});
