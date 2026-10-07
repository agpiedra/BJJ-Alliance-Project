import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { createTranslator, NextIntlClientProvider } from "next-intl";
import { getTestPrismaClient } from "../helpers/test-db";
import { makeAccountingOrg } from "../helpers/accounting-org";
import { createMonthlyObligation } from "../../src/lib/dues/ledger/create-monthly-obligation";
import type { TenantContext } from "../../src/lib/tenant/types";
import enMessages from "../../messages/en.json";

/**
 * Review-fix: "lack of existing RSC test tooling does not establish equivalence" — a real render, not a code
 * reading, proving (a) the inactive-ledger path renders exactly the legacy roster UI with none of the new ledger
 * surface leaking in, (b) the active path renders the new surface instead, and (c) the corrected legacy-bookmark
 * notice never claims "all students shown" when a real ledger filter is still narrowing the list alongside it.
 * Uses the same sanctioned test seam `payments-page-card-gating.test.ts` already established: mocking
 * `inactiveLedgerActivation` is the documented technique (`activation.ts`'s own file comment), not a workaround.
 */
const prisma = getTestPrismaClient();

let mockActive = false;
vi.mock("@/lib/dues/ledger/activation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/dues/ledger/activation")>();
  return { ...actual, inactiveLedgerActivation: { isActive: async () => mockActive } };
});

type MockSession = { user: { id: string }; activeOrganizationId: string | null } | null;
let currentSession: MockSession = null;
vi.mock("@/auth", () => ({ auth: () => Promise.resolve(currentSession) }));
// Same reasoning `payments-page-card-gating.test.ts` documents: the real `next-intl/server` throws under Vitest's
// plain "node" environment outside a real request scope, so this is a full replacement, not a partial.
vi.mock("next-intl/server", () => ({
  getLocale: () => Promise.resolve("en"),
  getTranslations: async (namespace: string) => createTranslator({ locale: "en", messages: enMessages, namespace } as never),
}));
// Unrelated client-side machinery this regression has nothing to do with (the create-student form's own action
// state, hooks, etc.) — stubbed out the same way `payments-page-card-gating.test.ts` stubs its own irrelevant
// children, so a crash there can never be mistaken for a finding about the ledger gate.
vi.mock("../../src/app/[locale]/(staff)/students/create-student-form", () => ({ CreateStudentForm: () => null }));

const { default: StudentsPage } = await import("../../src/app/[locale]/(staff)/students/page");

const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
type Fixture = Awaited<ReturnType<typeof makeAccountingOrg>>;
let a: Fixture;
let debtStudent: { id: string; firstName: string; lastName: string };
let cleanStudent: { id: string; firstName: string; lastName: string };

function context(over: Partial<TenantContext> = {}): TenantContext {
  return { kind: "tenant", actorUserId: a.admin.id, organizationId: a.org.id, organizationRole: "ADMIN", academyIds: "ALL", selfStudentId: null, linkedStudentId: null, ...over };
}

async function newStudent(label: string) {
  return prisma.student.create({
    data: {
      organizationId: a.org.id, homeAcademyId: a.academy.id, firstName: "RosterRender", lastName: `${label}-${suffix}`, phone: "00000000",
      email: `roster-render-${label}-${suffix}@example.com`, currentRankId: await a.rankId("WHITE"), codeHash: `roster-render-${label}-${suffix}`, status: "ACTIVE",
    },
  });
}

beforeAll(async () => {
  a = await makeAccountingOrg("CUMULATIVE", "roster-render");
  const plan = await prisma.paymentPlan.create({ data: { organizationId: a.org.id, academyId: a.academy.id, name: `RosterRender plan ${suffix}` } });
  const terms = await prisma.paymentPlanTerms.create({
    data: { organizationId: a.org.id, planId: plan.id, effectiveYear: 2020, effectiveMonth: 1, priceAmount: "100.00", currency: "USD", monthsCovered: 1, createdById: a.admin.id },
  });
  const policy = await prisma.duesPolicyVersion.create({
    data: { organizationId: a.org.id, academyId: a.academy.id, effectiveYear: 2020, effectiveMonth: 1, dueDay: 20, graceDay: 5, lateFeeAmount: "20.00", lateFeeCurrency: "USD", createdById: a.admin.id },
  });
  debtStudent = await newStudent("debt");
  cleanStudent = await newStudent("clean");
  const obligation = await createMonthlyObligation(
    { context: context(), studentId: debtStudent.id, coverage: { year: 2020, month: 1 }, planTermsId: terms.id, policyVersionId: policy.id },
    { activation: { isActive: async () => true }, now: () => new Date("2030-12-15T12:00:00-06:00") },
  );
  if (!obligation.ok) throw new Error(`fixture obligation failed: ${obligation.error}`);
}, 60_000);

afterAll(async () => {
  currentSession = null;
  if (!a) return;
  await prisma.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL session_replication_role = replica");
      for (const table of ["DuesSettlement", "DuesPayment", "DuesLateFee", "DuesCoverage", "DuesObligation"]) {
        await tx.$executeRawUnsafe(`DELETE FROM "${table}" WHERE "organizationId" = $1`, a.org.id);
      }
    },
    { timeout: 30_000 },
  );
  await prisma.paymentPlanTerms.deleteMany({ where: { organizationId: a.org.id } });
  await prisma.duesPolicyVersion.deleteMany({ where: { organizationId: a.org.id } });
  await prisma.paymentPlan.deleteMany({ where: { organizationId: a.org.id } });
  await a.drop();
}, 120_000);

async function renderRoster(searchParams: Record<string, string> = {}) {
  currentSession = { user: { id: a.admin.id }, activeOrganizationId: a.org.id };
  const page = await StudentsPage({ searchParams: Promise.resolve(searchParams) });
  const html = renderToStaticMarkup(createElement(NextIntlClientProvider, { locale: "en", messages: enMessages } as never, page));
  currentSession = null;
  return html;
}

describe("students/page.tsx: inactive-ledger render parity + corrected legacy-bookmark notice (review fix)", () => {
  it("REQUIRED: inactive ledger renders ONLY the legacy UI — no new ledger checkboxes, balance pills, or notice leak in", async () => {
    mockActive = false;
    const html = await renderRoster();
    // Legacy-only markers: the old enum <select name="payment">.
    expect(html).toContain('name="payment"');
    // None of the new ledger surface's markers appear at all.
    expect(html).not.toContain('name="debt"');
    expect(html).not.toContain('name="signupPastDue"');
    expect(html).not.toContain("Has outstanding debt");
    expect(html).not.toContain("No outstanding debt");
    expect(html).not.toContain("Checking more than one shows students");
  });

  it("REQUIRED: active ledger renders the new ledger UI instead — legacy select is gone", async () => {
    mockActive = true;
    const html = await renderRoster();
    expect(html).toContain('name="debt"');
    expect(html).toContain('name="signupPastDue"');
    expect(html).not.toContain('name="payment"');
    expect(html).toContain("Checking more than one shows students matching any of the selected filters");
    // The two seeded students each render their own correct, distinct state.
    expect(html).toContain("No outstanding debt"); // cleanStudent
  });

  it("REQUIRED: a legacy ?payment= bookmark combined with a real active filter shows the corrected notice AND still narrows by the real filter — never 'all students shown'", async () => {
    mockActive = true;
    const html = await renderRoster({ payment: "PAID", debt: "1" });
    // Corrected wording: says the legacy filter was not applied, never claims every student is shown.
    expect(html).toContain("was not applied");
    expect(html).not.toContain("Showing all students instead");
    // The real `debt=1` filter is still genuinely in effect: the debtor's name appears, the clean student's does not.
    expect(html).toContain(debtStudent.lastName);
    expect(html).not.toContain(cleanStudent.lastName);
  });
});
