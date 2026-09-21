import "dotenv/config";
import { getTestPrismaClient } from "../helpers/test-db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { requireEnv } from "../../src/lib/env";
import { digestLookupSecret } from "../../src/lib/crypto";
import { updateTrackConfig, validateTrackConfig, TrackConfigError, type RankForValidation } from "../../src/lib/promotion/config";
import type { TenantContext } from "../../src/lib/tenant/types";

const prisma = getTestPrismaClient();
const pepper = requireEnv("CODE_PEPPER");

const ORG = "promotion-config-test-org";
const ACADEMY = "promotion-config-test-academy";
const ACTOR_USER = "promotion-config-test-actor";
const RANK_WHITE = "promotion-config-test-rank-white";
const RANK_BLUE = "promotion-config-test-rank-blue";
const RANK_PURPLE = "promotion-config-test-rank-purple";
const RANK_BROWN = "promotion-config-test-rank-brown";
const RANK_BLACK = "promotion-config-test-rank-black";

function ctx(): TenantContext {
  return {
    kind: "tenant",
    actorUserId: ACTOR_USER,
    organizationId: ORG,
    organizationRole: "ADMIN",
    academyIds: "ALL",
    selfStudentId: null, linkedStudentId: null,
  };
}

/** Fixture rank matching the seed shape: 4-stripe non-terminal ranks, plus a 0-stripe terminal BLACK. */
function rank(overrides: Partial<RankForValidation> & Pick<RankForValidation, "id" | "code" | "order">): RankForValidation {
  return {
    isTerminal: false,
    maxStripes: 4,
    attendancesPerStripe: 10,
    attendancesForExam: 40,
    monthsPerStripe: null,
    monthsForExam: null,
    stripeColors: ["a", "b", "c", "d"],
    visibleStripeSlots: 4,
    ...overrides,
  };
}

const cleanupStudentIds: string[] = [];

async function makeStudent(currentRankId: string, currentStripes: number) {
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
  const student = await prisma.student.create({
    data: {
      homeAcademyId: ACADEMY,
      organizationId: ORG,
      firstName: "PromotionConfigTest",
      lastName: `Student-${suffix}`,
      phone: "88880000",
      email: `promotion-config-${suffix}@example.com`,
      currentRankId,
      currentStripes,
      status: "ACTIVE",
      codeHash: digestLookupSecret(`promotion-config-${suffix}`, pepper),
    },
  });
  cleanupStudentIds.push(student.id);
  return student;
}

beforeAll(async () => {
  await prisma.organization.create({
    data: { id: ORG, slug: ORG, name: "Promotion Config Test Org", status: "ACTIVE" },
  });
  await prisma.academy.create({
    data: { id: ACADEMY, organizationId: ORG, name: "Promotion Config Test Academy", slug: ACADEMY, kioskTokenHash: `${ACADEMY}-kiosk-hash` },
  });
  await prisma.user.create({
    data: { id: ACTOR_USER, email: `${ACTOR_USER}@example.com`, passwordHash: "unused", role: "ADMIN" },
  });
  await prisma.beltRank.createMany({
    data: [
      { id: RANK_WHITE, organizationId: ORG, track: "ADULT", code: "WHITE", labelEs: "Blanco", labelEn: "White", primaryColor: "#F0EBE0", barColor: "#111116", order: 1, maxStripes: 4, attendancesPerStripe: 10, attendancesForExam: 40, stripeColors: ["w1", "w2", "w3", "w4"] },
      { id: RANK_BLUE, organizationId: ORG, track: "ADULT", code: "BLUE", labelEs: "Azul", labelEn: "Blue", primaryColor: "#215DA5", barColor: "#111116", order: 2, maxStripes: 4, attendancesPerStripe: 15, attendancesForExam: 50, stripeColors: ["b1", "b2", "b3", "b4"] },
      { id: RANK_PURPLE, organizationId: ORG, track: "ADULT", code: "PURPLE", labelEs: "Morado", labelEn: "Purple", primaryColor: "#652F94", barColor: "#111116", order: 3, maxStripes: 4, attendancesPerStripe: 20, attendancesForExam: 60, stripeColors: ["p1", "p2", "p3", "p4"] },
      { id: RANK_BROWN, organizationId: ORG, track: "ADULT", code: "BROWN", labelEs: "Café", labelEn: "Brown", primaryColor: "#643D20", barColor: "#111116", order: 4, maxStripes: 4, attendancesPerStripe: 25, attendancesForExam: 70, stripeColors: ["n1", "n2", "n3", "n4"] },
      { id: RANK_BLACK, organizationId: ORG, track: "ADULT", code: "BLACK", labelEs: "Negro", labelEn: "Black", primaryColor: "#111116", barColor: "#B63B32", order: 5, maxStripes: 0, isTerminal: true, stripeColors: [] },
    ],
  });
  await prisma.promotionConfig.create({
    data: { organizationId: ORG, track: "ADULT", mode: "ATTENDANCE", requiresCoachApproval: true },
  });
});

afterAll(async () => {
  if (cleanupStudentIds.length > 0) {
    await prisma.student.deleteMany({ where: { id: { in: cleanupStudentIds } } });
  }
  await prisma.auditLog.deleteMany({ where: { organizationId: ORG } });
  await prisma.promotionConfig.deleteMany({ where: { organizationId: ORG } });
  await prisma.beltRank.deleteMany({ where: { organizationId: ORG } });
  await prisma.academy.deleteMany({ where: { organizationId: ORG } });
  await prisma.organization.deleteMany({ where: { id: ORG } });
  await prisma.user.deleteMany({ where: { id: ACTOR_USER } });
});

describe("validateTrackConfig (pure)", () => {
  const validAttendanceRanks: RankForValidation[] = [
    rank({ id: "w", code: "WHITE", order: 1 }),
    rank({ id: "bl", code: "BLUE", order: 2 }),
    rank({ id: "pu", code: "PURPLE", order: 3 }),
    rank({ id: "br", code: "BROWN", order: 4 }),
    rank({ id: "bk", code: "BLACK", order: 5, isTerminal: true, maxStripes: 0, attendancesPerStripe: null, attendancesForExam: null, stripeColors: [] }),
  ];

  it("a valid 5-rank ATTENDANCE config produces no errors", () => {
    expect(validateTrackConfig(validAttendanceRanks, "ATTENDANCE")).toEqual([]);
  });

  it("flags a non-terminal rank missing attendancesPerStripe/attendancesForExam under ATTENDANCE mode", () => {
    const ranks = validAttendanceRanks.map((r) => (r.code === "BLUE" ? { ...r, attendancesPerStripe: null, attendancesForExam: null } : r));
    const errors = validateTrackConfig(ranks, "ATTENDANCE");
    expect(errors.some((e) => e.includes("BLUE") && e.includes("attendancesPerStripe"))).toBe(true);
    expect(errors.some((e) => e.includes("BLUE") && e.includes("attendancesForExam"))).toBe(true);
  });

  it("under TIME mode, flags missing monthsPerStripe/monthsForExam and does NOT require attendance fields", () => {
    const ranks = validAttendanceRanks.map((r) => (r.isTerminal ? r : { ...r, attendancesPerStripe: null, attendancesForExam: null }));
    const errors = validateTrackConfig(ranks, "TIME");
    expect(errors.some((e) => e.includes("monthsPerStripe"))).toBe(true);
    expect(errors.some((e) => e.includes("attendancesPerStripe"))).toBe(false);
  });

  it("MANUAL mode requires neither attendance nor time fields", () => {
    const ranks = validAttendanceRanks.map((r) => (r.isTerminal ? r : { ...r, attendancesPerStripe: null, attendancesForExam: null }));
    expect(validateTrackConfig(ranks, "MANUAL")).toEqual([]);
  });

  it("a terminal rank with real degrees (maxStripes > 0) still needs attendancesPerStripe, but never attendancesForExam", () => {
    const ranksWithDegreedBlack = validAttendanceRanks.map((r) =>
      r.isTerminal ? { ...r, maxStripes: 6, stripeColors: ["1", "2", "3", "4", "5", "6"] } : r,
    );
    // attendancesPerStripe still null (as validAttendanceRanks left BLACK) — now required, since BLACK has real degrees to progress through.
    const errors = validateTrackConfig(ranksWithDegreedBlack, "ATTENDANCE");
    expect(errors.some((e) => e.includes("BLACK") && e.includes("attendancesPerStripe"))).toBe(true);
    expect(errors.some((e) => e.includes("BLACK") && e.includes("attendancesForExam"))).toBe(false);

    // Once attendancesPerStripe is supplied, it validates clean — still no exam field required.
    const fixed = ranksWithDegreedBlack.map((r) => (r.isTerminal ? { ...r, attendancesPerStripe: 40 } : r));
    expect(validateTrackConfig(fixed, "ATTENDANCE")).toEqual([]);
  });

  it("a terminal rank with maxStripes 0 stays exempt from attendancesPerStripe too (nothing to progress through)", () => {
    // validAttendanceRanks' own BLACK fixture: maxStripes 0, attendancesPerStripe null.
    expect(validateTrackConfig(validAttendanceRanks, "ATTENDANCE").some((e) => e.includes("BLACK"))).toBe(false);
  });

  it("a terminal rank is exempt from the active mode's numeric requirements", () => {
    // validAttendanceRanks already has BLACK with null attendance fields and is valid under ATTENDANCE.
    expect(validateTrackConfig(validAttendanceRanks, "ATTENDANCE").some((e) => e.includes("BLACK"))).toBe(false);
  });

  it("flags duplicate order, non-contiguous order, and duplicate code", () => {
    const dupOrder = validAttendanceRanks.map((r) => (r.code === "BLUE" ? { ...r, order: 1 } : r));
    expect(validateTrackConfig(dupOrder, "ATTENDANCE").some((e) => e.includes("Duplicate rank order"))).toBe(true);

    const gapOrder = validAttendanceRanks.map((r) => (r.code === "BLUE" ? { ...r, order: 6 } : r));
    expect(validateTrackConfig(gapOrder, "ATTENDANCE").some((e) => e.includes("contiguous"))).toBe(true);

    const dupCode = validAttendanceRanks.map((r) => (r.code === "BLUE" ? { ...r, code: "WHITE" } : r));
    expect(validateTrackConfig(dupCode, "ATTENDANCE").some((e) => e.includes("Duplicate rank code"))).toBe(true);
  });

  it("flags a stripeColors length mismatch and a negative maxStripes", () => {
    const badColors = validAttendanceRanks.map((r) => (r.code === "BLUE" ? { ...r, stripeColors: ["only-one"] } : r));
    expect(validateTrackConfig(badColors, "ATTENDANCE").some((e) => e.includes("stripeColors"))).toBe(true);

    const negativeStripes = validAttendanceRanks.map((r) => (r.code === "BLUE" ? { ...r, maxStripes: -1 } : r));
    expect(validateTrackConfig(negativeStripes, "ATTENDANCE").some((e) => e.includes("maxStripes"))).toBe(true);
  });

  it("flags zero terminal ranks, more than one terminal rank, and a terminal rank that isn't highest-order", () => {
    const noTerminal = validAttendanceRanks.map((r) => (r.isTerminal ? { ...r, isTerminal: false, attendancesPerStripe: 1, attendancesForExam: 1 } : r));
    expect(validateTrackConfig(noTerminal, "ATTENDANCE").some((e) => e.includes("Exactly one rank must be isTerminal"))).toBe(true);

    const twoTerminal = validAttendanceRanks.map((r) => (r.code === "BROWN" ? { ...r, isTerminal: true } : r));
    expect(validateTrackConfig(twoTerminal, "ATTENDANCE").some((e) => e.includes("Exactly one rank must be isTerminal"))).toBe(true);

    const wrongTerminal = validAttendanceRanks.map((r) => {
      if (r.code === "BLACK") return { ...r, isTerminal: false, attendancesPerStripe: 1, attendancesForExam: 1 };
      if (r.code === "BROWN") return { ...r, isTerminal: true };
      return r;
    });
    expect(validateTrackConfig(wrongTerminal, "ATTENDANCE").some((e) => e.includes("highest-order"))).toBe(true);
  });
});

describe("updateTrackConfig", () => {
  it("throws TrackConfigError and writes nothing when the resulting config would be invalid", async () => {
    const before = await prisma.beltRank.findUniqueOrThrow({ where: { id: RANK_WHITE } });

    await expect(
      updateTrackConfig(ctx(), "ADULT", { ranks: [{ id: RANK_WHITE, attendancesPerStripe: 0 }] }),
    ).rejects.toThrow(TrackConfigError);

    const after = await prisma.beltRank.findUniqueOrThrow({ where: { id: RANK_WHITE } });
    expect(after.attendancesPerStripe).toBe(before.attendancesPerStripe);
  });

  it("refuses to reduce a rank's maxStripes below a student's current degree count, and writes nothing", async () => {
    const student = await makeStudent(RANK_BLUE, 3);
    const before = await prisma.beltRank.findUniqueOrThrow({ where: { id: RANK_BLUE } });

    await expect(
      updateTrackConfig(ctx(), "ADULT", {
        ranks: [{ id: RANK_BLUE, maxStripes: 1, stripeColors: ["b1"] }],
      }),
    ).rejects.toThrow(TrackConfigError);

    const after = await prisma.beltRank.findUniqueOrThrow({ where: { id: RANK_BLUE } });
    expect(after.maxStripes).toBe(before.maxStripes);
    const studentAfter = await prisma.student.findUniqueOrThrow({ where: { id: student.id } });
    expect(studentAfter.currentStripes).toBe(3);
  });

  it("a successful update writes the new values and an AuditLog row", async () => {
    const configBefore = await prisma.promotionConfig.findUniqueOrThrow({ where: { organizationId_track: { organizationId: ORG, track: "ADULT" } } });
    expect(configBefore.requiresCoachApproval).toBe(true);

    await updateTrackConfig(ctx(), "ADULT", { requiresCoachApproval: false });

    const configAfter = await prisma.promotionConfig.findUniqueOrThrow({ where: { organizationId_track: { organizationId: ORG, track: "ADULT" } } });
    expect(configAfter.requiresCoachApproval).toBe(false);

    const auditRows = await prisma.auditLog.findMany({ where: { organizationId: ORG, action: "promotion-config.update" } });
    expect(auditRows.length).toBeGreaterThan(0);
    const latest = auditRows[auditRows.length - 1];
    expect(latest.entityId).toBe(configAfter.id);
    expect(latest.actorId).toBe(ACTOR_USER);
    expect(latest.before).toMatchObject({ requiresCoachApproval: true });
    expect(latest.after).toMatchObject({ requiresCoachApproval: false });

    // restore, so later tests in this file see the seeded default
    await updateTrackConfig(ctx(), "ADULT", { requiresCoachApproval: true });
  });

  it("mode values are preserved across a mode switch: configure ATTENDANCE, switch to TIME, switch back, and the original ATTENDANCE numbers survive", async () => {
    const nonTerminalIds = [RANK_WHITE, RANK_BLUE, RANK_PURPLE, RANK_BROWN];
    const originalAttendance = new Map(
      (await prisma.beltRank.findMany({ where: { id: { in: nonTerminalIds } } })).map((r) => [
        r.id,
        { attendancesPerStripe: r.attendancesPerStripe, attendancesForExam: r.attendancesForExam },
      ]),
    );

    // Switch to TIME, supplying TIME fields — deliberately NOT touching the
    // attendance fields in this patch at all.
    await updateTrackConfig(ctx(), "ADULT", {
      mode: "TIME",
      ranks: nonTerminalIds.map((id) => ({ id, monthsPerStripe: 2, monthsForExam: 4 })),
    });

    const midway = await prisma.beltRank.findMany({ where: { id: { in: nonTerminalIds } } });
    for (const r of midway) {
      const original = originalAttendance.get(r.id)!;
      expect(r.attendancesPerStripe).toBe(original.attendancesPerStripe);
      expect(r.attendancesForExam).toBe(original.attendancesForExam);
      expect(r.monthsPerStripe).toBe(2);
      expect(r.monthsForExam).toBe(4);
    }
    const configMidway = await prisma.promotionConfig.findUniqueOrThrow({ where: { organizationId_track: { organizationId: ORG, track: "ADULT" } } });
    expect(configMidway.mode).toBe("TIME");

    // Switch back to ATTENDANCE with NO ranks patch — validation must pass
    // purely because the original attendance numbers were never erased.
    await updateTrackConfig(ctx(), "ADULT", { mode: "ATTENDANCE" });

    const restored = await prisma.beltRank.findMany({ where: { id: { in: nonTerminalIds } } });
    for (const r of restored) {
      const original = originalAttendance.get(r.id)!;
      expect(r.attendancesPerStripe).toBe(original.attendancesPerStripe);
      expect(r.attendancesForExam).toBe(original.attendancesForExam);
      // TIME fields from the midway step are themselves preserved too, not
      // nulled by switching back — same "nullable means never configured"
      // contract in the other direction.
      expect(r.monthsPerStripe).toBe(2);
      expect(r.monthsForExam).toBe(4);
    }
    const configAfter = await prisma.promotionConfig.findUniqueOrThrow({ where: { organizationId_track: { organizationId: ORG, track: "ADULT" } } });
    expect(configAfter.mode).toBe("ATTENDANCE");
  });
});
