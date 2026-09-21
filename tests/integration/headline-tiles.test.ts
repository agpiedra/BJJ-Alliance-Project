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
import { adultRankId } from "../helpers/belt-ranks";

const { getHeadlineTiles, previousEquivalentRange } = await import(
  "../../src/lib/analytics/headline-tiles"
);

const prisma = getTestPrismaClient();

let allianceOrgIdPromise: Promise<string> | null = null;
function getAllianceOrganizationId() {
  allianceOrgIdPromise ??= prisma.organization.findUniqueOrThrow({ where: { slug: "alliance-cr" } }).then((o) => o.id);
  return allianceOrgIdPromise;
}
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
// real wall clock — `getHeadlineTiles` classifies active/new/lost against
// whatever `AnalyticsFilters` it's handed, so a hand-built one here never
// fights "today".
const RANGE_FROM = DateTime.fromISO("2026-08-01", { zone: ZONE }).startOf("day");
const RANGE_TO = DateTime.fromISO("2026-08-30", { zone: ZONE }).endOf("day");
const PREVIOUS = previousEquivalentRange({ from: RANGE_FROM, to: RANGE_TO });
const LONG_AGO = DateTime.fromISO("2020-01-01", { zone: ZONE }).toJSDate();

const cleanupStudentIds: string[] = [];
const cleanupUserIds: string[] = [];
const cleanupPlanIds: string[] = [];
const cleanupAcademyIds: string[] = [];

async function cleanup() {
  if (cleanupStudentIds.length > 0) {
    await prisma.paymentPeriod.deleteMany({ where: { studentId: { in: cleanupStudentIds } } });
    await prisma.attendanceRecord.deleteMany({ where: { studentId: { in: cleanupStudentIds } } });
    await prisma.student.deleteMany({ where: { id: { in: cleanupStudentIds } } });
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

// A private academy per scenario — never the shared seeded Escazú/Escalante
// rows — so an exact `enrolled` count here can never be polluted by
// seed.test.ts / other integration files' own fixtures under vitest's
// file-level parallelism (same reasoning as attendance-summary.test.ts's
// `cleanupAcademyIds`).
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

async function makePlan(academyId: string, organizationId: string) {
  const plan = await prisma.paymentPlan.create({
    data: { academyId, organizationId, name: `Headline Tiles Plan ${Date.now()}-${Math.floor(Math.random() * 1_000_000)}` },
  });
  cleanupPlanIds.push(plan.id);
  return plan;
}

async function makeRecorder() {
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
  const user = await prisma.user.create({
    data: {
      email: `headline-recorder-${suffix}@example.com`,
      passwordHash: await hashSecret("irrelevant-password-123"),
      role: "ADMIN",
    },
  });
  cleanupUserIds.push(user.id);
  return user;
}

async function makeStudent(academyId: string, organizationId: string, joinedAt: Date) {
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
  const student = await prisma.student.create({
    data: {
      homeAcademyId: academyId,
      organizationId,
      firstName: "HeadlineTilesTest",
      lastName: `Student-${suffix}`,
      phone: "88880000",
      email: `headline-tiles-${suffix}@example.com`,
      currentRankId: adultRankId("WHITE"),
      status: "ACTIVE",
      joinedAt,
      codeHash: digestLookupSecret(`headline-tiles-${suffix}`, pepper),
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
  year: number,
  month: number,
  status: "PAID" | "PENDING" | "PROMO" | "EXEMPT",
) {
  await prisma.paymentPeriod.create({
    data: { studentId, academyId, organizationId, planId, recordedById, currency: "CRC", year, month, status },
  });
}

describe("getHeadlineTiles", () => {
  afterAll(cleanup);

  it("computes enrolled/active/inactive/new/lost/attendance/payment-health for a scoped scenario", async () => {
    const academy = await makeAcademy("headline-scenario");
    const plan = await makePlan(academy.id, academy.organizationId);
    const recorder = await makeRecorder();

    // sA: enrolled long ago, attended twice inside the current range —
    // active, and (paid this month) counts toward payment health.
    const sA = await makeStudent(academy.id, academy.organizationId, LONG_AGO);
    // sB: enrolled long ago, attended only in the PREVIOUS period — lost.
    const sB = await makeStudent(academy.id, academy.organizationId, LONG_AGO);
    // sC: joined INSIDE the range, never attended — new, inactive.
    const sC = await makeStudent(academy.id, academy.organizationId, RANGE_FROM.plus({ days: 5 }).toJSDate());
    // sD: attended in both the previous and current period — active, not
    // lost, and (PENDING this month) does not count toward payment health.
    const sD = await makeStudent(academy.id, academy.organizationId, LONG_AGO);
    // sE: enrolled long ago, never attended at all — inactive, not lost
    // (no previous-period attendance either), no payment period recorded.
    const sE = await makeStudent(academy.id, academy.organizationId, LONG_AGO);

    await makeCheckin(sA.id, academy.id, academy.organizationId, RANGE_FROM.plus({ days: 2 }));
    await makeCheckin(sA.id, academy.id, academy.organizationId, RANGE_FROM.plus({ days: 3 }));
    await makeCheckin(sB.id, academy.id, academy.organizationId, PREVIOUS.from.plus({ days: 2 }));
    await makeCheckin(sD.id, academy.id, academy.organizationId, PREVIOUS.from.plus({ days: 3 }));
    await makeCheckin(sD.id, academy.id, academy.organizationId, RANGE_FROM.plus({ days: 4 }));

    const { year, month } = currentCrDateParts();
    await makePaymentPeriod(sA.id, academy.id, academy.organizationId, plan.id, recorder.id, year, month, "PAID");
    await makePaymentPeriod(sD.id, academy.id, academy.organizationId, plan.id, recorder.id, year, month, "PENDING");
    // sB, sC, sE: no current-month PaymentPeriod row at all.

    const admin = ctx("ADMIN", "ALL", academy.organizationId);
    const filters: AnalyticsFilters = { from: RANGE_FROM, to: RANGE_TO, academyId: academy.id };

    const tiles = await getHeadlineTiles(admin, filters);

    expect(tiles.enrolled).toBe(5);
    expect(tiles.active).toBe(2); // sA, sD
    expect(tiles.inactive).toBe(3); // sB, sC, sE
    expect(tiles.newThisMonth).toBe(1); // sC
    expect(tiles.lost).toBe(1); // sB
    expect(tiles.totalAttendances).toBe(3); // sA x2 + sD x1, inside the range only
    expect(tiles.avgAttendancesPerActive).toBe(1.5); // 3 / 2
    expect(tiles.paymentHealthPercent).toBe(20); // 1 healthy (sA) / 5 enrolled
  });

  it("an ADJUSTMENT record never counts toward attendance-based tiles, only a real CHECKIN does", async () => {
    const academy = await makeAcademy("headline-adjustment");
    const student = await makeStudent(academy.id, academy.organizationId, LONG_AGO);
    await prisma.attendanceRecord.create({
      data: {
        studentId: student.id,
        academyId: academy.id,
        organizationId: academy.organizationId,
        occurredAt: RANGE_FROM.plus({ days: 2 }).toJSDate(),
        date: toAttendanceDate(RANGE_FROM.plus({ days: 2 }).toJSDate()),
        type: "ADJUSTMENT",
        delta: 1,
        reason: "test correction",
        source: "STAFF",
      },
    });

    const admin = ctx("ADMIN", "ALL", academy.organizationId);
    const filters: AnalyticsFilters = { from: RANGE_FROM, to: RANGE_TO, academyId: academy.id };
    const tiles = await getHeadlineTiles(admin, filters);

    expect(tiles.active).toBe(0);
    expect(tiles.totalAttendances).toBe(0);
  });

  it("a DIRECTOR only ever sees their own academy, even if handed a filter naming another one", async () => {
    const academyOne = await makeAcademy("headline-scope-one");
    const academyTwo = await makeAcademy("headline-scope-two");
    await makeStudent(academyOne.id, academyOne.organizationId, LONG_AGO);
    await makeStudent(academyTwo.id, academyTwo.organizationId, LONG_AGO);

    const director = ctx("DIRECTOR", [academyOne.id], academyOne.organizationId);

    const ownScope = await getHeadlineTiles(director, {
      from: RANGE_FROM,
      to: RANGE_TO,
      academyId: academyOne.id,
    });
    expect(ownScope.enrolled).toBe(1);

    // A hand-built filter naming the OTHER academy (as if `resolveAnalyticsFilters`
    // had somehow been bypassed) still resolves to nothing for this DIRECTOR —
    // `academyScopeWhere(session)` is applied independently of
    // `filters.academyId`, never trusted alone.
    const forgedScope = await getHeadlineTiles(director, {
      from: RANGE_FROM,
      to: RANGE_TO,
      academyId: academyTwo.id,
    });
    expect(forgedScope.enrolled).toBe(0);

    const admin = ctx("ADMIN", "ALL", academyOne.organizationId);
    const adminCombined = await getHeadlineTiles(admin, { from: RANGE_FROM, to: RANGE_TO, academyId: null });
    expect(adminCombined.enrolled).toBeGreaterThanOrEqual(2);

    const adminFiltered = await getHeadlineTiles(admin, {
      from: RANGE_FROM,
      to: RANGE_TO,
      academyId: academyOne.id,
    });
    expect(adminFiltered.enrolled).toBe(1);
  });

  it("an INSTRUCTOR session is rejected entirely (self-enforced role gate)", async () => {
    const instructor = ctx("INSTRUCTOR", [], await getAllianceOrganizationId());
    const filters: AnalyticsFilters = { from: RANGE_FROM, to: RANGE_TO, academyId: null };

    await expect(getHeadlineTiles(instructor, filters)).rejects.toThrow("FORBIDDEN");
  });
});
