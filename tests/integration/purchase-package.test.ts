import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getTestPrismaClient } from "../helpers/test-db";
import { makeAccountingOrg } from "../helpers/accounting-org";
import type { TenantContext } from "../../src/lib/tenant/types";
import type { YearMonth } from "../../src/lib/dues/calendar";
import { createMonthlyObligation } from "../../src/lib/dues/ledger/create-monthly-obligation";
import { recordDuesPayment } from "../../src/lib/dues/ledger/record-payment";
import { reversePayment } from "../../src/lib/dues/ledger/reverse-payment";
import { purchasePackage } from "../../src/lib/dues/ledger/purchase-package";
import type { LedgerActivation } from "../../src/lib/dues/ledger/activation";

/**
 * Package-purchase brief, proved against the REAL test database, following this session's established fixture/concurrency
 * conventions (`prepay-monthly.test.ts`, `waive-late-fee.test.ts`). `purchasePackage` names its terms/version explicitly —
 * unlike prepayment, it never resolves a student's plan assignment, so this suite needs none of that machinery.
 */
const prisma = getTestPrismaClient();
type Fixture = Awaited<ReturnType<typeof makeAccountingOrg>>;
const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
const ACTIVE: LedgerActivation = { isActive: async () => true };
const at = (isoLocal: string) => () => new Date(`${isoLocal}-06:00`); // Costa Rica, UTC-6 all year
const DEC_2030 = at("2030-12-01T12:00:00");
const deps = (extra: Record<string, unknown> = {}) => ({ activation: ACTIVE, now: DEC_2030, ...extra });

let a: Fixture;
let b: Fixture;
let monthlyPlan: { id: string };
let monthlyTerms: { id: string };
let policyBase: { id: string; maxPrepaidMonths: number | null };
let packagePlan: { id: string };
let packageTerms: { id: string };

function context(over: Partial<TenantContext> = {}): TenantContext {
  return { kind: "tenant", actorUserId: a.admin.id, organizationId: a.org.id, organizationRole: "ADMIN", academyIds: "ALL", selfStudentId: null, linkedStudentId: null, ...over };
}

let studentCounter = 0;
async function newStudent(label: string, academyId = a.academy.id, org: Fixture = a) {
  const n = ++studentCounter;
  return prisma.student.create({
    data: {
      organizationId: org.org.id, homeAcademyId: academyId, firstName: "Package", lastName: `${label}${n}`, phone: "00000000",
      email: `package-${label}-${n}-${suffix}@example.com`, currentRankId: await org.rankId("WHITE"), codeHash: `package-${label}-${n}-${suffix}`, status: "ACTIVE",
    },
  });
}

/** A SIGNUP obligation (dues-signup-settlement brief): no writer creates a bare one outside enrollment, inserted directly in
 * the shape `dues-ledger-schema.test.ts` proves the database accepts. */
async function newSignupObligation(studentId: string, coverage: { year: number; month: number }, amount = "50.00") {
  return prisma.duesObligation.create({
    data: {
      organizationId: a.org.id, studentId, academyId: a.academy.id, type: "SIGNUP", origin: "STAFF",
      coverageYear: coverage.year, coverageMonth: coverage.month, monthsCovered: 1, amount, currency: "USD",
      lateFeeAmount: null, dueOn: new Date(Date.UTC(coverage.year, coverage.month - 1, 1)), graceDeadline: null,
      planTermsId: monthlyTerms.id, policyVersionId: null, createdById: a.admin.id,
    },
  });
}

const purchase = (over: Partial<Parameters<typeof purchasePackage>[0]> = {}, extraDeps: Record<string, unknown> = {}) =>
  purchasePackage(
    {
      // The TRUE first-uncovered month for a fresh student under the default December 2030 clock is December itself
      // (the floor is currentMonth, not currentMonth + 1 — approved policy 4, the one deliberate difference from
      // prepayment) — a fresh student has nothing covering December, so that is where an unqualified purchase must start.
      context: context(), studentId: "", planTermsId: packageTerms.id, requestedStartMonth: { year: 2030, month: 12 },
      receivedOn: { year: 2030, month: 12, day: 1 }, tender: { currency: "USD", amount: "" }, method: "EFECTIVO", maxBackdateDays: 90, ...over,
    },
    deps(extraDeps),
  );

async function ledgerCounts(organizationId: string) {
  return {
    obligations: await prisma.duesObligation.count({ where: { organizationId } }),
    coverage: await prisma.duesCoverage.count({ where: { organizationId } }),
    payments: await prisma.duesPayment.count({ where: { organizationId } }),
    settlements: await prisma.duesSettlement.count({ where: { organizationId } }),
    audits: await prisma.auditLog.count({ where: { organizationId, action: { startsWith: "dues" } } }),
  };
}

/** Waits until Postgres reports a session genuinely blocked on a lock matching every string in `matches` — the established
 * pattern, reused verbatim from `prepay-monthly.test.ts`/`dues-ledger-writers.test.ts`. */
async function waitUntilBlockedOnLock(matches: string[], timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = await prisma.$queryRawUnsafe<{ query: string }[]>(`SELECT query FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query IS NOT NULL`);
    if (rows.some((row) => matches.every((m) => row.query.includes(m)))) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

/** A dedicated, test-controlled transaction that holds a specific `PaymentPlanTerms` row `FOR UPDATE` — the identical lock
 * a real terms correction would take — until `release()`, simulating a concurrent configuration correction without
 * invoking the real (auth-bound) server action. */
function holdTermsLock(termsId: string) {
  let started!: () => void;
  const startedPromise = new Promise<void>((r) => (started = r));
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const held = prisma.$transaction(
    async (tx) => {
      await tx.$queryRawUnsafe(`SELECT "id" FROM "PaymentPlanTerms" WHERE "id" = '${termsId}' FOR UPDATE`);
      started();
      await gate;
    },
    { timeout: 60_000 },
  );
  return { startedPromise, release, held };
}

beforeAll(async () => {
  a = await makeAccountingOrg("CUMULATIVE", "package-a");
  b = await makeAccountingOrg("CUMULATIVE", "package-b");
  monthlyPlan = await prisma.paymentPlan.create({ data: { organizationId: a.org.id, academyId: a.academy.id, name: `Package-monthly plan ${suffix}` } });
  monthlyTerms = await prisma.paymentPlanTerms.create({
    data: { organizationId: a.org.id, planId: monthlyPlan.id, effectiveYear: 2027, effectiveMonth: 1, priceAmount: "100.00", currency: "USD", monthsCovered: 1, createdById: a.admin.id },
  });
  // A generous default horizon (not the specific boundary value under test anywhere on this shared academy — the
  // dedicated boundary/lowering-limit tests below each set up their own academy/policy with the exact limit they need)
  // so two back-to-back package purchases for the same student have room without tripping the horizon check first.
  policyBase = await prisma.duesPolicyVersion.create({
    data: { organizationId: a.org.id, academyId: a.academy.id, effectiveYear: 2027, effectiveMonth: 1, dueDay: 20, graceDay: 5, lateFeeAmount: "20.00", lateFeeCurrency: "USD", maxPrepaidMonths: 12, createdById: a.admin.id },
  });
  packagePlan = await prisma.paymentPlan.create({ data: { organizationId: a.org.id, academyId: a.academy.id, name: `Package plan ${suffix}` } });
  packageTerms = await prisma.paymentPlanTerms.create({
    data: { organizationId: a.org.id, planId: packagePlan.id, effectiveYear: 2027, effectiveMonth: 1, priceAmount: "270.00", currency: "USD", monthsCovered: 3, createdById: a.admin.id },
  });
}, 60_000);

async function clearLedgerTables(organizationId: string) {
  await prisma.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL session_replication_role = replica");
      for (const table of ["DuesSettlement", "DuesPayment", "DuesLateFee", "DuesCoverage", "DuesObligation"]) {
        await tx.$executeRawUnsafe(`DELETE FROM "${table}" WHERE "organizationId" = $1`, organizationId);
      }
    },
    { timeout: 60_000 },
  );
  await prisma.auditLog.deleteMany({ where: { organizationId } });
  await prisma.paymentPlanTerms.deleteMany({ where: { organizationId } });
  await prisma.duesPolicyVersion.deleteMany({ where: { organizationId } });
  await prisma.paymentPlan.deleteMany({ where: { organizationId } });
}

afterAll(async () => {
  if (a) await clearLedgerTables(a.org.id);
  if (b) await clearLedgerTables(b.org.id);
  await a?.drop();
  await b?.drop();
}, 120_000);

describe("purchasePackage: the gate — activation, owner-only, tenant/branch scope, malformed input", () => {
  it("refuses notActive and writes nothing when no activation is injected", async () => {
    const s = await newStudent("gate");
    const before = await ledgerCounts(a.org.id);
    const r = await purchasePackage({
      context: context(), studentId: s.id, planTermsId: packageTerms.id, requestedStartMonth: { year: 2031, month: 1 },
      receivedOn: { year: 2030, month: 12, day: 1 }, tender: { currency: "USD", amount: "270.00" }, method: "EFECTIVO", maxBackdateDays: 90,
    });
    expect(r).toEqual({ ok: false, error: "notActive" });
    expect(await ledgerCounts(a.org.id)).toEqual(before);
  });

  it("a DIRECTOR (non-owner) context is refused (notFound), zero writes", async () => {
    const s = await newStudent("director");
    const before = await ledgerCounts(a.org.id);
    const r = await purchase({ context: context({ organizationRole: "DIRECTOR" }), studentId: s.id, tender: { currency: "USD", amount: "270.00" } });
    expect(r).toEqual({ ok: false, error: "notFound" });
    expect(await ledgerCounts(a.org.id)).toEqual(before);
  });

  it("a DIRECTOR scoped to a different branch is refused (notFound)", async () => {
    const other = await prisma.academy.create({ data: { organizationId: a.org.id, name: `Other ${suffix}`, slug: `other-package-${suffix}`, kioskTokenHash: `other-package-${suffix}` } });
    const s = await newStudent("outofbranch");
    const r = await purchase({ context: context({ organizationRole: "DIRECTOR", academyIds: [other.id] }), studentId: s.id, tender: { currency: "USD", amount: "270.00" } });
    expect(r).toEqual({ ok: false, error: "notFound" });
    await prisma.academy.delete({ where: { id: other.id } });
  });

  it("a student of a different organization is refused (notFound), never leaked cross-tenant", async () => {
    const bStudent = await newStudent("cross", b.academy.id, b);
    const before = await ledgerCounts(a.org.id);
    const r = await purchase({ studentId: bStudent.id, tender: { currency: "USD", amount: "270.00" } });
    expect(r).toEqual({ ok: false, error: "notFound" });
    expect(await ledgerCounts(a.org.id)).toEqual(before);
  });

  it("a malformed studentId is refused (invalid), before any DB read, with an otherwise-fully-valid request", async () => {
    const real = await newStudent("studentidfixture");
    const validArgs = { planTermsId: packageTerms.id, requestedStartMonth: { year: 2030, month: 12 }, receivedOn: { year: 2030 as const, month: 12 as const, day: 1 as const }, tender: { currency: "USD" as const, amount: "270.00" } };
    const before = await ledgerCounts(a.org.id);
    for (const bad of [undefined, null, 12345, ""]) {
      const r = await purchase({ ...validArgs, studentId: bad as never });
      expect(r, `studentId=${JSON.stringify(bad)}`).toEqual({ ok: false, error: "invalid" });
      expect(await ledgerCounts(a.org.id), `studentId=${JSON.stringify(bad)}`).toEqual(before);
    }
    const ok = await purchase({ ...validArgs, studentId: real.id });
    expect(ok).toMatchObject({ ok: true });
  });

  it("malformed planTermsId, requestedStartMonth and existingObligationIds are refused (invalid), before any DB read", async () => {
    const s = await newStudent("malformed");
    const before = await ledgerCounts(a.org.id);
    for (const bad of ["", 12345 as never]) {
      expect(await purchase({ studentId: s.id, planTermsId: bad, tender: { currency: "USD", amount: "270.00" } })).toEqual({ ok: false, error: "invalid" });
    }
    for (const bad of [{ year: 2031, month: 13 }, { year: 1999, month: 1 }]) {
      expect(await purchase({ studentId: s.id, requestedStartMonth: bad as YearMonth, tender: { currency: "USD", amount: "270.00" } })).toEqual({ ok: false, error: "invalid" });
    }
    expect(await purchase({ studentId: s.id, existingObligationIds: ["", "dup", "dup"], tender: { currency: "USD", amount: "270.00" } })).toEqual({ ok: false, error: "invalid" });
    expect(await ledgerCounts(a.org.id)).toEqual(before);
  });
});

describe("purchasePackage: package terms must be the currently-effective version (§7 policy 3)", () => {
  it("a superseded planTermsId is refused (staleTerms), never silently repriced", async () => {
    const academy = await prisma.academy.create({ data: { organizationId: a.org.id, name: `Stale ${suffix}`, slug: `stale-package-${suffix}`, kioskTokenHash: `stale-package-${suffix}` } });
    const plan = await prisma.paymentPlan.create({ data: { organizationId: a.org.id, academyId: academy.id, name: `Stale plan ${suffix}` } });
    const v1 = await prisma.paymentPlanTerms.create({ data: { organizationId: a.org.id, planId: plan.id, effectiveYear: 2027, effectiveMonth: 1, priceAmount: "270.00", currency: "USD", monthsCovered: 3, createdById: a.admin.id } });
    await prisma.paymentPlanTerms.create({ data: { organizationId: a.org.id, planId: plan.id, effectiveYear: 2030, effectiveMonth: 1, priceAmount: "300.00", currency: "USD", monthsCovered: 3, createdById: a.admin.id } });
    const s = await newStudent("stale", academy.id);
    const before = await ledgerCounts(a.org.id);
    // "Today" is December 2030 (deps()'s default clock) — v2 (effective Jan 2030) is the currently-effective version; v1 is superseded.
    const r = await purchase({ studentId: s.id, planTermsId: v1.id, tender: { currency: "USD", amount: "270.00" } });
    expect(r).toEqual({ ok: false, error: "staleTerms" });
    expect(await ledgerCounts(a.org.id)).toEqual(before);
  });
});

describe("purchasePackage: explicit coverage-gap validation, floored at the CURRENT month (§7 policy 4)", () => {
  it("a package may start in the current month if it is uncovered — the one deliberate difference from prepayment", async () => {
    const s = await newStudent("currentstart");
    // "Today" is December 2030 — request starting THIS month, not currentMonth + 1.
    const r = await purchasePackage(
      { context: context(), studentId: s.id, planTermsId: packageTerms.id, requestedStartMonth: { year: 2030, month: 12 }, receivedOn: { year: 2030, month: 12, day: 1 }, tender: { currency: "USD", amount: "270.00" }, method: "EFECTIVO", maxBackdateDays: 90 },
      deps(),
    );
    expect(r).toMatchObject({ ok: true });
  });

  it("a requestedStartMonth that does not equal the true first-uncovered month is refused (coverageGap), never silently redirected", async () => {
    const s = await newStudent("gap");
    // Default start (December 2030, the true floor for a fresh student) covers Dec/Jan/Feb.
    const first = await purchase({ studentId: s.id, tender: { currency: "USD", amount: "270.00" } });
    expect(first).toMatchObject({ ok: true });
    const before = await ledgerCounts(a.org.id);
    // The true next first-uncovered month is now March 2031 — naming April instead (skipping March) must refuse, never
    // silently redirect to March.
    const wrongStart = await purchase({ studentId: s.id, requestedStartMonth: { year: 2031, month: 4 }, tender: { currency: "USD", amount: "270.00" } });
    expect(wrongStart).toEqual({ ok: false, error: "coverageGap" });
    expect(await ledgerCounts(a.org.id)).toEqual(before);
  });

  it("existing obligations/coverage of ANY origin reserve their months — a package never replaces one", async () => {
    const s = await newStudent("reserved");
    const ordinary = await createMonthlyObligation({ context: context(), studentId: s.id, coverage: { year: 2030, month: 12 }, planTermsId: monthlyTerms.id, policyVersionId: policyBase.id }, deps());
    if (!ordinary.ok) throw new Error(ordinary.error);
    // Settled on time (Dec 1, before its own Dec 20 due date) so December's coverage is reserved but is no longer OPEN
    // debt — this test is about coverage reservation, not the separate debtNotFullySettled requirement.
    const settleDec = await recordDuesPayment(
      { context: context(), studentId: s.id, receivedOn: { year: 2030, month: 12, day: 1 }, tender: { currency: "USD", amount: "100.00" }, method: "EFECTIVO", obligationIds: [ordinary.obligationId], maxBackdateDays: 90 },
      deps(),
    );
    if (!settleDec.ok) throw new Error(settleDec.error);
    // December is already covered by an ordinary MONTHLY obligation — a package cannot start there or skip past it silently.
    const before = await ledgerCounts(a.org.id);
    const startingOnReserved = await purchasePackage(
      { context: context(), studentId: s.id, planTermsId: packageTerms.id, requestedStartMonth: { year: 2030, month: 12 }, receivedOn: { year: 2030, month: 12, day: 1 }, tender: { currency: "USD", amount: "270.00" }, method: "EFECTIVO", maxBackdateDays: 90 },
      deps(),
    );
    expect(startingOnReserved).toEqual({ ok: false, error: "coverageGap" });
    const afterOrdinary = await ledgerCounts(a.org.id);
    expect(afterOrdinary).toEqual(before);

    // The true first-uncovered month (January) succeeds and never touches December's ordinary obligation.
    const ok = await purchasePackage(
      { context: context(), studentId: s.id, planTermsId: packageTerms.id, requestedStartMonth: { year: 2031, month: 1 }, receivedOn: { year: 2030, month: 12, day: 1 }, tender: { currency: "USD", amount: "270.00" }, method: "EFECTIVO", maxBackdateDays: 90 },
      deps(),
    );
    expect(ok).toMatchObject({ ok: true });
    expect(await prisma.duesObligation.findUniqueOrThrow({ where: { id: ordinary.obligationId } })).toMatchObject({ type: "MONTHLY" });
  });
});

describe("purchasePackage: the standing-horizon limit also bounds a package's final covered month (§7 policy 1)", () => {
  const SEPT_2030 = at("2030-09-15T12:00:00");

  it("a 3-month package ending exactly at the horizon succeeds", async () => {
    // Limit 2 from September -> horizon ends November. A fresh student's true floor is September itself (nothing covers
    // it yet), so a 3-month package starting there covers Sep/Oct/Nov — its final month lands EXACTLY on the horizon.
    const academy = await prisma.academy.create({ data: { organizationId: a.org.id, name: `BoundaryAt ${suffix}`, slug: `boundary-at-package-${suffix}`, kioskTokenHash: `boundary-at-package-${suffix}` } });
    const plan = await prisma.paymentPlan.create({ data: { organizationId: a.org.id, academyId: academy.id, name: `BoundaryAt plan ${suffix}` } });
    const terms3mo = await prisma.paymentPlanTerms.create({ data: { organizationId: a.org.id, planId: plan.id, effectiveYear: 2027, effectiveMonth: 1, priceAmount: "300.00", currency: "USD", monthsCovered: 3, createdById: a.admin.id } });
    await prisma.duesPolicyVersion.create({ data: { organizationId: a.org.id, academyId: academy.id, effectiveYear: 2027, effectiveMonth: 1, dueDay: 20, graceDay: 5, lateFeeAmount: "20.00", lateFeeCurrency: "USD", maxPrepaidMonths: 2, createdById: a.admin.id } });
    const s = await newStudent("boundary-at", academy.id);
    const r = await purchasePackage(
      { context: context(), studentId: s.id, planTermsId: terms3mo.id, requestedStartMonth: { year: 2030, month: 9 }, receivedOn: { year: 2030, month: 9, day: 15 }, tender: { currency: "USD", amount: "300.00" }, method: "EFECTIVO", maxBackdateDays: 90 },
      deps({ now: SEPT_2030 }),
    );
    expect(r).toMatchObject({ ok: true }); // Sep, Oct, Nov — Nov is exactly currentMonth + 2
  });

  it("a 3-month package reaching past the horizon refuses prepaymentLimitExceeded", async () => {
    // Limit 1 from September -> horizon ends October. The same 3-month span (Sep/Oct/Nov) now reaches past it.
    const academy = await prisma.academy.create({ data: { organizationId: a.org.id, name: `BoundaryPast ${suffix}`, slug: `boundary-past-package-${suffix}`, kioskTokenHash: `boundary-past-package-${suffix}` } });
    const plan = await prisma.paymentPlan.create({ data: { organizationId: a.org.id, academyId: academy.id, name: `BoundaryPast plan ${suffix}` } });
    const terms3mo = await prisma.paymentPlanTerms.create({ data: { organizationId: a.org.id, planId: plan.id, effectiveYear: 2027, effectiveMonth: 1, priceAmount: "300.00", currency: "USD", monthsCovered: 3, createdById: a.admin.id } });
    await prisma.duesPolicyVersion.create({ data: { organizationId: a.org.id, academyId: academy.id, effectiveYear: 2027, effectiveMonth: 1, dueDay: 20, graceDay: 5, lateFeeAmount: "20.00", lateFeeCurrency: "USD", maxPrepaidMonths: 1, createdById: a.admin.id } });
    const s = await newStudent("boundary-past", academy.id);
    const before = await ledgerCounts(a.org.id);
    const r = await purchasePackage(
      { context: context(), studentId: s.id, planTermsId: terms3mo.id, requestedStartMonth: { year: 2030, month: 9 }, receivedOn: { year: 2030, month: 9, day: 15 }, tender: { currency: "USD", amount: "300.00" }, method: "EFECTIVO", maxBackdateDays: 90 },
      deps({ now: SEPT_2030 }),
    );
    expect(r).toEqual({ ok: false, error: "prepaymentLimitExceeded" }); // Sep, Oct, Nov — Nov is past the horizon (October)
    expect(await ledgerCounts(a.org.id)).toEqual(before);
  });

  it("unset maxPrepaidMonths refuses prepaymentUnavailable outright", async () => {
    const noLimitAcademy = await prisma.academy.create({ data: { organizationId: a.org.id, name: `NoLimit ${suffix}`, slug: `nolimit-package-${suffix}`, kioskTokenHash: `nolimit-package-${suffix}` } });
    const noLimitPlan = await prisma.paymentPlan.create({ data: { organizationId: a.org.id, academyId: noLimitAcademy.id, name: `NoLimit plan ${suffix}` } });
    const noLimitTerms = await prisma.paymentPlanTerms.create({ data: { organizationId: a.org.id, planId: noLimitPlan.id, effectiveYear: 2027, effectiveMonth: 1, priceAmount: "300.00", currency: "USD", monthsCovered: 3, createdById: a.admin.id } });
    await prisma.duesPolicyVersion.create({ data: { organizationId: a.org.id, academyId: noLimitAcademy.id, effectiveYear: 2027, effectiveMonth: 1, dueDay: 20, graceDay: 5, lateFeeAmount: "20.00", lateFeeCurrency: "USD", maxPrepaidMonths: null, createdById: a.admin.id } });
    const s = await newStudent("nolimit", noLimitAcademy.id);
    const r = await purchasePackage(
      { context: context(), studentId: s.id, planTermsId: noLimitTerms.id, requestedStartMonth: { year: 2031, month: 1 }, receivedOn: { year: 2030, month: 12, day: 1 }, tender: { currency: "USD", amount: "300.00" }, method: "EFECTIVO", maxBackdateDays: 90 },
      deps(),
    );
    expect(r).toEqual({ ok: false, error: "prepaymentUnavailable" });
  });
});

describe("purchasePackage: lowering the limit never changes existing purchased coverage", () => {
  it("existing coverage stays exactly as it is; only a new purchase attempt is gated by the lower limit", async () => {
    const academy = await prisma.academy.create({ data: { organizationId: a.org.id, name: `Lower ${suffix}`, slug: `lower-package-${suffix}`, kioskTokenHash: `lower-package-${suffix}` } });
    const plan = await prisma.paymentPlan.create({ data: { organizationId: a.org.id, academyId: academy.id, name: `Lower plan ${suffix}` } });
    const terms3mo = await prisma.paymentPlanTerms.create({ data: { organizationId: a.org.id, planId: plan.id, effectiveYear: 2027, effectiveMonth: 1, priceAmount: "300.00", currency: "USD", monthsCovered: 3, createdById: a.admin.id } });
    await prisma.duesPolicyVersion.create({ data: { organizationId: a.org.id, academyId: academy.id, effectiveYear: 2027, effectiveMonth: 1, dueDay: 20, graceDay: 5, lateFeeAmount: "20.00", lateFeeCurrency: "USD", maxPrepaidMonths: 6, createdById: a.admin.id } });
    const s = await newStudent("lower", academy.id);
    const first = await purchasePackage(
      { context: context(), studentId: s.id, planTermsId: terms3mo.id, requestedStartMonth: { year: 2030, month: 12 }, receivedOn: { year: 2030, month: 12, day: 1 }, tender: { currency: "USD", amount: "300.00" }, method: "EFECTIVO", maxBackdateDays: 90 },
      deps(),
    );
    expect(first).toMatchObject({ ok: true });
    if (!first.ok) return;
    const before = await prisma.duesObligation.findUniqueOrThrow({ where: { id: first.obligationId } });

    // Lower the limit to 1 (effective a month later than the fixture's base, so it becomes the currently-effective one).
    await prisma.duesPolicyVersion.create({ data: { organizationId: a.org.id, academyId: academy.id, effectiveYear: 2030, effectiveMonth: 12, dueDay: 20, graceDay: 5, lateFeeAmount: "20.00", lateFeeCurrency: "USD", maxPrepaidMonths: 1, createdById: a.admin.id } });

    expect(await prisma.duesObligation.findUniqueOrThrow({ where: { id: first.obligationId } })).toEqual(before);

    const s2 = await newStudent("lower2", academy.id);
    const blocked = await purchasePackage(
      { context: context(), studentId: s2.id, planTermsId: terms3mo.id, requestedStartMonth: { year: 2030, month: 12 }, receivedOn: { year: 2030, month: 12, day: 1 }, tender: { currency: "USD", amount: "300.00" }, method: "EFECTIVO", maxBackdateDays: 90 },
      deps(),
    );
    expect(blocked).toEqual({ ok: false, error: "prepaymentLimitExceeded" }); // a 3-month package no longer fits under limit 1
  });
});

describe("purchasePackage: existing outstanding debt combined with the package in one receipt", () => {
  it("combines a named current-debt MONTHLY obligation with the package, oldest first, one exact total", async () => {
    const s = await newStudent("combined");
    const sep = await createMonthlyObligation({ context: context(), studentId: s.id, coverage: { year: 2030, month: 9 }, planTermsId: monthlyTerms.id, policyVersionId: policyBase.id }, deps());
    if (!sep.ok) throw new Error(sep.error);
    // September's grace deadline is Oct 5, 2030 — settling on Dec 1 (this receipt's date) is well past it: 100 (Sep + fee 20) + 270 (package) = 390.00.
    const r = await purchase({ studentId: s.id, existingObligationIds: [sep.obligationId], tender: { currency: "USD", amount: "390.00" } });
    expect(r).toMatchObject({ ok: true, totalMinor: 39000 });
    if (!r.ok) return;
    expect(await prisma.duesSettlement.count({ where: { paymentId: r.paymentId, reversedAt: null } })).toBe(2);
  });
});

describe("purchasePackage: full settlement — a debt-only tender is refused and rolled back, never a partial success (§4)", () => {
  it("a receipt matching only the current-debt portion's total refuses in full, package and every coverage row rolled back", async () => {
    const s = await newStudent("debtonly");
    const sep = await createMonthlyObligation({ context: context(), studentId: s.id, coverage: { year: 2030, month: 9 }, planTermsId: monthlyTerms.id, policyVersionId: policyBase.id }, deps());
    if (!sep.ok) throw new Error(sep.error);
    const before = await ledgerCounts(a.org.id);
    // 120.00 exactly settles September (100 + 20 fee) alone — a LEGITIMATE settleReceipt prefix that excludes the package.
    const r = await purchase({ studentId: s.id, existingObligationIds: [sep.obligationId], tender: { currency: "USD", amount: "120.00" } });
    expect(r.ok).toBe(false);
    expect(await ledgerCounts(a.org.id)).toEqual(before);
    expect(await prisma.duesSettlement.count({ where: { obligationId: sep.obligationId, reversedAt: null } })).toBe(0);
    // The offered total must be the ONE full-purchase amount (debt + package = 120 + 270 = 390.00), never the debt-only
    // prefix that was just refused — advertising that back would only lead to a second, identical refusal.
    if (!r.ok) expect(r.selectableTotals).toEqual(["390.00"]);
  });
});

describe("purchasePackage: ALL outstanding MONTHLY debt must be named and settled with the package, not just whatever the caller chose", () => {
  it("an older unpaid MONTHLY obligation exists; naming no existing-debt ids at all refuses debtNotFullySettled, zero writes", async () => {
    const s = await newStudent("debtunnamed");
    const aug = await createMonthlyObligation({ context: context(), studentId: s.id, coverage: { year: 2030, month: 8 }, planTermsId: monthlyTerms.id, policyVersionId: policyBase.id }, deps());
    if (!aug.ok) throw new Error(aug.error);
    const before = await ledgerCounts(a.org.id);
    const r = await purchase({ studentId: s.id, tender: { currency: "USD", amount: "270.00" } }); // no existingObligationIds named
    expect(r).toEqual({ ok: false, error: "debtNotFullySettled" });
    expect(await ledgerCounts(a.org.id)).toEqual(before);
  });

  it("two older unpaid MONTHLY obligations exist; naming only the first (a valid oldest-first prefix of count 1) still refuses debtNotFullySettled, zero writes", async () => {
    const s = await newStudent("debtpartial");
    const aug = await createMonthlyObligation({ context: context(), studentId: s.id, coverage: { year: 2030, month: 8 }, planTermsId: monthlyTerms.id, policyVersionId: policyBase.id }, deps());
    if (!aug.ok) throw new Error(aug.error);
    const sep = await createMonthlyObligation({ context: context(), studentId: s.id, coverage: { year: 2030, month: 9 }, planTermsId: monthlyTerms.id, policyVersionId: policyBase.id }, deps());
    if (!sep.ok) throw new Error(sep.error);
    const before = await ledgerCounts(a.org.id);
    // August alone (100 + 20 fee) + package 270 = 390.00 — a technically-fitting total, still refused since September is left unaddressed.
    const r = await purchase({ studentId: s.id, existingObligationIds: [aug.obligationId], tender: { currency: "USD", amount: "390.00" } });
    expect(r).toEqual({ ok: false, error: "debtNotFullySettled" });
    expect(await ledgerCounts(a.org.id)).toEqual(before);
  });

  it("control: naming and fully settling both older obligations plus the package in one receipt succeeds atomically, one exact total", async () => {
    const s = await newStudent("debtfull");
    const aug = await createMonthlyObligation({ context: context(), studentId: s.id, coverage: { year: 2030, month: 8 }, planTermsId: monthlyTerms.id, policyVersionId: policyBase.id }, deps());
    if (!aug.ok) throw new Error(aug.error);
    const sep = await createMonthlyObligation({ context: context(), studentId: s.id, coverage: { year: 2030, month: 9 }, planTermsId: monthlyTerms.id, policyVersionId: policyBase.id }, deps());
    if (!sep.ok) throw new Error(sep.error);
    // Both August (grace Sep 5) and September (grace Oct 5) are well past grace by Dec 1: (100+20) * 2 = 240, plus package 270 = 510.00.
    const r = await purchase({ studentId: s.id, existingObligationIds: [aug.obligationId, sep.obligationId], tender: { currency: "USD", amount: "510.00" } });
    expect(r).toMatchObject({ ok: true, totalMinor: 51000 });
    if (!r.ok) return;
    expect(await prisma.duesSettlement.count({ where: { paymentId: r.paymentId, reversedAt: null } })).toBe(3);
  });
});

/**
 * SIGNUP-settlement brief (D17): `debtNotFullySettled`'s own `chosenItems.length !== allOpenItems.length` check requires
 * ZERO code change here to extend to SIGNUP — `resolveMonthlyDebtItemsInTx` now returns an open SIGNUP as part of
 * `allOpenItems`, so an unnamed SIGNUP automatically fails this count comparison exactly like an unnamed MONTHLY would.
 */
describe("purchasePackage: an outstanding SIGNUP is also 'all outstanding debt' and must be named (dues-signup-settlement brief)", () => {
  it("an unpaid SIGNUP exists; naming no existing-debt ids at all refuses debtNotFullySettled, zero writes", async () => {
    const s = await newStudent("signup-unnamed");
    const signup = await newSignupObligation(s.id, { year: 2030, month: 8 });
    const before = await ledgerCounts(a.org.id);
    const r = await purchase({ studentId: s.id, tender: { currency: "USD", amount: "270.00" } });
    expect(r).toEqual({ ok: false, error: "debtNotFullySettled" });
    expect(await ledgerCounts(a.org.id)).toEqual(before);
    expect(await prisma.duesSettlement.count({ where: { obligationId: signup.id } })).toBe(0);
  });

  it("naming the SIGNUP plus the package together succeeds atomically, one exact total", async () => {
    const s = await newStudent("signup-named");
    const signup = await newSignupObligation(s.id, { year: 2030, month: 8 }, "50.00");
    const r = await purchase({ studentId: s.id, existingObligationIds: [signup.id], tender: { currency: "USD", amount: "320.00" } }); // 50 (SIGNUP, never late-fee eligible) + 270 (package)
    expect(r).toMatchObject({ ok: true, totalMinor: 32000 });
    if (!r.ok) return;
    const settlement = await prisma.duesSettlement.findFirstOrThrow({ where: { obligationId: signup.id, reversedAt: null } });
    expect(settlement.lateFeeId).toBeNull();
  });
});

describe("purchasePackage: the 60-per-receipt selection limit accounts for the package's own slot", () => {
  it("60 existing-debt ids plus the package (61 total) refuses invalid, before any DB read", async () => {
    const s = await newStudent("toomany");
    const fakeIds = Array.from({ length: 60 }, (_, i) => `fake-${i}`);
    const before = await ledgerCounts(a.org.id);
    const r = await purchase({ studentId: s.id, existingObligationIds: fakeIds, tender: { currency: "USD", amount: "270.00" } });
    expect(r).toEqual({ ok: false, error: "invalid" });
    expect(await ledgerCounts(a.org.id)).toEqual(before);
  });

  it("exactly 59 existing-debt ids plus the package (60 total) succeeds", async () => {
    const s = await newStudent("exactly59");
    // 59 consecutive months, far in the past and unrelated to any other fixture's coverage months.
    const span: YearMonth[] = Array.from({ length: 59 }, (_, i) => ({ year: 2010 + Math.floor(i / 12), month: (i % 12) + 1 }));
    await prisma.duesObligation.createMany({
      data: span.map((m) => ({
        organizationId: a.org.id, studentId: s.id, academyId: a.academy.id, type: "MONTHLY" as const, origin: "STAFF" as const,
        coverageYear: m.year, coverageMonth: m.month, monthsCovered: 1, amount: "100.00", currency: "USD" as const, lateFeeAmount: "0.00",
        dueOn: new Date(Date.UTC(m.year, m.month - 1, 1)), graceDeadline: new Date(Date.UTC(m.year, m.month - 1, 20)),
        planTermsId: monthlyTerms.id, policyVersionId: policyBase.id, createdById: a.admin.id,
      })),
    });
    const debtRows = await prisma.duesObligation.findMany({ where: { organizationId: a.org.id, studentId: s.id }, select: { id: true } });
    expect(debtRows).toHaveLength(59); // exactly this student's whole open MONTHLY set — required by the debtNotFullySettled check
    // 59 * 100.00 (lateFeeAmount 0.00, so no fee regardless of how late) + package 270.00 = 6170.00.
    const r = await purchase({ studentId: s.id, existingObligationIds: debtRows.map((d) => d.id), tender: { currency: "USD", amount: "6170.00" } });
    expect(r).toMatchObject({ ok: true, totalMinor: 617000 });
    if (!r.ok) return;
    expect(await prisma.duesSettlement.count({ where: { paymentId: r.paymentId, reversedAt: null } })).toBe(60);
  });
});

describe("purchasePackage: retries are bound to explicit selections, never recomputed", () => {
  it("an identical retried request refuses cleanly on retry — never silently extends further", async () => {
    const s = await newStudent("retry");
    const first = await purchase({ studentId: s.id, tender: { currency: "USD", amount: "270.00" } });
    expect(first).toMatchObject({ ok: true });
    const after = await ledgerCounts(a.org.id);
    const retry = await purchase({ studentId: s.id, tender: { currency: "USD", amount: "270.00" } });
    expect(retry.ok).toBe(false);
    expect(await ledgerCounts(a.org.id)).toEqual(after);
    // The true next available span (March-May 2031) must never have been silently purchased instead of refusing.
    expect(await prisma.duesObligation.count({ where: { organizationId: a.org.id, studentId: s.id, coverageYear: 2031, coverageMonth: { in: [3, 4, 5] } } })).toBe(0);
  });
});

describe("purchasePackage: rollback proof", () => {
  it("a settlement refusal (unknown current-debt id) rolls back the package obligation and every coverage row", async () => {
    const s = await newStudent("rollbacksettle");
    const before = await ledgerCounts(a.org.id);
    const r = await purchase({ studentId: s.id, existingObligationIds: ["no-such-obligation"], tender: { currency: "USD", amount: "270.00" } });
    expect(r).toMatchObject({ ok: false, error: "notFound" });
    expect(await ledgerCounts(a.org.id)).toEqual(before);
  });

  it("a forced failure right after the package obligation and coverage are written still leaves nothing persisted", async () => {
    const s = await newStudent("rollbackhook");
    const before = await ledgerCounts(a.org.id);
    await expect(
      purchase(
        { studentId: s.id, tender: { currency: "USD", amount: "270.00" } },
        { afterPackageObligationWrittenForTest: async () => { throw new Error("forced failure, proving rollback"); } },
      ),
    ).rejects.toThrow("forced failure");
    expect(await ledgerCounts(a.org.id)).toEqual(before);
  });
});

describe("purchasePackage: reversal is already refused by reverse-payment.ts's existing type check", () => {
  it("a payment settling a PACKAGE obligation refuses reversal (unsupportedObligationType), no new mechanism needed", async () => {
    const s = await newStudent("reversal");
    const r = await purchase({ studentId: s.id, tender: { currency: "USD", amount: "270.00" } });
    expect(r).toMatchObject({ ok: true });
    if (!r.ok) return;
    const reversed = await reversePayment({ context: context(), paymentId: r.paymentId, reversalReason: "test" }, deps());
    expect(reversed).toEqual({ ok: false, error: "unsupportedObligationType" });
  });
});

describe("purchasePackage: genuine concurrency — the student lock", () => {
  it("two purchase attempts for the same student genuinely serialize: the second blocks on the first's still-open transaction", async () => {
    const s = await newStudent("concurrentstudent");

    let gateRelease!: () => void;
    const gate = new Promise<void>((r) => (gateRelease = r));
    let pausedResolve!: () => void;
    const paused = new Promise<void>((r) => (pausedResolve = r));
    const first = purchase({ studentId: s.id, tender: { currency: "USD", amount: "270.00" } }, { afterPackageObligationWrittenForTest: async () => { pausedResolve(); await gate; } });

    try {
      await paused; // the first purchase has written its obligation/coverage and reached the pause point; transaction still open

      let secondDone = false;
      // The first purchase covers Dec 2030 - Feb 2031; the true next first-uncovered month is March 2031.
      const second = purchase({ studentId: s.id, requestedStartMonth: { year: 2031, month: 3 }, tender: { currency: "USD", amount: "270.00" } }).then((r) => ((secondDone = true), r));
      // Currency-conversion brief PR 2 (corrected): lockExchangeRateNamespaceShared is this writer's own literal first
      // statement, but SHARED holders never contend with each other — the first purchase's held shared lock does not
      // block the second's own attempt to acquire it too. The second purchase instead blocks exactly where it always
      // did, on the student row FOR UPDATE, still held by the first purchase's still-open transaction.
      const blocked = await waitUntilBlockedOnLock(['FROM "Student"', "FOR UPDATE"]);
      expect(blocked, "the second purchase must genuinely block on the first's still-held student lock").toBe(true);
      expect(secondDone).toBe(false);

      gateRelease();
      expect((await first).ok).toBe(true);
      const secondResult = await second;
      expect(secondResult).toMatchObject({ ok: true }); // 2031-03..05, correctly seeing the first purchase's committed coverage
    } finally {
      gateRelease();
      await Promise.allSettled([first]);
    }
  }, 20_000);
});

describe("purchasePackage: genuine concurrency — the terms lock (simulating a configuration correction)", () => {
  it("a purchase genuinely blocks on a concurrently held PaymentPlanTerms row before proceeding", async () => {
    const academy = await prisma.academy.create({ data: { organizationId: a.org.id, name: `TermsLock ${suffix}`, slug: `termslock-package-${suffix}`, kioskTokenHash: `termslock-package-${suffix}` } });
    const plan = await prisma.paymentPlan.create({ data: { organizationId: a.org.id, academyId: academy.id, name: `TermsLock plan ${suffix}` } });
    const terms = await prisma.paymentPlanTerms.create({ data: { organizationId: a.org.id, planId: plan.id, effectiveYear: 2027, effectiveMonth: 1, priceAmount: "270.00", currency: "USD", monthsCovered: 3, createdById: a.admin.id } });
    await prisma.duesPolicyVersion.create({ data: { organizationId: a.org.id, academyId: academy.id, effectiveYear: 2027, effectiveMonth: 1, dueDay: 20, graceDay: 5, lateFeeAmount: "20.00", lateFeeCurrency: "USD", maxPrepaidMonths: 3, createdById: a.admin.id } });
    const s = await newStudent("termslock", academy.id);

    const { startedPromise, release, held } = holdTermsLock(terms.id);
    try {
      await startedPromise;

      let done = false;
      const purchasing = purchasePackage(
        { context: context(), studentId: s.id, planTermsId: terms.id, requestedStartMonth: { year: 2030, month: 12 }, receivedOn: { year: 2030, month: 12, day: 1 }, tender: { currency: "USD", amount: "270.00" }, method: "EFECTIVO", maxBackdateDays: 90 },
        deps(),
      ).then((r) => ((done = true), r));
      // lockTermsShared takes FOR SHARE — the purchase's OWN blocked query looks like this, not the bystander's FOR UPDATE hold.
      const blocked = await waitUntilBlockedOnLock(['FROM "PaymentPlanTerms"', "FOR SHARE"]);
      expect(blocked, "the purchase must genuinely block on the held terms row").toBe(true);
      expect(done).toBe(false);

      release();
      await held;
      expect((await purchasing).ok).toBe(true);
    } finally {
      release();
      await Promise.allSettled([held]);
    }
  }, 20_000);
});
