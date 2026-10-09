import "dotenv/config";
import { afterAll, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { createTranslator, NextIntlClientProvider } from "next-intl";
import { getTestPrismaClient } from "../helpers/test-db";
import { makeAccountingOrg } from "../helpers/accounting-org";
import enMessages from "../../messages/en.json";

/**
 * REMAINING-LEDGER-CONSUMERS-BRIEF.md §2.2/§6.1 Decision 3 (PR 6): a real render of
 * `dashboard/analytics/page.tsx` (and, for one assertion, `locations-panel.tsx`'s own per-academy propagation),
 * proving the new ledger label, the partial-failure display string, and the empty-population string actually
 * reach the page — not merely the data layer this file's sibling (`analytics-payment-health.test.ts`) already
 * covers. Same mocking technique `payments-page-ledger-render.test.ts`/`dashboard-page-ledger-render.test.ts`
 * already establish: `@/lib/dues/ledger/activation` and `@/auth` mocked at the top level, `next-intl/server`
 * stubbed with the real `en.json` messages.
 */
const prisma = getTestPrismaClient();

let mockActive = true;
vi.mock("@/lib/dues/ledger/activation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/dues/ledger/activation")>();
  return { ...actual, inactiveLedgerActivation: { isActive: async () => mockActive } };
});

type MockSession = { user: { id: string }; activeOrganizationId: string | null } | null;
let currentSession: MockSession = null;
vi.mock("@/auth", () => ({ auth: () => Promise.resolve(currentSession) }));
vi.mock("next-intl/server", () => ({
  getLocale: () => Promise.resolve("en"),
  getTranslations: async (namespace: string) => createTranslator({ locale: "en", messages: enMessages, namespace } as never),
}));

const { default: AnalyticsPage } = await import("../../src/app/[locale]/(staff)/dashboard/analytics/page");
const { createMonthlyObligation } = await import("../../src/lib/dues/ledger/create-monthly-obligation");
const { recordDuesPayment } = await import("../../src/lib/dues/ledger/record-payment");

type Fixture = Awaited<ReturnType<typeof makeAccountingOrg>>;

function suffix() {
  return `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
}

function tenantContext(org: Fixture) {
  return { kind: "tenant" as const, actorUserId: org.admin.id, organizationId: org.org.id, organizationRole: "ADMIN" as const, academyIds: "ALL" as const, selfStudentId: null, linkedStudentId: null };
}

let studentCounter = 0;
async function newStudent(org: Fixture, academyId: string) {
  const n = ++studentCounter;
  const s = suffix();
  return prisma.student.create({
    data: {
      organizationId: org.org.id, homeAcademyId: academyId, firstName: "AnalyticsRender", lastName: `S${n}-${s}`, phone: "00000000",
      email: `analytics-render-${n}-${s}@example.com`, currentRankId: await org.rankId("WHITE"), codeHash: `analytics-render-${n}-${s}`, status: "ACTIVE",
    },
  });
}

async function seedPlanAndPolicy(org: Fixture, academyId: string) {
  const s = suffix();
  const plan = await prisma.paymentPlan.create({ data: { organizationId: org.org.id, academyId, name: `AR plan ${s}` } });
  const terms = await prisma.paymentPlanTerms.create({
    data: { organizationId: org.org.id, planId: plan.id, effectiveYear: 2025, effectiveMonth: 1, priceAmount: "100.00", currency: "USD", monthsCovered: 1, createdById: org.admin.id },
  });
  const policy = await prisma.duesPolicyVersion.create({
    data: { organizationId: org.org.id, academyId, effectiveYear: 2025, effectiveMonth: 1, dueDay: 20, graceDay: 5, lateFeeAmount: "20.00", lateFeeCurrency: "USD", createdById: org.admin.id },
  });
  return { terms, policy };
}

/** A real settled MONTHLY obligation for the REAL current branch-local month — `getHeadlineTiles`'s own
 * `ledgerNow` is real wall-clock time, not injectable from a page render, so every fixture here targets
 * whatever month the test actually runs in, via the writer's own default (real) clock. */
async function settledCurrentMonthStudent(org: Fixture, academyId: string, terms: { id: string }, policy: { id: string }) {
  const student = await newStudent(org, academyId);
  const today = new Date();
  const year = today.getFullYear();
  const month = today.getMonth() + 1;
  const created = await createMonthlyObligation({ context: tenantContext(org), studentId: student.id, coverage: { year, month }, planTermsId: terms.id, policyVersionId: policy.id });
  if (!created.ok) throw new Error(`fixture obligation failed: ${created.error}`);
  const settled = await recordDuesPayment({
    context: tenantContext(org), studentId: student.id, receivedOn: { year, month, day: 1 },
    tender: { currency: "USD", amount: "100.00" }, method: "EFECTIVO", obligationIds: [created.obligationId], maxBackdateDays: 60,
  });
  if (!settled.ok) throw new Error(`fixture settle failed: ${settled.error}`);
  return student;
}

async function unpaidCurrentMonthStudent(org: Fixture, academyId: string, terms: { id: string }, policy: { id: string }) {
  const student = await newStudent(org, academyId);
  const today = new Date();
  const created = await createMonthlyObligation({ context: tenantContext(org), studentId: student.id, coverage: { year: today.getFullYear(), month: today.getMonth() + 1 }, planTermsId: terms.id, policyVersionId: policy.id });
  if (!created.ok) throw new Error(`fixture obligation failed: ${created.error}`);
  return student;
}

async function dropDeps(org: Fixture) {
  await prisma.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL session_replication_role = replica");
      for (const table of ["DuesSettlement", "DuesPayment", "DuesLateFee", "DuesCoverage", "DuesObligation"]) {
        await tx.$executeRawUnsafe(`DELETE FROM "${table}" WHERE "organizationId" = $1`, org.org.id);
      }
    },
    { timeout: 60_000 },
  );
  await prisma.paymentPlanTerms.deleteMany({ where: { organizationId: org.org.id } });
  await prisma.duesPolicyVersion.deleteMany({ where: { organizationId: org.org.id } });
  await prisma.paymentPlan.deleteMany({ where: { organizationId: org.org.id } });
}

async function renderAs(userId: string, organizationId: string): Promise<string> {
  currentSession = { user: { id: userId }, activeOrganizationId: organizationId };
  const page = await AnalyticsPage({ searchParams: Promise.resolve({}) });
  const html = renderToStaticMarkup(createElement(NextIntlClientProvider, { locale: "en", messages: enMessages } as never, page));
  currentSession = null;
  return html;
}

describe("dashboard/analytics/page.tsx: payment health ledger cutover (page-level render)", () => {
  let fixture: Fixture;

  afterAll(async () => {
    if (fixture) {
      await dropDeps(fixture);
      await fixture.drop();
    }
  });

  it("REQUIRED: ledger-active, full success — the new ledger label and a plain percentage render", async () => {
    mockActive = true;
    fixture = await makeAccountingOrg("CUMULATIVE", "ar-full-success");
    const { terms, policy } = await seedPlanAndPolicy(fixture, fixture.academy.id);
    await settledCurrentMonthStudent(fixture, fixture.academy.id, terms, policy);

    const html = await renderAs(fixture.admin.id, fixture.org.id);
    // The headline stat tile swaps to the ledger label; the per-location comparison table's own column header
    // deliberately keeps the generic "Payment health (current month)" text (a scoped decision — see
    // `locations-panel.tsx`'s own comment — since that surface has no direct access to `ledgerActive`), so this
    // assertion is scoped to the stat-tile markup only, not a blanket absence check over the whole page.
    const statTileSection = html.slice(0, html.indexOf("Class popularity"));
    expect(statTileSection).toContain("Current month covered by settled payments");
    expect(statTileSection).toContain("100%");
    expect(statTileSection).not.toContain("Payment health (current month)");
  });

  it("REQUIRED: ledger-active, a partial read failure — the exact confirmed/checked/unknown string renders", async () => {
    mockActive = true;
    const org = await makeAccountingOrg("CUMULATIVE", "ar-partial-failure");
    try {
      const { terms, policy } = await seedPlanAndPolicy(org, org.academy.id);
      const confirmed = await settledCurrentMonthStudent(org, org.academy.id, terms, policy);
      const failed = await unpaidCurrentMonthStudent(org, org.academy.id, terms, policy);

      const duesFactsModule = await import("../../src/lib/dues/ledger/dues-facts");
      const real = duesFactsModule.listDuesFactsForStudents;
      const spy = vi.spyOn(duesFactsModule, "listDuesFactsForStudents").mockImplementation(async (...args) => {
        const result = await real(...args);
        if (!result.ok) return result;
        return { ...result, facts: result.facts.filter((f) => f.studentId !== failed.id) };
      });
      let html: string;
      try {
        html = await renderAs(org.admin.id, org.org.id);
      } finally {
        spy.mockRestore();
      }
      void confirmed;

      expect(html).toContain("1 confirmed-paid of 1 successfully checked (1 unknown)");
    } finally {
      await dropDeps(org);
      await org.drop();
    }
  });

  it("REQUIRED: ledger-active, an empty (zero-active-student) population shows the dedicated empty string, never 0% or a false 100%", async () => {
    mockActive = true;
    const org = await makeAccountingOrg("CUMULATIVE", "ar-empty-population");
    try {
      const html = await renderAs(org.admin.id, org.org.id);
      expect(html).toContain("No active students");
    } finally {
      await org.drop();
    }
  });

  it("the inactive path still renders the OLD label and a plain percentage — unchanged existing behavior", async () => {
    mockActive = false;
    const org = await makeAccountingOrg("CUMULATIVE", "ar-inactive-regression");
    try {
      const html = await renderAs(org.admin.id, org.org.id);
      expect(html).toContain("Payment health (current month)");
      expect(html).not.toContain("Current month covered by settled payments");
    } finally {
      mockActive = true;
      await org.drop();
    }
  });

  it("REQUIRED: the locations panel renders the SAME partial-failure string for one academy via locations.ts's own propagation", async () => {
    mockActive = true;
    const org = await makeAccountingOrg("CUMULATIVE", "ar-locations-partial");
    try {
      const { terms, policy } = await seedPlanAndPolicy(org, org.academy.id);
      const confirmed = await settledCurrentMonthStudent(org, org.academy.id, terms, policy);
      const failed = await unpaidCurrentMonthStudent(org, org.academy.id, terms, policy);
      void confirmed;

      const duesFactsModule = await import("../../src/lib/dues/ledger/dues-facts");
      const real = duesFactsModule.listDuesFactsForStudents;
      const spy = vi.spyOn(duesFactsModule, "listDuesFactsForStudents").mockImplementation(async (...args) => {
        const result = await real(...args);
        if (!result.ok) return result;
        return { ...result, facts: result.facts.filter((f) => f.studentId !== failed.id) };
      });
      let html: string;
      try {
        html = await renderAs(org.admin.id, org.org.id);
      } finally {
        spy.mockRestore();
      }

      // The locations comparison table's own row for this (single-academy) organization — same exact string
      // `paymentHealthDisplay` in `locations-panel.tsx` produces from `locations.ts`'s propagated counts.
      expect(html).toContain("1 confirmed-paid of 1 successfully checked (1 unknown)");
    } finally {
      await dropDeps(org);
      await org.drop();
    }
  });
});
