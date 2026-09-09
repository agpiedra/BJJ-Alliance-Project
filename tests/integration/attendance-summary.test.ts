import "dotenv/config";
import { afterAll, describe, expect, it } from "vitest";
import { PrismaClient } from "../../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { requireEnv } from "../../src/lib/env";
import { digestLookupSecret } from "../../src/lib/crypto";
import { toAttendanceDate } from "../../src/lib/scheduling/zone";

const { getAtBeltSummary } = await import("../../src/lib/students/attendance-summary");

const adapter = new PrismaPg({ connectionString: requireEnv("DATABASE_URL") });
const prisma = new PrismaClient({ adapter });
const pepper = requireEnv("CODE_PEPPER");

const DAY_MS = 24 * 60 * 60 * 1000;

const cleanupStudentIds: string[] = [];

async function cleanup() {
  if (cleanupStudentIds.length > 0) {
    await prisma.attendanceRecord.deleteMany({ where: { studentId: { in: cleanupStudentIds } } });
    await prisma.student.deleteMany({ where: { id: { in: cleanupStudentIds } } });
  }
}

async function makeStudent(
  academyId: string,
  overrides: { currentStripes: number; beltAwardedAt: Date },
) {
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
  const student = await prisma.student.create({
    data: {
      homeAcademyId: academyId,
      firstName: "AtBeltSummaryTest",
      lastName: "Student",
      phone: "88880000",
      email: `at-belt-summary-${suffix}@example.com`,
      currentBelt: "WHITE",
      currentStripes: overrides.currentStripes,
      beltAwardedAt: overrides.beltAwardedAt,
      codeHash: digestLookupSecret(`at-belt-summary-${suffix}`, pepper),
    },
  });
  cleanupStudentIds.push(student.id);
  return student;
}

/** Writes `count` real CHECKIN rows, one per day starting at `startAt`. */
async function addCheckins(studentId: string, academyId: string, count: number, startAt: Date) {
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

describe("getAtBeltSummary", () => {
  afterAll(cleanup);

  it("tracks remainingToNextStripe as White-belt attendances accumulate, applies a negative adjustment, and separates lifetime from at-belt counts", async () => {
    const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
    const beltAwardedAt = new Date("2026-01-01T12:00:00Z");
    const student = await makeStudent(escazu.id, { currentStripes: 0, beltAwardedAt });

    // 0 attendances since beltAwardedAt.
    let summary = await getAtBeltSummary(student.id);
    expect(summary.currentBelt).toBe("WHITE");
    expect(summary.currentStripes).toBe(0);
    expect(summary.atBeltCount).toBe(0);
    expect(summary.lifetimeCount).toBe(0);
    expect(summary.attendancesPerStripe).toBe(30);
    expect(summary.maxStripes).toBe(4);
    expect(summary.nextStripeAt).toBe(30);
    expect(summary.remainingToNextStripe).toBe(30);
    expect(summary.examEligible).toBe(false);

    // 29 attendances since beltAwardedAt.
    await addCheckins(student.id, escazu.id, 29, new Date(beltAwardedAt.getTime() + DAY_MS));
    summary = await getAtBeltSummary(student.id);
    expect(summary.atBeltCount).toBe(29);
    expect(summary.nextStripeAt).toBe(30);
    expect(summary.remainingToNextStripe).toBe(1);
    expect(summary.examEligible).toBe(false);

    // The 30th attendance reaches (but does not itself flip) the threshold.
    await addCheckins(student.id, escazu.id, 1, new Date(beltAwardedAt.getTime() + 30 * DAY_MS));
    summary = await getAtBeltSummary(student.id);
    expect(summary.atBeltCount).toBe(30);
    expect(summary.remainingToNextStripe).toBe(0);
    // Reaching the threshold is reported, not applied — currentStripes is
    // still whatever the seeded row says; only Phase 4 flips it.
    expect(summary.currentStripes).toBe(0);

    // A negative ADJUSTMENT row nets against the CHECKIN total by construction.
    const adjustmentAt = new Date(beltAwardedAt.getTime() + 31 * DAY_MS);
    await prisma.attendanceRecord.create({
      data: {
        studentId: student.id,
        academyId: escazu.id,
        occurredAt: adjustmentAt,
        date: toAttendanceDate(adjustmentAt),
        type: "ADJUSTMENT",
        delta: -5,
        reason: "test correction",
        source: "STAFF",
      },
    });
    summary = await getAtBeltSummary(student.id);
    expect(summary.atBeltCount).toBe(25);
    expect(summary.remainingToNextStripe).toBe(5);
    expect(summary.lifetimeCount).toBe(25);

    // A record predating the current beltAwardedAt counts toward lifetime
    // only — atBeltCount is unaffected.
    const beforeAward = new Date(beltAwardedAt.getTime() - 10 * DAY_MS);
    await prisma.attendanceRecord.create({
      data: {
        studentId: student.id,
        academyId: escazu.id,
        occurredAt: beforeAward,
        date: toAttendanceDate(beforeAward),
        type: "CHECKIN",
        delta: 1,
        source: "STAFF",
      },
    });
    summary = await getAtBeltSummary(student.id);
    expect(summary.atBeltCount).toBe(25);
    expect(summary.lifetimeCount).toBe(26);
  });

  it("reports exam eligibility only once attendancesForExam is reached past the 4th stripe", async () => {
    const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
    const beltAwardedAt = new Date("2026-02-01T12:00:00Z");
    // Already at 4 stripes: the 120 attendances that earned them, plus 29
    // more toward the exam threshold (30 more required past the 4th stripe).
    const student = await makeStudent(escazu.id, { currentStripes: 4, beltAwardedAt });

    await addCheckins(student.id, escazu.id, 149, new Date(beltAwardedAt.getTime() + DAY_MS));
    let summary = await getAtBeltSummary(student.id);
    expect(summary.currentStripes).toBe(4);
    expect(summary.maxStripes).toBe(4);
    expect(summary.atBeltCount).toBe(149);
    expect(summary.nextStripeAt).toBeNull();
    expect(summary.examEligible).toBe(false);
    expect(summary.remainingToNextStripe).toBe(1);

    // One more attendance (30 more past the 4th stripe) crosses the exam
    // threshold.
    await addCheckins(student.id, escazu.id, 1, new Date(beltAwardedAt.getTime() + 150 * DAY_MS));
    summary = await getAtBeltSummary(student.id);
    expect(summary.atBeltCount).toBe(150);
    expect(summary.examEligible).toBe(true);
    expect(summary.remainingToNextStripe).toBeNull();
  });
});
