import "dotenv/config";
import { getTestPrismaClient } from "../helpers/test-db";
import { afterAll, describe, expect, it } from "vitest";
import { requireEnv } from "../../src/lib/env";
import { digestLookupSecret } from "../../src/lib/crypto";
import { kidsRankId, adultRankId, type KidsBeltCode, type BeltCode } from "../helpers/belt-ranks";
import { getAtBeltSummary } from "../../src/lib/students/attendance-summary";
import { resolvePromotionConfigMap } from "../../src/lib/promotion/config";

const prisma = getTestPrismaClient();
const pepper = requireEnv("CODE_PEPPER");
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * MULTI_ACADEMY_AND_KIDS_BELTS.md Phase 3a — the 13-row Alliance kids
 * preset, exactly as the spec table lists it. The table's own `order`
 * column is 0-based; the real, enforced schema convention
 * (`validateTrackConfig`: "orders must be contiguous starting at 1") is
 * 1-based, so every expected `order` here is table-order + 1 — see
 * prisma/seed.ts's `KIDS_RANKS` doc comment for the same note.
 *
 * Revision 21 corrections asserted here: the third tape band is YELLOW on
 * every 11-degree rank regardless of the belt's own hue (never grey/orange/
 * green), and a `_white`/`_black` rank carries a `centerStripeColor` rather
 * than the old isSplit/splitColor pair.
 */
const TAPE_WHITE = "#FFFFFF";
const TAPE_RED = "#DC2626";
const TAPE_YELLOW = "#FACC15";
const CENTER_STRIPE_WHITE = "#F0EBE0";
const CENTER_STRIPE_BLACK = "#111116";
const TAPE_5 = [TAPE_WHITE, TAPE_WHITE, TAPE_WHITE, TAPE_WHITE, TAPE_RED];
const TAPE_11 = [TAPE_WHITE, TAPE_WHITE, TAPE_WHITE, TAPE_WHITE, TAPE_RED, TAPE_RED, TAPE_RED, TAPE_RED, TAPE_YELLOW, TAPE_YELLOW, TAPE_YELLOW];

const EXPECTED_RANKS: Array<{
  code: KidsBeltCode;
  order: number;
  labelEs: string;
  labelEn: string;
  maxStripes: number;
  isTerminal: boolean;
  stripeColors: string[];
  centerStripeColor: string | null;
}> = [
  { code: "white", order: 1, labelEs: "Blanco", labelEn: "White", maxStripes: 5, isTerminal: false, stripeColors: TAPE_5, centerStripeColor: null },
  { code: "grey_white", order: 2, labelEs: "Gris y Blanco", labelEn: "Grey-White", maxStripes: 5, isTerminal: false, stripeColors: TAPE_5, centerStripeColor: CENTER_STRIPE_WHITE },
  { code: "grey", order: 3, labelEs: "Gris", labelEn: "Grey", maxStripes: 11, isTerminal: false, stripeColors: TAPE_11, centerStripeColor: null },
  { code: "grey_black", order: 4, labelEs: "Gris y Negro", labelEn: "Grey-Black", maxStripes: 11, isTerminal: false, stripeColors: TAPE_11, centerStripeColor: CENTER_STRIPE_BLACK },
  { code: "yellow_white", order: 5, labelEs: "Amarillo y Blanco", labelEn: "Yellow-White", maxStripes: 11, isTerminal: false, stripeColors: TAPE_11, centerStripeColor: CENTER_STRIPE_WHITE },
  { code: "yellow", order: 6, labelEs: "Amarillo", labelEn: "Yellow", maxStripes: 11, isTerminal: false, stripeColors: TAPE_11, centerStripeColor: null },
  { code: "yellow_black", order: 7, labelEs: "Amarillo y Negro", labelEn: "Yellow-Black", maxStripes: 11, isTerminal: false, stripeColors: TAPE_11, centerStripeColor: CENTER_STRIPE_BLACK },
  { code: "orange_white", order: 8, labelEs: "Naranja y Blanco", labelEn: "Orange-White", maxStripes: 11, isTerminal: false, stripeColors: TAPE_11, centerStripeColor: CENTER_STRIPE_WHITE },
  { code: "orange", order: 9, labelEs: "Naranja", labelEn: "Orange", maxStripes: 11, isTerminal: false, stripeColors: TAPE_11, centerStripeColor: null },
  { code: "orange_black", order: 10, labelEs: "Naranja y Negro", labelEn: "Orange-Black", maxStripes: 11, isTerminal: false, stripeColors: TAPE_11, centerStripeColor: CENTER_STRIPE_BLACK },
  { code: "green_white", order: 11, labelEs: "Verde y Blanco", labelEn: "Green-White", maxStripes: 11, isTerminal: false, stripeColors: TAPE_11, centerStripeColor: CENTER_STRIPE_WHITE },
  { code: "green", order: 12, labelEs: "Verde", labelEn: "Green", maxStripes: 11, isTerminal: false, stripeColors: TAPE_11, centerStripeColor: null },
  { code: "green_black", order: 13, labelEs: "Verde y Negro", labelEn: "Green-Black", maxStripes: 11, isTerminal: true, stripeColors: TAPE_11, centerStripeColor: CENTER_STRIPE_BLACK },
];

let allianceOrgIdPromise: Promise<string> | null = null;
function getAllianceOrganizationId() {
  allianceOrgIdPromise ??= prisma.organization.findUniqueOrThrow({ where: { slug: "alliance-cr" } }).then((o) => o.id);
  return allianceOrgIdPromise;
}

describe("Kids belt catalog — row shape", () => {
  it("seeds all 13 KIDS ranks with the exact order, labels, maxStripes and isTerminal from the spec table", async () => {
    const organizationId = await getAllianceOrganizationId();
    const ranks = await prisma.beltRank.findMany({
      where: { organizationId, track: "KIDS" },
      orderBy: { order: "asc" },
    });
    expect(ranks).toHaveLength(13);
    ranks.forEach((rank, i) => {
      const expected = EXPECTED_RANKS[i]!;
      expect(rank.code).toBe(expected.code);
      expect(rank.order).toBe(expected.order);
      expect(rank.labelEs).toBe(expected.labelEs);
      expect(rank.labelEn).toBe(expected.labelEn);
      expect(rank.maxStripes).toBe(expected.maxStripes);
      expect(rank.isTerminal).toBe(expected.isTerminal);
      // Every kids rank uses the base-10 "Alliance kids rule", a different
      // scale from the adult thresholds (30/65/75/85) — this is the field
      // the math tests below actually exercise.
      expect(rank.attendancesPerStripe).toBe(10);
      expect(rank.attendancesForExam).toBe(10);
      expect(rank.stripeColors).toEqual(expected.stripeColors);
      expect(rank.centerStripeColor).toBe(expected.centerStripeColor);
      expect(rank.visibleStripeSlots).toBe(4);
    });
  });

  it("isTerminal is true on exactly one rank — the highest order (green_black) — never any other", async () => {
    const organizationId = await getAllianceOrganizationId();
    const ranks = await prisma.beltRank.findMany({ where: { organizationId, track: "KIDS" } });
    const terminal = ranks.filter((r) => r.isTerminal);
    expect(terminal).toHaveLength(1);
    expect(terminal[0]!.code).toBe("green_black");
  });
});

/**
 * Revision 21: "adult tapes are white" — white on every degree, on every
 * adult rank, never the belt's own colour. Hardcoded exact hex per rank
 * rather than a shared constant compared against itself, so a seed bug
 * that derives tape colour from the belt (or that only fixes stripeColors
 * on row creation, never on an update to an existing row — the actual bug
 * found twice on this catalog) fails this test instead of passing it
 * vacuously.
 */
const EXPECTED_ADULT_STRIPE_COLORS: Record<BeltCode, string[]> = {
  WHITE: ["#FFFFFF", "#FFFFFF", "#FFFFFF", "#FFFFFF"],
  BLUE: ["#FFFFFF", "#FFFFFF", "#FFFFFF", "#FFFFFF"],
  PURPLE: ["#FFFFFF", "#FFFFFF", "#FFFFFF", "#FFFFFF"],
  BROWN: ["#FFFFFF", "#FFFFFF", "#FFFFFF", "#FFFFFF"],
  // Terminal, time-based, six configured degrees (36/36/36/60/60/60 months) - a white tape per degree.
  BLACK: ["#FFFFFF", "#FFFFFF", "#FFFFFF", "#FFFFFF", "#FFFFFF", "#FFFFFF"],
};

describe("Adult belt catalog — tape colours are white, never the belt's own colour", () => {
  it.each(Object.entries(EXPECTED_ADULT_STRIPE_COLORS) as Array<[BeltCode, string[]]>)(
    "%s has the exact expected stripeColors",
    async (code, expectedStripeColors) => {
      const rank = await prisma.beltRank.findUniqueOrThrow({ where: { id: adultRankId(code) } });
      expect(rank.stripeColors).toEqual(expectedStripeColors);
    },
  );
});

describe("Kids belt catalog — the math is genuinely base-10, not adult-shaped", () => {
  const cleanupStudentIds: string[] = [];
  afterAll(async () => {
    if (cleanupStudentIds.length === 0) return;
    await prisma.attendanceRecord.deleteMany({ where: { studentId: { in: cleanupStudentIds } } });
    await prisma.student.deleteMany({ where: { id: { in: cleanupStudentIds } } });
  });

  async function makeKidsStudent(belt: KidsBeltCode, currentStripes: number, beltAwardedAt: Date) {
    const organizationId = await getAllianceOrganizationId();
    const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
    const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
    const student = await prisma.student.create({
      data: {
        homeAcademyId: escazu.id,
        organizationId,
        track: "KIDS",
        firstName: "KidsCatalogMathTest",
        lastName: `Student-${suffix}`,
        phone: "88880000",
        email: `kids-catalog-math-${suffix}@example.com`,
        currentRankId: kidsRankId(belt),
        currentStripes,
        beltAwardedAt,
        codeHash: digestLookupSecret(`kids-catalog-math-${suffix}`, pepper),
        status: "ACTIVE",
      },
    });
    cleanupStudentIds.push(student.id);
    return student;
  }

  async function addAttendances(studentId: string, count: number, startAt: Date) {
    if (count === 0) return;
    const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
    const organizationId = await getAllianceOrganizationId();
    await prisma.attendanceRecord.createMany({
      data: Array.from({ length: count }, (_, i) => {
        const occurredAt = new Date(startAt.getTime() + i * DAY_MS);
        return {
          studentId,
          academyId: escazu.id,
          organizationId,
          occurredAt,
          date: occurredAt,
          type: "CHECKIN" as const,
          delta: 1,
          source: "STAFF" as const,
        };
      }),
    });
  }

  it("a grey belt (degree 10) needs exactly 110 cumulative attendances for degree 11 — 109 is not enough, 110 is", async () => {
    const organizationId = await getAllianceOrganizationId();
    const configByTrack = await resolvePromotionConfigMap(organizationId);
    const beltAwardedAt = new Date("2026-01-01T12:00:00Z");

    const notYet = await makeKidsStudent("grey", 10, beltAwardedAt);
    await addAttendances(notYet.id, 109, new Date(beltAwardedAt.getTime() + DAY_MS));
    const notYetSummary = await getAtBeltSummary(notYet.id, notYet.organizationId, configByTrack);
    expect(notYetSummary.nextTarget).toBe("STRIPE");
    expect(notYetSummary.isEligible).toBe(false);
    expect(notYetSummary.remainingAttendance).toBe(1);

    const exactly = await makeKidsStudent("grey", 10, beltAwardedAt);
    await addAttendances(exactly.id, 110, new Date(beltAwardedAt.getTime() + DAY_MS));
    const exactlySummary = await getAtBeltSummary(exactly.id, exactly.organizationId, configByTrack);
    expect(exactlySummary.nextTarget).toBe("STRIPE");
    expect(exactlySummary.isEligible).toBe(true);
    expect(exactlySummary.remainingAttendance).toBe(0);
  });

  it("a grey belt at degree 11 (maxStripes) needs cumulative 120 attendances for the grey-black belt — proves the +10 'extra belt requirement' scales at base-10, not base-30 like adults", async () => {
    const organizationId = await getAllianceOrganizationId();
    const configByTrack = await resolvePromotionConfigMap(organizationId);
    const beltAwardedAt = new Date("2026-02-01T12:00:00Z");

    const notYet = await makeKidsStudent("grey", 11, beltAwardedAt);
    await addAttendances(notYet.id, 119, new Date(beltAwardedAt.getTime() + DAY_MS));
    const notYetSummary = await getAtBeltSummary(notYet.id, notYet.organizationId, configByTrack);
    expect(notYetSummary.nextTarget).toBe("BELT");
    expect(notYetSummary.isEligible).toBe(false);
    expect(notYetSummary.remainingAttendance).toBe(1);

    const exactly = await makeKidsStudent("grey", 11, beltAwardedAt);
    await addAttendances(exactly.id, 120, new Date(beltAwardedAt.getTime() + DAY_MS));
    const exactlySummary = await getAtBeltSummary(exactly.id, exactly.organizationId, configByTrack);
    expect(exactlySummary.nextTarget).toBe("BELT");
    expect(exactlySummary.isEligible).toBe(true);
    // null, not 0 — an exam-eligible candidate has nothing left to project
    // toward (dashboard/page.tsx's own convention for this case).
    expect(exactlySummary.remainingAttendance).toBeNull();
  });

  it("a maxed-out green-black kid (the terminal rank) never reports BELT — the terminal amendment caps it at NONE even though it still has real degrees", async () => {
    const organizationId = await getAllianceOrganizationId();
    const configByTrack = await resolvePromotionConfigMap(organizationId);
    const beltAwardedAt = new Date("2026-03-01T12:00:00Z");

    const student = await makeKidsStudent("green_black", 11, beltAwardedAt);
    await addAttendances(student.id, 120, new Date(beltAwardedAt.getTime() + DAY_MS));
    const summary = await getAtBeltSummary(student.id, student.organizationId, configByTrack);
    expect(summary.nextTarget).toBe("NONE");
  });
});
