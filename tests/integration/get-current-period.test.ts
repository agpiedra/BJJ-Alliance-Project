import "dotenv/config";
import { afterAll, describe, expect, it } from "vitest";
import { PrismaClient } from "../../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { requireEnv } from "../../src/lib/env";
import { digestLookupSecret, hashSecret } from "../../src/lib/crypto";
import { ensureCustomPromoPlan } from "../../src/lib/payments/ensure-custom-promo-plan";

const { getCurrentPaymentPeriod, getCurrentPaymentPeriodsForStudents } = await import(
  "../../src/lib/payments/get-current-period"
);

const adapter = new PrismaPg({ connectionString: requireEnv("DATABASE_URL") });
const prisma = new PrismaClient({ adapter });
const pepper = requireEnv("CODE_PEPPER");

const cleanupStudentIds: string[] = [];
const cleanupUserIds: string[] = [];

async function cleanup() {
  // The carry-forward materializer (`payment.carryForward`) writes real
  // AuditLog rows attributed to the recurring promo's original recorder —
  // those must go before the User rows they reference, same FK-ordering
  // discipline `payment-actions.test.ts`'s own cleanup already follows.
  if (cleanupUserIds.length > 0) {
    await prisma.auditLog.deleteMany({ where: { actorId: { in: cleanupUserIds } } });
  }
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

  // Reviewer finding HIGH-1: the carried-forward TERMS (plan/amount/promo
  // fields) must repeat unconditionally, but "was this month actually
  // paid" must not — a recurring PAID period with a real, non-zero agreed
  // amount means someone collected it ONE month, not that every future
  // month is pre-paid.
  it("a recurring PAID promo with a REAL amount > 0 materializes as PENDING next month, not PAID", async () => {
    const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
    const promoPlan = await ensureCustomPromoPlan(escazu.id);
    const director = await makeStaffUser("carry-forward-realpaid-director");
    const student = await makeStudent(escazu.id);

    // August: a discounted-but-real recurring arrangement, actually paid.
    await prisma.paymentPeriod.create({
      data: {
        studentId: student.id,
        academyId: escazu.id,
        year: 2026,
        month: 8,
        planId: promoPlan.id,
        status: "PAID",
        amount: 22500,
        promoName: "2x1 hermanos",
        promoRecurring: true,
        recordedById: director.id,
      },
    });

    const current = await getCurrentPaymentPeriod(student.id, { year: 2026, month: 9 });
    expect(current?.status).toBe("PENDING");
    // The TERMS still carry forward even though "paid" does not.
    expect(current?.amount).toBe(22500);
    expect(current?.promoName).toBe("2x1 hermanos");
    expect(current?.promoRecurring).toBe(true);
  });

  it("a recurring PAID promo with amount 0 (a full waiver recorded as paid) still carries forward as PAID", async () => {
    const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
    const promoPlan = await ensureCustomPromoPlan(escazu.id);
    const director = await makeStaffUser("carry-forward-paidzero-director");
    const student = await makeStudent(escazu.id);

    await prisma.paymentPeriod.create({
      data: {
        studentId: student.id,
        academyId: escazu.id,
        year: 2026,
        month: 8,
        planId: promoPlan.id,
        status: "PAID",
        amount: 0,
        promoName: "Beca completa",
        promoRecurring: true,
        recordedById: director.id,
      },
    });

    const current = await getCurrentPaymentPeriod(student.id, { year: 2026, month: 9 });
    expect(current?.status).toBe("PAID");
  });

  it("materializing writes an AuditLog row (payment.carryForward), but a second read does not write another", async () => {
    const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
    const promoPlan = await ensureCustomPromoPlan(escazu.id);
    const director = await makeStaffUser("carry-forward-audit-director");
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

    const current = await getCurrentPaymentPeriod(student.id, { year: 2026, month: 9 });
    await getCurrentPaymentPeriod(student.id, { year: 2026, month: 9 });

    const audits = await prisma.auditLog.findMany({
      where: { entityType: "PaymentPeriod", entityId: current!.id, action: "payment.carryForward" },
    });
    expect(audits).toHaveLength(1);
    expect(audits[0].actorId).toBe(director.id);
    expect(audits[0].before).toBeNull();
    expect(audits[0].after).toMatchObject({ status: "PROMO", promoRecurring: true });
  });

  // Reviewer finding MEDIUM-2: a single skipped month (nobody happened to
  // query that gap) must not permanently kill a recurring promo.
  it("carries forward across a GAP of more than one month with no rows in between", async () => {
    const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
    const promoPlan = await ensureCustomPromoPlan(escazu.id);
    const director = await makeStaffUser("carry-forward-gap-director");
    const student = await makeStudent(escazu.id);

    // June: recurring promo. July and August: nobody ever queried this
    // student's period, so neither month has a row. September: first query.
    await prisma.paymentPeriod.create({
      data: {
        studentId: student.id,
        academyId: escazu.id,
        year: 2026,
        month: 6,
        planId: promoPlan.id,
        status: "PROMO",
        amount: 0,
        promoName: "Beca de verano",
        promoRecurring: true,
        recordedById: director.id,
      },
    });

    const current = await getCurrentPaymentPeriod(student.id, { year: 2026, month: 9 });
    expect(current?.promoName).toBe("Beca de verano");
    expect(current?.year).toBe(2026);
    expect(current?.month).toBe(9);

    // July and August were never materialized retroactively — only the
    // queried month (September) was.
    const julyRow = await prisma.paymentPeriod.findUnique({
      where: { studentId_year_month: { studentId: student.id, year: 2026, month: 7 } },
    });
    expect(julyRow).toBeNull();
  });

  // A director explicitly cancelling the recurrence (editing a later row to
  // uncheck "repetir") must stop the chain, not merely pause it — searching
  // for the LAST recurring row instead of the MOST RECENT row (regardless
  // of its flag) would perversely revive a promo just turned off.
  it("does not revive a recurring promo after a later row explicitly turned promoRecurring off", async () => {
    const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
    const promoPlan = await ensureCustomPromoPlan(escazu.id);
    const director = await makeStaffUser("carry-forward-cancel-director");
    const student = await makeStudent(escazu.id);

    await prisma.paymentPeriod.create({
      data: {
        studentId: student.id,
        academyId: escazu.id,
        year: 2026,
        month: 6,
        planId: promoPlan.id,
        status: "PROMO",
        amount: 0,
        promoName: "Beca de verano",
        promoRecurring: true,
        recordedById: director.id,
      },
    });
    // July: the director explicitly removes the recurrence on this same
    // custom-promo plan (e.g. via "Editar"), while leaving the promo itself
    // in effect for July only.
    await prisma.paymentPeriod.create({
      data: {
        studentId: student.id,
        academyId: escazu.id,
        year: 2026,
        month: 7,
        planId: promoPlan.id,
        status: "PROMO",
        amount: 0,
        promoName: "Beca de verano (última vez)",
        promoRecurring: false,
        recordedById: director.id,
      },
    });

    const current = await getCurrentPaymentPeriod(student.id, { year: 2026, month: 8 });
    expect(current).toBeNull();
  });
});

describe("getCurrentPaymentPeriodsForStudents — batched resolution", () => {
  afterAll(cleanup);

  it("resolves a mix of already-recorded, carry-forward, and no-history students in one batched call", async () => {
    const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
    const promoPlan = await ensureCustomPromoPlan(escazu.id);
    const mensualidad = await prisma.paymentPlan.findFirstOrThrow({
      where: { academyId: escazu.id, name: "Mensualidad" },
    });
    const director = await makeStaffUser("batched-director");

    const recordedStudent = await makeStudent(escazu.id);
    await prisma.paymentPeriod.create({
      data: {
        studentId: recordedStudent.id,
        academyId: escazu.id,
        year: 2026,
        month: 9,
        planId: mensualidad.id,
        status: "PAID",
        amount: 45000,
        recordedById: director.id,
      },
    });

    const carryForwardStudent = await makeStudent(escazu.id);
    await prisma.paymentPeriod.create({
      data: {
        studentId: carryForwardStudent.id,
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

    const noHistoryStudent = await makeStudent(escazu.id);

    const results = await getCurrentPaymentPeriodsForStudents(
      [recordedStudent.id, carryForwardStudent.id, noHistoryStudent.id],
      { year: 2026, month: 9 },
    );

    expect(results.get(recordedStudent.id)).toMatchObject({ status: "PAID", planName: "Mensualidad" });
    expect(results.get(carryForwardStudent.id)).toMatchObject({
      status: "PROMO",
      promoName: "Beca competidor",
    });
    expect(results.get(noHistoryStudent.id)).toBeNull();

    // The carry-forward candidate was actually materialized as a real row,
    // same guarantee the single-student function gives.
    const materialized = await prisma.paymentPeriod.findUnique({
      where: { studentId_year_month: { studentId: carryForwardStudent.id, year: 2026, month: 9 } },
    });
    expect(materialized).not.toBeNull();
  });

  it("returns an empty map for an empty student list without querying", async () => {
    const results = await getCurrentPaymentPeriodsForStudents([], { year: 2026, month: 9 });
    expect(results.size).toBe(0);
  });
});
