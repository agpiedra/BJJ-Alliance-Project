import "dotenv/config";
import { afterAll, describe, expect, it } from "vitest";
import { PrismaClient } from "../../src/generated/prisma/client";
import type { PaymentStatus } from "../../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { requireEnv } from "../../src/lib/env";
import { digestLookupSecret, hashSecret } from "../../src/lib/crypto";
import type { StaffSession } from "../../src/lib/auth/session";
import type { OverdueStudent } from "../../src/lib/payments/list-overdue";

const { listOverdueStudents } = await import("../../src/lib/payments/list-overdue");

const adapter = new PrismaPg({ connectionString: requireEnv("DATABASE_URL") });
const prisma = new PrismaClient({ adapter });
const pepper = requireEnv("CODE_PEPPER");

// Fixed "today" for every test in this file — the whole point of
// `listOverdueStudents`'s injectable `today` parameter (mirroring
// `perform-check-in.ts`'s `now?: Date`) is that these tests never depend on
// the real wall clock's day-of-month relative to `DEFAULT_OVERDUE_CUTOFF_DAY`
// (5). `PAST_CUTOFF`/`BEFORE_CUTOFF` share the same year/month so a single
// `PaymentPeriod` row (or its absence) means the same thing under either.
const PAST_CUTOFF = { year: 2026, month: 9, day: 10 };
const BEFORE_CUTOFF = { year: 2026, month: 9, day: 3 };

const cleanupStudentIds: string[] = [];
const cleanupUserIds: string[] = [];

async function cleanup() {
  if (cleanupStudentIds.length > 0) {
    await prisma.paymentPeriod.deleteMany({ where: { studentId: { in: cleanupStudentIds } } });
    await prisma.student.deleteMany({ where: { id: { in: cleanupStudentIds } } });
  }
  if (cleanupUserIds.length > 0) {
    await prisma.staffAssignment.deleteMany({ where: { userId: { in: cleanupUserIds } } });
    await prisma.user.deleteMany({ where: { id: { in: cleanupUserIds } } });
  }
}

async function makeStaffUser(role: "ADMIN" | "DIRECTOR" | "INSTRUCTOR", label: string, academyId?: string) {
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
  const user = await prisma.user.create({
    data: {
      email: `${label}-${suffix}@example.com`,
      passwordHash: await hashSecret("irrelevant-password-123"),
      role,
    },
  });
  cleanupUserIds.push(user.id);
  if (academyId && role !== "ADMIN") {
    await prisma.staffAssignment.create({
      data: { userId: user.id, academyId, role: role === "DIRECTOR" ? "DIRECTOR" : "INSTRUCTOR" },
    });
  }
  return user;
}

async function makeStudent(
  academyId: string,
  status: "ACTIVE" | "PENDING" | "ARCHIVED" = "ACTIVE",
) {
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
  const student = await prisma.student.create({
    data: {
      homeAcademyId: academyId,
      firstName: "OverdueListTest",
      lastName: `Student-${suffix}`,
      phone: "88880000",
      email: `overdue-list-${suffix}@example.com`,
      status,
      codeHash: digestLookupSecret(`overdue-list-${suffix}`, pepper),
    },
  });
  cleanupStudentIds.push(student.id);
  return student;
}

async function makePaymentPeriod(
  studentId: string,
  academyId: string,
  planId: string,
  recordedById: string,
  year: number,
  month: number,
  status: PaymentStatus,
) {
  return prisma.paymentPeriod.create({
    data: { studentId, academyId, planId, recordedById, year, month, status },
  });
}

function findOverdue(list: OverdueStudent[], studentId: string) {
  return list.find((s) => s.studentId === studentId);
}

describe("listOverdueStudents", () => {
  afterAll(cleanup);

  it("an ACTIVE student with no PaymentPeriod row for the current month, past the cutoff day, appears", async () => {
    const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
    const admin: StaffSession = { userId: "x", role: "ADMIN", academyIds: "ALL" };
    const student = await makeStudent(escazu.id);

    const overdue = await listOverdueStudents(admin, PAST_CUTOFF);
    const found = findOverdue(overdue, student.id);
    expect(found).toBeDefined();
    expect(found?.lastPaidMonth).toBeNull();
    expect(found?.homeAcademyName).toBe(escazu.name);
  });

  it("an ACTIVE student with a PENDING row for the current month, past the cutoff day, appears", async () => {
    const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
    const plan = await prisma.paymentPlan.findFirstOrThrow({
      where: { academyId: escazu.id, name: "Mensualidad" },
    });
    const admin: StaffSession = { userId: "x", role: "ADMIN", academyIds: "ALL" };
    const recorder = await makeStaffUser("ADMIN", "overdue-recorder-pending");
    const student = await makeStudent(escazu.id);
    await makePaymentPeriod(
      student.id,
      escazu.id,
      plan.id,
      recorder.id,
      PAST_CUTOFF.year,
      PAST_CUTOFF.month,
      "PENDING",
    );

    const overdue = await listOverdueStudents(admin, PAST_CUTOFF);
    expect(findOverdue(overdue, student.id)).toBeDefined();
  });

  it.each(["PAID", "PROMO", "EXEMPT"] as const)(
    "an ACTIVE student with a %s row for the current month never appears, regardless of the day",
    async (status) => {
      const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
      const plan = await prisma.paymentPlan.findFirstOrThrow({
        where: { academyId: escazu.id, name: "Mensualidad" },
      });
      const admin: StaffSession = { userId: "x", role: "ADMIN", academyIds: "ALL" };
      const recorder = await makeStaffUser("ADMIN", `overdue-recorder-${status.toLowerCase()}`);
      const student = await makeStudent(escazu.id);
      await makePaymentPeriod(
        student.id,
        escazu.id,
        plan.id,
        recorder.id,
        PAST_CUTOFF.year,
        PAST_CUTOFF.month,
        status,
      );

      const overdue = await listOverdueStudents(admin, PAST_CUTOFF);
      expect(findOverdue(overdue, student.id)).toBeUndefined();
    },
  );

  it("before the cutoff day, nobody appears regardless of status (missing row or PENDING)", async () => {
    const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
    const plan = await prisma.paymentPlan.findFirstOrThrow({
      where: { academyId: escazu.id, name: "Mensualidad" },
    });
    const admin: StaffSession = { userId: "x", role: "ADMIN", academyIds: "ALL" };
    const recorder = await makeStaffUser("ADMIN", "overdue-recorder-beforecutoff");
    const missingRowStudent = await makeStudent(escazu.id);
    const pendingStudent = await makeStudent(escazu.id);
    await makePaymentPeriod(
      pendingStudent.id,
      escazu.id,
      plan.id,
      recorder.id,
      BEFORE_CUTOFF.year,
      BEFORE_CUTOFF.month,
      "PENDING",
    );

    const overdue = await listOverdueStudents(admin, BEFORE_CUTOFF);
    expect(findOverdue(overdue, missingRowStudent.id)).toBeUndefined();
    expect(findOverdue(overdue, pendingStudent.id)).toBeUndefined();
  });

  it.each(["PENDING", "ARCHIVED"] as const)(
    "a %s-status student (not PaymentStatus) never appears regardless of payment state",
    async (studentStatus) => {
      const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
      const admin: StaffSession = { userId: "x", role: "ADMIN", academyIds: "ALL" };
      const student = await makeStudent(escazu.id, studentStatus);

      const overdue = await listOverdueStudents(admin, PAST_CUTOFF);
      expect(findOverdue(overdue, student.id)).toBeUndefined();
    },
  );

  it("a DIRECTOR never sees the other academy's overdue students; ADMIN sees both", async () => {
    const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
    const escalante = await prisma.academy.findUniqueOrThrow({ where: { slug: "escalante" } });
    const escazuStudent = await makeStudent(escazu.id);
    const escalanteStudent = await makeStudent(escalante.id);

    const escazuDirector: StaffSession = { userId: "x", role: "DIRECTOR", academyIds: [escazu.id] };
    const scoped = await listOverdueStudents(escazuDirector, PAST_CUTOFF);
    expect(findOverdue(scoped, escazuStudent.id)).toBeDefined();
    expect(findOverdue(scoped, escalanteStudent.id)).toBeUndefined();

    const admin: StaffSession = { userId: "x", role: "ADMIN", academyIds: "ALL" };
    const full = await listOverdueStudents(admin, PAST_CUTOFF);
    expect(findOverdue(full, escazuStudent.id)).toBeDefined();
    expect(findOverdue(full, escalanteStudent.id)).toBeDefined();
  });

  it("an INSTRUCTOR session is rejected entirely (role gate), unlike the promotion queue which INSTRUCTOR can view read-only", async () => {
    const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
    const instructor: StaffSession = { userId: "x", role: "INSTRUCTOR", academyIds: [escazu.id] };

    await expect(listOverdueStudents(instructor, PAST_CUTOFF)).rejects.toThrow("FORBIDDEN");
  });

  it("lastPaidMonth reflects the most recent PAID period, formatted YYYY-MM, even while the CURRENT month is overdue", async () => {
    const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
    const plan = await prisma.paymentPlan.findFirstOrThrow({
      where: { academyId: escazu.id, name: "Mensualidad" },
    });
    const admin: StaffSession = { userId: "x", role: "ADMIN", academyIds: "ALL" };
    const recorder = await makeStaffUser("ADMIN", "overdue-recorder-lastpaid");
    const student = await makeStudent(escazu.id);

    // Paid the two months before PAST_CUTOFF's month, but nothing recorded
    // for PAST_CUTOFF's own month — so the student is overdue for the
    // current month while still having PAID history to report.
    await makePaymentPeriod(student.id, escazu.id, plan.id, recorder.id, 2026, 7, "PAID");
    await makePaymentPeriod(student.id, escazu.id, plan.id, recorder.id, 2026, 8, "PAID");

    const overdue = await listOverdueStudents(admin, PAST_CUTOFF);
    const found = findOverdue(overdue, student.id);
    expect(found).toBeDefined();
    expect(found?.lastPaidMonth).toBe("2026-08");
  });
});
