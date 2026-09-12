import "dotenv/config";
import { afterAll, describe, expect, it } from "vitest";
import { PrismaClient } from "../../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { requireEnv } from "../../src/lib/env";
import { digestLookupSecret, hashSecret } from "../../src/lib/crypto";
import { ensureCustomPromoPlan } from "../../src/lib/payments/ensure-custom-promo-plan";

const { getCurrentPaymentPeriod } = await import("../../src/lib/payments/get-current-period");

const adapter = new PrismaPg({ connectionString: requireEnv("DATABASE_URL") });
const prisma = new PrismaClient({ adapter });
const pepper = requireEnv("CODE_PEPPER");

const cleanupStudentIds: string[] = [];
const cleanupUserIds: string[] = [];

async function cleanup() {
  if (cleanupStudentIds.length > 0) {
    await prisma.paymentPeriod.deleteMany({ where: { studentId: { in: cleanupStudentIds } } });
    await prisma.student.deleteMany({ where: { id: { in: cleanupStudentIds } } });
  }
  if (cleanupUserIds.length > 0) {
    await prisma.user.deleteMany({ where: { id: { in: cleanupUserIds } } });
  }
}

async function makeStaffUser(label: string) {
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
  const user = await prisma.user.create({
    data: { email: `${label}-${suffix}@example.com`, passwordHash: await hashSecret("irrelevant-123"), role: "ADMIN" },
  });
  cleanupUserIds.push(user.id);
  return user;
}

async function makeStudent(academyId: string) {
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
  const student = await prisma.student.create({
    data: {
      homeAcademyId: academyId,
      firstName: "CarryForwardTest",
      lastName: `Student-${suffix}`,
      phone: "88880000",
      email: `carry-forward-${suffix}@example.com`,
      status: "ACTIVE",
      codeHash: digestLookupSecret(`carry-forward-${suffix}`, pepper),
    },
  });
  cleanupStudentIds.push(student.id);
  return student;
}

describe("getCurrentPaymentPeriod — recurring custom-promotion carry-forward", () => {
  afterAll(cleanup);

  it("materializes THIS month's row from last month's recurring custom promotion, carrying its terms forward", async () => {
    const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
    const promoPlan = await ensureCustomPromoPlan(escazu.id);
    const director = await makeStaffUser("carry-forward-director");
    const student = await makeStudent(escazu.id);

    // August: a recurring, fully-waived custom promotion.
    await prisma.paymentPeriod.create({
      data: {
        studentId: student.id,
        academyId: escazu.id,
        year: 2026,
        month: 8,
        planId: promoPlan.id,
        status: "PROMO",
        amount: 0,
        promoName: "Beca competidor",
        promoReason: "Compite por la academia",
        promoRecurring: true,
        recordedById: director.id,
      },
    });

    // September has no row of its own yet.
    const before = await prisma.paymentPeriod.findUnique({
      where: { studentId_year_month: { studentId: student.id, year: 2026, month: 9 } },
    });
    expect(before).toBeNull();

    const current = await getCurrentPaymentPeriod(student.id, { year: 2026, month: 9 });
    expect(current).not.toBeNull();
    expect(current).toMatchObject({
      year: 2026,
      month: 9,
      status: "PROMO",
      planName: "Promoción personalizada",
      amount: 0,
      promoName: "Beca competidor",
      promoReason: "Compite por la academia",
      promoRecurring: true,
      recordedById: director.id,
    });

    // Materialized as a REAL row, not synthesized on every call — a second
    // read must not create a second row.
    const materialized = await prisma.paymentPeriod.findUnique({
      where: { studentId_year_month: { studentId: student.id, year: 2026, month: 9 } },
    });
    expect(materialized).not.toBeNull();

    const again = await getCurrentPaymentPeriod(student.id, { year: 2026, month: 9 });
    expect(again?.id).toBe(current?.id);
    const count = await prisma.paymentPeriod.count({ where: { studentId: student.id, year: 2026, month: 9 } });
    expect(count).toBe(1);
  });

  it("does NOT carry forward a NON-recurring custom promotion", async () => {
    const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
    const promoPlan = await ensureCustomPromoPlan(escazu.id);
    const director = await makeStaffUser("carry-forward-nonrecurring-director");
    const student = await makeStudent(escazu.id);

    await prisma.paymentPeriod.create({
      data: {
        studentId: student.id,
        academyId: escazu.id,
        year: 2026,
        month: 8,
        planId: promoPlan.id,
        status: "PROMO",
        amount: 0,
        promoName: "Beca de un mes",
        promoRecurring: false,
        recordedById: director.id,
      },
    });

    const current = await getCurrentPaymentPeriod(student.id, { year: 2026, month: 9 });
    expect(current).toBeNull();
  });

  it("does NOT carry forward a recurring row on an ORDINARY (non-custom-promo) plan", async () => {
    const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
    const mensualidad = await prisma.paymentPlan.findFirstOrThrow({
      where: { academyId: escazu.id, name: "Mensualidad" },
    });
    const director = await makeStaffUser("carry-forward-ordinary-director");
    const student = await makeStudent(escazu.id);

    // promoRecurring on a non-custom-promo plan should never happen via the
    // real form, but the query must not carry it forward even if it did.
    await prisma.paymentPeriod.create({
      data: {
        studentId: student.id,
        academyId: escazu.id,
        year: 2026,
        month: 8,
        planId: mensualidad.id,
        status: "PAID",
        amount: 45000,
        promoRecurring: true,
        recordedById: director.id,
      },
    });

    const current = await getCurrentPaymentPeriod(student.id, { year: 2026, month: 9 });
    expect(current).toBeNull();
  });

  it("a real row for the current month always wins over any carry-forward candidate", async () => {
    const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
    const promoPlan = await ensureCustomPromoPlan(escazu.id);
    const mensualidad = await prisma.paymentPlan.findFirstOrThrow({
      where: { academyId: escazu.id, name: "Mensualidad" },
    });
    const director = await makeStaffUser("carry-forward-override-director");
    const student = await makeStudent(escazu.id);

    await prisma.paymentPeriod.create({
      data: {
        studentId: student.id,
        academyId: escazu.id,
        year: 2026,
        month: 8,
        planId: promoPlan.id,
        status: "PROMO",
        amount: 0,
        promoName: "Beca competidor",
        promoRecurring: true,
        recordedById: director.id,
      },
    });
    // September was recorded normally (e.g. the promo was cancelled and a
    // real mensualidad collected instead).
    await prisma.paymentPeriod.create({
      data: {
        studentId: student.id,
        academyId: escazu.id,
        year: 2026,
        month: 9,
        planId: mensualidad.id,
        status: "PAID",
        amount: 45000,
        recordedById: director.id,
      },
    });

    const current = await getCurrentPaymentPeriod(student.id, { year: 2026, month: 9 });
    expect(current?.status).toBe("PAID");
    expect(current?.planName).toBe("Mensualidad");
  });

  it("handles the January -> previous December rollover when looking up the prior month", async () => {
    const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
    const promoPlan = await ensureCustomPromoPlan(escazu.id);
    const director = await makeStaffUser("carry-forward-rollover-director");
    const student = await makeStudent(escazu.id);

    await prisma.paymentPeriod.create({
      data: {
        studentId: student.id,
        academyId: escazu.id,
        year: 2025,
        month: 12,
        planId: promoPlan.id,
        status: "PROMO",
        amount: 0,
        promoName: "Beca de fin de año",
        promoRecurring: true,
        recordedById: director.id,
      },
    });

    const current = await getCurrentPaymentPeriod(student.id, { year: 2026, month: 1 });
    expect(current?.promoName).toBe("Beca de fin de año");
  });
});
