import "dotenv/config";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "../../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { requireEnv } from "../../src/lib/env";
import { digestLookupSecret, hashSecret } from "../../src/lib/crypto";

// `recordPayment` reaches `requireStaffSession()` -> `getStaffSession()` ->
// next-auth's `auth()`, which needs a real HTTP request's cookies to resolve
// a JWT session — unavailable in a plain integration test. Mocking `@/auth`'s
// `auth()` lets this Server Action be exercised directly against the real
// DB, matching `tests/integration/promotion-actions.test.ts`'s established
// pattern for a cookie-bound write action, while still using real `User` /
// `StaffAssignment` rows underneath so `getStaffSession()`'s own DB queries
// run unmodified.
let currentSession: { user: { id: string; role: string } } | null = null;

vi.mock("@/auth", () => ({
  auth: () => Promise.resolve(currentSession),
}));

const { recordPayment } = await import("../../src/app/[locale]/students/[id]/payment-actions");

const adapter = new PrismaPg({ connectionString: requireEnv("DATABASE_URL") });
const prisma = new PrismaClient({ adapter });
const pepper = requireEnv("CODE_PEPPER");

function formData(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    fd.set(key, value);
  }
  return fd;
}

const cleanupUserIds: string[] = [];
const cleanupStudentIds: string[] = [];

async function cleanup() {
  if (cleanupStudentIds.length > 0) {
    await prisma.auditLog.deleteMany({
      where: {
        entityType: "PaymentPeriod",
        entityId: { in: await paymentPeriodIdsFor(cleanupStudentIds) },
      },
    });
    await prisma.paymentPeriod.deleteMany({ where: { studentId: { in: cleanupStudentIds } } });
    await prisma.student.deleteMany({ where: { id: { in: cleanupStudentIds } } });
  }
  if (cleanupUserIds.length > 0) {
    await prisma.staffAssignment.deleteMany({ where: { userId: { in: cleanupUserIds } } });
    await prisma.user.deleteMany({ where: { id: { in: cleanupUserIds } } });
  }
}

async function paymentPeriodIdsFor(studentIds: string[]): Promise<string[]> {
  const rows = await prisma.paymentPeriod.findMany({
    where: { studentId: { in: studentIds } },
    select: { id: true },
  });
  return rows.map((r) => r.id);
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

async function makeStudent(academyId: string, lastName?: string) {
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
  const student = await prisma.student.create({
    data: {
      homeAcademyId: academyId,
      firstName: "PaymentActionTest",
      lastName: lastName ?? `Student-${suffix}`,
      phone: "88880000",
      email: `payment-action-${suffix}@example.com`,
      status: "ACTIVE",
      codeHash: digestLookupSecret(`payment-action-${suffix}`, pepper),
    },
  });
  cleanupStudentIds.push(student.id);
  return student;
}

function paymentPeriodFor(studentId: string, year: number, month: number) {
  return prisma.paymentPeriod.findUnique({ where: { studentId_year_month: { studentId, year, month } } });
}

function auditRowsFor(entityId: string, action: string) {
  return prisma.auditLog.findMany({ where: { entityId, action }, orderBy: { createdAt: "asc" } });
}

describe("recordPayment", () => {
  afterAll(cleanup);

  beforeEach(() => {
    currentSession = null;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("an ADMIN recording a payment for the first time creates a PaymentPeriod row with the correct fields and writes an AuditLog row", async () => {
    const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
    const plan = await prisma.paymentPlan.findFirstOrThrow({
      where: { academyId: escazu.id, name: "Mensualidad" },
    });
    const admin = await makeStaffUser("ADMIN", "record-admin");
    const student = await makeStudent(escazu.id);

    currentSession = { user: { id: admin.id, role: "ADMIN" } };
    const result = await recordPayment(
      {},
      formData({
        studentId: student.id,
        year: "2026",
        month: "3",
        planId: plan.id,
        status: "PAID",
        amount: "45000",
        notes: "cash",
      }),
    );
    expect(result.ok).toBe(true);

    const period = await paymentPeriodFor(student.id, 2026, 3);
    expect(period).not.toBeNull();
    expect(period).toMatchObject({
      status: "PAID",
      planId: plan.id,
      academyId: escazu.id,
      recordedById: admin.id,
      notes: "cash",
    });
    expect(period!.amount?.toNumber()).toBe(45000);

    const audits = await auditRowsFor(period!.id, "payment.record");
    expect(audits).toHaveLength(1);
    expect(audits[0].actorId).toBe(admin.id);
    expect(audits[0].academyId).toBe(escazu.id);
    expect(audits[0].before).toBeNull();
    expect(audits[0].after).toMatchObject({ status: "PAID", planId: plan.id, amount: 45000 });
  });

  it("recording AGAIN for the same student/month updates the SAME row rather than creating a second one, and the AuditLog's before reflects the prior status", async () => {
    const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
    const plan = await prisma.paymentPlan.findFirstOrThrow({
      where: { academyId: escazu.id, name: "Mensualidad" },
    });
    const admin = await makeStaffUser("ADMIN", "record-again-admin");
    const student = await makeStudent(escazu.id);

    currentSession = { user: { id: admin.id, role: "ADMIN" } };
    const first = await recordPayment(
      {},
      formData({
        studentId: student.id,
        year: "2026",
        month: "4",
        planId: plan.id,
        status: "PENDING",
        amount: "45000",
      }),
    );
    expect(first.ok).toBe(true);

    const second = await recordPayment(
      {},
      formData({
        studentId: student.id,
        year: "2026",
        month: "4",
        planId: plan.id,
        status: "PAID",
        amount: "45000",
      }),
    );
    expect(second.ok).toBe(true);

    const count = await prisma.paymentPeriod.count({
      where: { studentId: student.id, year: 2026, month: 4 },
    });
    expect(count).toBe(1);

    const period = await paymentPeriodFor(student.id, 2026, 4);
    expect(period!.status).toBe("PAID");

    const audits = await auditRowsFor(period!.id, "payment.record");
    expect(audits).toHaveLength(2);
    expect(audits[0].before).toBeNull();
    expect(audits[1].before).toMatchObject({ status: "PENDING", planId: plan.id, amount: 45000 });
    expect(audits[1].after).toMatchObject({ status: "PAID", planId: plan.id, amount: 45000 });
  });

  it("a planId belonging to the OTHER academy is rejected with invalidPlan, writing no row", async () => {
    const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
    const escalante = await prisma.academy.findUniqueOrThrow({ where: { slug: "escalante" } });
    const wrongAcademyPlan = await prisma.paymentPlan.findFirstOrThrow({
      where: { academyId: escalante.id, name: "Mensualidad" },
    });
    const admin = await makeStaffUser("ADMIN", "record-wrongplan-admin");
    const student = await makeStudent(escazu.id);

    currentSession = { user: { id: admin.id, role: "ADMIN" } };
    const result = await recordPayment(
      {},
      formData({
        studentId: student.id,
        year: "2026",
        month: "5",
        planId: wrongAcademyPlan.id,
        status: "PAID",
      }),
    );
    expect(result.error).toBe("invalidPlan");

    const period = await paymentPeriodFor(student.id, 2026, 5);
    expect(period).toBeNull();
  });

  it("an INSTRUCTOR session is rejected (role gate)", async () => {
    const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
    const plan = await prisma.paymentPlan.findFirstOrThrow({
      where: { academyId: escazu.id, name: "Mensualidad" },
    });
    const instructor = await makeStaffUser("INSTRUCTOR", "record-instructor", escazu.id);
    const student = await makeStudent(escazu.id);

    currentSession = { user: { id: instructor.id, role: "INSTRUCTOR" } };
    await expect(
      recordPayment(
        {},
        formData({ studentId: student.id, year: "2026", month: "6", planId: plan.id, status: "PAID" }),
      ),
    ).rejects.toThrow("FORBIDDEN");

    const period = await paymentPeriodFor(student.id, 2026, 6);
    expect(period).toBeNull();
  });

  it("a DIRECTOR whose StaffAssignment doesn't cover the target student's academy is rejected with notFound", async () => {
    const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
    const escalante = await prisma.academy.findUniqueOrThrow({ where: { slug: "escalante" } });
    const plan = await prisma.paymentPlan.findFirstOrThrow({
      where: { academyId: escazu.id, name: "Mensualidad" },
    });
    const outOfScopeDirector = await makeStaffUser("DIRECTOR", "record-scope-director", escalante.id);
    const student = await makeStudent(escazu.id);

    currentSession = { user: { id: outOfScopeDirector.id, role: "DIRECTOR" } };
    const result = await recordPayment(
      {},
      formData({ studentId: student.id, year: "2026", month: "7", planId: plan.id, status: "PAID" }),
    );
    expect(result.error).toBe("notFound");

    const period = await paymentPeriodFor(student.id, 2026, 7);
    expect(period).toBeNull();
  });

  it("an in-scope DIRECTOR can record a payment", async () => {
    const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
    const plan = await prisma.paymentPlan.findFirstOrThrow({
      where: { academyId: escazu.id, name: "Mensualidad" },
    });
    const director = await makeStaffUser("DIRECTOR", "record-inscope-director", escazu.id);
    const student = await makeStudent(escazu.id);

    currentSession = { user: { id: director.id, role: "DIRECTOR" } };
    const result = await recordPayment(
      {},
      formData({ studentId: student.id, year: "2026", month: "8", planId: plan.id, status: "PAID" }),
    );
    expect(result.ok).toBe(true);

    const period = await paymentPeriodFor(student.id, 2026, 8);
    expect(period?.recordedById).toBe(director.id);
  });

  it("an invalid month (13) is rejected by zod validation before any DB write", async () => {
    const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
    const plan = await prisma.paymentPlan.findFirstOrThrow({
      where: { academyId: escazu.id, name: "Mensualidad" },
    });
    const admin = await makeStaffUser("ADMIN", "record-badmonth-admin");
    const student = await makeStudent(escazu.id);

    currentSession = { user: { id: admin.id, role: "ADMIN" } };
    const result = await recordPayment(
      {},
      formData({ studentId: student.id, year: "2026", month: "13", planId: plan.id, status: "PAID" }),
    );
    expect(result.error).toBe("invalid");
    expect(result.fieldErrors?.month).toBeDefined();

    const count = await prisma.paymentPeriod.count({ where: { studentId: student.id } });
    expect(count).toBe(0);
  });

  it("omitting `amount` and `notes` from the FormData entirely (as the fixed form now does for a blank field) records `null` for both, not `0`/`\"\"`", async () => {
    // Regression test for Phase 6 Task 2 fix round 1: the bug was that the
    // form used to submit `amount=""` — a PRESENT, empty-string field — which
    // the (correct, unmodified) `z.coerce.number().min(0).optional()` schema
    // coerced to `0` rather than `undefined` (`Number("") === 0`). The fix is
    // in the form layer (`RecordPaymentForm` now strips blank `amount`/
    // `notes` from the `FormData` before submitting, so the key is genuinely
    // ABSENT, not empty). This test proves the schema+action side of that
    // contract: when the field is truly absent — exactly what the fixed form
    // now sends — the resulting row has `amount: null` and `notes: null`,
    // never `0` or `""`.
    const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
    const plan = await prisma.paymentPlan.findFirstOrThrow({
      where: { academyId: escazu.id, name: "Mensualidad" },
    });
    const admin = await makeStaffUser("ADMIN", "record-blank-optional-admin");
    const student = await makeStudent(escazu.id);

    currentSession = { user: { id: admin.id, role: "ADMIN" } };
    const result = await recordPayment(
      {},
      formData({
        studentId: student.id,
        year: "2026",
        month: "9",
        planId: plan.id,
        status: "PAID",
        // `amount` and `notes` deliberately omitted — not set to "" — since
        // that is what the fixed form now sends for a blank optional field.
      }),
    );
    expect(result.ok).toBe(true);

    const period = await paymentPeriodFor(student.id, 2026, 9);
    expect(period).not.toBeNull();
    expect(period!.amount).toBeNull();
    expect(period!.notes).toBeNull();

    const audits = await auditRowsFor(period!.id, "payment.record");
    expect(audits).toHaveLength(1);
    expect(audits[0].after).toMatchObject({ status: "PAID", planId: plan.id, amount: null });
  });

  it("correcting an EXISTING payment while leaving amount/notes blank CLEARS the previous values rather than retaining them", async () => {
    // Regression test for Phase 6 final whole-branch review finding I-2: a
    // real cross-task interaction bug. Task 2's fix round made the form
    // strip blank amount/notes from the FormData entirely (absent, not
    // ""), which is correct for CREATE (a schema default of `undefined`
    // there properly writes `null`). But the `update` branch of this
    // upsert used to pass `data.amount`/`data.notes` straight through, and
    // Prisma's `update` treats an `undefined` field as "leave the column
    // unchanged" — so correcting an existing $45,000/"cash in full" PAID
    // record to EXEMPT with blank fields used to silently keep storing
    // {amount: 45000, notes: "cash in full"}, the opposite of a director's
    // evident intent when leaving those fields blank on a correction.
    const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
    const plan = await prisma.paymentPlan.findFirstOrThrow({
      where: { academyId: escazu.id, name: "Mensualidad" },
    });
    const admin = await makeStaffUser("ADMIN", "record-clear-on-correct-admin");
    const student = await makeStudent(escazu.id);

    currentSession = { user: { id: admin.id, role: "ADMIN" } };

    const first = await recordPayment(
      {},
      formData({
        studentId: student.id,
        year: "2026",
        month: "10",
        planId: plan.id,
        status: "PAID",
        amount: "45000",
        notes: "cash in full",
      }),
    );
    expect(first.ok).toBe(true);

    const afterFirst = await paymentPeriodFor(student.id, 2026, 10);
    expect(afterFirst!.amount?.toNumber()).toBe(45000);
    expect(afterFirst!.notes).toBe("cash in full");

    // Correction: same student/month, a different status, amount/notes
    // omitted entirely — exactly what the fixed form now sends for a blank
    // optional field on a correction, not "" for either.
    const second = await recordPayment(
      {},
      formData({
        studentId: student.id,
        year: "2026",
        month: "10",
        planId: plan.id,
        status: "EXEMPT",
      }),
    );
    expect(second.ok).toBe(true);

    const count = await prisma.paymentPeriod.count({
      where: { studentId: student.id, year: 2026, month: 10 },
    });
    expect(count).toBe(1);

    const afterSecond = await paymentPeriodFor(student.id, 2026, 10);
    expect(afterSecond!.status).toBe("EXEMPT");
    expect(afterSecond!.amount).toBeNull();
    expect(afterSecond!.notes).toBeNull();

    const audits = await auditRowsFor(afterSecond!.id, "payment.record");
    expect(audits).toHaveLength(2);
    expect(audits[1].before).toMatchObject({ status: "PAID", planId: plan.id, amount: 45000 });
    expect(audits[1].after).toMatchObject({ status: "EXEMPT", planId: plan.id, amount: null });
  });

  it("an invalid month (0) is rejected by zod validation before any DB write", async () => {
    const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
    const plan = await prisma.paymentPlan.findFirstOrThrow({
      where: { academyId: escazu.id, name: "Mensualidad" },
    });
    const admin = await makeStaffUser("ADMIN", "record-zeromonth-admin");
    const student = await makeStudent(escazu.id);

    currentSession = { user: { id: admin.id, role: "ADMIN" } };
    const result = await recordPayment(
      {},
      formData({ studentId: student.id, year: "2026", month: "0", planId: plan.id, status: "PAID" }),
    );
    expect(result.error).toBe("invalid");
    expect(result.fieldErrors?.month).toBeDefined();

    const count = await prisma.paymentPeriod.count({ where: { studentId: student.id } });
    expect(count).toBe(0);
  });
});
