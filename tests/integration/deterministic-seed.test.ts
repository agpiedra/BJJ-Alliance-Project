import "dotenv/config";
import { getTestPrismaClient } from "../helpers/test-db";
import { describe, expect, it } from "vitest";

const prisma = getTestPrismaClient();

/**
 * docs/MULTI_ACADEMY_AND_KIDS_BELTS.md Phase 0 acceptance criterion: "The
 * seed contains every listed edge case, verified by assertions rather than
 * by eye." Each test below queries the real seeded test database for one
 * required case from prisma/seed.ts's STUDENTS roster.
 */
describe("deterministic seed — required edge cases", () => {
  it("#1 a student with zero attendance ever", async () => {
    const count = await prisma.attendanceRecord.count({ where: { studentId: "seed-student-001" } });
    expect(count).toBe(0);
  });

  it("#2 a student who trains at both branches", async () => {
    const academies = await prisma.attendanceRecord.findMany({
      where: { studentId: "seed-student-002" },
      select: { academyId: true },
      distinct: ["academyId"],
    });
    const academyIds = academies.map((a) => a.academyId).sort();
    expect(academyIds).toEqual(["seed-academy-escalante", "seed-academy-escazu"]);
  });

  it("#3 a student at max stripes (4/4) with enough promotion-relevant attendance to be awaiting a belt", async () => {
    const student = await prisma.student.findUniqueOrThrow({
      where: { id: "seed-student-003" },
      include: { currentRank: { select: { code: true } } },
    });
    expect(student.currentStripes).toBe(4);

    // Replicates src/lib/students/attendance-summary.ts's PROMOTION_RELEVANT
    // filter exactly (including the UNMATCHED exclusion — see that file's
    // doc comment, cited from a different, already-shipped spec:
    // docs/REDESIGN_BRIEF.md Phase 9, not this one).
    const sum = await prisma.attendanceRecord.aggregate({
      where: {
        studentId: student.id,
        occurredAt: { gte: student.beltAwardedAt },
        OR: [
          { classSessionId: null, NOT: { matchSource: "UNMATCHED" } },
          { classSession: { countsTowardPromotion: true } },
        ],
      },
      _sum: { delta: true },
    });
    const belt = await prisma.beltRank.findFirstOrThrow({
      where: { organizationId: student.organizationId, track: "ADULT", code: student.currentRank.code },
    });
    const beltThreshold = belt.maxStripes * (belt.attendancesPerStripe ?? 0) + (belt.attendancesForExam ?? 0);

    expect(sum._sum.delta ?? 0).toBeGreaterThanOrEqual(beltThreshold);
    // Still WHITE — an award is a staff action, never automatic. "Awaiting a
    // belt" means eligible, not already promoted.
    expect(student.currentRank.code).toBe("WHITE");
  });

  it("#4 a negative-delta manual adjustment", async () => {
    const adjustments = await prisma.attendanceRecord.findMany({
      where: { studentId: "seed-student-004", type: "ADJUSTMENT" },
    });
    expect(adjustments.length).toBeGreaterThan(0);
    expect(adjustments.some((a) => a.delta < 0)).toBe(true);
    expect(adjustments.every((a) => a.classSessionId === null)).toBe(true);
  });

  it("#5 attendance on a class with countsTowardPromotion: false", async () => {
    const rows = await prisma.attendanceRecord.findMany({
      where: { studentId: "seed-student-005" },
      include: { classSession: true },
    });
    const onNonCountingClass = rows.filter((r) => r.classSession?.countsTowardPromotion === false);
    expect(onNonCountingClass.length).toBeGreaterThan(0);
    expect(onNonCountingClass.every((r) => r.classSession?.type === "STRIKING")).toBe(true);
  });

  it("one student at every adult belt, including terminal BLACK", async () => {
    const belts = await prisma.student.groupBy({
      by: ["currentRankId"],
      where: { id: { startsWith: "seed-student-" } },
      _count: { _all: true },
    });
    const rankCodeById = new Map(
      (await prisma.beltRank.findMany({ where: { track: "ADULT" }, select: { id: true, code: true } })).map((r) => [
        r.id,
        r.code,
      ]),
    );
    const beltsPresent = belts.map((b) => rankCodeById.get(b.currentRankId)).sort();
    expect(beltsPresent).toEqual(["BLACK", "BLUE", "BROWN", "PURPLE", "WHITE"]);

    const black = await prisma.student.findFirstOrThrow({
      where: { id: { startsWith: "seed-student-" }, currentRank: { code: "BLACK" } },
    });
    expect(black.currentStripes).toBe(0);
  });

  it("belt distribution is a pyramid — many white, few purple, one or two brown", async () => {
    const belts = await prisma.student.groupBy({
      by: ["currentRankId"],
      where: { id: { startsWith: "seed-student-" } },
      _count: { _all: true },
    });
    const rankCodeById = new Map(
      (await prisma.beltRank.findMany({ where: { track: "ADULT" }, select: { id: true, code: true } })).map((r) => [
        r.id,
        r.code,
      ]),
    );
    const byBelt = Object.fromEntries(belts.map((b) => [rankCodeById.get(b.currentRankId), b._count._all]));
    expect(byBelt.WHITE).toBeGreaterThan(byBelt.BLUE);
    expect(byBelt.BLUE).toBeGreaterThan(byBelt.PURPLE);
    expect(byBelt.BROWN).toBeGreaterThanOrEqual(1);
    expect(byBelt.BROWN).toBeLessThanOrEqual(2);
    expect(byBelt.BLACK).toBe(1);
  });
});
