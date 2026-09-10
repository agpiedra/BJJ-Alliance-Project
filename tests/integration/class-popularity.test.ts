import "dotenv/config";
import { afterAll, describe, expect, it } from "vitest";
import { DateTime } from "luxon";
import { PrismaClient } from "../../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { requireEnv } from "../../src/lib/env";
import { digestLookupSecret } from "../../src/lib/crypto";
import { toAttendanceDate, ZONE } from "../../src/lib/scheduling/zone";
import type { StaffSession } from "../../src/lib/auth/session";
import type { AnalyticsFilters } from "../../src/lib/analytics/filters";

const { getClassPopularity } = await import("../../src/lib/analytics/class-popularity");
const { previousEquivalentRange } = await import("../../src/lib/analytics/headline-tiles");

const adapter = new PrismaPg({ connectionString: requireEnv("DATABASE_URL") });
const prisma = new PrismaClient({ adapter });
const pepper = requireEnv("CODE_PEPPER");

// A fixed range for every test in this file, entirely independent of the
// real wall clock — same reasoning as headline-tiles.test.ts.
const RANGE_FROM = DateTime.fromISO("2026-08-01", { zone: ZONE }).startOf("day");
const RANGE_TO = DateTime.fromISO("2026-08-30", { zone: ZONE }).endOf("day");
const PREVIOUS = previousEquivalentRange({ from: RANGE_FROM, to: RANGE_TO });

const cleanupStudentIds: string[] = [];
const cleanupClassSessionIds: string[] = [];
const cleanupAcademyIds: string[] = [];

async function cleanup() {
  if (cleanupStudentIds.length > 0) {
    await prisma.attendanceRecord.deleteMany({ where: { studentId: { in: cleanupStudentIds } } });
    await prisma.student.deleteMany({ where: { id: { in: cleanupStudentIds } } });
  }
  if (cleanupClassSessionIds.length > 0) {
    await prisma.classSession.deleteMany({ where: { id: { in: cleanupClassSessionIds } } });
  }
  if (cleanupAcademyIds.length > 0) {
    await prisma.academy.deleteMany({ where: { id: { in: cleanupAcademyIds } } });
  }
}

// A private academy per scenario, never the shared seeded Escazú/Escalante
// rows — same reasoning as headline-tiles.test.ts's makeAcademy.
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

async function makeClassSession(
  academyId: string,
  fields: { dayOfWeek: "MONDAY" | "TUESDAY" | "WEDNESDAY"; startTime: string; name: string },
) {
  const session = await prisma.classSession.create({
    data: {
      academyId,
      dayOfWeek: fields.dayOfWeek,
      startTime: fields.startTime,
      durationMinutes: 60,
      name: fields.name,
      type: "GI",
    },
  });
  cleanupClassSessionIds.push(session.id);
  return session;
}

async function makeStudent(academyId: string) {
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
  const student = await prisma.student.create({
    data: {
      homeAcademyId: academyId,
      firstName: "ClassPopularityTest",
      lastName: `Student-${suffix}`,
      phone: "88880000",
      email: `class-popularity-${suffix}@example.com`,
      status: "ACTIVE",
      joinedAt: new Date("2020-01-01"),
      codeHash: digestLookupSecret(`class-popularity-${suffix}`, pepper),
    },
  });
  cleanupStudentIds.push(student.id);
  return student;
}

async function makeCheckin(
  studentId: string,
  academyId: string,
  classSessionId: string,
  occurredAt: DateTime,
) {
  const at = occurredAt.toJSDate();
  await prisma.attendanceRecord.create({
    data: {
      studentId,
      academyId,
      classSessionId,
      occurredAt: at,
      date: toAttendanceDate(at),
      type: "CHECKIN",
      delta: 1,
      source: "STAFF",
    },
  });
}

describe("getClassPopularity", () => {
  afterAll(cleanup);

  it("ranks descending by current-range attendances, surfaces the zero/lowest slot, and matches computeTrend", async () => {
    const academy = await makeAcademy("popularity-scenario");
    const student = await makeStudent(academy.id);

    // Created deliberately OUT of final-rank order (zero first, popular
    // last) — Prisma's default findMany order is creation order, so this
    // arrangement would fail if getClassPopularity ever dropped its own
    // explicit descending sort and relied on DB insertion order instead.
    // Zero: never attended in either period — must still appear, flat.
    const zero = await makeClassSession(academy.id, {
      dayOfWeek: "WEDNESDAY",
      startTime: "07:00",
      name: "Open Mat",
    });
    // Declining: 1 attendance now, 3 previously — down.
    const declining = await makeClassSession(academy.id, {
      dayOfWeek: "TUESDAY",
      startTime: "19:00",
      name: "Advanced",
    });
    // Popular: 3 attendances now, 1 previously — up.
    const popular = await makeClassSession(academy.id, {
      dayOfWeek: "MONDAY",
      startTime: "18:00",
      name: "Fundamentals",
    });

    await makeCheckin(student.id, academy.id, popular.id, RANGE_FROM.plus({ days: 1 }));
    await makeCheckin(student.id, academy.id, popular.id, RANGE_FROM.plus({ days: 2 }));
    await makeCheckin(student.id, academy.id, popular.id, RANGE_FROM.plus({ days: 3 }));
    await makeCheckin(student.id, academy.id, popular.id, PREVIOUS.from.plus({ days: 1 }));

    await makeCheckin(student.id, academy.id, declining.id, RANGE_FROM.plus({ days: 1 }));
    await makeCheckin(student.id, academy.id, declining.id, PREVIOUS.from.plus({ days: 1 }));
    await makeCheckin(student.id, academy.id, declining.id, PREVIOUS.from.plus({ days: 2 }));
    await makeCheckin(student.id, academy.id, declining.id, PREVIOUS.from.plus({ days: 3 }));

    const director: StaffSession = { userId: "x", role: "DIRECTOR", academyIds: [academy.id] };
    const filters: AnalyticsFilters = { from: RANGE_FROM, to: RANGE_TO, academyId: academy.id };

    const rows = await getClassPopularity(director, filters);

    expect(rows).toHaveLength(3);
    // Ranked descending by attendances.
    expect(rows.map((r) => r.classSessionId)).toEqual([popular.id, declining.id, zero.id]);

    const popularRow = rows.find((r) => r.classSessionId === popular.id)!;
    expect(popularRow.attendances).toBe(3);
    expect(popularRow.previousAttendances).toBe(1);
    expect(popularRow.trend).toBe("up");
    expect(popularRow.dayOfWeek).toBe("MONDAY");
    expect(popularRow.startTime).toBe("18:00");
    expect(popularRow.label).toContain("18:00");
    expect(popularRow.label).toContain("Fundamentals");
    // Default locale (es) day name, not the raw enum value.
    expect(popularRow.label).not.toContain("MONDAY");

    const decliningRow = rows.find((r) => r.classSessionId === declining.id)!;
    expect(decliningRow.attendances).toBe(1);
    expect(decliningRow.previousAttendances).toBe(3);
    expect(decliningRow.trend).toBe("down");

    // The lowest-attended (zero) slot is present and identifiable, not
    // filtered out.
    const zeroRow = rows.find((r) => r.classSessionId === zero.id)!;
    expect(zeroRow.attendances).toBe(0);
    expect(zeroRow.previousAttendances).toBe(0);
    expect(zeroRow.trend).toBe("flat");
  });

  it("composes label using the translated day name for the requested locale", async () => {
    const academy = await makeAcademy("popularity-locale");
    const session = await makeClassSession(academy.id, {
      dayOfWeek: "MONDAY",
      startTime: "18:00",
      name: "Fundamentals",
    });

    const director: StaffSession = { userId: "x", role: "DIRECTOR", academyIds: [academy.id] };
    const filters: AnalyticsFilters = { from: RANGE_FROM, to: RANGE_TO, academyId: academy.id };

    const esRows = await getClassPopularity(director, filters, "es");
    expect(esRows.find((r) => r.classSessionId === session.id)!.label).toContain("Lunes");

    const enRows = await getClassPopularity(director, filters, "en");
    expect(enRows.find((r) => r.classSessionId === session.id)!.label).toContain("Monday");
  });

  it("a DIRECTOR never sees the other academy's classes", async () => {
    const academyOne = await makeAcademy("popularity-scope-one");
    const academyTwo = await makeAcademy("popularity-scope-two");
    await makeClassSession(academyOne.id, { dayOfWeek: "MONDAY", startTime: "18:00", name: "One" });
    await makeClassSession(academyTwo.id, { dayOfWeek: "MONDAY", startTime: "18:00", name: "Two" });

    const director: StaffSession = { userId: "x", role: "DIRECTOR", academyIds: [academyOne.id] };

    const ownScope = await getClassPopularity(director, {
      from: RANGE_FROM,
      to: RANGE_TO,
      academyId: academyOne.id,
    });
    expect(ownScope).toHaveLength(1);
    expect(ownScope[0].label).toContain("One");

    // A hand-built filter naming the OTHER academy still resolves to nothing
    // for this DIRECTOR — academyScopeWhere(session) is applied
    // independently of filters.academyId, never trusted alone.
    const forgedScope = await getClassPopularity(director, {
      from: RANGE_FROM,
      to: RANGE_TO,
      academyId: academyTwo.id,
    });
    expect(forgedScope).toHaveLength(0);
  });

  it("an INSTRUCTOR session is rejected entirely (self-enforced role gate)", async () => {
    const instructor: StaffSession = { userId: "x", role: "INSTRUCTOR", academyIds: [] };
    const filters: AnalyticsFilters = { from: RANGE_FROM, to: RANGE_TO, academyId: null };

    await expect(getClassPopularity(instructor, filters)).rejects.toThrow("FORBIDDEN");
  });
});
