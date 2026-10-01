import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getTestPrismaClient } from "../helpers/test-db";
import { prisma as appPrisma } from "../../src/lib/prisma";
import { makeAccountingOrg } from "../helpers/accounting-org";
import type { TenantContext } from "../../src/lib/tenant/types";
import type { LedgerActivation } from "../../src/lib/dues/ledger/activation";
import { resumeChargeInTx } from "../../src/lib/dues/ledger/resume-charge";
import { writeMonthlyObligationInTx } from "../../src/lib/dues/ledger/create-monthly-obligation";
import type { CalendarDate } from "../../src/lib/dues/calendar";

// resumeStudent (a real server action) calls resolveActionContext -> auth(), which needs a Next.js request scope that
// doesn't exist here — mocked exactly as prepay-monthly.test.ts/student-status-history.test.ts already do.
let currentSession: { user: { id: string; role: string } } | null = null;
vi.mock("@/auth", () => ({ auth: () => Promise.resolve(currentSession), signIn: vi.fn() }));
const { resumeStudent } = await import("../../src/app/[locale]/(staff)/students/[id]/actions");

/**
 * Enrollment/resume integration plan §2-§6, resume scope only: `resumeChargeInTx`'s gated financial
 * path, and `resumeStudent`'s own composition of it, proved against the REAL test database.
 * `resumeStudent`'s own pre-existing test suite (student-status-history.test.ts: precondition
 * refusal, same-day ordering, the existing concurrency proof) is untouched by this file.
 */
const prisma = getTestPrismaClient();
type Fixture = Awaited<ReturnType<typeof makeAccountingOrg>>;
const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
const ACTIVE: LedgerActivation = { isActive: async () => true };
const at = (isoLocal: string) => () => new Date(`${isoLocal}-06:00`); // Costa Rica, UTC-6 all year, matching prepay-monthly.test.ts
const deps = (extra: Record<string, unknown> = {}) => ({ activation: ACTIVE, ...extra });

let a: Fixture;
let planA: { id: string };
let termsA: { id: string }; // dueDay 20
let policyA: { id: string }; // dueDay 20, graceDay 5

function context(over: Partial<TenantContext> = {}): TenantContext {
  return { kind: "tenant", actorUserId: a.admin.id, organizationId: a.org.id, organizationRole: "ADMIN", academyIds: "ALL", selfStudentId: null, linkedStudentId: null, ...over };
}

let studentCounter = 0;
async function newStudent(status: "ACTIVE" | "INACTIVE", label: string) {
  const n = ++studentCounter;
  return prisma.student.create({
    data: {
      organizationId: a.org.id, homeAcademyId: a.academy.id, firstName: "Resume", lastName: `${label}${n}`, phone: "00000000",
      email: `resume-${label}-${n}-${suffix}@example.com`, currentRankId: await a.rankId("WHITE"), codeHash: `resume-${label}-${n}-${suffix}`, status,
    },
  });
}

async function assign(studentId: string, planId: string | null, effectiveYear = 2020, effectiveMonth = 1) {
  return prisma.studentPlanAssignment.create({ data: { organizationId: a.org.id, studentId, planId, effectiveYear, effectiveMonth, createdById: a.admin.id } });
}

async function ledgerCounts() {
  return {
    obligations: await prisma.duesObligation.count({ where: { organizationId: a.org.id } }),
    coverage: await prisma.duesCoverage.count({ where: { organizationId: a.org.id } }),
    statusChanges: await prisma.studentStatusChange.count({ where: { organizationId: a.org.id } }),
    audits: await prisma.auditLog.count({ where: { organizationId: a.org.id } }),
  };
}

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) fd.set(key, value);
  return fd;
}

/** Waits until Postgres reports a session genuinely blocked on a lock matching every string in `matches` — the
 * established pattern, reused verbatim from prepay-monthly.test.ts/dues-ledger-writers.test.ts. */
async function waitUntilBlockedOnLock(matches: string[], timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = await prisma.$queryRawUnsafe<{ query: string }[]>(`SELECT query FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query IS NOT NULL`);
    if (rows.some((row) => matches.every((m) => row.query.includes(m)))) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

beforeAll(async () => {
  a = await makeAccountingOrg("CUMULATIVE", "resume-a");
  currentSession = { user: { id: a.admin.id, role: "ADMIN" } };
  const plan = await prisma.paymentPlan.create({ data: { organizationId: a.org.id, academyId: a.academy.id, name: `Resume plan ${suffix}` } });
  planA = plan;
  termsA = await prisma.paymentPlanTerms.create({
    data: { organizationId: a.org.id, planId: plan.id, effectiveYear: 2020, effectiveMonth: 1, priceAmount: "100.00", currency: "USD", monthsCovered: 1, createdById: a.admin.id },
  });
  policyA = await prisma.duesPolicyVersion.create({
    data: { organizationId: a.org.id, academyId: a.academy.id, effectiveYear: 2020, effectiveMonth: 1, dueDay: 20, graceDay: 5, lateFeeAmount: "20.00", lateFeeCurrency: "USD", maxPrepaidMonths: 3, createdById: a.admin.id },
  });
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
  await prisma.paymentPlanTerms.deleteMany({ where: { organizationId: a.org.id } });
  await prisma.duesPolicyVersion.deleteMany({ where: { organizationId: a.org.id } });
  await prisma.paymentPlan.deleteMany({ where: { organizationId: a.org.id } });
  await a.drop();
});

describe("billing inactive: resumeStudent is byte-identical to before this PR", () => {
  it("resumes a student with zero writes to any dues ledger table", async () => {
    const s = await newStudent("INACTIVE", "inactive");
    const before = await ledgerCounts();
    const result = await resumeStudent(a.org.id, {}, form({ studentId: s.id }));
    expect(result).toEqual({ ok: true });
    const after = await prisma.student.findUniqueOrThrow({ where: { id: s.id } });
    expect(after.status).toBe("ACTIVE");
    // gated branch is unreachable in production (default deps) — only StudentStatusChange/audit change, never the ledger.
    expect(await ledgerCounts()).toEqual({ ...before, statusChanges: before.statusChanges + 1, audits: before.audits + 1 });
  });
});

describe("the testable composition boundary (plan §3, §6)", () => {
  it("resumeStudent's own exported signature carries no deps/activation/date parameter", () => {
    // Fixed server-action signature: (organizationId, prevState, formData) — arity 3, nothing more.
    expect(resumeStudent.length).toBe(3);
  });

  it("resumeChargeInTx is the separate, deps-injectable core — production never reaches its gated branch", async () => {
    const s = await newStudent("INACTIVE", "boundary");
    const result = await appPrisma.$transaction((tx) => resumeChargeInTx(tx, { context: context(), student: { id: s.id, homeAcademyId: a.academy.id } }, {}));
    // default deps ({}) => inactiveLedgerActivation => "notActive", before any lock — proving the gated branch is
    // structurally unreachable without an explicit, test-only deps override.
    expect(result).toEqual({ ok: false, error: "notActive" });
    await prisma.student.update({ where: { id: s.id }, data: { status: "INACTIVE" } }); // resumeChargeInTx took no lock, nothing to undo besides this
  });
});

describe("billing active: configuration resolves, month not yet covered", () => {
  it("resume succeeds, creates one obligation with dueOn = max(normal due date, resume date), graceDeadline unchanged", async () => {
    const s = await newStudent("INACTIVE", "newcharge");
    await assign(s.id, planA.id);
    // Resume on the 25th — AFTER the policy's dueDay (20) — so minimumDueOn must actually raise dueOn past the normal date.
    const result = await appPrisma.$transaction((tx) =>
      resumeChargeInTx(tx, { context: context(), student: { id: s.id, homeAcademyId: a.academy.id } }, deps({ now: at("2030-06-25T12:00:00") })),
    );
    expect(result).toEqual({ ok: true });
    const student = await prisma.student.findUniqueOrThrow({ where: { id: s.id } });
    expect(student.status).toBe("ACTIVE");
    const obligation = await prisma.duesObligation.findFirstOrThrow({ where: { organizationId: a.org.id, studentId: s.id, coverageYear: 2030, coverageMonth: 6 } });
    expect(obligation.dueOn!.toISOString().slice(0, 10)).toBe("2030-06-25"); // raised past the normal 20th
    expect(obligation.graceDeadline!.toISOString().slice(0, 10)).toBe("2030-07-05"); // policy's own grace day, never recomputed
    const history = await prisma.studentStatusChange.findFirst({ where: { organizationId: a.org.id, studentId: s.id, status: "ACTIVE" } });
    expect(history?.effectiveOn.toISOString().slice(0, 10)).toBe("2030-06-25");
    const audit = await prisma.auditLog.count({ where: { organizationId: a.org.id, entityId: s.id, action: "student.resume" } });
    expect(audit).toBe(1);
  });

  it("a resume date on or before the normal due date does not lower it", async () => {
    const s = await newStudent("INACTIVE", "earlycharge");
    await assign(s.id, planA.id);
    const result = await appPrisma.$transaction((tx) =>
      resumeChargeInTx(tx, { context: context(), student: { id: s.id, homeAcademyId: a.academy.id } }, deps({ now: at("2030-07-10T12:00:00") })),
    );
    expect(result).toEqual({ ok: true });
    const obligation = await prisma.duesObligation.findFirstOrThrow({ where: { organizationId: a.org.id, studentId: s.id, coverageYear: 2030, coverageMonth: 7 } });
    expect(obligation.dueOn!.toISOString().slice(0, 10)).toBe("2030-07-20"); // the normal due date, never lowered by an earlier resume date
  });
});

describe("billing active: the month is already covered", () => {
  it("an existing MONTHLY for that month: resume succeeds, that obligation stays completely unchanged", async () => {
    const s = await newStudent("INACTIVE", "existingmonthly");
    await assign(s.id, planA.id);
    const existing = await prisma.duesObligation.create({
      data: {
        organizationId: a.org.id, studentId: s.id, academyId: a.academy.id, type: "MONTHLY", origin: "STAFF",
        coverageYear: 2030, coverageMonth: 8, monthsCovered: 1, amount: "100.00", currency: "USD", lateFeeAmount: "20.00",
        dueOn: new Date(Date.UTC(2030, 7, 20)), graceDeadline: new Date(Date.UTC(2030, 8, 5)), planTermsId: termsA.id, policyVersionId: policyA.id, createdById: a.admin.id,
      },
    });
    const result = await appPrisma.$transaction((tx) =>
      resumeChargeInTx(tx, { context: context(), student: { id: s.id, homeAcademyId: a.academy.id } }, deps({ now: at("2030-08-15T12:00:00") })),
    );
    expect(result).toEqual({ ok: true });
    const count = await prisma.duesObligation.count({ where: { organizationId: a.org.id, studentId: s.id, coverageYear: 2030, coverageMonth: 8 } });
    expect(count).toBe(1); // never a second obligation
    const after = await prisma.duesObligation.findUniqueOrThrow({ where: { id: existing.id } });
    expect(after.dueOn).toEqual(existing.dueOn); // completely unchanged — never re-dated
    expect(after.amount).toEqual(existing.amount);
  });

  it("package coverage for that month: resume succeeds, no new obligation of any kind", async () => {
    const s = await newStudent("INACTIVE", "existingpackage");
    await assign(s.id, planA.id);
    // A SEPARATE plan/terms for the pre-seeded package row — planA's own terms history (termsA, monthsCovered: 1,
    // relied on by every other test in this file) must stay untouched by this fixture's own monthsCovered: 2 shape.
    const pkgPlan = await prisma.paymentPlan.create({ data: { organizationId: a.org.id, academyId: a.academy.id, name: `Resume pkg plan ${suffix}` } });
    const packageTerms = await prisma.paymentPlanTerms.create({
      data: { organizationId: a.org.id, planId: pkgPlan.id, effectiveYear: 2020, effectiveMonth: 1, priceAmount: "180.00", currency: "USD", monthsCovered: 2, createdById: a.admin.id },
    });
    const pkgObligation = await prisma.duesObligation.create({
      data: {
        organizationId: a.org.id, studentId: s.id, academyId: a.academy.id, type: "PACKAGE", origin: "STAFF",
        coverageYear: 2030, coverageMonth: 9, monthsCovered: 2, amount: "180.00", currency: "USD", planTermsId: packageTerms.id, createdById: a.admin.id,
      },
    });
    await prisma.duesCoverage.create({ data: { organizationId: a.org.id, studentId: s.id, obligationId: pkgObligation.id, year: 2030, month: 9 } });
    const before = await prisma.duesObligation.count({ where: { organizationId: a.org.id } });
    const result = await appPrisma.$transaction((tx) =>
      resumeChargeInTx(tx, { context: context(), student: { id: s.id, homeAcademyId: a.academy.id } }, deps({ now: at("2030-09-10T12:00:00") })),
    );
    expect(result).toEqual({ ok: true });
    expect(await prisma.duesObligation.count({ where: { organizationId: a.org.id } })).toBe(before); // no new row
    const status = await prisma.student.findUniqueOrThrow({ where: { id: s.id } });
    expect(status.status).toBe("ACTIVE");
  });
});

describe("billing active: a genuine configuration gap refuses the WHOLE attempt", () => {
  it("no plan assignment at all: refuses, status/history/audit/ledger all stay unchanged", async () => {
    const s = await newStudent("INACTIVE", "noassignment");
    // deliberately no assign() call
    const before = await ledgerCounts();
    const result = await appPrisma.$transaction((tx) =>
      resumeChargeInTx(tx, { context: context(), student: { id: s.id, homeAcademyId: a.academy.id } }, deps({ now: at("2030-10-05T12:00:00") })),
    );
    expect(result).toEqual({ ok: false, error: "inapplicable" });
    const after = await prisma.student.findUniqueOrThrow({ where: { id: s.id } });
    expect(after.status).toBe("INACTIVE"); // never proceeded — the config-gap reversal of the earlier "proceed unbilled" draft
    expect(await ledgerCounts()).toEqual(before);
  });

  it("explicitly unassigned (planId: null): refuses the same way, not silently treated as covered", async () => {
    const s = await newStudent("INACTIVE", "unassigned");
    await assign(s.id, null);
    const before = await ledgerCounts();
    const result = await appPrisma.$transaction((tx) =>
      resumeChargeInTx(tx, { context: context(), student: { id: s.id, homeAcademyId: a.academy.id } }, deps({ now: at("2030-10-05T12:00:00") })),
    );
    expect(result).toEqual({ ok: false, error: "inapplicable" });
    expect(await ledgerCounts()).toEqual(before);
  });

  it("a genuine refusal from writeMonthlyObligationInTx itself (currencyMismatch) refuses the whole attempt, not just resume-charge's own pre-checks", async () => {
    const s = await newStudent("INACTIVE", "currencymismatch");
    const mismatchPlan = await prisma.paymentPlan.create({ data: { organizationId: a.org.id, academyId: a.academy.id, name: `Resume mismatch plan ${suffix}` } });
    await prisma.paymentPlanTerms.create({
      data: { organizationId: a.org.id, planId: mismatchPlan.id, effectiveYear: 2020, effectiveMonth: 1, priceAmount: "50000.00", currency: "CRC", monthsCovered: 1, createdById: a.admin.id },
    });
    await assign(s.id, mismatchPlan.id);
    const before = await ledgerCounts();
    const result = await appPrisma.$transaction((tx) =>
      resumeChargeInTx(tx, { context: context(), student: { id: s.id, homeAcademyId: a.academy.id } }, deps({ now: at("2030-10-05T12:00:00") })),
    );
    // policyA's own lateFeeCurrency is USD; this plan's terms are CRC — writeMonthlyObligationInTx's own
    // currencyMismatch check, not any of resume-charge.ts's own earlier pre-checks.
    expect(result).toEqual({ ok: false, error: "currencyMismatch" });
    const after = await prisma.student.findUniqueOrThrow({ where: { id: s.id } });
    expect(after.status).toBe("INACTIVE");
    expect(await ledgerCounts()).toEqual(before);
  });
});

describe("coverage precedence (second review round): existing coverage is checked BEFORE any hypothetical new charge's own configuration", () => {
  it("existing MONTHLY for the month, but NO assignment at all: resume succeeds (the exact bug this fix corrects — the old order resolved assignment first and wrongly refused `inapplicable`)", async () => {
    const s = await newStudent("INACTIVE", "monthlynoassign");
    // deliberately no assign() call
    const existing = await prisma.duesObligation.create({
      data: {
        organizationId: a.org.id, studentId: s.id, academyId: a.academy.id, type: "MONTHLY", origin: "STAFF",
        coverageYear: 2031, coverageMonth: 1, monthsCovered: 1, amount: "100.00", currency: "USD", lateFeeAmount: "20.00",
        dueOn: new Date(Date.UTC(2031, 0, 20)), graceDeadline: new Date(Date.UTC(2031, 1, 5)), planTermsId: termsA.id, policyVersionId: policyA.id, createdById: a.admin.id,
      },
    });
    const before = await ledgerCounts();
    const result = await appPrisma.$transaction((tx) =>
      resumeChargeInTx(tx, { context: context(), student: { id: s.id, homeAcademyId: a.academy.id } }, deps({ now: at("2031-01-10T12:00:00") })),
    );
    expect(result).toEqual({ ok: true });
    const after = await prisma.student.findUniqueOrThrow({ where: { id: s.id } });
    expect(after.status).toBe("ACTIVE");
    const unchanged = await prisma.duesObligation.findUniqueOrThrow({ where: { id: existing.id } });
    expect(unchanged.dueOn).toEqual(existing.dueOn);
    expect(unchanged.amount).toEqual(existing.amount);
    expect(await ledgerCounts()).toEqual({ ...before, statusChanges: before.statusChanges + 1, audits: before.audits + 1 });
  });

  it("existing package coverage for the month, but explicitly unassigned (planId: null): resume succeeds, no new obligation of any kind", async () => {
    const s = await newStudent("INACTIVE", "pkgnoassign");
    await assign(s.id, null);
    const pkgPlan = await prisma.paymentPlan.create({ data: { organizationId: a.org.id, academyId: a.academy.id, name: `Resume pkg2 plan ${suffix}` } });
    const packageTerms = await prisma.paymentPlanTerms.create({
      data: { organizationId: a.org.id, planId: pkgPlan.id, effectiveYear: 2020, effectiveMonth: 1, priceAmount: "180.00", currency: "USD", monthsCovered: 2, createdById: a.admin.id },
    });
    const pkgObligation = await prisma.duesObligation.create({
      data: {
        organizationId: a.org.id, studentId: s.id, academyId: a.academy.id, type: "PACKAGE", origin: "STAFF",
        coverageYear: 2031, coverageMonth: 2, monthsCovered: 2, amount: "180.00", currency: "USD", planTermsId: packageTerms.id, createdById: a.admin.id,
      },
    });
    await prisma.duesCoverage.create({ data: { organizationId: a.org.id, studentId: s.id, obligationId: pkgObligation.id, year: 2031, month: 2 } });
    const before = await ledgerCounts();
    const result = await appPrisma.$transaction((tx) =>
      resumeChargeInTx(tx, { context: context(), student: { id: s.id, homeAcademyId: a.academy.id } }, deps({ now: at("2031-02-10T12:00:00") })),
    );
    expect(result).toEqual({ ok: true });
    expect(await ledgerCounts()).toEqual({ ...before, statusChanges: before.statusChanges + 1, audits: before.audits + 1 });
  });

  it("existing coverage from a PREPAYMENT-origin obligation, with an assignment whose terms can't resolve at all: resume succeeds anyway", async () => {
    const s = await newStudent("INACTIVE", "prepaidnoterms");
    const noTermsPlan = await prisma.paymentPlan.create({ data: { organizationId: a.org.id, academyId: a.academy.id, name: `Resume noterms plan ${suffix}` } });
    await assign(s.id, noTermsPlan.id); // assigned, but this plan has NO terms rows at all — unresolvable if ever reached
    const existing = await prisma.duesObligation.create({
      data: {
        organizationId: a.org.id, studentId: s.id, academyId: a.academy.id, type: "MONTHLY", origin: "PREPAYMENT",
        coverageYear: 2031, coverageMonth: 3, monthsCovered: 1, amount: "100.00", currency: "USD", lateFeeAmount: "20.00",
        dueOn: new Date(Date.UTC(2031, 2, 20)), graceDeadline: new Date(Date.UTC(2031, 3, 5)), planTermsId: termsA.id, policyVersionId: policyA.id, createdById: a.admin.id,
      },
    });
    const before = await ledgerCounts();
    const result = await appPrisma.$transaction((tx) =>
      resumeChargeInTx(tx, { context: context(), student: { id: s.id, homeAcademyId: a.academy.id } }, deps({ now: at("2031-03-10T12:00:00") })),
    );
    expect(result).toEqual({ ok: true });
    const unchanged = await prisma.duesObligation.findUniqueOrThrow({ where: { id: existing.id } });
    expect(unchanged.amount).toEqual(existing.amount);
    expect(await ledgerCounts()).toEqual({ ...before, statusChanges: before.statusChanges + 1, audits: before.audits + 1 });
  });

  it("an UNCOVERED student with the identical configuration gap (no assignment) still refuses the whole attempt with zero writes — the fix does not let an uncovered+unconfigured resume through", async () => {
    const s = await newStudent("INACTIVE", "uncoverednoassign");
    // deliberately no assign() call, and no pre-existing obligation/coverage for this month either
    const before = await ledgerCounts();
    const result = await appPrisma.$transaction((tx) =>
      resumeChargeInTx(tx, { context: context(), student: { id: s.id, homeAcademyId: a.academy.id } }, deps({ now: at("2031-04-05T12:00:00") })),
    );
    expect(result).toEqual({ ok: false, error: "inapplicable" });
    const after = await prisma.student.findUniqueOrThrow({ where: { id: s.id } });
    expect(after.status).toBe("INACTIVE");
    expect(await ledgerCounts()).toEqual(before); // zero writes anywhere
  });
});

describe("unexpected failure after a provisional write rolls back everything", () => {
  it("a forced failure right after the obligation write rolls back the obligation, status, history and audit together", async () => {
    const s = await newStudent("INACTIVE", "forcedfail");
    await assign(s.id, planA.id);
    const before = await ledgerCounts();
    await expect(
      appPrisma.$transaction((tx) =>
        resumeChargeInTx(
          tx,
          { context: context(), student: { id: s.id, homeAcademyId: a.academy.id } },
          deps({ now: at("2030-11-05T12:00:00"), afterResumeObligationWrittenForTest: async () => { throw new Error("forced failure for test"); } }),
        ),
      ),
    ).rejects.toThrow("forced failure for test");
    const after = await prisma.student.findUniqueOrThrow({ where: { id: s.id } });
    expect(after.status).toBe("INACTIVE"); // rolled back, not ACTIVE
    expect(await ledgerCounts()).toEqual(before); // the obligation/coverage write rolled back too
  });
});

describe("minimumDueOn's own narrow validation (plan §2)", () => {
  it("a value outside the coverage month refuses invalid, never silently clamped or widened", async () => {
    const s = await newStudent("INACTIVE", "outofmonth");
    await assign(s.id, planA.id);
    const result = await appPrisma.$transaction((tx) =>
      writeMonthlyObligationInTx(
        tx,
        { context: context(), student: { id: s.id, homeAcademyId: a.academy.id }, coverage: { year: 2030, month: 6 }, planTermsId: termsA.id, policyVersionId: policyA.id, origin: "STAFF", minimumDueOn: { year: 2030, month: 7, day: 1 } },
        deps(),
      ),
    );
    expect(result).toEqual({ ok: false, error: "invalid" });
    expect(await prisma.duesObligation.count({ where: { organizationId: a.org.id, studentId: s.id, coverageYear: 2030, coverageMonth: 6 } })).toBe(0);
  });

  it("null is refused invalid, never treated as omitted (second review round)", async () => {
    const s = await newStudent("INACTIVE", "nulldue");
    await assign(s.id, planA.id);
    const result = await appPrisma.$transaction((tx) =>
      writeMonthlyObligationInTx(
        tx,
        { context: context(), student: { id: s.id, homeAcademyId: a.academy.id }, coverage: { year: 2032, month: 1 }, planTermsId: termsA.id, policyVersionId: policyA.id, origin: "STAFF", minimumDueOn: null as unknown as CalendarDate },
        deps(),
      ),
    );
    expect(result).toEqual({ ok: false, error: "invalid" });
    expect(await prisma.duesObligation.count({ where: { organizationId: a.org.id, studentId: s.id, coverageYear: 2032, coverageMonth: 1 } })).toBe(0);
  });

  it("a malformed object (day of the wrong type) is refused invalid, never crashes isRealDate (second review round)", async () => {
    const s = await newStudent("INACTIVE", "malformeddue");
    await assign(s.id, planA.id);
    const result = await appPrisma.$transaction((tx) =>
      writeMonthlyObligationInTx(
        tx,
        { context: context(), student: { id: s.id, homeAcademyId: a.academy.id }, coverage: { year: 2032, month: 2 }, planTermsId: termsA.id, policyVersionId: policyA.id, origin: "STAFF", minimumDueOn: { year: 2032, month: 2, day: "15" } as unknown as CalendarDate },
        deps(),
      ),
    );
    expect(result).toEqual({ ok: false, error: "invalid" });
    expect(await prisma.duesObligation.count({ where: { organizationId: a.org.id, studentId: s.id, coverageYear: 2032, coverageMonth: 2 } })).toBe(0);
  });

  it("September 31 (a calendar rollover) is refused invalid, not silently normalized to October 1 (second review round)", async () => {
    const s = await newStudent("INACTIVE", "sept31due");
    await assign(s.id, planA.id);
    const result = await appPrisma.$transaction((tx) =>
      writeMonthlyObligationInTx(
        tx,
        { context: context(), student: { id: s.id, homeAcademyId: a.academy.id }, coverage: { year: 2032, month: 9 }, planTermsId: termsA.id, policyVersionId: policyA.id, origin: "STAFF", minimumDueOn: { year: 2032, month: 9, day: 31 } },
        deps(),
      ),
    );
    expect(result).toEqual({ ok: false, error: "invalid" });
    expect(await prisma.duesObligation.count({ where: { organizationId: a.org.id, studentId: s.id, coverageYear: 2032, coverageMonth: 9 } })).toBe(0);
  });

  it("day 0 is refused invalid (second review round)", async () => {
    const s = await newStudent("INACTIVE", "day0due");
    await assign(s.id, planA.id);
    const result = await appPrisma.$transaction((tx) =>
      writeMonthlyObligationInTx(
        tx,
        { context: context(), student: { id: s.id, homeAcademyId: a.academy.id }, coverage: { year: 2032, month: 10 }, planTermsId: termsA.id, policyVersionId: policyA.id, origin: "STAFF", minimumDueOn: { year: 2032, month: 10, day: 0 } },
        deps(),
      ),
    );
    expect(result).toEqual({ ok: false, error: "invalid" });
    expect(await prisma.duesObligation.count({ where: { organizationId: a.org.id, studentId: s.id, coverageYear: 2032, coverageMonth: 10 } })).toBe(0);
  });

  it("a fractional day (15.5) is refused invalid (second review round)", async () => {
    const s = await newStudent("INACTIVE", "fractionaldue");
    await assign(s.id, planA.id);
    const result = await appPrisma.$transaction((tx) =>
      writeMonthlyObligationInTx(
        tx,
        { context: context(), student: { id: s.id, homeAcademyId: a.academy.id }, coverage: { year: 2032, month: 11 }, planTermsId: termsA.id, policyVersionId: policyA.id, origin: "STAFF", minimumDueOn: { year: 2032, month: 11, day: 15.5 } },
        deps(),
      ),
    );
    expect(result).toEqual({ ok: false, error: "invalid" });
    expect(await prisma.duesObligation.count({ where: { organizationId: a.org.id, studentId: s.id, coverageYear: 2032, coverageMonth: 11 } })).toBe(0);
  });

  it("absent for every ordinary caller: behavior is unaffected (no dueOn floor applied)", async () => {
    const s = await newStudent("INACTIVE", "noOverride");
    await assign(s.id, planA.id);
    const result = await appPrisma.$transaction((tx) =>
      writeMonthlyObligationInTx(
        tx,
        { context: context(), student: { id: s.id, homeAcademyId: a.academy.id }, coverage: { year: 2030, month: 6 }, planTermsId: termsA.id, policyVersionId: policyA.id, origin: "STAFF" },
        deps(),
      ),
    );
    expect(result).toMatchObject({ ok: true });
    const obligation = await prisma.duesObligation.findFirstOrThrow({ where: { organizationId: a.org.id, studentId: s.id, coverageYear: 2030, coverageMonth: 6 } });
    expect(obligation.dueOn!.toISOString().slice(0, 10)).toBe("2030-06-20"); // the plain computed due date, unaffected
  });
});

describe("genuine concurrency: two different students' resumes, same organization", () => {
  it("a second student's resume completes while the first is still open, holding the same branch FOR SHARE lock", async () => {
    const s1 = await newStudent("INACTIVE", "conc1");
    const s2 = await newStudent("INACTIVE", "conc2");
    await assign(s1.id, planA.id);
    await assign(s2.id, planA.id);

    let release1!: () => void;
    const gate1 = new Promise<void>((r) => (release1 = r));
    let paused1Resolve!: () => void;
    const paused1 = new Promise<void>((r) => (paused1Resolve = r));
    const resume1 = appPrisma.$transaction((tx) =>
      resumeChargeInTx(
        tx,
        { context: context(), student: { id: s1.id, homeAcademyId: a.academy.id } },
        deps({ now: at("2030-12-05T12:00:00"), afterResumeLocksForTest: async () => { paused1Resolve(); await gate1; } }),
      ),
    );

    try {
      await paused1; // student 1's resume holds the branch FOR SHARE lock; still open

      const resume2 = await appPrisma.$transaction((tx) =>
        resumeChargeInTx(tx, { context: context(), student: { id: s2.id, homeAcademyId: a.academy.id } }, deps({ now: at("2030-12-05T12:00:00") })),
      );
      expect(resume2, "student 2's resume must complete without waiting on student 1's still-open branch share lock").toEqual({ ok: true });

      release1();
      expect(await resume1).toEqual({ ok: true });
    } finally {
      release1();
      await Promise.allSettled([resume1]);
    }
  }, 20_000);
});

describe("genuine concurrency: a resume racing a concurrent assignment correction", () => {
  it("a resume's own lockAssignmentShared genuinely blocks behind a bystander holding the identical row FOR UPDATE (the exact lock/row shape correctAssignment itself uses)", async () => {
    const s = await newStudent("INACTIVE", "racecorrect");
    const assignment = await assign(s.id, planA.id);

    // A raw bystander holding the assignment row FOR UPDATE — the exact shape correctAssignment itself uses, mirroring
    // prepay-monthly.test.ts's own holdAssignmentLock helper — so resumeChargeInTx's own lockAssignmentShared call is
    // what genuinely blocks here, not a test-only hook standing in for it.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let pausedResolve!: () => void;
    const paused = new Promise<void>((r) => (pausedResolve = r));
    const held = prisma.$transaction(
      async (tx) => {
        await tx.$queryRawUnsafe(`SELECT "id" FROM "StudentPlanAssignment" WHERE "id" = '${assignment.id}' FOR UPDATE`);
        pausedResolve();
        await gate;
      },
      { timeout: 60_000 },
    );

    try {
      await paused; // the bystander holds the assignment row FOR UPDATE

      let resumeDone = false;
      const resumePromise = appPrisma.$transaction((tx) =>
        resumeChargeInTx(tx, { context: context(), student: { id: s.id, homeAcademyId: a.academy.id } }, deps({ now: at("2030-12-20T12:00:00") })),
      ).then((r) => ((resumeDone = true), r));

      const blocked = await waitUntilBlockedOnLock(['FROM "StudentPlanAssignment"', "FOR SHARE"]);
      expect(blocked, "resumeChargeInTx's lockAssignmentShared must genuinely block behind the bystander's FOR UPDATE hold").toBe(true);
      expect(resumeDone).toBe(false);

      release();
      expect(await resumePromise).toEqual({ ok: true });
      await held;
    } finally {
      release();
      await Promise.allSettled([held]);
    }
  }, 20_000);
});
