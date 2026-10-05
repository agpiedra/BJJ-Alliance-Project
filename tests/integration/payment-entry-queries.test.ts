import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getTestPrismaClient } from "../helpers/test-db";
import { makeAccountingOrg } from "../helpers/accounting-org";
import type { TenantContext } from "../../src/lib/tenant/types";
import type { LedgerActivation } from "../../src/lib/dues/ledger/activation";
import { createMonthlyObligation } from "../../src/lib/dues/ledger/create-monthly-obligation";
import { recordDuesPayment } from "../../src/lib/dues/ledger/record-payment";
import { listPayableObligations, orderPayableOldestFirst, isMixedCurrency, listStudentsForPaymentEntry, getStudentBranchLocalToday } from "../../src/lib/dues/payment-entry-queries";

/**
 * Ordinary payment-entry UI brief §8 tier 1: `payment-entry-queries.ts`, proved against the REAL test database.
 * `listDuesFactsForStudents`'s own correctness is already fully covered (dues-facts.test.ts) — this file proves only
 * this module's OWN additions: the PACKAGE/settled filter, the mixed-currency flag, and the local oldest-first
 * comparator's agreement with `record-payment.ts`'s own real rule.
 */
const prisma = getTestPrismaClient();
type Fixture = Awaited<ReturnType<typeof makeAccountingOrg>>;
const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
const ACTIVE: LedgerActivation = { isActive: async () => true };
const deps = (extra: Record<string, unknown> = {}) => ({ activation: ACTIVE, ...extra });

let a: Fixture;
let academy2: { id: string };
let academyFarTz: { id: string; timezone: string };
let usdTerms: { id: string };
let usdPolicy: { id: string };
let crcTerms: { id: string };
let crcPolicy: { id: string };
let packageTerms: { id: string };

function context(over: Partial<TenantContext> = {}): TenantContext {
  return { kind: "tenant", actorUserId: a.admin.id, organizationId: a.org.id, organizationRole: "ADMIN", academyIds: "ALL", selfStudentId: null, linkedStudentId: null, ...over };
}

let studentCounter = 0;
async function newStudent(academyId = a.academy.id, status: "ACTIVE" | "INACTIVE" | "ARCHIVED" | "PENDING" = "ACTIVE") {
  const n = ++studentCounter;
  return prisma.student.create({
    data: {
      organizationId: a.org.id, homeAcademyId: academyId, firstName: "Entry", lastName: `Q${n}`, phone: "00000000",
      email: `entryq-${n}-${suffix}@example.com`, currentRankId: await a.rankId("WHITE"), codeHash: `entryq-${n}-${suffix}`, status,
    },
  });
}

async function monthly(studentId: string, year: number, month: number, terms = usdTerms, policy = usdPolicy) {
  const r = await createMonthlyObligation({ context: context(), studentId, coverage: { year, month }, planTermsId: terms.id, policyVersionId: policy.id }, deps());
  if (!r.ok) throw new Error(`fixture: createMonthlyObligation failed: ${r.error}`);
  return r.obligationId;
}

/** A raw MONTHLY row, bypassing `createMonthlyObligation`'s own "latest effective version" check entirely — needed
 * for the mixed-currency fixture below, since a single academy's policy has exactly ONE currently-effective
 * lateFeeCurrency at a time (the real-world mixed-currency case is a branch that changed pricing currency over
 * TIME, leaving an old obligation in the old currency; `listPayableObligations` only reads the stored `currency`
 * column and does not care which writer created the row). Mirrors `dues-facts.test.ts`'s own `createObligation`. */
async function rawMonthly(studentId: string, year: number, month: number, currency: "USD" | "CRC") {
  const o = await prisma.duesObligation.create({
    data: {
      organizationId: a.org.id, studentId, academyId: a.academy.id, origin: "STAFF", type: "MONTHLY", coverageYear: year, coverageMonth: month, monthsCovered: 1,
      amount: "100.00", currency, dueOn: new Date(Date.UTC(year, month - 1, 20)), graceDeadline: new Date(Date.UTC(year, month, 5)),
      lateFeeAmount: "20.00", planTermsId: currency === "USD" ? usdTerms.id : crcTerms.id, policyVersionId: currency === "USD" ? usdPolicy.id : crcPolicy.id, createdById: a.admin.id,
    },
  });
  return o.id;
}

// DuesObligation_shape_by_type (schema): SIGNUP requires monthsCovered=1, dueOn NOT NULL, graceDeadline/lateFeeAmount/
// policyVersionId all NULL.
async function signup(studentId: string, year: number, month: number) {
  const o = await prisma.duesObligation.create({
    data: { organizationId: a.org.id, studentId, academyId: a.academy.id, origin: "STAFF", type: "SIGNUP", coverageYear: year, coverageMonth: month, monthsCovered: 1, dueOn: new Date(Date.UTC(year, month - 1, 5)), amount: "50.00", currency: "USD", planTermsId: usdTerms.id, createdById: a.admin.id },
  });
  return o.id;
}

// DuesObligation_shape_by_type requires PACKAGE's monthsCovered >= 2 AND dueOn/graceDeadline/lateFeeAmount/
// policyVersionId all NULL; a separate trigger also requires monthsCovered to match the referenced terms row's own
// monthsCovered — packageTerms is a dedicated terms row for exactly this.
async function packageObligation(studentId: string, year: number, month: number) {
  const o = await prisma.duesObligation.create({
    data: { organizationId: a.org.id, studentId, academyId: a.academy.id, origin: "STAFF", type: "PACKAGE", coverageYear: year, coverageMonth: month, monthsCovered: 3, amount: "250.00", currency: "USD", planTermsId: packageTerms.id, createdById: a.admin.id },
  });
  return o.id;
}

beforeAll(async () => {
  a = await makeAccountingOrg("CUMULATIVE", "entryq-a");
  academy2 = await prisma.academy.create({ data: { organizationId: a.org.id, name: "Entry Q A2", slug: `entryq-a2-${suffix}`, kioskTokenHash: `entryq-a2-${suffix}` } });
  // Deliberately NOT the schema default ("America/Costa_Rica") and far enough away (UTC+14) that a naive
  // browser/server-clock date would almost never agree with it by coincidence — the same anti-coincidence choice
  // vitest.config.ts itself makes for the whole suite's own TZ.
  academyFarTz = await prisma.academy.create({ data: { organizationId: a.org.id, name: "Entry Q Far TZ", slug: `entryq-fartz-${suffix}`, kioskTokenHash: `entryq-fartz-${suffix}`, timezone: "Pacific/Kiritimati" } });
  const planA = await prisma.paymentPlan.create({ data: { organizationId: a.org.id, academyId: a.academy.id, name: `Entry Q USD plan ${suffix}` } });
  usdTerms = await prisma.paymentPlanTerms.create({ data: { organizationId: a.org.id, planId: planA.id, effectiveYear: 2026, effectiveMonth: 1, priceAmount: "100.00", currency: "USD", monthsCovered: 1, createdById: a.admin.id } });
  usdPolicy = await prisma.duesPolicyVersion.create({ data: { organizationId: a.org.id, academyId: a.academy.id, effectiveYear: 2026, effectiveMonth: 1, dueDay: 20, graceDay: 5, lateFeeAmount: "20.00", lateFeeCurrency: "USD", createdById: a.admin.id } });
  // A DIFFERENT effectiveMonth from usdPolicy's (2026-01) — DuesPolicyVersion is unique per (academyId,
  // effectiveYear, effectiveMonth) regardless of currency, and createMonthlyObligation takes the policyVersionId
  // directly (no latestEffective resolution), so an earlier effective month works for any later coverage month.
  const planB = await prisma.paymentPlan.create({ data: { organizationId: a.org.id, academyId: a.academy.id, name: `Entry Q CRC plan ${suffix}` } });
  crcTerms = await prisma.paymentPlanTerms.create({ data: { organizationId: a.org.id, planId: planB.id, effectiveYear: 2024, effectiveMonth: 1, priceAmount: "50000.00", currency: "CRC", monthsCovered: 1, createdById: a.admin.id } });
  crcPolicy = await prisma.duesPolicyVersion.create({ data: { organizationId: a.org.id, academyId: a.academy.id, effectiveYear: 2024, effectiveMonth: 1, dueDay: 20, graceDay: 5, lateFeeAmount: "5000.00", lateFeeCurrency: "CRC", createdById: a.admin.id } });
  const planC = await prisma.paymentPlan.create({ data: { organizationId: a.org.id, academyId: a.academy.id, name: `Entry Q package plan ${suffix}` } });
  packageTerms = await prisma.paymentPlanTerms.create({ data: { organizationId: a.org.id, planId: planC.id, effectiveYear: 2026, effectiveMonth: 1, priceAmount: "250.00", currency: "USD", monthsCovered: 3, createdById: a.admin.id } });
}, 60_000);

afterAll(async () => {
  await prisma.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL session_replication_role = replica");
      for (const table of ["DuesSettlement", "DuesPayment", "DuesLateFee", "DuesCoverage", "DuesObligation"]) {
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
  if (academyFarTz) {
    await prisma.student.deleteMany({ where: { organizationId: a.org.id, homeAcademyId: academyFarTz.id } });
    await prisma.academy.deleteMany({ where: { id: academyFarTz.id } });
  }
  await a?.drop();
}, 120_000);

describe("listPayableObligations", () => {
  it("notActive under the real, unmodified default", async () => {
    const s = await newStudent();
    expect(await listPayableObligations(context(), s.id)).toEqual({ ok: false, error: "notActive" });
  });

  it("invalid for a blank studentId", async () => {
    expect(await listPayableObligations(context(), "  ", deps())).toEqual({ ok: false, error: "invalid" });
  });

  it("notFound for a student outside the caller's own branch scope", async () => {
    const s = await newStudent(academy2.id);
    const director = context({ organizationRole: "DIRECTOR", academyIds: [a.academy.id] }); // excludes academy2
    expect(await listPayableObligations(director, s.id, deps())).toEqual({ ok: false, error: "notFound" });
  });

  it("excludes PACKAGE obligations from the returned list", async () => {
    const s = await newStudent();
    const monthlyId = await monthly(s.id, 2026, 3);
    await packageObligation(s.id, 2026, 4);
    const result = await listPayableObligations(context(), s.id, deps());
    if (!result.ok) throw new Error(JSON.stringify(result));
    expect(result.obligations.map((o) => o.obligationId)).toEqual([monthlyId]);
  });

  it("excludes already-settled obligations", async () => {
    const s = await newStudent();
    // paidId is settled while it is the ONLY (and therefore oldest) outstanding obligation; unpaidId is created
    // afterward so the payment itself is never a genuine oldest-first violation.
    const paidId = await monthly(s.id, 2026, 5);
    const paid = await recordDuesPayment({ context: context(), studentId: s.id, receivedOn: { year: 2026, month: 5, day: 1 }, tender: { currency: "USD", amount: "100.00" }, method: "EFECTIVO", obligationIds: [paidId], maxBackdateDays: 3660 }, deps());
    if (!paid.ok) throw new Error(`fixture: payment failed: ${JSON.stringify(paid)}`);
    const unpaidId = await monthly(s.id, 2026, 6);
    const result = await listPayableObligations(context(), s.id, deps());
    if (!result.ok) throw new Error(JSON.stringify(result));
    expect(result.obligations.map((o) => o.obligationId)).toEqual([unpaidId]);
  });
});

describe("isMixedCurrency", () => {
  it("false for a single-currency outstanding set, true once a second currency appears", async () => {
    const s = await newStudent();
    const usdId = await monthly(s.id, 2026, 7);
    const result1 = await listPayableObligations(context(), s.id, deps());
    if (!result1.ok) throw new Error(JSON.stringify(result1));
    expect(isMixedCurrency(result1.obligations)).toBe(false);

    await rawMonthly(s.id, 2026, 8, "CRC"); // a second, distinct-month CRC obligation — at most one MONTHLY per student per coverage month (DuesObligation_student_month_monthly_key)
    const result2 = await listPayableObligations(context(), s.id, deps());
    if (!result2.ok) throw new Error(JSON.stringify(result2));
    expect(result2.obligations.length).toBeGreaterThanOrEqual(2);
    expect(isMixedCurrency(result2.obligations)).toBe(true);
    expect(result2.obligations.map((o) => o.obligationId)).toContain(usdId);
  });
});

describe("orderPayableOldestFirst — cross-checked directly against record-payment.ts's own real rule", () => {
  it("orders strictly by coverage month, oldest first", async () => {
    const s = await newStudent();
    const marchId = await monthly(s.id, 2026, 9);
    const februaryId = await monthly(s.id, 2026, 8);
    const result = await listPayableObligations(context(), s.id, deps());
    if (!result.ok) throw new Error(JSON.stringify(result));
    const ordered = orderPayableOldestFirst(result.obligations);
    expect(ordered.map((o) => o.obligationId)).toEqual([februaryId, marchId]);
  });

  it("a SIGNUP sorts ahead of a MONTHLY due the SAME coverage month — matching record-payment.ts:263's debtItemPriority exactly", async () => {
    const s = await newStudent();
    const monthlyId = await monthly(s.id, 2026, 10);
    const signupId = await signup(s.id, 2026, 10);
    const result = await listPayableObligations(context(), s.id, deps());
    if (!result.ok) throw new Error(JSON.stringify(result));
    const ordered = orderPayableOldestFirst(result.obligations);
    expect(ordered.map((o) => o.obligationId)).toEqual([signupId, monthlyId]);

    // The real engine's own oldest-first check agrees: submitting [monthlyId, signupId] (reversed) still succeeds
    // once BOTH are selected (order of the array itself is not what the server checks), but selecting the MONTHLY
    // alone while the same-month SIGNUP is left out is refused — proving the SIGNUP is genuinely "older" in the
    // engine's own eyes, not just in this UI's own comparator.
    const monthlyAlone = await recordDuesPayment({ context: context(), studentId: s.id, receivedOn: { year: 2026, month: 10, day: 1 }, tender: { currency: "USD", amount: "100.00" }, method: "EFECTIVO", obligationIds: [monthlyId], maxBackdateDays: 3660 }, deps());
    expect(monthlyAlone).toMatchObject({ ok: false, error: "notOldestFirst" });
  });
});

describe("listStudentsForPaymentEntry (point 6 — the picker is NOT filtered to status:\"ACTIVE\")", () => {
  it("returns an INACTIVE and an ARCHIVED student, neither of which listCurrentPaymentStatus's own ACTIVE-only filter would include", async () => {
    const activeS = await newStudent(a.academy.id, "ACTIVE");
    const inactiveS = await newStudent(a.academy.id, "INACTIVE");
    const archivedS = await newStudent(a.academy.id, "ARCHIVED");
    const result = await listStudentsForPaymentEntry(context());
    const ids = result.map((s) => s.id);
    expect(ids).toEqual(expect.arrayContaining([activeS.id, inactiveS.id, archivedS.id]));
  });

  it("branch-scopes exactly like every other staff-facing dues reader — excludes a student outside the caller's own branch", async () => {
    const outOfScope = await newStudent(academy2.id, "ACTIVE");
    const director = context({ organizationRole: "DIRECTOR", academyIds: [a.academy.id] }); // excludes academy2
    const result = await listStudentsForPaymentEntry(director);
    expect(result.map((s) => s.id)).not.toContain(outOfScope.id);
  });

  it("an INACTIVE student with genuine outstanding debt is selectable in the new picker AND a payment for them succeeds", async () => {
    const inactiveS = await newStudent(a.academy.id, "INACTIVE");
    // usdTerms/usdPolicy are effective from 2026-01 onward (`staleVersion` otherwise) — month 2 keeps this inside
    // every other test's own already-proven-safe window in this file (up to month 10) without colliding with any.
    const obligationId = await monthly(inactiveS.id, 2026, 2);

    const picker = await listStudentsForPaymentEntry(context());
    expect(picker.map((s) => s.id)).toContain(inactiveS.id);

    const outstanding = await listPayableObligations(context(), inactiveS.id, deps());
    if (!outstanding.ok) throw new Error(JSON.stringify(outstanding));
    expect(outstanding.obligations.map((o) => o.obligationId)).toContain(obligationId);

    const paid = await recordDuesPayment({ context: context(), studentId: inactiveS.id, receivedOn: { year: 2026, month: 2, day: 1 }, tender: { currency: "USD", amount: "100.00" }, method: "EFECTIVO", obligationIds: [obligationId], maxBackdateDays: 3660 }, deps());
    expect(paid).toMatchObject({ ok: true });
  });
});

describe("getStudentBranchLocalToday (point 7 — the student's own branch timezone, never the caller's clock)", () => {
  it("resolves the real academy's own timezone, genuinely different from a naive UTC/browser read at the same instant", async () => {
    const s = await newStudent(academyFarTz.id);
    // A fixed instant whose UTC calendar date and Pacific/Kiritimati (UTC+14) calendar date genuinely differ.
    const instant = new Date("2026-11-01T20:00:00.000Z"); // UTC: 2026-11-01 20:00; Kiritimati: 2026-11-02 10:00
    const result = await getStudentBranchLocalToday(context(), s.id, instant);
    expect(result).toEqual({ year: 2026, month: 11, day: 2 });
    expect(result).not.toEqual({ year: instant.getUTCFullYear(), month: instant.getUTCMonth() + 1, day: instant.getUTCDate() });
  });

  it("returns null for a student outside the caller's own branch scope — the same silent-exclusion rule as every other reader here", async () => {
    const outOfScope = await newStudent(academy2.id);
    const director = context({ organizationRole: "DIRECTOR", academyIds: [a.academy.id] });
    expect(await getStudentBranchLocalToday(director, outOfScope.id)).toBeNull();
  });
});
