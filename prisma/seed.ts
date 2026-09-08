import "dotenv/config";
import { PrismaClient, Role } from "../src/generated/prisma/client";
import type { Belt, ClassType, DayOfWeek } from "../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { generateRandomToken, hashSecret } from "../src/lib/crypto";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
const prisma = new PrismaClient({ adapter });

const BELT_REQUIREMENTS: Array<{
  belt: Belt;
  attendancesPerStripe: number;
  maxStripes: number;
  attendancesForExam: number;
}> = [
  { belt: "WHITE", attendancesPerStripe: 30, maxStripes: 4, attendancesForExam: 30 },
  { belt: "BLUE", attendancesPerStripe: 65, maxStripes: 4, attendancesForExam: 65 },
  { belt: "PURPLE", attendancesPerStripe: 75, maxStripes: 4, attendancesForExam: 75 },
  { belt: "BROWN", attendancesPerStripe: 85, maxStripes: 4, attendancesForExam: 85 },
  { belt: "BLACK", attendancesPerStripe: 0, maxStripes: 0, attendancesForExam: 0 },
];

const ESCAZU_SCHEDULE: Array<{
  dayOfWeek: DayOfWeek;
  startTime: string;
  durationMinutes: number;
  name: string;
  type: ClassType;
  countsTowardPromotion: boolean;
}> = [
  { dayOfWeek: "MONDAY", startTime: "06:00", durationMinutes: 60, name: "GI", type: "GI", countsTowardPromotion: true },
  { dayOfWeek: "MONDAY", startTime: "12:00", durationMinutes: 60, name: "NO-GI", type: "NO_GI", countsTowardPromotion: true },
  { dayOfWeek: "MONDAY", startTime: "18:00", durationMinutes: 60, name: "GI — Principiantes", type: "GI", countsTowardPromotion: true },
  { dayOfWeek: "MONDAY", startTime: "19:00", durationMinutes: 60, name: "GI — Avanzados", type: "GI", countsTowardPromotion: true },
  { dayOfWeek: "TUESDAY", startTime: "12:00", durationMinutes: 60, name: "GI", type: "GI", countsTowardPromotion: true },
  { dayOfWeek: "TUESDAY", startTime: "18:00", durationMinutes: 60, name: "NO-GI — Todos los niveles", type: "NO_GI", countsTowardPromotion: true },
  { dayOfWeek: "TUESDAY", startTime: "19:00", durationMinutes: 60, name: "GI — Todos los niveles", type: "GI", countsTowardPromotion: true },
  { dayOfWeek: "WEDNESDAY", startTime: "06:00", durationMinutes: 60, name: "GI", type: "GI", countsTowardPromotion: true },
  { dayOfWeek: "WEDNESDAY", startTime: "12:00", durationMinutes: 60, name: "NO-GI", type: "NO_GI", countsTowardPromotion: true },
  { dayOfWeek: "WEDNESDAY", startTime: "18:30", durationMinutes: 60, name: "Competición", type: "COMPETITION", countsTowardPromotion: true },
  { dayOfWeek: "THURSDAY", startTime: "12:00", durationMinutes: 60, name: "GI", type: "GI", countsTowardPromotion: true },
  { dayOfWeek: "THURSDAY", startTime: "18:00", durationMinutes: 60, name: "NO-GI — Todos los niveles", type: "NO_GI", countsTowardPromotion: true },
  { dayOfWeek: "THURSDAY", startTime: "19:00", durationMinutes: 60, name: "GI — Todos los niveles", type: "GI", countsTowardPromotion: true },
  { dayOfWeek: "FRIDAY", startTime: "12:00", durationMinutes: 60, name: "NO-GI", type: "NO_GI", countsTowardPromotion: true },
  { dayOfWeek: "FRIDAY", startTime: "18:30", durationMinutes: 60, name: "GI — Todos los niveles", type: "GI", countsTowardPromotion: true },
  { dayOfWeek: "SATURDAY", startTime: "09:00", durationMinutes: 60, name: "Striking", type: "STRIKING", countsTowardPromotion: false },
  { dayOfWeek: "SATURDAY", startTime: "10:00", durationMinutes: 60, name: "Kids", type: "KIDS", countsTowardPromotion: true },
  { dayOfWeek: "SATURDAY", startTime: "11:00", durationMinutes: 60, name: "Open Mat", type: "OPEN_MAT", countsTowardPromotion: true },
];

const PAYMENT_PLAN_NAMES = ["Mensualidad", "Promoción", "Becado"] as const;

const ADMIN_EMAIL = "admin@alliancecr.com";

async function main() {
  const escazu = await prisma.academy.upsert({
    where: { slug: "escazu" },
    update: {},
    create: {
      name: "Alliance Escazú",
      slug: "escazu",
      timezone: "America/Costa_Rica",
      kioskTokenHash: await hashSecret(generateRandomToken()),
    },
  });

  const escalante = await prisma.academy.upsert({
    where: { slug: "escalante" },
    update: {},
    create: {
      name: "Alliance Escalante",
      slug: "escalante",
      timezone: "America/Costa_Rica",
      kioskTokenHash: await hashSecret(generateRandomToken()),
    },
  });

  for (const requirement of BELT_REQUIREMENTS) {
    const existingRequirement = await prisma.beltRequirement.findFirst({
      where: { academyId: null, belt: requirement.belt },
    });
    if (existingRequirement) {
      await prisma.beltRequirement.update({
        where: { id: existingRequirement.id },
        data: requirement,
      });
    } else {
      await prisma.beltRequirement.create({
        data: { academyId: null, ...requirement },
      });
    }
  }

  for (const session of ESCAZU_SCHEDULE) {
    await prisma.classSession.upsert({
      where: {
        academyId_dayOfWeek_startTime_name: {
          academyId: escazu.id,
          dayOfWeek: session.dayOfWeek,
          startTime: session.startTime,
          name: session.name,
        },
      },
      update: {
        durationMinutes: session.durationMinutes,
        type: session.type,
        countsTowardPromotion: session.countsTowardPromotion,
      },
      create: { academyId: escazu.id, ...session },
    });
  }

  for (const academy of [escazu, escalante]) {
    for (const name of PAYMENT_PLAN_NAMES) {
      await prisma.paymentPlan.upsert({
        where: { academyId_name: { academyId: academy.id, name } },
        update: {},
        create: { academyId: academy.id, name },
      });
    }
  }

  const existingAdmin = await prisma.user.findUnique({ where: { email: ADMIN_EMAIL } });
  if (!existingAdmin) {
    const tempPassword = generateRandomToken(9);
    await prisma.user.create({
      data: {
        email: ADMIN_EMAIL,
        passwordHash: await hashSecret(tempPassword),
        role: Role.ADMIN,
        locale: "es",
      },
    });
    console.log("=".repeat(60));
    console.log(`Admin account created: ${ADMIN_EMAIL}`);
    console.log(`Temporary password: ${tempPassword}`);
    console.log("Change this password after first login.");
    console.log("=".repeat(60));
  } else {
    console.log(`Admin account ${ADMIN_EMAIL} already exists — skipped.`);
  }

  console.log("Seed complete.");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
