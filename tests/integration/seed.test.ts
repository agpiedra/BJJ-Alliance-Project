import "dotenv/config";
import { describe, expect, it } from "vitest";
import { PrismaClient } from "../../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
const prisma = new PrismaClient({ adapter });

describe("seed data", () => {
  it("creates exactly two academies: Escazú and Escalante", async () => {
    const academies = await prisma.academy.findMany({ orderBy: { slug: "asc" } });
    expect(academies.map((a) => a.slug)).toEqual(["escalante", "escazu"]);
  });

  it("seeds correct global BeltRequirement values for all five belts", async () => {
    const requirements = await prisma.beltRequirement.findMany({ where: { academyId: null } });
    expect(requirements).toHaveLength(5);

    const byBelt = Object.fromEntries(requirements.map((r) => [r.belt, r]));
    expect(byBelt.WHITE).toMatchObject({ attendancesPerStripe: 30, maxStripes: 4, attendancesForExam: 30 });
    expect(byBelt.BLUE).toMatchObject({ attendancesPerStripe: 65, maxStripes: 4, attendancesForExam: 65 });
    expect(byBelt.PURPLE).toMatchObject({ attendancesPerStripe: 75, maxStripes: 4, attendancesForExam: 75 });
    expect(byBelt.BROWN).toMatchObject({ attendancesPerStripe: 85, maxStripes: 4, attendancesForExam: 85 });
    expect(byBelt.BLACK).toMatchObject({ attendancesPerStripe: 0, maxStripes: 0, attendancesForExam: 0 });
  });

  it("seeds Escazú's full 18-session class schedule and leaves Escalante empty", async () => {
    const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
    const escalante = await prisma.academy.findUniqueOrThrow({ where: { slug: "escalante" } });

    const escazuSessions = await prisma.classSession.findMany({ where: { academyId: escazu.id } });
    const escalanteSessions = await prisma.classSession.findMany({ where: { academyId: escalante.id } });

    expect(escazuSessions).toHaveLength(18);
    expect(escalanteSessions).toHaveLength(0);
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
    expect(plans.map((p) => p.name).sort()).toEqual(["Becado", "Mensualidad", "Promoción"].sort());
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
