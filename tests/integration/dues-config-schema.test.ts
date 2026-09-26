import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getTestPrismaClient } from "../helpers/test-db";
import { makeAccountingOrg } from "../helpers/accounting-org";
import { prisma as guardedPrisma } from "../../src/lib/prisma";
import { UnscopedTenantQueryError } from "../../src/lib/tenant/tenant-guard";

/**
 * PR 2A (student dues configuration schema), proved against the REAL test database. Two private, temporary organizations are created
 * (never the seeded Alliance data) and removed in afterAll.
 *
 * Amounts and days below are synthetic test data, not anyone's settings.
 *
 * WHAT THE DATABASE ENFORCES (asserted below as rejections): tenant-safe composite foreign keys, version-uniqueness keys, the CHECK
 * constraints, and restricted deletes. WHAT IT DOES NOT (asserted below as documented non-guarantees, so the schema comments cannot
 * quietly overstate): append-only (updates and deletes are possible), a plan's terms being single-currency, and an assignment's plan
 * belonging to the student's branch. Later writers own those.
 */
const prisma = getTestPrismaClient();

type Fixture = Awaited<ReturnType<typeof makeAccountingOrg>>;
let a: Fixture;
let b: Fixture;
let a2: { id: string }; // a second branch in organization A
let planA1: { id: string }; // organization A, first branch
let planA2: { id: string }; // organization A, second branch
let planB: { id: string }; // organization B
let studentA: { id: string };
let studentB: { id: string };

const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;

function policy(over: Record<string, unknown> = {}) {
  return {
    organizationId: a.org.id,
    academyId: a.academy.id,
    effectiveYear: 2027,
    effectiveMonth: 3,
    dueDay: 15,
    graceDay: 4,
    lateFeeAmount: "12.50",
    lateFeeCurrency: "USD" as const,
    createdById: a.admin.id,
    ...over,
  };
}

function terms(over: Record<string, unknown> = {}) {
  return {
    organizationId: a.org.id,
    planId: planA1.id,
    effectiveYear: 2027,
    effectiveMonth: 3,
    priceAmount: "45.00",
    currency: "USD" as const,
    monthsCovered: 1,
    createdById: a.admin.id,
    ...over,
  };
}

function assignment(over: Record<string, unknown> = {}) {
  return {
    organizationId: a.org.id,
    studentId: studentA.id,
    planId: planA1.id,
    effectiveYear: 2027,
    effectiveMonth: 3,
    createdById: a.admin.id,
    ...over,
  };
}

async function newStudent(fx: Fixture, academyId: string, label: string) {
  return prisma.student.create({
    data: {
      organizationId: fx.org.id,
      homeAcademyId: academyId,
      firstName: "Dues",
      lastName: label,
      phone: "00000000",
      email: `dues-${label}-${suffix}@example.com`,
      currentRankId: await fx.rankId("WHITE"),
      codeHash: `dues-${label}-${suffix}`,
      status: "ACTIVE",
    },
  });
}

beforeAll(async () => {
  a = await makeAccountingOrg("CUMULATIVE", "dues-cfg-a");
  b = await makeAccountingOrg("CUMULATIVE", "dues-cfg-b");
  a2 = await prisma.academy.create({
    data: { organizationId: a.org.id, name: "Dues Cfg A Second Branch", slug: `dues-cfg-a2-${suffix}`, kioskTokenHash: `dues-cfg-a2-${suffix}` },
  });
  planA1 = await prisma.paymentPlan.create({ data: { organizationId: a.org.id, academyId: a.academy.id, name: "Monthly" } });
  planA2 = await prisma.paymentPlan.create({ data: { organizationId: a.org.id, academyId: a2.id, name: "Monthly" } });
  planB = await prisma.paymentPlan.create({ data: { organizationId: b.org.id, academyId: b.academy.id, name: "Monthly" } });
  studentA = await newStudent(a, a.academy.id, "a");
  studentB = await newStudent(b, b.academy.id, "b");
});

afterAll(async () => {
  for (const fx of [a, b]) {
    if (!fx) continue;
    await prisma.studentPlanAssignment.deleteMany({ where: { organizationId: fx.org.id } });
    await prisma.paymentPlanTerms.deleteMany({ where: { organizationId: fx.org.id } });
    await prisma.duesPolicyVersion.deleteMany({ where: { organizationId: fx.org.id } });
    await prisma.paymentPlan.deleteMany({ where: { organizationId: fx.org.id } });
  }
  if (a2) await prisma.academy.deleteMany({ where: { id: a2.id } });
  await a?.drop();
  await b?.drop();
});

/** The database rejected the write; when the driver names the constraint, it must be the expected one. */
async function rejected(write: Promise<unknown>, constraintHint?: string) {
  let error: unknown;
  try {
    await write;
  } catch (e) {
    error = e;
  }
  expect(error, "the database must reject this write").toBeDefined();
  if (constraintHint) expect(String(error) + JSON.stringify(error)).toContain(constraintHint);
}

describe("DuesPolicyVersion", () => {
  it("accepts a valid version, stores money exactly, and keeps maxPrepaidMonths null as 'not entered'", async () => {
    const row = await prisma.duesPolicyVersion.create({ data: policy() });
    expect(row.lateFeeAmount.toFixed(2)).toBe("12.50");
    expect(row.maxPrepaidMonths).toBeNull();
  });

  it("stores a limit when one is entered, and accepts a zero fee", async () => {
    const row = await prisma.duesPolicyVersion.create({ data: policy({ effectiveMonth: 4, maxPrepaidMonths: 1, lateFeeAmount: "0.00" }) });
    expect(row.maxPrepaidMonths).toBe(1);
    expect(row.lateFeeAmount.toFixed(2)).toBe("0.00");
  });

  it("allows a later version for the same branch and the same month for a different branch (independent branches)", async () => {
    await prisma.duesPolicyVersion.create({ data: policy({ effectiveMonth: 5 }) });
    await prisma.duesPolicyVersion.create({ data: policy({ academyId: a2.id, effectiveMonth: 5, dueDay: 25 }) });
  });

  it("rejects a second version for the same branch and effective month (version uniqueness)", async () => {
    await prisma.duesPolicyVersion.create({ data: policy({ effectiveMonth: 6 }) });
    await rejected(prisma.duesPolicyVersion.create({ data: policy({ effectiveMonth: 6, dueDay: 1 }) }));
  });

  it("rejects a branch of another organization (tenant-safe composite foreign key)", async () => {
    await rejected(prisma.duesPolicyVersion.create({ data: policy({ organizationId: b.org.id }) }));
    await rejected(prisma.duesPolicyVersion.create({ data: policy({ academyId: b.academy.id }) }));
  });

  it.each([
    ["effectiveMonth", 0, "effective_month_valid"],
    ["effectiveMonth", 13, "effective_month_valid"],
    ["effectiveYear", 1999, "effective_year_sane"],
    ["effectiveYear", 2101, "effective_year_sane"],
    ["dueDay", 0, "due_day_valid"],
    ["dueDay", 32, "due_day_valid"],
    ["graceDay", 0, "grace_day_valid"],
    ["graceDay", 32, "grace_day_valid"],
    ["lateFeeAmount", "-0.01", "late_fee_non_negative"],
    ["maxPrepaidMonths", 0, "max_prepaid_months_positive"],
    ["maxPrepaidMonths", -3, "max_prepaid_months_positive"],
  ])("rejects %s = %s (CHECK %s)", async (field, value, hint) => {
    // a distinct month per case so a wrongly-accepted row cannot hide behind the uniqueness key
    const month = field === "effectiveMonth" ? (value as number) : 1 + Math.floor(Math.random() * 12);
    const year = field === "effectiveYear" ? (value as number) : 2040 + Math.floor(Math.random() * 30);
    await rejected(prisma.duesPolicyVersion.create({ data: policy({ effectiveYear: year, effectiveMonth: month, [field]: value }) }), hint);
  });

  it("accepts the boundary values 1 and 31, month 1 and 12, years 2000 and 2100", async () => {
    await prisma.duesPolicyVersion.create({ data: policy({ effectiveYear: 2000, effectiveMonth: 1, dueDay: 1, graceDay: 1 }) });
    await prisma.duesPolicyVersion.create({ data: policy({ effectiveYear: 2100, effectiveMonth: 12, dueDay: 31, graceDay: 31 }) });
  });

  it("restricts deleting a branch that has versions (money history is not deleted through foreign keys)", async () => {
    await prisma.duesPolicyVersion.create({ data: policy({ academyId: a2.id, effectiveMonth: 9 }) });
    await rejected(prisma.academy.delete({ where: { id: a2.id } }));
  });

  it("DOCUMENTED NON-GUARANTEE: the database does not make a version append-only; an UPDATE succeeds", async () => {
    const row = await prisma.duesPolicyVersion.create({ data: policy({ effectiveMonth: 8 }) });
    const changed = await prisma.duesPolicyVersion.update({ where: { id: row.id }, data: { dueDay: 2 } });
    expect(changed.dueDay).toBe(2); // append-only is a convention writers must keep, not a database property
  });
});

describe("PaymentPlanTerms", () => {
  it("accepts an ordinary monthly plan (1 month) and a multi-month package priced as a whole", async () => {
    const monthly = await prisma.paymentPlanTerms.create({ data: terms({ effectiveMonth: 1 }) });
    const pkg = await prisma.paymentPlanTerms.create({ data: terms({ planId: planA2.id, effectiveMonth: 1, monthsCovered: 3, priceAmount: "120.00" }) });
    expect(monthly.monthsCovered).toBe(1);
    expect(pkg.priceAmount.toFixed(2)).toBe("120.00");
  });

  it("rejects a second version of the same plan for the same effective month, but allows other plans and months", async () => {
    await prisma.paymentPlanTerms.create({ data: terms({ effectiveMonth: 2 }) });
    await rejected(prisma.paymentPlanTerms.create({ data: terms({ effectiveMonth: 2, priceAmount: "50.00" }) }));
    await prisma.paymentPlanTerms.create({ data: terms({ effectiveMonth: 4 }) });
    await prisma.paymentPlanTerms.create({ data: terms({ planId: planA2.id, effectiveMonth: 2 }) });
  });

  it("rejects a plan of another organization (tenant-safe composite foreign key)", async () => {
    await rejected(prisma.paymentPlanTerms.create({ data: terms({ planId: planB.id, effectiveMonth: 9 }) }));
    await rejected(prisma.paymentPlanTerms.create({ data: terms({ organizationId: b.org.id, effectiveMonth: 9 }) }));
  });

  it.each([
    ["effectiveMonth", 0, "effective_month_valid"],
    ["effectiveMonth", 13, "effective_month_valid"],
    ["effectiveYear", 1999, "effective_year_sane"],
    ["effectiveYear", 2101, "effective_year_sane"],
    ["priceAmount", "0.00", "price_positive"],
    ["priceAmount", "-5.00", "price_positive"],
    ["monthsCovered", 0, "months_covered_positive"],
    ["monthsCovered", -1, "months_covered_positive"],
  ])("rejects %s = %s (CHECK %s)", async (field, value, hint) => {
    const year = field === "effectiveYear" ? (value as number) : 2040 + Math.floor(Math.random() * 30);
    const month = field === "effectiveMonth" ? (value as number) : 1 + Math.floor(Math.random() * 12);
    await rejected(prisma.paymentPlanTerms.create({ data: terms({ effectiveYear: year, effectiveMonth: month, [field]: value }) }), hint);
  });

  it("restricts deleting a plan that has terms", async () => {
    await prisma.paymentPlanTerms.create({ data: terms({ effectiveMonth: 10 }) });
    await rejected(prisma.paymentPlan.delete({ where: { id: planA1.id } }));
  });

  it("DOCUMENTED NON-GUARANTEE: the database does not keep one plan's terms in a single currency (writers and the library must)", async () => {
    await prisma.paymentPlanTerms.create({ data: terms({ planId: planA2.id, effectiveMonth: 11, currency: "USD" }) });
    await prisma.paymentPlanTerms.create({ data: terms({ planId: planA2.id, effectiveMonth: 12, currency: "CRC", priceAmount: "5000.00" }) });
  });
});

describe("StudentPlanAssignment", () => {
  it("accepts an assignment, and an explicit 'not assigned' (planId null) from a later month", async () => {
    const on = await prisma.studentPlanAssignment.create({ data: assignment({ effectiveMonth: 3 }) });
    const off = await prisma.studentPlanAssignment.create({ data: assignment({ effectiveMonth: 6, planId: null }) });
    expect(on.planId).toBe(planA1.id);
    expect(off.planId).toBeNull();
  });

  it("rejects a second assignment for the same student and month, including a null-plan one (version uniqueness)", async () => {
    await prisma.studentPlanAssignment.create({ data: assignment({ effectiveMonth: 7 }) });
    await rejected(prisma.studentPlanAssignment.create({ data: assignment({ effectiveMonth: 7, planId: null }) }));
    await rejected(prisma.studentPlanAssignment.create({ data: assignment({ effectiveMonth: 7 }) }));
  });

  it("rejects a student of another organization (tenant-safe composite foreign key)", async () => {
    await rejected(prisma.studentPlanAssignment.create({ data: assignment({ studentId: studentB.id, effectiveMonth: 1 }) }));
    await rejected(prisma.studentPlanAssignment.create({ data: assignment({ organizationId: b.org.id, effectiveMonth: 1 }) }));
  });

  it("rejects a plan of another organization, even for a student of the right one", async () => {
    await rejected(prisma.studentPlanAssignment.create({ data: assignment({ planId: planB.id, effectiveMonth: 1 }) }));
  });

  it.each([
    ["effectiveMonth", 0, "effective_month_valid"],
    ["effectiveMonth", 13, "effective_month_valid"],
    ["effectiveMonth", -1, "effective_month_valid"],
    ["effectiveYear", 1999, "effective_year_sane"],
    ["effectiveYear", 2101, "effective_year_sane"],
  ])("rejects the assignment's %s = %s (CHECK %s)", async (field, value, hint) => {
    const year = field === "effectiveYear" ? (value as number) : 2040 + Math.floor(Math.random() * 30);
    const month = field === "effectiveMonth" ? (value as number) : 1 + Math.floor(Math.random() * 12);
    await rejected(prisma.studentPlanAssignment.create({ data: assignment({ effectiveYear: year, effectiveMonth: month }) }), hint);
  });

  it("accepts the boundary months 1 and 12", async () => {
    await prisma.studentPlanAssignment.create({ data: assignment({ effectiveYear: 2031, effectiveMonth: 1 }) });
    await prisma.studentPlanAssignment.create({ data: assignment({ effectiveYear: 2031, effectiveMonth: 12 }) });
  });

  it("restricts deleting a student that has assignments", async () => {
    await rejected(prisma.student.delete({ where: { id: studentA.id } }));
  });

  it("DOCUMENTED NON-GUARANTEE: the database does not check that the plan belongs to the student's branch (writers must)", async () => {
    // studentA's home branch is the first one; planA2 belongs to the second branch of the same organization
    const row = await prisma.studentPlanAssignment.create({ data: assignment({ planId: planA2.id, effectiveMonth: 9 }) });
    expect(row.planId).toBe(planA2.id);
  });
});

describe("tenant-guard registration", () => {
  it.each(["duesPolicyVersion", "paymentPlanTerms", "studentPlanAssignment"] as const)(
    "the guarded client refuses an unscoped %s query and allows one scoped by organization",
    async (delegate) => {
      const model = guardedPrisma[delegate] as unknown as { findMany: (args: object) => Promise<unknown[]> };
      await expect(model.findMany({})).rejects.toThrow(UnscopedTenantQueryError);
      await expect(model.findMany({ where: { organizationId: a.org.id } })).resolves.toBeInstanceOf(Array);
    },
  );
});

describe("legacy payment tables are untouched", () => {
  it("PaymentPlan keeps its mutable defaultAmount, and PaymentPeriod keeps exactly its existing columns", async () => {
    const plan = await prisma.paymentPlan.update({ where: { id: planA1.id }, data: { defaultAmount: "33.00" } });
    expect(plan.defaultAmount?.toFixed(2)).toBe("33.00");
    const columns = await prisma.$queryRawUnsafe<{ column_name: string }[]>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'PaymentPeriod' ORDER BY column_name`,
    );
    expect(columns.map((c) => c.column_name).sort()).toEqual(
      ["academyId", "amount", "currency", "id", "method", "month", "notes", "organizationId", "planId", "promoName", "promoReason", "promoRecurring", "recordedAt", "recordedById", "status", "studentId", "year"].sort(),
    );
  });
});
