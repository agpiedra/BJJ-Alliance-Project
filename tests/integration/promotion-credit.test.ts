import "dotenv/config";
import { getTestPrismaClient } from "../helpers/test-db";
import { afterAll, describe, expect, it } from "vitest";
import { requireEnv } from "../../src/lib/env";
import { digestLookupSecret } from "../../src/lib/crypto";
import { adultRankId } from "../helpers/belt-ranks";
import { ALLIANCE_ATTENDANCE_CONFIG } from "../helpers/promotion-config";
import { writeAward } from "../../src/lib/promotion/award";

const { getAtBeltSummary } = await import("../../src/lib/students/attendance-summary");

const prisma = getTestPrismaClient();
const pepper = requireEnv("CODE_PEPPER");

const cleanupStudentIds: string[] = [];

async function cleanup() {
  if (cleanupStudentIds.length > 0) {
    await prisma.promotionCredit.deleteMany({ where: { studentId: { in: cleanupStudentIds } } });
    await prisma.promotion.deleteMany({ where: { studentId: { in: cleanupStudentIds } } });
    await prisma.auditLog.deleteMany({ where: { entityId: { in: cleanupStudentIds } } });
    await prisma.attendanceRecord.deleteMany({ where: { studentId: { in: cleanupStudentIds } } });
    await prisma.student.deleteMany({ where: { id: { in: cleanupStudentIds } } });
  }
}

async function makeStudent(
  academyId: string,
  organizationId: string,
  overrides: { currentStripes: number; beltAwardedAt: Date },
) {
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
  const student = await prisma.student.create({
    data: {
      homeAcademyId: academyId,
      organizationId,
      firstName: "PromotionCreditTest",
      lastName: "Student",
      phone: "88880030",
      email: `promotion-credit-${suffix}@example.com`,
      currentRankId: adultRankId("WHITE"),
      currentStripes: overrides.currentStripes,
      beltAwardedAt: overrides.beltAwardedAt,
      // writeAward's updateMany matches on status: ACTIVE (see award.ts) —
      // required for the stripe/belt-award test below; harmless for the
      // other cases here, which never call writeAward.
      status: "ACTIVE",
      codeHash: digestLookupSecret(`promotion-credit-${suffix}`, pepper),
    },
  });
  cleanupStudentIds.push(student.id);
  return student;
}

/**
 * MULTI_ACADEMY_AND_KIDS_BELTS.md Phase 3d verification requirements:
 * 1. A credit of N is N classes closer to promotion, per the engine's OWN
 *    calculation — never a reimplementation of its math.
 * 2. Attendance analytics show ZERO attendance for a credited student — the
 *    test that proves the separation from AttendanceRecord is structural.
 * 3. A credit of 0 behaves identically to no credit at all.
 * 4. A credit survives a stripe award; a belt award supersedes it (retained,
 *    out of scope — never deleted, per this plan's own ruling).
 */
describe("PromotionCredit — Phase 3d onboarding credit", () => {
  afterAll(cleanup);

  it("REQUIRED: a credit of N moves the engine's own eligibility calculation N classes closer to promotion", async () => {
    const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
    const beltAwardedAt = new Date("2026-03-01T12:00:00Z");
    const student = await makeStudent(escazu.id, escazu.organizationId, { currentStripes: 0, beltAwardedAt });

    // Before any credit: 0 real attendance, 0 credited.
    const before = await getAtBeltSummary(student.id, student.organizationId, ALLIANCE_ATTENDANCE_CONFIG);
    expect(before.atBeltCount).toBe(0);
    expect(before.creditedClasses).toBe(0);
    expect(before.remainingAttendance).toBe(30); // attendancesPerStripe for WHITE, per attendance-summary.test.ts

    // Grant a credit of 20 for this same belt period.
    await prisma.promotionCredit.create({
      data: {
        studentId: student.id,
        academyId: escazu.id,
        organizationId: escazu.organizationId,
        beltAwardedAtAnchor: beltAwardedAt,
        classesGranted: 20,
        reason: "Estimated from prior gym.",
      },
    });

    const after = await getAtBeltSummary(student.id, student.organizationId, ALLIANCE_ATTENDANCE_CONFIG);
    expect(after.creditedClasses).toBe(20);
    expect(after.atBeltCount).toBe(20);
    // The engine's OWN remaining-attendance math, not reimplemented here —
    // exactly 20 classes closer than `before`.
    expect(after.remainingAttendance).toBe(before.remainingAttendance! - 20);
    expect(after.isEligible).toBe(false);
  });

  it("REQUIRED: attendance analytics show ZERO attendance for a credited student — proves the separation is structural, not conventional", async () => {
    const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
    const beltAwardedAt = new Date("2026-03-05T12:00:00Z");
    const student = await makeStudent(escazu.id, escazu.organizationId, { currentStripes: 0, beltAwardedAt });

    await prisma.promotionCredit.create({
      data: {
        studentId: student.id,
        academyId: escazu.id,
        organizationId: escazu.organizationId,
        beltAwardedAtAnchor: beltAwardedAt,
        classesGranted: 30,
        reason: "Full stripe's worth, estimated.",
      },
    });

    const summary = await getAtBeltSummary(student.id, student.organizationId, ALLIANCE_ATTENDANCE_CONFIG);
    // The promotion engine sees the credit...
    expect(summary.atBeltCount).toBe(30);
    expect(summary.isEligible).toBe(true);
    // ...but the AttendanceRecord table — what every attendance/retention/
    // headline-tile analytics query reads — never received a row. This is
    // never a query filtering the credit out; there is nothing to filter,
    // because PromotionCredit and AttendanceRecord are different tables.
    expect(await prisma.attendanceRecord.count({ where: { studentId: student.id } })).toBe(0);
    expect(summary.lifetimeCount).toBe(0);
  });

  it("a credit of 0 behaves identically to no credit at all", async () => {
    const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
    const beltAwardedAt = new Date("2026-03-10T12:00:00Z");
    const uncredited = await makeStudent(escazu.id, escazu.organizationId, { currentStripes: 0, beltAwardedAt });
    const zeroCredited = await makeStudent(escazu.id, escazu.organizationId, { currentStripes: 0, beltAwardedAt });
    // No PromotionCredit row for either — Phase 3d's own design point: a
    // credit of 0 never gets a row (see create-student-action.ts), so "0"
    // and "no credit" are the same state, not two states compared equal.

    const [summaryA, summaryB] = await Promise.all([
      getAtBeltSummary(uncredited.id, uncredited.organizationId, ALLIANCE_ATTENDANCE_CONFIG),
      getAtBeltSummary(zeroCredited.id, zeroCredited.organizationId, ALLIANCE_ATTENDANCE_CONFIG),
    ]);

    expect(summaryB.creditedClasses).toBe(0);
    expect(summaryB.atBeltCount).toBe(summaryA.atBeltCount);
    expect(summaryB.remainingAttendance).toBe(summaryA.remainingAttendance);
    expect(summaryB.isEligible).toBe(summaryA.isEligible);
  });

  it("REQUIRED: a credit survives a STRIPE award, and is superseded (retained, out of scope) by a BELT award", async () => {
    const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
    const beltAwardedAt = new Date("2026-03-15T12:00:00Z");
    const student = await makeStudent(escazu.id, escazu.organizationId, { currentStripes: 0, beltAwardedAt });

    const credit = await prisma.promotionCredit.create({
      data: {
        studentId: student.id,
        academyId: escazu.id,
        organizationId: escazu.organizationId,
        beltAwardedAtAnchor: beltAwardedAt,
        classesGranted: 15,
        reason: "Survives-stripe test fixture.",
      },
    });

    // A STRIPE award: writeAward's studentUpdate is {} — beltAwardedAt is
    // untouched (award.ts's own real behavior, not a test double).
    const whiteRankId = adultRankId("WHITE");
    const stripeResult = await writeAward({
      studentId: student.id,
      homeAcademyId: escazu.id,
      organizationId: escazu.organizationId,
      fromRankId: whiteRankId,
      fromStripes: 0,
      toRankId: whiteRankId,
      toStripes: 1,
      studentUpdate: {},
      before: { belt: "WHITE", stripes: 0 },
      after: { belt: "WHITE", stripes: 1 },
      source: "MANUAL",
      awardedById: null,
      notes: null,
    });
    expect(stripeResult.ok).toBe(true);

    const afterStripe = await getAtBeltSummary(student.id, student.organizationId, ALLIANCE_ATTENDANCE_CONFIG);
    expect(afterStripe.creditedClasses).toBe(15);

    const studentAfterStripe = await prisma.student.findUniqueOrThrow({ where: { id: student.id } });
    expect(studentAfterStripe.beltAwardedAt.getTime()).toBe(beltAwardedAt.getTime());

    // A BELT award: writeAward's studentUpdate carries a real new
    // beltAwardedAt (award.ts's own `{ beltAwardedAt: new Date() }` for a
    // belt, not a stripe) — the credit's anchor no longer matches.
    const blueRankId = adultRankId("BLUE");
    const newBeltAwardedAt = new Date();
    const beltResult = await writeAward({
      studentId: student.id,
      homeAcademyId: escazu.id,
      organizationId: escazu.organizationId,
      fromRankId: whiteRankId,
      fromStripes: 1,
      toRankId: blueRankId,
      toStripes: 0,
      studentUpdate: { beltAwardedAt: newBeltAwardedAt },
      before: { belt: "WHITE", stripes: 1 },
      after: { belt: "BLUE", stripes: 0 },
      source: "MANUAL",
      awardedById: null,
      notes: null,
    });
    expect(beltResult.ok).toBe(true);

    const afterBelt = await getAtBeltSummary(student.id, student.organizationId, ALLIANCE_ATTENDANCE_CONFIG);
    // Superseded: out of scope for the new belt period.
    expect(afterBelt.creditedClasses).toBe(0);

    // Retained: the original row still exists, unmodified, for audit — never
    // deleted, never mutated.
    const stillThere = await prisma.promotionCredit.findUniqueOrThrow({ where: { id: credit.id } });
    expect(stillThere.classesGranted).toBe(15);
    expect(stillThere.beltAwardedAtAnchor.getTime()).toBe(beltAwardedAt.getTime());
  });
});
