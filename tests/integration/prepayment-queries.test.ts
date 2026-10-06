import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getTestPrismaClient } from "../helpers/test-db";
import { makeAccountingOrg } from "../helpers/accounting-org";
import type { TenantContext } from "../../src/lib/tenant/types";
import { firstAvailablePrepaymentMonth, listMonthPrices } from "../../src/lib/dues/prepayment-queries";

/**
 * Monthly-prepayment UI brief §2.2/§2.3 deliverables, proved against the REAL test database: the first-available-
 * month + horizon advisory, and the per-month effective-price resolution. Both are plain, read-only modules — no
 * `deps` override, no activation gate; `now` is injected directly, mirroring `package-purchase-queries.ts`'s own
 * precedent.
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
      organizationId: a.org.id, homeAcademyId: academyId, firstName: "PrepayQuery", lastName: `S${n}`, phone: "00000000",
      email: `prepayquery-${n}-${suffix}@example.com`, currentRankId: await a.rankId("WHITE"), codeHash: `prepayquery-${n}-${suffix}`, status: "ACTIVE",
    },
  });
}

beforeAll(async () => {
  a = await makeAccountingOrg("CUMULATIVE", "prepayquery-a");
  academy2 = await prisma.academy.create({ data: { organizationId: a.org.id, name: "PrepayQuery A2", slug: `prepayquery-a2-${suffix}`, kioskTokenHash: `prepayquery-a2-${suffix}` } });
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
  await prisma.studentPlanAssignment.deleteMany({ where: { organizationId: a.org.id } });
  await prisma.paymentPlanTerms.deleteMany({ where: { organizationId: a.org.id } });
  await prisma.duesPolicyVersion.deleteMany({ where: { organizationId: a.org.id } });
  await prisma.paymentPlan.deleteMany({ where: { organizationId: a.org.id } });
  if (academy2) {
    await prisma.student.deleteMany({ where: { organizationId: a.org.id, homeAcademyId: academy2.id } });
    await prisma.academy.deleteMany({ where: { id: academy2.id } });
  }
  await a?.drop();
}, 120_000);

describe("firstAvailablePrepaymentMonth", () => {
  it("notFound for a student outside the caller's own branch scope", async () => {
    const s = await newStudent(academy2.id);
    const director = context({ organizationRole: "DIRECTOR", academyIds: [a.academy.id] });
    expect(await firstAvailablePrepaymentMonth(director, s.id, NOW)).toEqual({ ok: false, error: "notFound" });
  });

  it("a fresh student with no policy configured resolves month/horizonEnd: null (nothing useful to suggest), not an error", async () => {
    const s = await newStudent(academy2.id);
    const result = await firstAvailablePrepaymentMonth(context(), s.id, NOW);
    expect(result).toEqual({ ok: true, month: null, horizonEnd: null });
  });

  it("suggests currentMonth + 1 (floor = currentMonth + 1, unlike the package read's currentMonth), with the horizon end also reported", async () => {
    await prisma.duesPolicyVersion.create({ data: { organizationId: a.org.id, academyId: a.academy.id, effectiveYear: 2027, effectiveMonth: 1, dueDay: 20, graceDay: 5, lateFeeAmount: "20.00", lateFeeCurrency: "USD", maxPrepaidMonths: 3, createdById: a.admin.id } });
    const s = await newStudent();
    const result = await firstAvailablePrepaymentMonth(context(), s.id, NOW);
    expect(result).toEqual({ ok: true, month: { year: 2027, month: 7 }, horizonEnd: { year: 2027, month: 9 } });
  });

  it("skips months already covered by an existing obligation, suggesting the first genuinely uncovered one on/after currentMonth + 1", async () => {
    const policy = await prisma.duesPolicyVersion.findFirstOrThrow({ where: { organizationId: a.org.id, academyId: a.academy.id, effectiveYear: 2027, effectiveMonth: 1 } });
    const s = await newStudent();
    const plan = await prisma.paymentPlan.create({ data: { organizationId: a.org.id, academyId: a.academy.id, name: `PrepayQuery skip ${suffix}` } });
    const terms = await prisma.paymentPlanTerms.create({ data: { organizationId: a.org.id, planId: plan.id, effectiveYear: 2027, effectiveMonth: 1, priceAmount: "100.00", currency: "USD", monthsCovered: 1, createdById: a.admin.id } });
    await prisma.duesObligation.create({
      data: { organizationId: a.org.id, studentId: s.id, academyId: a.academy.id, type: "MONTHLY", origin: "STAFF", coverageYear: 2027, coverageMonth: 7, monthsCovered: 1, amount: "100.00", currency: "USD", dueOn: new Date(Date.UTC(2027, 6, 20)), graceDeadline: new Date(Date.UTC(2027, 7, 5)), lateFeeAmount: "20.00", planTermsId: terms.id, policyVersionId: policy.id, createdById: a.admin.id },
    });
    const result = await firstAvailablePrepaymentMonth(context(), s.id, NOW);
    expect(result).toEqual({ ok: true, month: { year: 2027, month: 8 }, horizonEnd: { year: 2027, month: 9 } });
  });

  it("month: null (but horizonEnd still reported) once the standing horizon is fully consumed by existing coverage — a limit condition, not an error", async () => {
    const policy = await prisma.duesPolicyVersion.create({ data: { organizationId: a.org.id, academyId: a.academy.id, effectiveYear: 2027, effectiveMonth: 2, dueDay: 20, graceDay: 5, lateFeeAmount: "20.00", lateFeeCurrency: "USD", maxPrepaidMonths: 1, createdById: a.admin.id } });
    const s = await newStudent();
    const plan = await prisma.paymentPlan.create({ data: { organizationId: a.org.id, academyId: a.academy.id, name: `PrepayQuery exhausted ${suffix}` } });
    const terms = await prisma.paymentPlanTerms.create({ data: { organizationId: a.org.id, planId: plan.id, effectiveYear: 2027, effectiveMonth: 1, priceAmount: "100.00", currency: "USD", monthsCovered: 1, createdById: a.admin.id } });
    // Horizon end = currentMonth (2027-06) + maxPrepaidMonths(1) = 2027-07; floor is 2027-07 too — cover it, nothing left.
    await prisma.duesObligation.create({
      data: { organizationId: a.org.id, studentId: s.id, academyId: a.academy.id, type: "MONTHLY", origin: "STAFF", coverageYear: 2027, coverageMonth: 7, monthsCovered: 1, amount: "100.00", currency: "USD", dueOn: new Date(Date.UTC(2027, 6, 20)), graceDeadline: new Date(Date.UTC(2027, 7, 5)), lateFeeAmount: "20.00", planTermsId: terms.id, policyVersionId: policy.id, createdById: a.admin.id },
    });
    const result = await firstAvailablePrepaymentMonth(context(), s.id, NOW);
    expect(result).toEqual({ ok: true, month: null, horizonEnd: { year: 2027, month: 7 } });
  });
});

describe("listMonthPrices", () => {
  it("notFound for a student outside the caller's own branch scope", async () => {
    const s = await newStudent(academy2.id);
    const director = context({ organizationRole: "DIRECTOR", academyIds: [a.academy.id] });
    expect(await listMonthPrices(director, s.id, [{ year: 2027, month: 7 }])).toEqual({ ok: false, error: "notFound" });
  });

  it("notFound for a studentId that does not resolve", async () => {
    expect(await listMonthPrices(context(), "no-such-student", [{ year: 2027, month: 7 }])).toEqual({ ok: false, error: "notFound" });
  });

  it("an empty months array resolves an empty prices array, not an error", async () => {
    const s = await newStudent();
    expect(await listMonthPrices(context(), s.id, [])).toEqual({ ok: true, prices: [] });
  });

  it("a month with no StudentPlanAssignment at all resolves {error: inapplicable} for that entry", async () => {
    const s = await newStudent();
    const result = await listMonthPrices(context(), s.id, [{ year: 2027, month: 7 }]);
    expect(result).toEqual({ ok: true, prices: [{ month: { year: 2027, month: 7 }, error: "inapplicable" }] });
  });

  it("resolves a month's price from the terms version effective AT THAT SPECIFIC month — CORRECTED: a scheduled price change mid-span prices two months of the same prepayment span DIFFERENTLY, never one lookup applied uniformly", async () => {
    const s = await newStudent();
    const plan = await prisma.paymentPlan.create({ data: { organizationId: a.org.id, academyId: a.academy.id, name: `PrepayQuery priced ${suffix}` } });
    await prisma.studentPlanAssignment.create({ data: { organizationId: a.org.id, studentId: s.id, planId: plan.id, effectiveYear: 2027, effectiveMonth: 1, createdById: a.admin.id } });
    await prisma.paymentPlanTerms.create({ data: { organizationId: a.org.id, planId: plan.id, effectiveYear: 2027, effectiveMonth: 1, priceAmount: "100.00", currency: "USD", monthsCovered: 1, createdById: a.admin.id } });
    // A scheduled price change effective 2027-08 — August and later months must price at the NEW terms; July still prices at the old one.
    await prisma.paymentPlanTerms.create({ data: { organizationId: a.org.id, planId: plan.id, effectiveYear: 2027, effectiveMonth: 8, priceAmount: "120.00", currency: "USD", monthsCovered: 1, createdById: a.admin.id } });

    const result = await listMonthPrices(context(), s.id, [{ year: 2027, month: 7 }, { year: 2027, month: 8 }, { year: 2027, month: 9 }]);
    if (!result.ok) throw new Error(JSON.stringify(result));
    expect(result.prices).toEqual([
      { month: { year: 2027, month: 7 }, priceAmount: "100.00", currency: "USD" },
      { month: { year: 2027, month: 8 }, priceAmount: "120.00", currency: "USD" },
      { month: { year: 2027, month: 9 }, priceAmount: "120.00", currency: "USD" },
    ]);
  });

  it("resolves the effective ASSIGNMENT at each month too, not just the terms — a plan change mid-span is honored per month", async () => {
    const s = await newStudent();
    const planA = await prisma.paymentPlan.create({ data: { organizationId: a.org.id, academyId: a.academy.id, name: `PrepayQuery planA ${suffix}` } });
    await prisma.paymentPlanTerms.create({ data: { organizationId: a.org.id, planId: planA.id, effectiveYear: 2027, effectiveMonth: 1, priceAmount: "90.00", currency: "USD", monthsCovered: 1, createdById: a.admin.id } });
    const planB = await prisma.paymentPlan.create({ data: { organizationId: a.org.id, academyId: a.academy.id, name: `PrepayQuery planB ${suffix}` } });
    await prisma.paymentPlanTerms.create({ data: { organizationId: a.org.id, planId: planB.id, effectiveYear: 2027, effectiveMonth: 1, priceAmount: "150.00", currency: "USD", monthsCovered: 1, createdById: a.admin.id } });
    await prisma.studentPlanAssignment.create({ data: { organizationId: a.org.id, studentId: s.id, planId: planA.id, effectiveYear: 2027, effectiveMonth: 1, createdById: a.admin.id } });
    // Assignment switches to planB starting 2027-08.
    await prisma.studentPlanAssignment.create({ data: { organizationId: a.org.id, studentId: s.id, planId: planB.id, effectiveYear: 2027, effectiveMonth: 8, createdById: a.admin.id } });

    const result = await listMonthPrices(context(), s.id, [{ year: 2027, month: 7 }, { year: 2027, month: 8 }]);
    if (!result.ok) throw new Error(JSON.stringify(result));
    expect(result.prices).toEqual([
      { month: { year: 2027, month: 7 }, priceAmount: "90.00", currency: "USD" },
      { month: { year: 2027, month: 8 }, priceAmount: "150.00", currency: "USD" },
    ]);
  });

  it("a month before any assignment's own effective date resolves {error: inapplicable}", async () => {
    const s = await newStudent();
    const plan = await prisma.paymentPlan.create({ data: { organizationId: a.org.id, academyId: a.academy.id, name: `PrepayQuery late-assignment ${suffix}` } });
    await prisma.paymentPlanTerms.create({ data: { organizationId: a.org.id, planId: plan.id, effectiveYear: 2027, effectiveMonth: 1, priceAmount: "100.00", currency: "USD", monthsCovered: 1, createdById: a.admin.id } });
    await prisma.studentPlanAssignment.create({ data: { organizationId: a.org.id, studentId: s.id, planId: plan.id, effectiveYear: 2027, effectiveMonth: 9, createdById: a.admin.id } });

    const result = await listMonthPrices(context(), s.id, [{ year: 2027, month: 7 }]);
    expect(result).toEqual({ ok: true, prices: [{ month: { year: 2027, month: 7 }, error: "inapplicable" }] });
  });

  describe("issue 3: malformed `months` input is refused BEFORE any database access", () => {
    // `"no-such-student"` never resolves to a real row — the existing test above (line 117-119) already proves that
    // alone produces `{ok:false, error:"notFound"}`. So if a run here instead comes back `{ok:false, error:"invalid"}`,
    // the only way that could happen is if the `months` validation rejected the call BEFORE the function ever reached
    // the student lookup (the first real database access) — the same proof technique this file already establishes.

    it("months: null is refused, never thrown", async () => {
      expect(await listMonthPrices(context(), "no-such-student", null as unknown as { year: number; month: number }[])).toEqual({ ok: false, error: "invalid" });
    });

    it("months: a non-array (string) is refused, never thrown", async () => {
      expect(await listMonthPrices(context(), "no-such-student", "not-an-array" as unknown as { year: number; month: number }[])).toEqual({ ok: false, error: "invalid" });
    });

    it("an entry with a wildly out-of-range year/month is refused", async () => {
      expect(await listMonthPrices(context(), "no-such-student", [{ year: 1500, month: 999 }])).toEqual({ ok: false, error: "invalid" });
    });

    it("a non-integer / garbage-shaped entry is refused, never thrown", async () => {
      expect(await listMonthPrices(context(), "no-such-student", [{ year: "2027", month: 7 } as unknown as { year: number; month: number }])).toEqual({ ok: false, error: "invalid" });
      expect(await listMonthPrices(context(), "no-such-student", ["July"] as unknown as { year: number; month: number }[])).toEqual({ ok: false, error: "invalid" });
      expect(await listMonthPrices(context(), "no-such-student", [null] as unknown as { year: number; month: number }[])).toEqual({ ok: false, error: "invalid" });
    });

    it("duplicate months in the array are refused", async () => {
      expect(await listMonthPrices(context(), "no-such-student", [{ year: 2027, month: 7 }, { year: 2027, month: 7 }])).toEqual({ ok: false, error: "invalid" });
    });

    it("an array longer than the request-size bound is refused", async () => {
      const tooMany = Array.from({ length: 61 }, (_, i) => ({ year: 2030 + Math.floor(i / 12), month: (i % 12) + 1 }));
      expect(await listMonthPrices(context(), "no-such-student", tooMany)).toEqual({ ok: false, error: "invalid" });
    });

    it("a genuinely valid, real studentId with malformed months is STILL refused invalid (not notFound) — confirming the order is months-first", async () => {
      const s = await newStudent();
      expect(await listMonthPrices(context(), s.id, [{ year: 1500, month: 999 }])).toEqual({ ok: false, error: "invalid" });
    });
  });
});
