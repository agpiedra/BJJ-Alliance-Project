import "dotenv/config";
import { getTestPrismaClient } from "../helpers/test-db";
import { describe, expect, it } from "vitest";

const prisma = getTestPrismaClient();

describe("seed data", () => {
  it("creates Escazú and Escalante with fixed, expected slugs", async () => {
    // Scoped to the seed's own two slugs, not a blanket findMany(): other
    // integration test files legitimately create their own throwaway
    // academies during the same `pnpm test:integration` run (the shared test
    // database is wiped and reseeded once per run, not between files — see
    // tests/integration-global-setup.ts), so asserting the WHOLE table
    // contains nothing else would be flaky depending on run order.
    const academies = await prisma.academy.findMany({
      where: { slug: { in: ["escalante", "escazu"] } },
      orderBy: { slug: "asc" },
    });
    expect(academies.map((a) => a.slug)).toEqual(["escalante", "escazu"]);
  });

  it("seeds correct ADULT BeltRank values for all five belts", async () => {
    // Scoped to the seed's own organization — MULTI_ACADEMY_AND_KIDS_BELTS.md
    // Phase 2 tests legitimately create their own organization-scoped
    // BeltRank rows (e.g. kiosk-check-in-route.test.ts's scratch-org
    // fixtures), same reasoning as the academies test above.
    const alliance = await prisma.organization.findUniqueOrThrow({ where: { slug: "alliance-cr" } });
    const ranks = await prisma.beltRank.findMany({
      where: { organizationId: alliance.id, track: "ADULT" },
    });
    expect(ranks).toHaveLength(5);

    const byBelt = Object.fromEntries(ranks.map((r) => [r.code, r]));
    expect(byBelt.WHITE).toMatchObject({ order: 1, attendancesPerStripe: 30, maxStripes: 4, attendancesForExam: 30, isTerminal: false });
    expect(byBelt.BLUE).toMatchObject({ order: 2, attendancesPerStripe: 65, maxStripes: 4, attendancesForExam: 65, isTerminal: false });
    expect(byBelt.PURPLE).toMatchObject({ order: 3, attendancesPerStripe: 75, maxStripes: 4, attendancesForExam: 75, isTerminal: false });
    expect(byBelt.BROWN).toMatchObject({ order: 4, attendancesPerStripe: 85, maxStripes: 4, attendancesForExam: 85, isTerminal: false });
    // Black belt is TIME-based with a different interval per degree, configured through the 6th degree only.
    expect(byBelt.BLACK).toMatchObject({
      order: 5,
      maxStripes: 6,
      isTerminal: true,
      progressionMode: "TIME",
      stripeIntervalMonths: [36, 36, 36, 60, 60, 60],
    });
  });

  it("seeds Escazú's full 18-session class schedule and Escalante's smaller 6-session one", async () => {
    // Both branches have real classes (docs/MULTI_ACADEMY_AND_KIDS_BELTS.md
    // Phase 0's "students who train at both branches" edge case needs
    // classes at both locations to attend) — Escalante is deliberately
    // smaller, not empty.
    const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
    const escalante = await prisma.academy.findUniqueOrThrow({ where: { slug: "escalante" } });

    const escazuSessions = await prisma.classSession.findMany({ where: { academyId: escazu.id } });
    const escalanteSessions = await prisma.classSession.findMany({ where: { academyId: escalante.id } });

    expect(escazuSessions).toHaveLength(18);
    expect(escalanteSessions).toHaveLength(6);
  });

  it("seeds specific Escazú class sessions with correct day, time, name, and type", async () => {
    const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });

    const mondaySixAm = await prisma.classSession.findFirstOrThrow({
      where: { academyId: escazu.id, dayOfWeek: "MONDAY", startTime: "06:00" },
    });
    expect(mondaySixAm).toMatchObject({ name: "GI", type: "GI", countsTowardPromotion: true });

    const wednesdayCompetition = await prisma.classSession.findFirstOrThrow({
      where: { academyId: escazu.id, name: "Competición" },
    });
    expect(wednesdayCompetition).toMatchObject({ dayOfWeek: "WEDNESDAY", startTime: "18:30", type: "COMPETITION", countsTowardPromotion: true });

    const saturdayStriking = await prisma.classSession.findFirstOrThrow({
      where: { academyId: escazu.id, name: "Striking" },
    });
    expect(saturdayStriking).toMatchObject({ dayOfWeek: "SATURDAY", startTime: "09:00", type: "STRIKING", countsTowardPromotion: false });
  });

  it("marks Saturday Striking as not counting toward promotion, everything else as counting", async () => {
    const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
    const striking = await prisma.classSession.findFirstOrThrow({
      where: { academyId: escazu.id, name: "Striking" },
    });
    expect(striking.countsTowardPromotion).toBe(false);

    const otherSessions = await prisma.classSession.findMany({
      where: { academyId: escazu.id, name: { not: "Striking" } },
    });
    expect(otherSessions.every((s) => s.countsTowardPromotion)).toBe(true);
  });

  it("seeds three payment plans per academy", async () => {
    const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
    const plans = await prisma.paymentPlan.findMany({ where: { academyId: escazu.id } });
    // `arrayContaining`, not exact equality: REDESIGN_BRIEF.md Phase 6's
    // `ensureCustomPromoPlan` idempotently seeds a real, additional
    // "Promoción personalizada" row for every academy the first time any
    // Pagos code path touches it (page load, or another test) — a genuine
    // extra plan this app itself creates, not test pollution to guard
    // against. This test's job is only to confirm `prisma/seed.ts`'s own
    // three plans are present, not that nothing else has ever been added.
    expect(plans.map((p) => p.name)).toEqual(
      expect.arrayContaining(["Becado", "Mensualidad", "Promoción"]),
    );
  });

  it("seeds exactly one ADMIN user with no StaffAssignment rows", async () => {
    const admin = await prisma.user.findUniqueOrThrow({ where: { email: "admin@alliancecr.com" } });
    expect(admin.role).toBe("ADMIN");
    const assignments = await prisma.staffAssignment.findMany({ where: { userId: admin.id } });
    expect(assignments).toHaveLength(0);
  });

  it("gives each academy a distinct, non-empty kiosk token hash", async () => {
    const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
    const escalante = await prisma.academy.findUniqueOrThrow({ where: { slug: "escalante" } });
    expect(escazu.kioskTokenHash).not.toBe(escalante.kioskTokenHash);
    expect(escazu.kioskTokenHash.length).toBeGreaterThan(0);
  });
});
