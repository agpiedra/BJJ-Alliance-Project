import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getTestPrismaClient } from "../helpers/test-db";
import { prisma as appPrisma } from "../../src/lib/prisma";
import { makeAccountingOrg } from "../helpers/accounting-org";
import type { TenantContext } from "../../src/lib/tenant/types";
import type { LedgerActivation } from "../../src/lib/dues/ledger/activation";
import { enrollmentChargeInTx } from "../../src/lib/dues/ledger/enrollment-charge";
import { EnrollmentRefusedError } from "../../src/lib/dues/enrollment-refused-error";
import type { CalendarDate } from "../../src/lib/dues/calendar";
import { firstUncoveredFrom } from "../../src/lib/dues/ledger/prepay-monthly";
import { checkPackageCoverageAvailableInTx } from "../../src/lib/dues/ledger/purchase-package";

/**
 * Enrollment/resume integration plan §7.1-§7.7: `enrollmentChargeInTx`'s gated financial core, `approveStudentInTx`/
 * `createStudentInTx`/`createStudentCore`'s composition of it (including §7.6's plan-selection authorization split
 * and §7.7's staff-creation idempotency), proved against the REAL test database. `approveStudent`'s own pre-existing
 * test suite (student-detail-actions.test.ts) and `createStudent`'s own (create-student-action.test.ts) are
 * untouched by this file.
 */
const prisma = getTestPrismaClient();
type Fixture = Awaited<ReturnType<typeof makeAccountingOrg>>;
const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
const ACTIVE: LedgerActivation = { isActive: async () => true };
const at = (isoLocal: string) => () => new Date(`${isoLocal}-06:00`); // Costa Rica, UTC-6 all year
const deps = (extra: Record<string, unknown> = {}) => ({ activation: ACTIVE, ...extra });

let currentSession: { user: { id: string; role: string } | null; activeOrganizationId?: string } | null = null;
vi.mock("@/auth", () => ({ auth: () => Promise.resolve(currentSession), signIn: vi.fn() }));
const { approveStudent, approveStudentInTx } = await import("../../src/app/[locale]/(staff)/students/[id]/actions");
const { createStudent, createStudentCore } = await import("../../src/app/[locale]/(staff)/students/create-student-action");

let a: Fixture;
let planA: { id: string }; // monthly, dueDay 5
let packagePlan: { id: string };

function context(over: Partial<TenantContext> = {}): TenantContext {
  return { kind: "tenant", actorUserId: a.admin.id, organizationId: a.org.id, organizationRole: "ADMIN", academyIds: "ALL", selfStudentId: null, linkedStudentId: null, ...over };
}

let studentCounter = 0;
async function newStudent(status: "PENDING" | "ACTIVE", label: string) {
  const n = ++studentCounter;
  return prisma.student.create({
    data: {
      organizationId: a.org.id, homeAcademyId: a.academy.id, firstName: "Enroll", lastName: `${label}${n}`, phone: "00000000",
      email: `enroll-${label}-${n}-${suffix}@example.com`, currentRankId: await a.rankId("WHITE"), codeHash: `enroll-${label}-${n}-${suffix}`, status,
    },
  });
}

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) fd.set(key, value);
  return fd;
}

async function ledgerCounts() {
  return {
    obligations: await prisma.duesObligation.count({ where: { organizationId: a.org.id } }),
    coverage: await prisma.duesCoverage.count({ where: { organizationId: a.org.id } }),
    assignments: await prisma.studentPlanAssignment.count({ where: { organizationId: a.org.id } }),
    statusChanges: await prisma.studentStatusChange.count({ where: { organizationId: a.org.id } }),
    audits: await prisma.auditLog.count({ where: { organizationId: a.org.id } }),
    students: await prisma.student.count({ where: { organizationId: a.org.id } }),
  };
}

beforeAll(async () => {
  a = await makeAccountingOrg("CUMULATIVE", "enroll-a");
  currentSession = { user: { id: a.admin.id, role: "ADMIN" }, activeOrganizationId: a.org.id };
  const plan = await prisma.paymentPlan.create({ data: { organizationId: a.org.id, academyId: a.academy.id, name: `Enroll plan ${suffix}` } });
  planA = plan;
  await prisma.paymentPlanTerms.create({
    data: { organizationId: a.org.id, planId: plan.id, effectiveYear: 2020, effectiveMonth: 1, priceAmount: "150.00", currency: "USD", monthsCovered: 1, createdById: a.admin.id },
  });
  await prisma.duesPolicyVersion.create({
    data: { organizationId: a.org.id, academyId: a.academy.id, effectiveYear: 2020, effectiveMonth: 1, dueDay: 5, graceDay: 20, lateFeeAmount: "20.00", lateFeeCurrency: "USD", maxPrepaidMonths: 3, createdById: a.admin.id },
  });
  const pack = await prisma.paymentPlan.create({ data: { organizationId: a.org.id, academyId: a.academy.id, name: `Enroll package ${suffix}` } });
  await prisma.paymentPlanTerms.create({
    data: { organizationId: a.org.id, planId: pack.id, effectiveYear: 2020, effectiveMonth: 1, priceAmount: "400.00", currency: "USD", monthsCovered: 3, createdById: a.admin.id },
  });
  packagePlan = pack;
}, 60_000);

afterAll(async () => {
  if (!a) return;
  await prisma.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL session_replication_role = replica");
      for (const table of ["DuesCoverage", "DuesObligation", "StudentStatusChange", "StudentPlanAssignment"]) {
        await tx.$executeRawUnsafe(`DELETE FROM "${table}" WHERE "organizationId" = $1`, a.org.id);
      }
    },
    { timeout: 30_000 },
  );
  await prisma.auditLog.deleteMany({ where: { organizationId: a.org.id } });
  await prisma.staffAssignment.deleteMany({ where: { organizationId: a.org.id } });
  await prisma.organizationMembership.deleteMany({ where: { organizationId: a.org.id, role: "DIRECTOR" } });
  await prisma.user.deleteMany({ where: { email: { contains: suffix } } });
  await prisma.paymentPlanTerms.deleteMany({ where: { organizationId: a.org.id } });
  await prisma.duesPolicyVersion.deleteMany({ where: { organizationId: a.org.id } });
  await prisma.paymentPlan.deleteMany({ where: { organizationId: a.org.id } });
  await a.drop();
});

describe("billing inactive: approveStudent and createStudent are byte-identical to before this PR", () => {
  it("approveStudent approves with zero writes to any dues ledger table", async () => {
    const s = await newStudent("PENDING", "inactive-approve");
    const before = await ledgerCounts();
    const result = await approveStudent(a.org.id, {}, form({ studentId: s.id }));
    expect(result).toEqual({ ok: true });
    expect((await prisma.student.findUniqueOrThrow({ where: { id: s.id } })).status).toBe("ACTIVE");
    expect(await ledgerCounts()).toEqual({ ...before, statusChanges: before.statusChanges + 1, audits: before.audits + 1 });
  });

  it("createStudent creates with zero writes to any dues ledger table, and no creationRequestId/fingerprint stored", async () => {
    const before = await ledgerCounts();
    const result = await createStudent(
      a.org.id, {},
      form({ firstName: "Inactive", lastName: "Create", phone: "1", email: `inactive-create-${suffix}@example.com`, homeAcademyId: a.academy.id, track: "ADULT", currentRankId: await a.rankId("WHITE"), currentStripes: "0", creationRequestId: "should-be-ignored" }),
    );
    expect(result.ok).toBe(true);
    expect(result.code).toMatch(/^\d{4}$/);
    const created = await prisma.student.findFirstOrThrow({ where: { email: `inactive-create-${suffix}@example.com` } });
    expect(created.creationRequestId).toBeNull();
    expect(created.creationFingerprint).toBeNull();
    expect(await ledgerCounts()).toEqual({ ...before, students: before.students + 1, statusChanges: before.statusChanges + 1, audits: before.audits + 1 });
  });
});

describe("the testable composition boundary (plan §3, §6, §7.6)", () => {
  it("approveStudent and createStudent carry no deps/activation/date parameter", () => {
    expect(approveStudent.length).toBe(3);
    expect(createStudent.length).toBe(3);
  });

  it("enrollmentChargeInTx is unreachable without injected deps", async () => {
    const result = await appPrisma.$transaction((tx) => enrollmentChargeInTx(tx, { context: context(), student: { id: "irrelevant", homeAcademyId: a.academy.id }, enrollmentDate: { year: 2030, month: 1, day: 1 }, assignedPlanId: null }, {}));
    expect(result).toEqual({ ok: false, error: "notActive" });
  });
});

describe("enrollmentChargeInTx: D13/D14/§7.2 worked examples", () => {
  it("before the due day: creates SIGNUP (due on enrollment) and that month's MONTHLY (due on the branch's due day)", async () => {
    const s = await newStudent("ACTIVE", "before-due");
    const enrollmentDate: CalendarDate = { year: 2031, month: 3, day: 3 }; // dueDay is 5
    const result = await appPrisma.$transaction((tx) => enrollmentChargeInTx(tx, { context: context(), student: { id: s.id, homeAcademyId: a.academy.id }, enrollmentDate, assignedPlanId: planA.id }, deps()));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.monthlyObligationId).not.toBeNull();
    const signup = await prisma.duesObligation.findUniqueOrThrow({ where: { id: result.signupObligationId } });
    expect(signup.type).toBe("SIGNUP");
    expect(signup.dueOn?.toISOString().slice(0, 10)).toBe("2031-03-03");
    expect(signup.graceDeadline).toBeNull();
    expect(signup.lateFeeAmount).toBeNull();
    expect(signup.policyVersionId).toBeNull();
    expect(signup.amount.toFixed(2)).toBe("150.00");
    expect(await prisma.duesCoverage.count({ where: { obligationId: signup.id } })).toBe(0);
    const monthly = await prisma.duesObligation.findUniqueOrThrow({ where: { id: result.monthlyObligationId! } });
    expect(monthly.type).toBe("MONTHLY");
    expect(monthly.dueOn?.toISOString().slice(0, 10)).toBe("2031-03-05");
    expect(await prisma.duesCoverage.count({ where: { obligationId: monthly.id } })).toBe(1);
  });

  it("on or after the due day: SIGNUP only, no MONTHLY for this month", async () => {
    const s = await newStudent("ACTIVE", "on-after-due");
    const result = await appPrisma.$transaction((tx) => enrollmentChargeInTx(tx, { context: context(), student: { id: s.id, homeAcademyId: a.academy.id }, enrollmentDate: { year: 2031, month: 4, day: 5 }, assignedPlanId: planA.id }, deps()));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.monthlyObligationId).toBeNull();
    expect(await prisma.duesObligation.count({ where: { studentId: s.id, type: "MONTHLY" } })).toBe(0);
  });

  it("at most one SIGNUP per student, ever — the database enforces it", async () => {
    const s = await newStudent("ACTIVE", "signup-once");
    await appPrisma.$transaction((tx) => enrollmentChargeInTx(tx, { context: context(), student: { id: s.id, homeAcademyId: a.academy.id }, enrollmentDate: { year: 2031, month: 6, day: 20 }, assignedPlanId: planA.id }, deps()));
    await expect(appPrisma.$transaction((tx) => enrollmentChargeInTx(tx, { context: context(), student: { id: s.id, homeAcademyId: a.academy.id }, enrollmentDate: { year: 2031, month: 7, day: 20 }, assignedPlanId: planA.id }, deps()))).rejects.toThrow();
    expect(await prisma.duesObligation.count({ where: { studentId: s.id, type: "SIGNUP" } })).toBe(1);
  });
});

describe("enrollmentChargeInTx: refusals, each distinct, each with zero writes", () => {
  it("no assignment at all: inapplicable, zero writes", async () => {
    const s = await newStudent("ACTIVE", "no-assignment");
    const before = await ledgerCounts();
    const result = await appPrisma.$transaction((tx) => enrollmentChargeInTx(tx, { context: context(), student: { id: s.id, homeAcademyId: a.academy.id }, enrollmentDate: { year: 2031, month: 8, day: 1 }, assignedPlanId: null }, deps()));
    expect(result).toEqual({ ok: false, error: "inapplicable" });
    expect(await ledgerCounts()).toEqual(before);
  });

  it("package-shaped plan: unsupportedEnrollmentPlan, zero writes — never 'proceeds, no charge'", async () => {
    const s = await newStudent("ACTIVE", "package-plan");
    const before = await ledgerCounts();
    const result = await appPrisma.$transaction((tx) => enrollmentChargeInTx(tx, { context: context(), student: { id: s.id, homeAcademyId: a.academy.id }, enrollmentDate: { year: 2031, month: 8, day: 1 }, assignedPlanId: packagePlan.id }, deps()));
    expect(result).toEqual({ ok: false, error: "unsupportedEnrollmentPlan" });
    expect(await ledgerCounts()).toEqual(before);
  });

  it("package-plan and missing-configuration are genuinely distinct error values", async () => {
    const s1 = await newStudent("ACTIVE", "distinct-1");
    const s2 = await newStudent("ACTIVE", "distinct-2");
    const r1 = await appPrisma.$transaction((tx) => enrollmentChargeInTx(tx, { context: context(), student: { id: s1.id, homeAcademyId: a.academy.id }, enrollmentDate: { year: 2031, month: 9, day: 1 }, assignedPlanId: packagePlan.id }, deps()));
    const r2 = await appPrisma.$transaction((tx) => enrollmentChargeInTx(tx, { context: context(), student: { id: s2.id, homeAcademyId: a.academy.id }, enrollmentDate: { year: 2031, month: 9, day: 1 }, assignedPlanId: null }, deps()));
    expect(r1.ok).toBe(false);
    expect(r2.ok).toBe(false);
    if (r1.ok || r2.ok) throw new Error("unreachable");
    expect(r1.error).not.toBe(r2.error);
  });

  it("a terms/policy currency mismatch refuses currencyMismatch", async () => {
    const crcPlan = await prisma.paymentPlan.create({ data: { organizationId: a.org.id, academyId: a.academy.id, name: `CRC plan ${suffix}` } });
    await prisma.paymentPlanTerms.create({ data: { organizationId: a.org.id, planId: crcPlan.id, effectiveYear: 2020, effectiveMonth: 1, priceAmount: "50000.00", currency: "CRC", monthsCovered: 1, createdById: a.admin.id } });
    const s = await newStudent("ACTIVE", "currency-mismatch");
    const result = await appPrisma.$transaction((tx) => enrollmentChargeInTx(tx, { context: context(), student: { id: s.id, homeAcademyId: a.academy.id }, enrollmentDate: { year: 2031, month: 10, day: 1 }, assignedPlanId: crcPlan.id }, deps()));
    expect(result).toEqual({ ok: false, error: "currencyMismatch" });
    await prisma.paymentPlanTerms.deleteMany({ where: { planId: crcPlan.id } });
    await prisma.paymentPlan.delete({ where: { id: crcPlan.id } });
  });
});

describe("approveStudentInTx: §7.6 plan-selection, authorization, and atomicity", () => {
  it("ADMIN, no existing assignment, valid plan: assignment + SIGNUP created atomically with approval", async () => {
    const s = await newStudent("PENDING", "approve-admin-assign");
    const before = await ledgerCounts();
    await appPrisma.$transaction((tx) => approveStudentInTx(tx, { context: context(), student: { id: s.id, organizationId: a.org.id, homeAcademyId: a.academy.id, timezone: a.academy.timezone, userId: null }, planId: planA.id }, deps({ now: at("2031-11-03T09:00:00") })));
    expect((await prisma.student.findUniqueOrThrow({ where: { id: s.id } })).status).toBe("ACTIVE");
    const after = await ledgerCounts();
    expect(after.assignments).toBe(before.assignments + 1);
    expect(after.obligations).toBeGreaterThan(before.obligations);
  });

  it("DIRECTOR, no existing assignment, plan supplied: refuses requiresAdmin, zero writes", async () => {
    const s = await newStudent("PENDING", "approve-director-refused");
    const before = await ledgerCounts();
    await expect(
      appPrisma.$transaction((tx) => approveStudentInTx(tx, { context: context({ organizationRole: "DIRECTOR" }), student: { id: s.id, organizationId: a.org.id, homeAcademyId: a.academy.id, timezone: a.academy.timezone, userId: null }, planId: planA.id }, deps({ now: at("2031-11-04T09:00:00") })))
    ).rejects.toBeInstanceOf(EnrollmentRefusedError);
    expect((await prisma.student.findUniqueOrThrow({ where: { id: s.id } })).status).toBe("PENDING");
    expect(await ledgerCounts()).toEqual(before);
  });

  it("existing assignment for the month: reused, no new assignment, a DIRECTOR may approve", async () => {
    const s = await newStudent("PENDING", "approve-reuse");
    await prisma.studentPlanAssignment.create({ data: { organizationId: a.org.id, studentId: s.id, planId: planA.id, effectiveYear: 2031, effectiveMonth: 12, createdById: a.admin.id } });
    const before = await ledgerCounts();
    await appPrisma.$transaction((tx) => approveStudentInTx(tx, { context: context({ organizationRole: "DIRECTOR" }), student: { id: s.id, organizationId: a.org.id, homeAcademyId: a.academy.id, timezone: a.academy.timezone, userId: null }, planId: null }, deps({ now: at("2031-12-03T09:00:00") })));
    expect((await prisma.student.findUniqueOrThrow({ where: { id: s.id } })).status).toBe("ACTIVE");
    expect((await ledgerCounts()).assignments).toBe(before.assignments); // reused, not duplicated
  });

  it("existing assignment present, a DIFFERENT plan supplied: refuses planConflict, original assignment unchanged", async () => {
    const s = await newStudent("PENDING", "approve-conflict");
    const original = await prisma.studentPlanAssignment.create({ data: { organizationId: a.org.id, studentId: s.id, planId: planA.id, effectiveYear: 2032, effectiveMonth: 1, createdById: a.admin.id } });
    const otherPlan = await prisma.paymentPlan.create({ data: { organizationId: a.org.id, academyId: a.academy.id, name: `Conflict plan ${suffix}` } });
    await expect(
      appPrisma.$transaction((tx) => approveStudentInTx(tx, { context: context(), student: { id: s.id, organizationId: a.org.id, homeAcademyId: a.academy.id, timezone: a.academy.timezone, userId: null }, planId: otherPlan.id }, deps({ now: at("2032-01-03T09:00:00") })))
    ).rejects.toBeInstanceOf(EnrollmentRefusedError);
    const unchanged = await prisma.studentPlanAssignment.findUniqueOrThrow({ where: { id: original.id } });
    expect(unchanged.planId).toBe(planA.id);
    await prisma.paymentPlan.delete({ where: { id: otherPlan.id } });
  });

  it("package-shaped plan via approval: refuses unsupportedEnrollmentPlan, zero writes (not 'proceeds, no charge')", async () => {
    const s = await newStudent("PENDING", "approve-package");
    const before = await ledgerCounts();
    await expect(
      appPrisma.$transaction((tx) => approveStudentInTx(tx, { context: context(), student: { id: s.id, organizationId: a.org.id, homeAcademyId: a.academy.id, timezone: a.academy.timezone, userId: null }, planId: packagePlan.id }, deps({ now: at("2032-02-03T09:00:00") })))
    ).rejects.toThrow();
    expect((await prisma.student.findUniqueOrThrow({ where: { id: s.id } })).status).toBe("PENDING");
    expect(await ledgerCounts()).toEqual(before);
  });

  it("missing configuration (no plan at all): refuses the WHOLE approval, zero writes", async () => {
    const s = await newStudent("PENDING", "approve-no-config");
    const before = await ledgerCounts();
    await expect(
      appPrisma.$transaction((tx) => approveStudentInTx(tx, { context: context(), student: { id: s.id, organizationId: a.org.id, homeAcademyId: a.academy.id, timezone: a.academy.timezone, userId: null }, planId: null }, deps({ now: at("2032-03-03T09:00:00") })))
    ).rejects.toThrow();
    expect((await prisma.student.findUniqueOrThrow({ where: { id: s.id } })).status).toBe("PENDING");
    expect(await ledgerCounts()).toEqual(before);
  });

  it("via the real approveStudent action end-to-end: the forged-plan/foreign-branch/package cases reuse resolvePlanId and refuse with zero writes", async () => {
    const s = await newStudent("PENDING", "approve-e2e-forged");
    const before = await ledgerCounts();
    const result = await approveStudent(a.org.id, {}, form({ studentId: s.id, planId: "forged-id" }));
    expect(result.error).toBe("invalid");
    expect(await ledgerCounts()).toEqual(before);
  });
});

describe("createStudentCore: §7.6 plan-selection, authorization, and §7.7 submission idempotency", () => {
  const baseData = (overrides: Record<string, unknown> = {}) => ({
    firstName: "Core", lastName: "Student", phone: "1", email: `core-${Math.random()}-${suffix}@example.com`, homeAcademyId: a.academy.id,
    track: "ADULT" as const, currentRankId: "", currentStripes: 0, ...overrides,
  });
  async function coreArgs(overrides: Record<string, unknown> = {}, over: Record<string, unknown> = {}) {
    const rankId = await a.rankId("WHITE");
    const data = baseData({ currentRankId: rankId, ...overrides });
    return {
      context: context(), academy: { organizationId: a.org.id, timezone: a.academy.timezone }, data, rank: { id: rankId, code: "WHITE" },
      codeHash: `core-${Math.random()}-${suffix}`, beltAwardedAt: new Date(), planId: null, creationRequestId: null, fingerprint: {},
      ...over,
    };
  }

  it("ADMIN with a valid plan: student + assignment + SIGNUP created atomically", async () => {
    const args = await coreArgs({}, { planId: planA.id, fingerprint: { planId: planA.id } });
    const before = await ledgerCounts();
    const result = await createStudentCore(args as never, deps({ now: at("2032-04-03T09:00:00") }));
    expect(result.ok).toBe(true);
    const after = await ledgerCounts();
    expect(after.students).toBe(before.students + 1);
    expect(after.assignments).toBe(before.assignments + 1);
    expect(after.obligations).toBeGreaterThan(before.obligations);
  });

  it("DIRECTOR with a plan supplied: refuses requiresAdmin, zero writes (not even the student row)", async () => {
    const args = await coreArgs({}, { context: context({ organizationRole: "DIRECTOR" }), planId: planA.id, fingerprint: { planId: planA.id } });
    const before = await ledgerCounts();
    const result = await createStudentCore(args as never, deps({ now: at("2032-04-04T09:00:00") }));
    expect(result).toEqual({ ok: false, error: "requiresAdmin" });
    expect(await ledgerCounts()).toEqual(before);
  });

  it("package plan: refuses unsupportedEnrollmentPlan, zero writes", async () => {
    const args = await coreArgs({}, { planId: packagePlan.id, fingerprint: { planId: packagePlan.id } });
    const before = await ledgerCounts();
    const result = await createStudentCore(args as never, deps({ now: at("2032-04-05T09:00:00") }));
    expect(result).toEqual({ ok: false, error: "unsupportedEnrollmentPlan" });
    expect(await ledgerCounts()).toEqual(before);
  });

  it("no plan supplied while active: refuses inapplicable (configuration gap), zero writes", async () => {
    const args = await coreArgs();
    const before = await ledgerCounts();
    const result = await createStudentCore(args as never, deps({ now: at("2032-04-06T09:00:00") }));
    expect(result).toEqual({ ok: false, error: "inapplicable" });
    expect(await ledgerCounts()).toEqual(before);
  });

  it("billing inactive: creationRequestId/fingerprint stay unset even when supplied", async () => {
    const args = await coreArgs({}, { creationRequestId: `req-${suffix}-inactive`, fingerprint: { x: 1 } });
    const result = await createStudentCore(args as never, {}); // default deps => inactive
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    const row = await prisma.student.findUniqueOrThrow({ where: { id: result.studentId } });
    expect(row.creationRequestId).toBeNull();
    expect(row.creationFingerprint).toBeNull();
  });

  it("same creationRequestId, identical data, two sequential calls: exactly one Student row, both calls report success", async () => {
    const key = `req-${suffix}-retry-identical`;
    const email = `retry-identical-${suffix}@example.com`;
    const args = { ...(await coreArgs({ email }, { creationRequestId: key, planId: planA.id })) };
    const fp = { email, firstName: "Core", lastName: "Student", planId: planA.id };
    const first = await createStudentCore({ ...args, fingerprint: fp } as never, deps({ now: at("2032-05-01T09:00:00") }));
    const second = await createStudentCore({ ...args, codeHash: `${args.codeHash}-retry`, fingerprint: fp } as never, deps({ now: at("2032-05-01T09:05:00") }));
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) throw new Error("unreachable");
    expect(second.studentId).toBe(first.studentId);
    expect(second.alreadyCreated).toBe(true);
    expect(await prisma.student.count({ where: { organizationId: a.org.id, email } })).toBe(1);
  });

  it("same creationRequestId, CONFLICTING data: refuses explicitly, original row unchanged", async () => {
    const key = `req-${suffix}-retry-conflict`;
    const email = `retry-conflict-${suffix}@example.com`;
    const args = await coreArgs({ email }, { creationRequestId: key, planId: planA.id });
    const first = await createStudentCore({ ...args, fingerprint: { email, firstName: "Core", planId: planA.id } } as never, deps({ now: at("2032-05-02T09:00:00") }));
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("unreachable");
    const second = await createStudentCore({ ...args, codeHash: `${args.codeHash}-2`, fingerprint: { email, firstName: "DIFFERENT", planId: planA.id } } as never, deps({ now: at("2032-05-02T09:05:00") }));
    expect(second).toEqual({ ok: false, error: "conflictingResubmission" });
    expect(await prisma.student.count({ where: { organizationId: a.org.id, email } })).toBe(1);
  });

  it("different creationRequestIds, similar data: two separate students are created", async () => {
    const email1 = `different-key-1-${suffix}@example.com`;
    const email2 = `different-key-2-${suffix}@example.com`;
    const args1 = await coreArgs({ email: email1, firstName: "Same" }, { creationRequestId: `req-${suffix}-a`, planId: planA.id });
    const args2 = await coreArgs({ email: email2, firstName: "Same" }, { creationRequestId: `req-${suffix}-b`, planId: planA.id });
    const r1 = await createStudentCore({ ...args1, fingerprint: { email: email1, firstName: "Same", planId: planA.id } } as never, deps({ now: at("2032-05-03T09:00:00") }));
    const r2 = await createStudentCore({ ...args2, fingerprint: { email: email2, firstName: "Same", planId: planA.id } } as never, deps({ now: at("2032-05-03T09:01:00") }));
    expect(r1.ok && r2.ok).toBe(true);
    if (!r1.ok || !r2.ok) throw new Error("unreachable");
    expect(r1.studentId).not.toBe(r2.studentId);
  });

  it("retry AFTER the created student's mutable fields were edited: still recognized via the stored fingerprint, not current fields", async () => {
    const key = `req-${suffix}-retry-after-edit`;
    const email = `retry-after-edit-${suffix}@example.com`;
    const args = await coreArgs({ email }, { creationRequestId: key, planId: planA.id });
    const first = await createStudentCore({ ...args, fingerprint: { email, firstName: "Core", planId: planA.id } } as never, deps({ now: at("2032-05-04T09:00:00") }));
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("unreachable");
    await prisma.student.update({ where: { id: first.studentId }, data: { firstName: "EditedByStaff" } });
    const second = await createStudentCore({ ...args, codeHash: `${args.codeHash}-2`, fingerprint: { email, firstName: "Core", planId: planA.id } } as never, deps({ now: at("2032-05-04T09:05:00") }));
    expect(second).toEqual({ ok: true, studentId: first.studentId, alreadyCreated: true });
  });

  it("same creationRequestId reused across two different organizations: no collision", async () => {
    const b = await makeAccountingOrg("CUMULATIVE", "enroll-b");
    try {
      const key = `req-${suffix}-cross-org`;
      const emailA = `cross-org-a-${suffix}@example.com`;
      const emailB = `cross-org-b-${suffix}@example.com`;
      const argsA = await coreArgs({ email: emailA }, { creationRequestId: key, planId: planA.id });
      const rankB = await b.rankId("WHITE");
      const argsB = {
        context: context({ organizationId: b.org.id, actorUserId: b.admin.id }), academy: { organizationId: b.org.id, timezone: b.academy.timezone },
        data: baseData({ email: emailB, homeAcademyId: b.academy.id, currentRankId: rankB }), rank: { id: rankB, code: "WHITE" },
        codeHash: `cross-org-b-${suffix}`, beltAwardedAt: new Date(), planId: null, creationRequestId: key, fingerprint: { email: emailB },
      };
      const rA = await createStudentCore({ ...argsA, fingerprint: { email: emailA, planId: planA.id } } as never, deps({ now: at("2032-05-05T09:00:00") }));
      // Org B's own billing stays inactive for this test (no fixture configuration exists there) — proving the
      // composite scoping, not a second active-billing path; `planId: null` + default deps is already covered above.
      const rB = await createStudentCore(argsB as never, {});
      expect(rA.ok && rB.ok).toBe(true);
      if (!rA.ok || !rB.ok) throw new Error("unreachable");
      expect(rA.studentId).not.toBe(rB.studentId);
    } finally {
      await b.drop();
    }
  });

  it("an unrelated unique violation (codeHash collision) is NOT misclassified as a creationRequestId retry", async () => {
    const sharedCodeHash = `collide-${suffix}`;
    const email1 = `collide-1-${suffix}@example.com`;
    const email2 = `collide-2-${suffix}@example.com`;
    const args1 = await coreArgs({ email: email1 }, { codeHash: sharedCodeHash, creationRequestId: `req-${suffix}-collide-1`, planId: planA.id, fingerprint: { email: email1, planId: planA.id } });
    const first = await createStudentCore(args1 as never, deps({ now: at("2032-05-06T09:00:00") }));
    expect(first.ok).toBe(true);
    const args2 = await coreArgs({ email: email2 }, { codeHash: sharedCodeHash, creationRequestId: `req-${suffix}-collide-2`, planId: planA.id, fingerprint: { email: email2, planId: planA.id } });
    await expect(createStudentCore(args2 as never, deps({ now: at("2032-05-06T09:01:00") }))).rejects.toThrow();
    expect(await prisma.student.count({ where: { organizationId: a.org.id, email: email2 } })).toBe(0);
  });

  it("GENUINE CONCURRENT submission of the same creationRequestId: exactly one student is created, the loser recovers the winner's result", async () => {
    const key = `req-${suffix}-concurrent`;
    const email = `concurrent-${suffix}@example.com`;
    const args1 = await coreArgs({ email }, { creationRequestId: key, planId: planA.id, fingerprint: { email, planId: planA.id } });
    const args2 = await coreArgs({ email }, { creationRequestId: key, planId: planA.id, fingerprint: { email, planId: planA.id } });
    const [r1, r2] = await Promise.all([
      createStudentCore(args1 as never, deps({ now: at("2032-05-07T09:00:00") })),
      createStudentCore(args2 as never, deps({ now: at("2032-05-07T09:00:00") })),
    ]);
    expect(r1.ok && r2.ok).toBe(true);
    if (!r1.ok || !r2.ok) throw new Error("unreachable");
    expect(r1.studentId).toBe(r2.studentId);
    expect([r1.alreadyCreated, r2.alreadyCreated].sort()).toEqual([false, true]);
    expect(await prisma.student.count({ where: { organizationId: a.org.id, email } })).toBe(1);
  });
});

describe("SIGNUP consumer-path audit: a SIGNUP-only enrollment month must not be treated as already covered", () => {
  it("firstUncoveredFrom (prepay-monthly.ts, shared with purchasePackage) skips a SIGNUP row, never mistaking it for real coverage", async () => {
    const s = await newStudent("ACTIVE", "signup-firstuncovered");
    // on/after the due day: SIGNUP only, no MONTHLY, no DuesCoverage row for this month
    const enrollmentDate: CalendarDate = { year: 2033, month: 1, day: 20 };
    const result = await appPrisma.$transaction((tx) => enrollmentChargeInTx(tx, { context: context(), student: { id: s.id, homeAcademyId: a.academy.id }, enrollmentDate, assignedPlanId: planA.id }, deps()));
    expect(result.ok).toBe(true);
    expect(await prisma.duesCoverage.count({ where: { studentId: s.id, year: 2033, month: 1 } })).toBe(0);
    // Before the fix, firstUncoveredFrom would have found this SIGNUP row by coverageYear/coverageMonth alone and
    // wrongly treated January 2033 as already covered, skipping straight to February.
    const uncovered = await appPrisma.$transaction((tx) => firstUncoveredFrom(tx, a.org.id, s.id, { year: 2033, month: 1 }, { year: 2033, month: 12 }));
    expect(uncovered).toEqual({ year: 2033, month: 1 });
  });

  it("checkPackageCoverageAvailableInTx (purchase-package.ts) does not refuse a package starting in the student's own SIGNUP-only enrollment month", async () => {
    const s = await newStudent("ACTIVE", "signup-package-avail");
    const enrollmentDate: CalendarDate = { year: 2033, month: 2, day: 20 };
    const result = await appPrisma.$transaction((tx) => enrollmentChargeInTx(tx, { context: context(), student: { id: s.id, homeAcademyId: a.academy.id }, enrollmentDate, assignedPlanId: planA.id }, deps()));
    expect(result.ok).toBe(true);
    // Before the fix, this would have returned { ok: false } — a package genuinely purchasable this month wrongly
    // refused because the student's own SIGNUP obligation happens to share this coverageYear/coverageMonth.
    const available = await appPrisma.$transaction((tx) => checkPackageCoverageAvailableInTx(tx, { organizationId: a.org.id, studentId: s.id, startMonth: { year: 2033, month: 2 }, monthsCovered: 3 }));
    expect(available).toEqual({ ok: true });
  });
});

describe("via the real createStudent action end-to-end", () => {
  it("billing inactive: unchanged success shape, a real check-in code is returned", async () => {
    const email = `e2e-inactive-${suffix}@example.com`;
    const result = await createStudent(
      a.org.id, {},
      form({ firstName: "E2E", lastName: "Inactive", phone: "1", email, homeAcademyId: a.academy.id, track: "ADULT", currentRankId: await a.rankId("WHITE"), currentStripes: "0" }),
    );
    expect(result.ok).toBe(true);
    expect(result.code).toMatch(/^\d{4}$/);
    expect(result.alreadyCreated).toBeUndefined();
  });
});
