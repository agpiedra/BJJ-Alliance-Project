import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getTestPrismaClient } from "../helpers/test-db";
import { makeAccountingOrg } from "../helpers/accounting-org";
import type { TenantContext } from "../../src/lib/tenant/types";
import { listActivePackagePlanOptions, firstAvailablePackageMonth } from "../../src/lib/dues/package-purchase-queries";

/**
 * Package-purchase UI brief §2 deliverables 1/2, proved against the REAL test database: the plan/terms picker read
 * and the first-available-month advisory. Both are plain, read-only modules — no `deps` override, no activation
 * gate (reads, not writes); `now` is injected directly, mirroring `getStudentBranchLocalToday`'s own precedent.
 */
const prisma = getTestPrismaClient();
type Fixture = Awaited<ReturnType<typeof makeAccountingOrg>>;
const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
const NOW = new Date("2027-06-01T12:00:00-06:00"); // Costa Rica, branch-local June 2027

let a: Fixture;
let academy2: { id: string };

function context(over: Partial<TenantContext> = {}): TenantContext {
  return { kind: "tenant", actorUserId: a.admin.id, organizationId: a.org.id, organizationRole: "ADMIN", academyIds: "ALL", selfStudentId: null, linkedStudentId: null, ...over };
}

let studentCounter = 0;
async function newStudent(academyId = a.academy.id) {
  const n = ++studentCounter;
  return prisma.student.create({
    data: {
      organizationId: a.org.id, homeAcademyId: academyId, firstName: "PkgQuery", lastName: `S${n}`, phone: "00000000",
      email: `pkgquery-${n}-${suffix}@example.com`, currentRankId: await a.rankId("WHITE"), codeHash: `pkgquery-${n}-${suffix}`, status: "ACTIVE",
    },
  });
}

beforeAll(async () => {
  a = await makeAccountingOrg("CUMULATIVE", "pkgquery-a");
  academy2 = await prisma.academy.create({ data: { organizationId: a.org.id, name: "PkgQuery A2", slug: `pkgquery-a2-${suffix}`, kioskTokenHash: `pkgquery-a2-${suffix}` } });
}, 60_000);

afterAll(async () => {
  await prisma.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL session_replication_role = replica");
      for (const table of ["DuesCoverage", "DuesObligation"]) {
        await tx.$executeRawUnsafe(`DELETE FROM "${table}" WHERE "organizationId" = $1`, a.org.id);
      }
    },
    { timeout: 60_000 },
  );
  await prisma.auditLog.deleteMany({ where: { organizationId: a.org.id } });
  await prisma.paymentPlanTerms.deleteMany({ where: { organizationId: a.org.id } });
  await prisma.duesPolicyVersion.deleteMany({ where: { organizationId: a.org.id } });
  await prisma.paymentPlan.deleteMany({ where: { organizationId: a.org.id } });
  if (academy2) {
    await prisma.student.deleteMany({ where: { organizationId: a.org.id, homeAcademyId: academy2.id } });
    await prisma.academy.deleteMany({ where: { id: academy2.id } });
  }
  await a?.drop();
}, 120_000);

describe("listActivePackagePlanOptions", () => {
  it("notFound for a student outside the caller's own branch scope", async () => {
    const s = await newStudent(academy2.id);
    const director = context({ organizationRole: "DIRECTOR", academyIds: [a.academy.id] });
    expect(await listActivePackagePlanOptions(director, s.id, NOW)).toEqual({ ok: false, error: "notFound" });
  });

  it("notFound for a studentId that does not resolve", async () => {
    expect(await listActivePackagePlanOptions(context(), "no-such-student", NOW)).toEqual({ ok: false, error: "notFound" });
  });

  it("lists an ACTIVE package plan with its CURRENTLY effective terms, excludes an ordinary (single-month) plan, and excludes an INACTIVE package plan", async () => {
    const s = await newStudent();
    const monthlyPlan = await prisma.paymentPlan.create({ data: { organizationId: a.org.id, academyId: a.academy.id, name: `PkgQuery monthly ${suffix}`, active: true } });
    await prisma.paymentPlanTerms.create({ data: { organizationId: a.org.id, planId: monthlyPlan.id, effectiveYear: 2026, effectiveMonth: 1, priceAmount: "100.00", currency: "USD", monthsCovered: 1, createdById: a.admin.id } });

    const packagePlan = await prisma.paymentPlan.create({ data: { organizationId: a.org.id, academyId: a.academy.id, name: `PkgQuery package ${suffix}`, active: true } });
    await prisma.paymentPlanTerms.create({ data: { organizationId: a.org.id, planId: packagePlan.id, effectiveYear: 2027, effectiveMonth: 1, priceAmount: "270.00", currency: "USD", monthsCovered: 3, createdById: a.admin.id } });

    const inactivePackagePlan = await prisma.paymentPlan.create({ data: { organizationId: a.org.id, academyId: a.academy.id, name: `PkgQuery inactive package ${suffix}`, active: false } });
    await prisma.paymentPlanTerms.create({ data: { organizationId: a.org.id, planId: inactivePackagePlan.id, effectiveYear: 2027, effectiveMonth: 1, priceAmount: "999.00", currency: "USD", monthsCovered: 6, createdById: a.admin.id } });

    const result = await listActivePackagePlanOptions(context(), s.id, NOW);
    if (!result.ok) throw new Error(JSON.stringify(result));
    expect(result.plans).toEqual([{ planId: packagePlan.id, planTermsId: expect.any(String), planName: packagePlan.name, monthsCovered: 3, priceAmount: "270.00", currency: "USD" }]);
  });

  it("omits a package plan whose terms are not effective yet (dated after `now`) rather than erroring", async () => {
    const s = await newStudent();
    const futurePlan = await prisma.paymentPlan.create({ data: { organizationId: a.org.id, academyId: a.academy.id, name: `PkgQuery future ${suffix}`, active: true } });
    await prisma.paymentPlanTerms.create({ data: { organizationId: a.org.id, planId: futurePlan.id, effectiveYear: 2030, effectiveMonth: 1, priceAmount: "300.00", currency: "USD", monthsCovered: 2, createdById: a.admin.id } });

    const result = await listActivePackagePlanOptions(context(), s.id, NOW);
    if (!result.ok) throw new Error(JSON.stringify(result));
    expect(result.plans.map((p) => p.planId)).not.toContain(futurePlan.id);
  });

  it("resolves the LATEST effective terms version, never an earlier superseded one", async () => {
    const s = await newStudent();
    const plan = await prisma.paymentPlan.create({ data: { organizationId: a.org.id, academyId: a.academy.id, name: `PkgQuery versioned ${suffix}`, active: true } });
    await prisma.paymentPlanTerms.create({ data: { organizationId: a.org.id, planId: plan.id, effectiveYear: 2025, effectiveMonth: 1, priceAmount: "200.00", currency: "USD", monthsCovered: 2, createdById: a.admin.id } });
    const newer = await prisma.paymentPlanTerms.create({ data: { organizationId: a.org.id, planId: plan.id, effectiveYear: 2027, effectiveMonth: 1, priceAmount: "220.00", currency: "USD", monthsCovered: 2, createdById: a.admin.id } });

    const result = await listActivePackagePlanOptions(context(), s.id, NOW);
    if (!result.ok) throw new Error(JSON.stringify(result));
    const found = result.plans.find((p) => p.planId === plan.id);
    expect(found).toMatchObject({ planTermsId: newer.id, priceAmount: "220.00" });
  });
});

describe("firstAvailablePackageMonth", () => {
  it("notFound for a student outside the caller's own branch scope", async () => {
    const s = await newStudent(academy2.id);
    const director = context({ organizationRole: "DIRECTOR", academyIds: [a.academy.id] });
    expect(await firstAvailablePackageMonth(director, s.id, NOW)).toEqual({ ok: false, error: "notFound" });
  });

  it("a fresh student with no policy configured resolves month: null (nothing useful to suggest), not an error", async () => {
    const s = await newStudent(academy2.id);
    const result = await firstAvailablePackageMonth(context(), s.id, NOW);
    expect(result).toEqual({ ok: true, month: null });
  });

  it("suggests the CURRENT month for a fresh student (floor = currentMonth, unlike prepayment's currentMonth + 1)", async () => {
    await prisma.duesPolicyVersion.create({ data: { organizationId: a.org.id, academyId: a.academy.id, effectiveYear: 2027, effectiveMonth: 1, dueDay: 20, graceDay: 5, lateFeeAmount: "20.00", lateFeeCurrency: "USD", maxPrepaidMonths: 12, createdById: a.admin.id } });
    const s = await newStudent();
    const result = await firstAvailablePackageMonth(context(), s.id, NOW);
    expect(result).toEqual({ ok: true, month: { year: 2027, month: 6 } });
  });

  it("skips months already covered by an existing obligation, suggesting the first genuinely uncovered one", async () => {
    // Reuses the SAME policy row the previous test installed (`DuesObligation` rows are never deleted — `dues_ledger:
    // rows are never deleted` — so this suite never deletes or replaces a policy row once created; a later test
    // that needs a DIFFERENT limit installs a NEW, later-effective version instead, below).
    const policy = await prisma.duesPolicyVersion.findFirstOrThrow({ where: { organizationId: a.org.id, academyId: a.academy.id, effectiveYear: 2027, effectiveMonth: 1 } });
    const s = await newStudent();
    const plan = await prisma.paymentPlan.create({ data: { organizationId: a.org.id, academyId: a.academy.id, name: `PkgQuery skip ${suffix}` } });
    const terms = await prisma.paymentPlanTerms.create({ data: { organizationId: a.org.id, planId: plan.id, effectiveYear: 2027, effectiveMonth: 1, priceAmount: "100.00", currency: "USD", monthsCovered: 1, createdById: a.admin.id } });
    await prisma.duesObligation.create({
      data: { organizationId: a.org.id, studentId: s.id, academyId: a.academy.id, type: "MONTHLY", origin: "STAFF", coverageYear: 2027, coverageMonth: 6, monthsCovered: 1, amount: "100.00", currency: "USD", dueOn: new Date(Date.UTC(2027, 5, 20)), graceDeadline: new Date(Date.UTC(2027, 6, 5)), lateFeeAmount: "20.00", planTermsId: terms.id, policyVersionId: policy.id, createdById: a.admin.id },
    });
    const result = await firstAvailablePackageMonth(context(), s.id, NOW);
    expect(result).toEqual({ ok: true, month: { year: 2027, month: 7 } });
  });

  it("month: null once the standing horizon is fully consumed by existing coverage — a limit condition, not an error", async () => {
    // A NEW, LATER-effective policy version (never deleting/replacing the earlier one — see the note above) with a
    // tight maxPrepaidMonths=1, so `latestEffective` picks THIS one for `NOW` (2027-06) instead of the earlier
    // maxPrepaidMonths=12 version.
    const policy = await prisma.duesPolicyVersion.create({ data: { organizationId: a.org.id, academyId: a.academy.id, effectiveYear: 2027, effectiveMonth: 2, dueDay: 20, graceDay: 5, lateFeeAmount: "20.00", lateFeeCurrency: "USD", maxPrepaidMonths: 1, createdById: a.admin.id } });
    const s = await newStudent();
    const plan = await prisma.paymentPlan.create({ data: { organizationId: a.org.id, academyId: a.academy.id, name: `PkgQuery exhausted ${suffix}` } });
    const terms = await prisma.paymentPlanTerms.create({ data: { organizationId: a.org.id, planId: plan.id, effectiveYear: 2027, effectiveMonth: 1, priceAmount: "100.00", currency: "USD", monthsCovered: 1, createdById: a.admin.id } });
    // Horizon end = currentMonth (2027-06) + maxPrepaidMonths(1) = 2027-07; cover both 06 and 07 — nothing left in [06,07].
    for (const month of [6, 7]) {
      await prisma.duesObligation.create({
        data: { organizationId: a.org.id, studentId: s.id, academyId: a.academy.id, type: "MONTHLY", origin: "STAFF", coverageYear: 2027, coverageMonth: month, monthsCovered: 1, amount: "100.00", currency: "USD", dueOn: new Date(Date.UTC(2027, month - 1, 20)), graceDeadline: new Date(Date.UTC(2027, month, 5)), lateFeeAmount: "20.00", planTermsId: terms.id, policyVersionId: policy.id, createdById: a.admin.id },
      });
    }
    const result = await firstAvailablePackageMonth(context(), s.id, NOW);
    expect(result).toEqual({ ok: true, month: null });
  });
});
