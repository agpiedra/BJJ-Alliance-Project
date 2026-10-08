/** @vitest-environment jsdom */
import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { getTestPrismaClient } from "../helpers/test-db";
import { prisma as appPrisma } from "../../src/lib/prisma";
import { makeAccountingOrg } from "../helpers/accounting-org";
import enMessages from "../../messages/en.json";
import type { TenantContext } from "../../src/lib/tenant/types";
import type { LedgerActivation } from "../../src/lib/dues/ledger/activation";
import { resumeChargeInTx } from "../../src/lib/dues/ledger/resume-charge";
import { purchasePackage } from "../../src/lib/dues/ledger/purchase-package";
import { getOwnPaymentFacts, resolveEligibilityNoticeKey, type PortalSelfContext } from "../../src/lib/dues/portal-ledger-queries";
import { toRosterLedgerDisplay } from "../../src/lib/dues/roster-payment-facts-queries";
import { StudentBalanceSummary } from "../../src/app/[locale]/(staff)/students/[id]/student-balance-summary";

/**
 * STUDENT-PORTAL-LEDGER-INTEGRATION-BRIEF.md §3/§5.2: `getOwnPaymentFacts` against the REAL test database, and
 * the three required eligibility-notice regression scenarios, each against real `getOwnPaymentFacts`/
 * `resolveEligibilityNoticeKey` output and a real `StudentBalanceSummary` COMPONENT render (via
 * `@testing-library/react`'s `render`, not a full page render) — "the rendered balance shows no notice" is
 * proved by rendering that one component, not inferred from data alone and not a full-page proof (the latter,
 * including the real `getCurrentPaymentPeriod`/`isOverdue` cutover behavior, lives in
 * `portal-page-ledger-render.test.tsx`).
 *
 * The THREE scenarios use genuinely different fixture techniques, named honestly at each one: regression 1
 * (mid-month resume) and regression 2 (package) call REAL engine writers (`resumeChargeInTx`, `purchasePackage`)
 * — their obligations/coverage/settlements are genuinely engine-produced. Regression 3 (the bare-SIGNUP
 * counterexample) is a DIRECTLY SEEDED fixture (hand-built `DuesObligation`/`StudentStatusChange` rows via
 * Prisma) that reproduces the relevant SHAPE without executing `enrollmentChargeInTx` — see that test's own
 * comment for exactly what it does and does not claim.
 */
const prisma = getTestPrismaClient();
type Fixture = Awaited<ReturnType<typeof makeAccountingOrg>>;
const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
const ACTIVE: LedgerActivation = { isActive: async () => true };
const at = (isoLocal: string) => new Date(`${isoLocal}-06:00`); // Costa Rica, UTC-6 all year
const deps = (extra: Record<string, unknown> = {}) => ({ activation: ACTIVE, ...extra });

function buildT() {
  return (key: string, values?: Record<string, string>) => {
    const parts = key.split(".");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let node: any = enMessages.students;
    for (const p of parts) node = node?.[p];
    let text = typeof node === "string" ? node : key;
    if (values) for (const [k, v] of Object.entries(values)) text = text.replace(`{${k}}`, v);
    return text;
  };
}
const t = buildT();

let a: Fixture;
let planA: { id: string }; // monthly, dueDay 20
let termsA: { id: string };

function context(over: Partial<TenantContext> = {}): TenantContext {
  return { kind: "tenant", actorUserId: a.admin.id, organizationId: a.org.id, organizationRole: "ADMIN", academyIds: "ALL", selfStudentId: null, linkedStudentId: null, ...over };
}
function selfContext(linkedStudentId: string, over: Partial<TenantContext> = {}): PortalSelfContext {
  return { ...context({ organizationRole: "STUDENT", academyIds: [], ...over }), linkedStudentId };
}

let studentCounter = 0;
async function newStudent(status: "ACTIVE" | "INACTIVE", label: string) {
  const n = ++studentCounter;
  return prisma.student.create({
    data: {
      organizationId: a.org.id, homeAcademyId: a.academy.id, firstName: "PortalFacts", lastName: `${label}${n}`, phone: "00000000",
      email: `portalfacts-${label}-${n}-${suffix}@example.com`, currentRankId: await a.rankId("WHITE"), codeHash: `portalfacts-${label}-${n}-${suffix}`, status,
    },
  });
}
async function assign(studentId: string, planId: string, effectiveYear = 2020, effectiveMonth = 1) {
  return prisma.studentPlanAssignment.create({ data: { organizationId: a.org.id, studentId, planId, effectiveYear, effectiveMonth, createdById: a.admin.id } });
}
async function createObligation(opts: {
  studentId: string; type: "MONTHLY" | "SIGNUP" | "PACKAGE"; year: number; month: number; monthsCovered?: number;
  amount?: string; dueOn?: Date | null; graceDeadline?: Date | null; lateFeeAmount?: string | null; policyVersionId?: string | null; planTermsId?: string;
}) {
  return prisma.duesObligation.create({
    data: {
      organizationId: a.org.id, studentId: opts.studentId, academyId: a.academy.id, origin: "STAFF",
      type: opts.type, coverageYear: opts.year, coverageMonth: opts.month, monthsCovered: opts.monthsCovered ?? 1,
      amount: opts.amount ?? "100.00", currency: "USD",
      dueOn: opts.dueOn ?? null, graceDeadline: opts.graceDeadline ?? null, lateFeeAmount: opts.lateFeeAmount ?? null,
      planTermsId: opts.planTermsId ?? termsA.id, policyVersionId: opts.policyVersionId ?? null, createdById: a.admin.id,
    },
  });
}

beforeAll(async () => {
  a = await makeAccountingOrg("CUMULATIVE", "portalfacts-a");
  const plan = await prisma.paymentPlan.create({ data: { organizationId: a.org.id, academyId: a.academy.id, name: `PortalFacts plan ${suffix}` } });
  planA = plan;
  termsA = await prisma.paymentPlanTerms.create({
    data: { organizationId: a.org.id, planId: plan.id, effectiveYear: 2020, effectiveMonth: 1, priceAmount: "100.00", currency: "USD", monthsCovered: 1, createdById: a.admin.id },
  });
  // A real DuesPolicyVersion row for this academy/period, required for `resumeChargeInTx`'s own configuration
  // resolution — never read back by this file itself, so not captured in a named variable.
  await prisma.duesPolicyVersion.create({
    data: { organizationId: a.org.id, academyId: a.academy.id, effectiveYear: 2020, effectiveMonth: 1, dueDay: 20, graceDay: 5, lateFeeAmount: "20.00", lateFeeCurrency: "USD", maxPrepaidMonths: 3, createdById: a.admin.id },
  });
}, 60_000);

afterAll(async () => {
  if (!a) return;
  await prisma.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL session_replication_role = replica");
      for (const table of ["DuesSettlement", "DuesPayment", "DuesCoverage", "DuesObligation", "StudentStatusChange", "StudentPlanAssignment"]) {
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
}, 60_000);

describe("getOwnPaymentFacts: basic ok/fail paths", () => {
  it("ok:false when the linked student doesn't exist (a deleted/foreign id)", async () => {
    const result = await getOwnPaymentFacts(selfContext("nonexistent-id"), at("2030-06-15T12:00:00"), deps());
    expect(result).toEqual({ ok: false });
  });

  it("ok:true with the student's own branch-local today, for a real student with no debt", async () => {
    const s = await newStudent("ACTIVE", "basic");
    const result = await getOwnPaymentFacts(selfContext(s.id), at("2030-06-15T12:00:00"), deps());
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.facts.studentId).toBe(s.id);
    expect(result.currentPeriod).toEqual({ year: 2030, month: 6 });
  });
});

describe("getOwnPaymentFacts: runtime identity guard runs BEFORE the first query (review fix)", () => {
  async function expectRefusedWithoutQuerying(linkedStudentId: unknown) {
    const spy = vi.spyOn(appPrisma.student, "findFirst");
    try {
      const ctx = selfContext(linkedStudentId as string);
      const result = await getOwnPaymentFacts(ctx, at("2030-06-15T12:00:00"), deps());
      expect(result).toEqual({ ok: false });
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  }

  it("refuses null before querying student.findFirst", () => expectRefusedWithoutQuerying(null));
  it("refuses undefined before querying student.findFirst", () => expectRefusedWithoutQuerying(undefined));
  it("refuses an empty string before querying student.findFirst", () => expectRefusedWithoutQuerying(""));
  it("refuses a whitespace-only string before querying student.findFirst", () => expectRefusedWithoutQuerying("   "));
});

describe("§5.2 regression 1: mid-month resume with an existing current-period charge", () => {
  it("eligibility is NOT_ELIGIBLE, outstanding contains the current-period obligation, and the rendered balance shows NO notice", async () => {
    const s = await newStudent("INACTIVE", "resume");
    await assign(s.id, planA.id);
    // The student's `status` COLUMN alone is not what `eligibleAndAssigned` reads — it reads
    // `StudentStatusChange` HISTORY rows. Without one dated before the month, eligibility comes back
    // UNDECIDABLE ("no history at all"), not NOT_ELIGIBLE — a real status-change row effective BEFORE the
    // month start is required for this scenario to mean what it claims.
    await prisma.studentStatusChange.create({ data: { organizationId: a.org.id, studentId: s.id, status: "INACTIVE", effectiveOn: new Date("2029-12-01"), sequence: 1, source: "EVENT", actorId: a.admin.id } });
    // Real engine writer: resumes mid-month (the 25th, AFTER the policy's dueDay 20), which raises dueOn and
    // writes a real current-period MONTHLY obligation — the exact divergence brief §5.2 traces.
    const resumed = await appPrisma.$transaction((tx) =>
      resumeChargeInTx(tx, { context: context(), student: { id: s.id, homeAcademyId: a.academy.id } }, deps({ now: () => at("2030-06-25T12:00:00") })),
    );
    expect(resumed.ok).toBe(true);

    const result = await getOwnPaymentFacts(selfContext(s.id), at("2030-06-25T12:00:00"), deps());
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.facts.eligibility).toEqual({ outcome: "NOT_ELIGIBLE" });
    expect(result.facts.outstanding.some((o) => o.type === "MONTHLY" && o.coverageYear === 2030 && o.coverageMonth === 6)).toBe(true);

    const noticeKey = resolveEligibilityNoticeKey(result.facts, result.currentPeriod);
    expect(noticeKey).toBeNull(); // suppression fired correctly

    const display = toRosterLedgerDisplay(result.facts, result.todayIso);
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <StudentBalanceSummary display={display} pendingReceipts={result.facts.pendingReceipts} locale="en" t={t} notice={noticeKey ? t(`ledger.eligibilityNotice.${noticeKey}`) : undefined} />
      </NextIntlClientProvider>,
    );
    // The real balance IS shown (never contradicted by a notice)...
    expect(screen.getByText(/\$ 100\.00/)).toBeTruthy();
    // ...and none of the three approved notice strings render.
    expect(screen.queryByText(t("ledger.eligibilityNotice.notRecorded"))).toBeNull();
    expect(screen.queryByText(t("ledger.eligibilityNotice.noAssignment"))).toBeNull();
    expect(screen.queryByText(t("ledger.eligibilityNotice.unconfirmed"))).toBeNull();
  });
});

describe("§5.2 regression 2: a package-covered month", () => {
  it("eligibility is MISSING_CONFIGURATION, coverage contains the current-period row, and the rendered balance shows NO notice", async () => {
    const s = await newStudent("ACTIVE", "package");
    await prisma.studentStatusChange.create({ data: { organizationId: a.org.id, studentId: s.id, status: "ACTIVE", effectiveOn: new Date("2029-12-01"), sequence: 1, source: "EVENT", actorId: a.admin.id } });
    const pkgPlan = await prisma.paymentPlan.create({ data: { organizationId: a.org.id, academyId: a.academy.id, name: `PortalFacts pkg plan ${suffix}` } });
    const packageTerms = await prisma.paymentPlanTerms.create({
      data: { organizationId: a.org.id, planId: pkgPlan.id, effectiveYear: 2020, effectiveMonth: 1, priceAmount: "270.00", currency: "USD", monthsCovered: 3, createdById: a.admin.id },
    });
    await assign(s.id, pkgPlan.id, 2029, 12);
    // REAL engine writer (review fix — replaces a hand-built obligation + a fake $1 settlement that never
    // reconciled with the $270 price): `purchasePackage` creates the PACKAGE obligation, all three of its
    // DuesCoverage rows, AND settles it in the same atomic receipt — a genuinely, amount-consistently paid
    // package, not a boolean flipped by a mismatched settlement. June 2030 is this fresh student's own true
    // first-uncovered month under the frozen clock below, so it is both the valid `requestedStartMonth` and the
    // current period this regression needs covered.
    const purchased = await purchasePackage(
      {
        context: context(), studentId: s.id, planTermsId: packageTerms.id, requestedStartMonth: { year: 2030, month: 6 },
        receivedOn: { year: 2030, month: 6, day: 1 }, tender: { currency: "USD", amount: "270.00" }, method: "EFECTIVO", maxBackdateDays: 90,
      },
      deps({ now: () => at("2030-06-15T12:00:00") }),
    );
    expect(purchased.ok).toBe(true);
    if (!purchased.ok) throw new Error(`fixture purchase failed: ${purchased.error}`);

    const result = await getOwnPaymentFacts(selfContext(s.id), at("2030-06-15T12:00:00"), deps());
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.facts.eligibility).toEqual({ outcome: "MISSING_CONFIGURATION" }); // the engine's real, unchanged behavior
    expect(result.facts.coverage).toEqual(expect.arrayContaining([{ year: 2030, month: 6, obligationId: purchased.obligationId }]));

    const noticeKey = resolveEligibilityNoticeKey(result.facts, result.currentPeriod);
    expect(noticeKey).toBeNull();

    const display = toRosterLedgerDisplay(result.facts, result.todayIso);
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <StudentBalanceSummary display={display} pendingReceipts={result.facts.pendingReceipts} locale="en" t={t} notice={noticeKey ? t(`ledger.eligibilityNotice.${noticeKey}`) : undefined} />
      </NextIntlClientProvider>,
    );
    expect(screen.getByText(t("ledger.balanceSummary.noDebt"))).toBeTruthy(); // fully covered, nothing unsettled
    expect(screen.queryByText(t("ledger.eligibilityNotice.unconfirmed"))).toBeNull();
  });
});

describe("§5.2 regression 3 (counterexample): a bare SIGNUP must NOT suppress a genuine discrepancy notice", () => {
  it("eligibility is OBSERVED_DISCREPANCY, the SIGNUP is present in outstanding, and the notice STILL renders", async () => {
    const s = await newStudent("ACTIVE", "signuponly");
    await prisma.studentStatusChange.create({ data: { organizationId: a.org.id, studentId: s.id, status: "ACTIVE", effectiveOn: new Date("2029-12-01"), sequence: 1, source: "EVENT", actorId: a.admin.id } });
    await assign(s.id, planA.id, 2029, 12);
    // DIRECTLY SEEDED fixture (not run through the real enrollmentChargeInTx writer, and not a reconstruction of
    // a genuine enrollment event): the pre-month ACTIVE status-change row above only establishes ELIGIBLE and
    // assigned, so `eligibleAndAssigned` reaches OBSERVED_DISCREPANCY instead of short-circuiting to
    // NOT_ELIGIBLE/NO_ASSIGNMENT — it is not claimed to be what a real enrollment's own status history looks
    // like. The hand-built obligation below reproduces only the SHAPE `enrollmentChargeInTx` produces for an
    // on/after-due-day enrollment (dueOn 2030-06-21, after the policy's dueDay 20; no same-month MONTHLY; zero
    // DuesCoverage rows — enrollment-charge.ts:108-140), never executes that writer. Deliberately NO MONTHLY/
    // coverage row for this period at all — the genuine gap this counterexample proves a bare SIGNUP cannot hide.
    await createObligation({ studentId: s.id, type: "SIGNUP", year: 2030, month: 6, dueOn: new Date("2030-06-21"), graceDeadline: null, lateFeeAmount: null });

    const result = await getOwnPaymentFacts(selfContext(s.id), at("2030-06-25T12:00:00"), deps());
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.facts.eligibility).toEqual({ outcome: "OBSERVED_DISCREPANCY" });
    expect(result.facts.outstanding.some((o) => o.type === "SIGNUP")).toBe(true);
    expect(result.facts.outstanding.some((o) => o.type === "MONTHLY")).toBe(false);
    expect(result.facts.coverage).toEqual([]);

    const noticeKey = resolveEligibilityNoticeKey(result.facts, result.currentPeriod);
    expect(noticeKey).toBe("unconfirmed"); // NOT suppressed by the bare SIGNUP

    const display = toRosterLedgerDisplay(result.facts, result.todayIso);
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <StudentBalanceSummary display={display} pendingReceipts={result.facts.pendingReceipts} locale="en" t={t} notice={t(`ledger.eligibilityNotice.${noticeKey}`)} />
      </NextIntlClientProvider>,
    );
    expect(screen.getByText(t("ledger.eligibilityNotice.unconfirmed"))).toBeTruthy();
    expect(screen.getByText(/\$ 100\.00/)).toBeTruthy(); // the SIGNUP debt stays visible independently
  });
});
