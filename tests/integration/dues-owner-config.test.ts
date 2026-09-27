import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getTestPrismaClient } from "../helpers/test-db";
import { makeAccountingOrg } from "../helpers/accounting-org";
import { currentMonthIn, policyRevision, termsRevision } from "../../src/lib/dues/config-input";
import { addMonths } from "../../src/lib/dues/calendar";

vi.mock("@/lib/email/send-transactional-email", () => ({ sendTransactionalEmail: vi.fn(async () => ({ success: true })) }));

// The actions read the session through next-auth's `auth()`, which needs a real request; tests set who is acting.
let currentSession: { user: { id: string; role: string } | null; activeOrganizationId?: string } | null = null;
vi.mock("@/auth", () => ({ auth: () => Promise.resolve(currentSession), signIn: vi.fn() }));

const actions = await import("../../src/lib/dues/config-actions");
const { createPackagePlan, addPlanTerms, addPolicyVersion, correctPlanTerms, correctPolicyVersion } = actions;
const { recordPayment, markPaymentPaid } = await import("../../src/lib/payments/payment-actions");
const { listSelectablePlans, listPlansForManagement } = await import("../../src/lib/payments/list-plans");
const { deactivatePlan, reactivatePlan, updatePlan } = await import("../../src/lib/payments/plan-actions");

/**
 * PR 3 (owner dues configuration), proved against the REAL test database with private, temporary organizations (removed in afterAll;
 * the seeded Alliance data is never touched). Amounts and days are synthetic test data.
 *
 * Sections: authorization and tenancy; exact input; effective months in the branch timezone; insert-only versions; D25 corrections
 * (future only, audited, stale-edit detection); package isolation across creation, activation, selection and server submission; and
 * genuinely concurrent saves. The pure input rules are in tests/unit/dues-config-input.test.ts.
 */
const prisma = getTestPrismaClient();
type Fixture = Awaited<ReturnType<typeof makeAccountingOrg>>;
let a: Fixture; // organization A: owner = a.admin
let b: Fixture; // organization B
let a2: { id: string }; // a second branch of A
let director: { id: string }; // DIRECTOR of A's first branch
let instructor: { id: string }; // INSTRUCTOR of A's first branch
let monthlyA1: { id: string }; // A, first branch: the ordinary monthly plan
let monthlyA2: { id: string }; // A, second branch
let monthlyB: { id: string }; // B
let studentA: { id: string };

const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
const ZONE = "America/Costa_Rica";
const now = () => currentMonthIn(ZONE);
const FUTURE = () => addMonths(now(), 2);
const PAST = () => addMonths(now(), -1);

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) fd.set(key, value);
  return fd;
}
const ym = (m: { year: number; month: number }) => ({ effectiveYear: String(m.year), effectiveMonth: String(m.month) });

function actAs(userId: string | null, organizationId: string, role = "ADMIN") {
  currentSession = userId ? { user: { id: userId, role }, activeOrganizationId: organizationId } : null;
}
const asOwner = () => actAs(a.admin.id, a.org.id);

const termsForm = (over: Record<string, string> = {}) =>
  form({ planId: monthlyA1.id, ...ym(FUTURE()), priceAmount: "45.00", currency: "USD", monthsCovered: "1", ...over });
const policyForm = (over: Record<string, string> = {}) =>
  form({ academyId: a.academy.id, ...ym(FUTURE()), dueDay: "15", graceDay: "4", lateFeeAmount: "12.50", lateFeeCurrency: "USD", maxPrepaidMonths: "", ...over });
const packageForm = (over: Record<string, string> = {}) =>
  form({ academyId: a.academy.id, name: `Pack ${suffix}`, description: "", ...ym(FUTURE()), priceAmount: "120.00", currency: "USD", monthsCovered: "3", ...over });

async function counts(orgId: string) {
  return {
    terms: await prisma.paymentPlanTerms.count({ where: { organizationId: orgId } }),
    policies: await prisma.duesPolicyVersion.count({ where: { organizationId: orgId } }),
    plans: await prisma.paymentPlan.count({ where: { organizationId: orgId } }),
    audits: await prisma.auditLog.count({ where: { organizationId: orgId, action: { startsWith: "dues" } } }),
  };
}

async function newStaff(fx: Fixture, academyId: string, role: "DIRECTOR" | "INSTRUCTOR") {
  const user = await prisma.user.create({ data: { email: `dues-${role.toLowerCase()}-${suffix}@example.com`, passwordHash: "x", role } });
  await prisma.organizationMembership.create({ data: { userId: user.id, organizationId: fx.org.id, role } });
  await prisma.staffAssignment.create({ data: { userId: user.id, academyId, organizationId: fx.org.id, role } });
  return user;
}

beforeAll(async () => {
  a = await makeAccountingOrg("CUMULATIVE", "dues-owner-a");
  b = await makeAccountingOrg("CUMULATIVE", "dues-owner-b");
  a2 = await prisma.academy.create({ data: { organizationId: a.org.id, name: "Dues Owner A2", slug: `dues-owner-a2-${suffix}`, kioskTokenHash: `dues-owner-a2-${suffix}` } });
  monthlyA1 = await prisma.paymentPlan.create({ data: { organizationId: a.org.id, academyId: a.academy.id, name: "Monthly" } });
  monthlyA2 = await prisma.paymentPlan.create({ data: { organizationId: a.org.id, academyId: a2.id, name: "Monthly" } });
  monthlyB = await prisma.paymentPlan.create({ data: { organizationId: b.org.id, academyId: b.academy.id, name: "Monthly" } });
  director = await newStaff(a, a.academy.id, "DIRECTOR");
  instructor = await newStaff(a, a.academy.id, "INSTRUCTOR");
  studentA = await prisma.student.create({
    data: {
      organizationId: a.org.id, homeAcademyId: a.academy.id, firstName: "Dues", lastName: "Owner", phone: "00000000",
      email: `dues-owner-student-${suffix}@example.com`, currentRankId: await a.rankId("WHITE"), codeHash: `dues-owner-${suffix}`, status: "ACTIVE",
    },
  });
});

afterAll(async () => {
  currentSession = null;
  // The ledger refuses deletes by trigger; the one test that created an obligation is cleaned up in a test-only transaction that switches
  // triggers off for itself alone (the migration is untouched).
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SET LOCAL session_replication_role = replica");
    await tx.$executeRawUnsafe(`DELETE FROM "DuesObligation" WHERE "organizationId" = ANY($1::text[])`, [a?.org.id, b?.org.id].filter(Boolean));
  });
  for (const fx of [a, b]) {
    if (!fx) continue;
    await prisma.auditLog.deleteMany({ where: { organizationId: fx.org.id } });
    await prisma.paymentPeriod.deleteMany({ where: { organizationId: fx.org.id } });
    await prisma.studentPlanAssignment.deleteMany({ where: { organizationId: fx.org.id } });
    await prisma.paymentPlanTerms.deleteMany({ where: { organizationId: fx.org.id } });
    await prisma.duesPolicyVersion.deleteMany({ where: { organizationId: fx.org.id } });
    await prisma.paymentPlan.deleteMany({ where: { organizationId: fx.org.id } });
    await prisma.staffAssignment.deleteMany({ where: { organizationId: fx.org.id } });
  }
  await a?.drop();
  await b?.drop();
  await prisma.user.deleteMany({ where: { id: { in: [director?.id, instructor?.id].filter(Boolean) as string[] } } });
});

describe("authorization: owners only, nothing written otherwise", () => {
  it("an owner can add terms, a policy version and a package plan", async () => {
    asOwner();
    expect(await addPlanTerms(a.org.id, {}, termsForm({ planId: monthlyA2.id }))).toEqual({ ok: true });
    expect(await addPolicyVersion(a.org.id, {}, policyForm({ academyId: a2.id }))).toEqual({ ok: true });
    expect(await createPackagePlan(a.org.id, {}, packageForm({ name: `Owner pack ${suffix}`, academyId: a2.id }))).toEqual({ ok: true });
  });

  const writes = () =>
    [
      ["addPlanTerms", () => addPlanTerms(a.org.id, {}, termsForm({ ...ym(addMonths(FUTURE(), 5)) }))],
      ["addPolicyVersion", () => addPolicyVersion(a.org.id, {}, policyForm({ ...ym(addMonths(FUTURE(), 5)) }))],
      ["createPackagePlan", () => createPackagePlan(a.org.id, {}, packageForm({ name: `Refused ${suffix}` }))],
      ["correctPlanTerms", () => correctPlanTerms(a.org.id, {}, form({ termsId: "x", expectedRevision: "x", priceAmount: "1.00", currency: "USD", monthsCovered: "1" }))],
      ["correctPolicyVersion", () => correctPolicyVersion(a.org.id, {}, form({ policyId: "x", expectedRevision: "x", dueDay: "1", graceDay: "1", lateFeeAmount: "1.00", lateFeeCurrency: "USD", maxPrepaidMonths: "" }))],
    ] as const;

  // Same convention as every other owner-only action here (changeOrganizationCurrency): a genuine member with the wrong role
  // throws FORBIDDEN (the error boundary), it is not silently reported as "not found".
  it.each([
    ["a DIRECTOR", () => actAs(director.id, a.org.id, "DIRECTOR")],
    ["an INSTRUCTOR", () => actAs(instructor.id, a.org.id, "INSTRUCTOR")],
  ])("%s is refused (FORBIDDEN) on every write action, and nothing is written", async (_who, become) => {
    const before = await counts(a.org.id);
    become();
    for (const [name, run] of writes()) {
      await expect(run(), `${name} must refuse`).rejects.toThrow("FORBIDDEN");
    }
    expect(await counts(a.org.id)).toEqual(before);
  });

  // A non-member or an unauthenticated caller learns nothing: the same generic notFound as every cross-tenant check.
  it.each([
    ["a member of ANOTHER organization", () => actAs(b.admin.id, a.org.id)],
    ["nobody signed in", () => actAs(null, a.org.id)],
  ])("%s gets notFound on every write action, and nothing is written", async (_who, become) => {
    const before = await counts(a.org.id);
    become();
    for (const [name, run] of writes()) {
      expect(await run(), `${name} must refuse`).toEqual({ error: "notFound" });
    }
    expect(await counts(a.org.id)).toEqual(before);
  });

  it("an owner of organization B cannot use organization A's plan or branch ids, even in their own organization's session", async () => {
    const before = await counts(a.org.id);
    const beforeB = await counts(b.org.id);
    actAs(b.admin.id, b.org.id);
    expect(await addPlanTerms(b.org.id, {}, termsForm({ planId: monthlyA1.id }))).toEqual({ error: "notFound" });
    expect(await addPolicyVersion(b.org.id, {}, policyForm({ academyId: a.academy.id }))).toEqual({ error: "notFound" });
    expect(await createPackagePlan(b.org.id, {}, packageForm({ academyId: a.academy.id, name: `Cross ${suffix}` }))).toEqual({ error: "notFound" });
    expect(await counts(a.org.id)).toEqual(before);
    expect(await counts(b.org.id)).toEqual(beforeB);
  });

  it("an unknown plan or branch id is not found", async () => {
    asOwner();
    expect(await addPlanTerms(a.org.id, {}, termsForm({ planId: "no-such-plan" }))).toEqual({ error: "notFound" });
    expect(await addPolicyVersion(a.org.id, {}, policyForm({ academyId: "no-such-branch" }))).toEqual({ error: "notFound" });
  });
});

describe("exact input: refused, never rounded, nothing stored", () => {
  it.each([
    ["priceAmount", "1.005"], ["priceAmount", "1e2"], ["priceAmount", "1,5"], ["priceAmount", "0"], ["priceAmount", "-3"], ["priceAmount", ""],
    ["monthsCovered", "0"], ["monthsCovered", "1.5"], ["monthsCovered", "1213"], ["currency", "EUR"],
    ["effectiveMonth", "13"], ["effectiveYear", "1999"],
  ])("terms: %s = %j is invalid", async (field, value) => {
    asOwner();
    const before = await counts(a.org.id);
    const r = await addPlanTerms(a.org.id, {}, termsForm({ ...ym(addMonths(FUTURE(), 9)), [field]: value }));
    expect(r.error, JSON.stringify(r)).toBe("invalid");
    expect(await counts(a.org.id)).toEqual(before);
  });

  it.each([
    ["lateFeeAmount", "1.005"], ["lateFeeAmount", "-0.01"], ["lateFeeAmount", "abc"],
    ["dueDay", "0"], ["dueDay", "32"], ["dueDay", "1.5"], ["graceDay", "0"], ["graceDay", "32"],
    ["maxPrepaidMonths", "0"], ["maxPrepaidMonths", "-1"], ["maxPrepaidMonths", "1213"], ["maxPrepaidMonths", "2.5"], ["lateFeeCurrency", "XYZ"],
  ])("policy: %s = %j is invalid", async (field, value) => {
    asOwner();
    const before = await counts(a.org.id);
    const r = await addPolicyVersion(a.org.id, {}, policyForm({ ...ym(addMonths(FUTURE(), 9)), [field]: value }));
    expect(r.error, JSON.stringify(r)).toBe("invalid");
    expect(await counts(a.org.id)).toEqual(before);
  });

  it("stores exact values: 45.50 stays 45.50, a zero fee is allowed, a blank limit is null (not entered), 120 months is not a limit", async () => {
    asOwner();
    const m10 = addMonths(FUTURE(), 10);
    expect(await addPlanTerms(a.org.id, {}, termsForm({ ...ym(m10), priceAmount: "45.5" }))).toEqual({ ok: true });
    const t = await prisma.paymentPlanTerms.findFirstOrThrow({ where: { planId: monthlyA1.id, effectiveYear: m10.year, effectiveMonth: m10.month } });
    expect(t.priceAmount.toFixed(2)).toBe("45.50");
    expect(await addPolicyVersion(a.org.id, {}, policyForm({ ...ym(m10), lateFeeAmount: "0", maxPrepaidMonths: "" }))).toEqual({ ok: true });
    const p = await prisma.duesPolicyVersion.findFirstOrThrow({ where: { academyId: a.academy.id, effectiveYear: m10.year, effectiveMonth: m10.month } });
    expect(p.lateFeeAmount.toFixed(2)).toBe("0.00");
    expect(p.maxPrepaidMonths).toBeNull();
    expect(await addPolicyVersion(a.org.id, {}, policyForm({ ...ym(addMonths(FUTURE(), 11)), maxPrepaidMonths: "121" }))).toEqual({ ok: true });
  });
});

describe("effective months are judged in the branch's timezone", () => {
  it("a past month is refused, the current month and later are accepted", async () => {
    asOwner();
    expect((await addPlanTerms(a.org.id, {}, termsForm(ym(PAST())))).error).toBe("pastMonth");
    expect((await addPolicyVersion(a.org.id, {}, policyForm(ym(PAST())))).error).toBe("pastMonth");
    expect((await createPackagePlan(a.org.id, {}, packageForm({ ...ym(PAST()), name: `Past ${suffix}` }))).error).toBe("pastMonth");
    expect(await addPlanTerms(a.org.id, {}, termsForm({ planId: monthlyA2.id, ...ym(now()), priceAmount: "44.00" }))).toEqual({ ok: true });
  });
});

describe("versions are insert-only: earlier rows are untouched", () => {
  it("adding a version grows the count by exactly one and leaves every earlier row byte-identical; a second version for the same month is refused", async () => {
    asOwner();
    const month = addMonths(FUTURE(), 20);
    const snapshot = async () => (await prisma.paymentPlanTerms.findMany({ where: { planId: monthlyA1.id }, orderBy: [{ effectiveYear: "asc" }, { effectiveMonth: "asc" }] })).map((r) => JSON.stringify(r));
    const before = await snapshot();
    expect(await addPlanTerms(a.org.id, {}, termsForm({ ...ym(month), priceAmount: "50.00" }))).toEqual({ ok: true });
    const after = await snapshot();
    expect(after.length).toBe(before.length + 1);
    for (const row of before) expect(after).toContain(row);
    expect((await addPlanTerms(a.org.id, {}, termsForm({ ...ym(month), priceAmount: "51.00" }))).error).toBe("versionExists");
    expect((await snapshot()).length).toBe(before.length + 1);
  });

  it("every accepted write leaves an audit row", async () => {
    asOwner();
    const before = (await counts(a.org.id)).audits;
    expect(await addPolicyVersion(a.org.id, {}, policyForm({ ...ym(addMonths(FUTURE(), 30)) }))).toEqual({ ok: true });
    expect((await counts(a.org.id)).audits).toBe(before + 1);
  });
});

describe("D25: only a version whose month is still in the future can be corrected, safely", () => {
  async function futureTerms(offset: number, price = "60.00") {
    asOwner();
    const m = addMonths(now(), offset);
    await addPlanTerms(a.org.id, {}, termsForm({ planId: monthlyA2.id, ...ym(m), priceAmount: price }));
    return prisma.paymentPlanTerms.findFirstOrThrow({ where: { planId: monthlyA2.id, effectiveYear: m.year, effectiveMonth: m.month } });
  }
  const fix = (row: Awaited<ReturnType<typeof futureTerms>>, over: Record<string, string> = {}) =>
    form({ termsId: row.id, expectedRevision: termsRevision(row), priceAmount: "61.25", currency: "USD", monthsCovered: "1", ...over });

  it("corrects a future version, keeps its effective month, and writes the before and after in the same transaction", async () => {
    const row = await futureTerms(40);
    const auditsBefore = (await counts(a.org.id)).audits;
    expect(await correctPlanTerms(a.org.id, {}, fix(row))).toEqual({ ok: true });
    const changed = await prisma.paymentPlanTerms.findUniqueOrThrow({ where: { id: row.id } });
    expect(changed.priceAmount.toFixed(2)).toBe("61.25");
    expect([changed.effectiveYear, changed.effectiveMonth]).toEqual([row.effectiveYear, row.effectiveMonth]);
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { organizationId: a.org.id, action: "duesPlanTerms.correct", entityId: row.id } });
    expect(JSON.stringify(audit.before)).toContain("60.00");
    expect(JSON.stringify(audit.after)).toContain("61.25");
    expect((await counts(a.org.id)).audits).toBe(auditsBefore + 1);
  });

  it("refuses a stale edit: a second editor holding the old revision cannot overwrite the first", async () => {
    const row = await futureTerms(41);
    const stale = fix(row, { priceAmount: "70.00" });
    expect(await correctPlanTerms(a.org.id, {}, fix(row, { priceAmount: "65.00" }))).toEqual({ ok: true });
    expect((await correctPlanTerms(a.org.id, {}, stale)).error).toBe("stale");
    expect((await prisma.paymentPlanTerms.findUniqueOrThrow({ where: { id: row.id } })).priceAmount.toFixed(2)).toBe("65.00");
  });

  it("refuses to correct a version of the current month or a past month (they are immutable), and writes nothing", async () => {
    const current = await prisma.paymentPlanTerms.create({ data: { organizationId: a.org.id, planId: monthlyA2.id, effectiveYear: now().year, effectiveMonth: now().month, priceAmount: "40.00", currency: "USD", monthsCovered: 1, createdById: a.admin.id } }).catch(async () => prisma.paymentPlanTerms.findFirstOrThrow({ where: { planId: monthlyA2.id, effectiveYear: now().year, effectiveMonth: now().month } }));
    const past = await prisma.paymentPlanTerms.create({ data: { organizationId: a.org.id, planId: monthlyA2.id, effectiveYear: PAST().year, effectiveMonth: PAST().month, priceAmount: "39.00", currency: "USD", monthsCovered: 1, createdById: a.admin.id } });
    const audits = (await counts(a.org.id)).audits;
    for (const row of [current, past]) {
      expect((await correctPlanTerms(a.org.id, {}, fix(row))).error).toBe("notFuture");
      expect((await prisma.paymentPlanTerms.findUniqueOrThrow({ where: { id: row.id } })).priceAmount.toFixed(2)).toBe(row.priceAmount.toFixed(2));
    }
    expect((await counts(a.org.id)).audits).toBe(audits);
  });

  it("refuses to correct a version that a financial record references (a prepaid package can depend on a future version), and changes nothing", async () => {
    asOwner();
    const month = addMonths(now(), 45);
    expect(await createPackagePlan(a.org.id, {}, packageForm({ name: `Referenced ${suffix}`, ...ym(month) }))).toEqual({ ok: true });
    const plan = await prisma.paymentPlan.findFirstOrThrow({ where: { organizationId: a.org.id, name: `Referenced ${suffix}` } });
    const terms = await prisma.paymentPlanTerms.findFirstOrThrow({ where: { planId: plan.id } });
    await prisma.duesObligation.create({
      data: {
        organizationId: a.org.id, studentId: studentA.id, academyId: a.academy.id, type: "PACKAGE", origin: "STAFF", coverageYear: month.year, coverageMonth: month.month,
        monthsCovered: 3, amount: "120.00", currency: "USD", planTermsId: terms.id, createdById: a.admin.id,
      },
    });
    const audits = (await counts(a.org.id)).audits;
    const r = await correctPlanTerms(a.org.id, {}, form({ termsId: terms.id, expectedRevision: termsRevision(terms), priceAmount: "130.00", currency: "USD", monthsCovered: "3" }));
    expect(r).toEqual({ error: "referenced" });
    expect((await prisma.paymentPlanTerms.findUniqueOrThrow({ where: { id: terms.id } })).priceAmount.toFixed(2)).toBe("120.00");
    expect((await counts(a.org.id)).audits).toBe(audits);
  });

  it("refuses to correct a policy version that a monthly obligation references, and changes nothing", async () => {
    asOwner();
    const month = addMonths(now(), 46);
    expect(await addPolicyVersion(a.org.id, {}, policyForm({ academyId: a2.id, ...ym(month), lateFeeAmount: "9.00" }))).toEqual({ ok: true });
    const policy = await prisma.duesPolicyVersion.findFirstOrThrow({ where: { academyId: a2.id, effectiveYear: month.year, effectiveMonth: month.month } });
    const terms = await futureTerms(47);
    await prisma.duesObligation.create({
      data: {
        organizationId: a.org.id, studentId: studentA.id, academyId: a2.id, type: "MONTHLY", origin: "SCHEDULED_JOB", coverageYear: month.year, coverageMonth: month.month,
        monthsCovered: 1, amount: "60.00", currency: "USD", lateFeeAmount: "9.00", dueOn: new Date(Date.UTC(month.year, month.month - 1, 20)),
        graceDeadline: new Date(Date.UTC(month.year, month.month, 5)), planTermsId: terms.id, policyVersionId: policy.id, createdById: a.admin.id,
      },
    });
    const r = await correctPolicyVersion(
      a.org.id,
      {},
      form({ policyId: policy.id, expectedRevision: policyRevision(policy), dueDay: "10", graceDay: "3", lateFeeAmount: "9.99", lateFeeCurrency: "USD", maxPrepaidMonths: "" }),
    );
    expect(r).toEqual({ error: "referenced" });
    expect((await prisma.duesPolicyVersion.findUniqueOrThrow({ where: { id: policy.id } })).lateFeeAmount.toFixed(2)).toBe("9.00");
  });

  it("a correction cannot change a plan between monthly and package, and cannot introduce a second currency", async () => {
    const row = await futureTerms(42);
    expect((await correctPlanTerms(a.org.id, {}, fix(row, { monthsCovered: "3" }))).error).toBe("durationMismatch");
    expect((await correctPlanTerms(a.org.id, {}, fix(row, { currency: "CRC", priceAmount: "5000.00" }))).error).toBe("currencyMismatch");
    expect((await prisma.paymentPlanTerms.findUniqueOrThrow({ where: { id: row.id } })).priceAmount.toFixed(2)).toBe("60.00");
  });

  it("saves the correction and its audit atomically: if the audit row cannot be written, the correction is rolled back", async () => {
    const row = await futureTerms(44, "70.00");
    // A trigger that rejects the correction's audit row (this organization only), so the audit INSERT fails AFTER the update ran.
    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION pr3_reject_terms_audit() RETURNS trigger AS $$
      BEGIN
        IF NEW."organizationId" = '${a.org.id}' AND NEW."action" = 'duesPlanTerms.correct' THEN RAISE EXCEPTION 'audit write refused (test)'; END IF;
        RETURN NEW;
      END; $$ LANGUAGE plpgsql`);
    await prisma.$executeRawUnsafe(`CREATE TRIGGER pr3_reject_terms_audit BEFORE INSERT ON "AuditLog" FOR EACH ROW EXECUTE FUNCTION pr3_reject_terms_audit()`);
    try {
      await expect(correctPlanTerms(a.org.id, {}, fix(row, { priceAmount: "71.00" }))).rejects.toThrow();
    } finally {
      await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS pr3_reject_terms_audit ON "AuditLog"`);
      await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS pr3_reject_terms_audit()`);
    }
    expect((await prisma.paymentPlanTerms.findUniqueOrThrow({ where: { id: row.id } })).priceAmount.toFixed(2)).toBe("70.00");
  });

  it("corrects a future policy version the same way, and refuses a stale one", async () => {
    asOwner();
    const m = addMonths(now(), 43);
    await addPolicyVersion(a.org.id, {}, policyForm({ academyId: a2.id, ...ym(m) }));
    const row = await prisma.duesPolicyVersion.findFirstOrThrow({ where: { academyId: a2.id, effectiveYear: m.year, effectiveMonth: m.month } });
    const edit = (over: Record<string, string> = {}) =>
      form({ policyId: row.id, expectedRevision: policyRevision(row), dueDay: "10", graceDay: "3", lateFeeAmount: "9.99", lateFeeCurrency: "USD", maxPrepaidMonths: "6", ...over });
    expect(await correctPolicyVersion(a.org.id, {}, edit())).toEqual({ ok: true });
    const changed = await prisma.duesPolicyVersion.findUniqueOrThrow({ where: { id: row.id } });
    expect([changed.dueDay, changed.graceDay, changed.lateFeeAmount.toFixed(2), changed.maxPrepaidMonths]).toEqual([10, 3, "9.99", 6]);
    expect((await correctPolicyVersion(a.org.id, {}, edit({ dueDay: "11" }))).error).toBe("stale");
  });
});

describe("one currency across a branch's dues configuration, and one duration kind per plan", () => {
  it("rejects a second currency on the same plan, and a fee currency that differs from the branch's plans (and the reverse)", async () => {
    asOwner();
    const m = (n: number) => ym(addMonths(FUTURE(), n));
    // make sure the second branch already holds USD terms and a USD policy, then a CRC write must fail on either table
    await addPlanTerms(a.org.id, {}, termsForm({ planId: monthlyA2.id, ...m(49), currency: "USD" }));
    await addPolicyVersion(a.org.id, {}, policyForm({ academyId: a2.id, ...m(49), lateFeeCurrency: "USD" }));
    expect((await addPlanTerms(a.org.id, {}, termsForm({ planId: monthlyA2.id, ...m(50), currency: "CRC", priceAmount: "5000.00" }))).error).toBe("currencyMismatch");
    expect((await addPolicyVersion(a.org.id, {}, policyForm({ academyId: a2.id, ...m(50), lateFeeCurrency: "CRC" }))).error).toBe("currencyMismatch");
  });

  it("a different branch has its own currency", async () => {
    actAs(b.admin.id, b.org.id);
    expect(await addPlanTerms(b.org.id, {}, termsForm({ planId: monthlyB.id, currency: "CRC", priceAmount: "5000.00" }))).toEqual({ ok: true });
    expect(await addPolicyVersion(b.org.id, {}, policyForm({ academyId: b.academy.id, lateFeeCurrency: "CRC", lateFeeAmount: "1000.00" }))).toEqual({ ok: true });
  });

  it("package terms cannot be added to an existing monthly plan, monthly terms cannot be added to a package plan", async () => {
    asOwner();
    expect((await addPlanTerms(a.org.id, {}, termsForm({ planId: monthlyA1.id, ...ym(addMonths(FUTURE(), 60)), monthsCovered: "3" }))).error).toBe("durationMismatch");
    const created = await createPackagePlan(a.org.id, {}, packageForm({ name: `Kind ${suffix}`, ...ym(addMonths(FUTURE(), 61)) }));
    expect(created).toEqual({ ok: true });
    const pack = await prisma.paymentPlan.findFirstOrThrow({ where: { organizationId: a.org.id, name: `Kind ${suffix}` } });
    expect((await addPlanTerms(a.org.id, {}, termsForm({ planId: pack.id, ...ym(addMonths(FUTURE(), 62)), monthsCovered: "1" }))).error).toBe("durationMismatch");
    expect(await addPlanTerms(a.org.id, {}, termsForm({ planId: pack.id, ...ym(addMonths(FUTURE(), 62)), monthsCovered: "6" }))).toEqual({ ok: true });
  });

  it("a package plan needs at least two months", async () => {
    asOwner();
    expect((await createPackagePlan(a.org.id, {}, packageForm({ name: `One ${suffix}`, monthsCovered: "1" }))).error).toBe("invalid");
  });
});

describe("package isolation: creation, activation, selection and server submission", () => {
  let pack: { id: string };
  beforeAll(async () => {
    asOwner();
    expect(await createPackagePlan(a.org.id, {}, packageForm({ name: `Aaa Isolation ${suffix}`, ...ym(addMonths(FUTURE(), 70)) }))).toEqual({ ok: true });
    pack = await prisma.paymentPlan.findFirstOrThrow({ where: { organizationId: a.org.id, name: `Aaa Isolation ${suffix}` } });
  });

  it("creation is atomic: the plan and its first terms exist together, and the plan is active", async () => {
    const plan = await prisma.paymentPlan.findUniqueOrThrow({ where: { id: pack.id }, include: { terms: true } });
    expect(plan.active).toBe(true);
    expect(plan.terms).toHaveLength(1);
    expect(plan.terms[0].monthsCovered).toBe(3);
    expect(plan.defaultAmount).toBeNull();
  });

  it("selection: the legacy picker lists the monthly plan and never the package plan", async () => {
    const ids = (await listSelectablePlans(a.org.id, [a.academy.id, a2.id])).map((p) => p.id);
    expect(ids).toContain(monthlyA1.id);
    expect(ids).not.toContain(pack.id);
  });

  it("management: an owner's list includes the package plan; the list a director gets can exclude it", async () => {
    const all = (await listPlansForManagement(a.org.id, [a.academy.id])).map((p) => p.id);
    expect(all).toContain(pack.id);
    const withoutPackages = (await listPlansForManagement(a.org.id, [a.academy.id], { includePackages: false })).map((p) => p.id);
    expect(withoutPackages).not.toContain(pack.id);
    expect(withoutPackages).toContain(monthlyA1.id);
  });

  it("server submission: recordPayment refuses a package plan even when the id is submitted directly, and records nothing", async () => {
    asOwner();
    const before = await prisma.paymentPeriod.count({ where: { studentId: studentA.id } });
    const r = await recordPayment(a.org.id, {}, form({ studentId: studentA.id, year: String(now().year), month: String(now().month), planId: pack.id, status: "PAID", amount: "10.00" }));
    expect(r.error).toBe("invalidPlan");
    expect(await prisma.paymentPeriod.count({ where: { studentId: studentA.id } })).toBe(before);
  });

  it("server submission: the same payment on the ordinary monthly plan still works (legacy behaviour unchanged)", async () => {
    asOwner();
    const m = addMonths(now(), -2);
    const r = await recordPayment(a.org.id, {}, form({ studentId: studentA.id, year: String(m.year), month: String(m.month), planId: monthlyA1.id, status: "PAID", amount: "10.00" }));
    expect(r, JSON.stringify(r)).toMatchObject({ ok: true });
  });

  it("markPaymentPaid's plan fallback never picks a package plan (it sorts first by name) and picks the branch's ordinary plan", async () => {
    // A branch with NO default-named monthly plan, so the by-name lookup misses and the alphabetical fallback decides.
    asOwner();
    const branch = await prisma.academy.create({ data: { organizationId: a.org.id, name: "Fallback branch", slug: `fallback-${suffix}`, kioskTokenHash: `fallback-${suffix}` } });
    const ordinary = await prisma.paymentPlan.create({ data: { organizationId: a.org.id, academyId: branch.id, name: `Zeta Standard ${suffix}` } });
    expect(await createPackagePlan(a.org.id, {}, packageForm({ academyId: branch.id, name: `Aaa Fallback ${suffix}`, ...ym(addMonths(FUTURE(), 72)) }))).toEqual({ ok: true });
    const student = await prisma.student.create({
      data: {
        organizationId: a.org.id, homeAcademyId: branch.id, firstName: "Fallback", lastName: "Owner", phone: "00000000",
        email: `dues-fallback-${suffix}@example.com`, currentRankId: await a.rankId("WHITE"), codeHash: `dues-fallback-${suffix}`, status: "ACTIVE",
      },
    });
    const m = addMonths(now(), -3);
    const r = await markPaymentPaid(a.org.id, student.id, m.year, m.month);
    expect(r, JSON.stringify(r)).toMatchObject({ ok: true });
    const period = await prisma.paymentPeriod.findUniqueOrThrow({ where: { studentId_year_month: { studentId: student.id, year: m.year, month: m.month } } });
    expect(period.planId).toBe(ordinary.id);
  });

  it("markPaymentPaid's by-name lookup never picks a package plan that carries a default plan name", async () => {
    asOwner();
    const branch = await prisma.academy.create({ data: { organizationId: a.org.id, name: "Default-name branch", slug: `defname-${suffix}`, kioskTokenHash: `defname-${suffix}` } });
    const ordinary = await prisma.paymentPlan.create({ data: { organizationId: a.org.id, academyId: branch.id, name: `Zeta Only ${suffix}` } });
    expect(await createPackagePlan(a.org.id, {}, packageForm({ academyId: branch.id, name: "Mensualidad", ...ym(addMonths(FUTURE(), 73)) }))).toEqual({ ok: true });
    const student = await prisma.student.create({
      data: {
        organizationId: a.org.id, homeAcademyId: branch.id, firstName: "DefName", lastName: "Owner", phone: "00000000",
        email: `dues-defname-${suffix}@example.com`, currentRankId: await a.rankId("WHITE"), codeHash: `dues-defname-${suffix}`, status: "ACTIVE",
      },
    });
    const m = addMonths(now(), -4);
    expect(await markPaymentPaid(a.org.id, student.id, m.year, m.month)).toMatchObject({ ok: true });
    const period = await prisma.paymentPeriod.findUniqueOrThrow({ where: { studentId_year_month: { studentId: student.id, year: m.year, month: m.month } } });
    expect(period.planId).toBe(ordinary.id);
  });

  it("saving future monthly terms on an existing monthly plan does not remove it from the legacy picker", async () => {
    asOwner();
    expect(await addPlanTerms(a.org.id, {}, termsForm({ planId: monthlyA1.id, ...ym(addMonths(FUTURE(), 71)) }))).toEqual({ ok: true });
    expect((await listSelectablePlans(a.org.id, [a.academy.id])).map((p) => p.id)).toContain(monthlyA1.id);
  });

  it("activation: the last MONTHLY plan cannot be deactivated just because a package plan is active; deactivating a package plan is not blocked by that rule", async () => {
    asOwner();
    expect((await deactivatePlan(a.org.id, monthlyA1.id)).error).toBe("lastActivePlan");
    expect(await deactivatePlan(a.org.id, pack.id)).toEqual({ ok: true });
    expect((await listSelectablePlans(a.org.id, [a.academy.id])).map((p) => p.id)).not.toContain(pack.id);
    expect(await reactivatePlan(a.org.id, pack.id)).toEqual({ ok: true });
    expect((await listSelectablePlans(a.org.id, [a.academy.id])).map((p) => p.id)).not.toContain(pack.id); // reactivating never puts it in the legacy picker
  });

  it("a director cannot edit, deactivate or reactivate a package plan (owners only), and can still manage ordinary plans", async () => {
    actAs(director.id, a.org.id, "DIRECTOR");
    // a director does not see package plans at all, so for them a package plan simply does not exist
    expect((await updatePlan(a.org.id, {}, form({ planId: pack.id, name: "Renamed by director", description: "", defaultAmount: "" }))).error).toBe("notFound");
    expect((await deactivatePlan(a.org.id, pack.id)).error).toBe("notFound");
    expect((await reactivatePlan(a.org.id, pack.id)).error).toBe("notFound");
    expect((await prisma.paymentPlan.findUniqueOrThrow({ where: { id: pack.id } })).name).toBe(`Aaa Isolation ${suffix}`);
    expect(await updatePlan(a.org.id, {}, form({ planId: monthlyA1.id, name: "Monthly", description: "kept", defaultAmount: "" }))).toEqual({ ok: true });
  });
});

describe("concurrency: simultaneous saves cannot break the single-currency or single-version rules", () => {
  const together = async <T>(...calls: Promise<T>[]) => Promise.all(calls);

  it("two conflicting currencies for the same plan saved at the same moment: exactly one wins", async () => {
    asOwner();
    const branch = await prisma.academy.create({ data: { organizationId: a.org.id, name: "Race branch 1", slug: `race1-${suffix}`, kioskTokenHash: `race1-${suffix}` } });
    const plan = await prisma.paymentPlan.create({ data: { organizationId: a.org.id, academyId: branch.id, name: `Race plan ${suffix}` } });
    const results = await together(
      addPlanTerms(a.org.id, {}, termsForm({ planId: plan.id, ...ym(addMonths(FUTURE(), 80)), currency: "USD", priceAmount: "10.00" })),
      addPlanTerms(a.org.id, {}, termsForm({ planId: plan.id, ...ym(addMonths(FUTURE(), 81)), currency: "CRC", priceAmount: "5000.00" })),
    );
    expect(results.filter((r) => r.ok).length, JSON.stringify(results)).toBe(1);
    expect(results.filter((r) => r.error === "currencyMismatch").length).toBe(1);
    const currencies = new Set((await prisma.paymentPlanTerms.findMany({ where: { planId: plan.id } })).map((t) => t.currency));
    expect(currencies.size).toBe(1);
  });

  it("a fee currency and a plan-terms currency saved at the same moment on one branch: exactly one wins", async () => {
    asOwner();
    const branch = await prisma.academy.create({ data: { organizationId: a.org.id, name: "Race branch 2", slug: `race2-${suffix}`, kioskTokenHash: `race2-${suffix}` } });
    const plan = await prisma.paymentPlan.create({ data: { organizationId: a.org.id, academyId: branch.id, name: `Race plan 2 ${suffix}` } });
    const results = await together(
      addPolicyVersion(a.org.id, {}, policyForm({ academyId: branch.id, ...ym(addMonths(FUTURE(), 82)), lateFeeCurrency: "CRC", lateFeeAmount: "1000.00" })),
      addPlanTerms(a.org.id, {}, termsForm({ planId: plan.id, ...ym(addMonths(FUTURE(), 82)), currency: "USD", priceAmount: "10.00" })),
    );
    expect(results.filter((r) => r.ok).length, JSON.stringify(results)).toBe(1);
    expect(results.filter((r) => r.error === "currencyMismatch").length).toBe(1);
    const currencies = new Set([
      ...(await prisma.duesPolicyVersion.findMany({ where: { academyId: branch.id } })).map((p) => p.lateFeeCurrency),
      ...(await prisma.paymentPlanTerms.findMany({ where: { planId: plan.id } })).map((t) => t.currency),
    ]);
    expect(currencies.size).toBe(1);
  });

  it("the same version month saved twice at once: one succeeds and the other is reported as versionExists, never thrown", async () => {
    asOwner();
    const month = ym(addMonths(FUTURE(), 83));
    const results = await together(
      addPlanTerms(a.org.id, {}, termsForm({ planId: monthlyA1.id, ...month, priceAmount: "20.00" })),
      addPlanTerms(a.org.id, {}, termsForm({ planId: monthlyA1.id, ...month, priceAmount: "21.00" })),
    );
    expect(results.filter((r) => r.ok).length).toBe(1);
    expect(results.filter((r) => r.error === "versionExists").length).toBe(1);
  });

  it("two owners correcting the same version at once from the same revision: one wins, the other is told it is stale", async () => {
    asOwner();
    const m = addMonths(now(), 84);
    await addPlanTerms(a.org.id, {}, termsForm({ planId: monthlyA2.id, ...ym(m), priceAmount: "30.00" }));
    const row = await prisma.paymentPlanTerms.findFirstOrThrow({ where: { planId: monthlyA2.id, effectiveYear: m.year, effectiveMonth: m.month } });
    const edit = (price: string) => form({ termsId: row.id, expectedRevision: termsRevision(row), priceAmount: price, currency: "USD", monthsCovered: "1" });
    const results = await together(correctPlanTerms(a.org.id, {}, edit("31.00")), correctPlanTerms(a.org.id, {}, edit("32.00")));
    expect(results.filter((r) => r.ok).length, JSON.stringify(results)).toBe(1);
    expect(results.filter((r) => r.error === "stale").length).toBe(1);
  });

  it("two package plans with the same name created at once: one succeeds, the other is nameTaken", async () => {
    asOwner();
    const results = await together(
      createPackagePlan(a.org.id, {}, packageForm({ name: `Twin ${suffix}`, ...ym(addMonths(FUTURE(), 85)) })),
      createPackagePlan(a.org.id, {}, packageForm({ name: `Twin ${suffix}`, ...ym(addMonths(FUTURE(), 86)) })),
    );
    expect(results.filter((r) => r.ok).length, JSON.stringify(results)).toBe(1);
    expect(results.filter((r) => r.error === "nameTaken").length).toBe(1);
    expect(await prisma.paymentPlan.count({ where: { organizationId: a.org.id, name: `Twin ${suffix}` } })).toBe(1);
  });
});
