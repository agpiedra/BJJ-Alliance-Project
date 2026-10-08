import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { createTranslator, NextIntlClientProvider } from "next-intl";
import { getTestPrismaClient } from "../helpers/test-db";
import { makeAccountingOrg } from "../helpers/accounting-org";
import { hashSecret } from "../../src/lib/crypto";
import enMessages from "../../messages/en.json";
import { createMonthlyObligation } from "../../src/lib/dues/ledger/create-monthly-obligation";
import { recordDuesPayment } from "../../src/lib/dues/ledger/record-payment";
import { listPaymentHistoryForStudent } from "../../src/lib/dues/payment-history-queries";
import type { TenantContext } from "../../src/lib/tenant/types";
import * as getCurrentPeriodModule from "../../src/lib/payments/get-current-period";
import * as overdueModule from "../../src/lib/payments/overdue";

/**
 * STUDENT-PORTAL-LEDGER-INTEGRATION-BRIEF.md §3.1: a real render, not a code reading, proving (a) the
 * inactive-ledger path renders exactly the legacy portal UI with none of the new ledger surface leaking in, (b)
 * the active path replaces the legacy payment card with the new balance summary and adds the history section.
 * Mirrors `students-page-ledger-render.test.ts`'s own sanctioned mocking technique exactly.
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
vi.mock("next-intl/server", () => ({
  getLocale: () => Promise.resolve("en"),
  getTranslations: async (namespace: string) => createTranslator({ locale: "en", messages: enMessages, namespace } as never),
}));
// Unrelated client-side chrome this regression has nothing to do with — it calls next/navigation's useRouter,
// which has no app-router context outside a real Next.js request. Stubbed the same way
// `students-page-ledger-render.test.ts` stubs its own irrelevant children (CreateStudentForm).
vi.mock("../../src/app/[locale]/portal/portal-top-bar", () => ({ PortalTopBar: () => null }));
vi.mock("../../src/app/[locale]/portal/todays-classes-card", () => ({ TodaysClassesCard: () => null }));

// Review fix: a PARTIAL mock wrapping the REAL component — captures the exact props the real page.tsx passes it
// (inspected directly, not inferred from rendered HTML) while still rendering the genuine component, so every
// existing HTML-level assertion below keeps working unchanged.
let capturedHistoryProps: Record<string, unknown> | null = null;
vi.mock("../../src/app/[locale]/portal/payment-history-section", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/app/[locale]/portal/payment-history-section")>();
  return {
    PortalPaymentHistorySection: (props: Record<string, unknown>) => {
      capturedHistoryProps = props;
      return actual.PortalPaymentHistorySection(props as never);
    },
  };
});

const { default: StudentPortalPage } = await import("../../src/app/[locale]/portal/page");
const { getOwnPaymentHistoryPage } = await import("../../src/app/[locale]/portal/payment-history-actions");

const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
type Fixture = Awaited<ReturnType<typeof makeAccountingOrg>>;
let a: Fixture;
let studentUser: { id: string };
let student: { id: string };
let newerPaymentId: string;
let sharedTerms: { id: string };
let sharedPolicy: { id: string };

function adminContext(): TenantContext {
  return { kind: "tenant", actorUserId: a.admin.id, organizationId: a.org.id, organizationRole: "ADMIN", academyIds: "ALL", selfStudentId: null, linkedStudentId: null };
}
const ACTIVE_DEPS = { activation: { isActive: async () => true }, now: () => new Date("2030-06-15T12:00:00-06:00") };

beforeAll(async () => {
  a = await makeAccountingOrg("CUMULATIVE", "portalrender-a");
  studentUser = await prisma.user.create({ data: { email: `portalrender-student-${suffix}@example.com`, passwordHash: await hashSecret("irrelevant-password-123"), role: "STUDENT" } });
  await prisma.organizationMembership.create({ data: { userId: studentUser.id, organizationId: a.org.id, role: "STUDENT" } });
  student = await prisma.student.create({
    data: {
      organizationId: a.org.id, homeAcademyId: a.academy.id, userId: studentUser.id, firstName: "PortalRender", lastName: `S-${suffix}`, phone: "00000000",
      email: `portalrender-linked-${suffix}@example.com`, currentRankId: await a.rankId("WHITE"), codeHash: `portalrender-linked-${suffix}`, status: "ACTIVE",
    },
  });

  // A real, SETTLED payment carrying a staff-only note — settled so "No outstanding debt." still holds in the
  // other test below; the note's only purpose here is to prove it never reaches the actual rendered portal page.
  const plan = await prisma.paymentPlan.create({ data: { organizationId: a.org.id, academyId: a.academy.id, name: `PortalRender plan ${suffix}` } });
  const terms = await prisma.paymentPlanTerms.create({
    data: { organizationId: a.org.id, planId: plan.id, effectiveYear: 2020, effectiveMonth: 1, priceAmount: "100.00", currency: "USD", monthsCovered: 1, createdById: a.admin.id },
  });
  const policy = await prisma.duesPolicyVersion.create({
    data: { organizationId: a.org.id, academyId: a.academy.id, effectiveYear: 2020, effectiveMonth: 1, dueDay: 20, graceDay: 5, lateFeeAmount: "20.00", lateFeeCurrency: "USD", createdById: a.admin.id },
  });
  sharedTerms = terms;
  sharedPolicy = policy;
  const obligation = await createMonthlyObligation(
    { context: adminContext(), studentId: student.id, coverage: { year: 2030, month: 6 }, planTermsId: terms.id, policyVersionId: policy.id },
    ACTIVE_DEPS,
  );
  if (!obligation.ok) throw new Error(`fixture obligation failed: ${obligation.error}`);
  const recorded = await recordDuesPayment(
    { context: adminContext(), studentId: student.id, receivedOn: { year: 2030, month: 6, day: 10 }, tender: { currency: "USD", amount: "100.00" }, method: "EFECTIVO", obligationIds: [obligation.obligationId], maxBackdateDays: 30, notes: "a private staff note that must never reach the portal" },
    ACTIVE_DEPS,
  );
  if (!recorded.ok) throw new Error("fixture payment failed");
  newerPaymentId = recorded.paymentId;

  // A second, OLDER settled payment with its own distinct note — gives the action's real cursor pagination a
  // genuinely nonempty second page to fetch (the newer payment above anchors page "1"; this one is what a
  // cursor-after-it call returns).
  const olderObligation = await createMonthlyObligation(
    { context: adminContext(), studentId: student.id, coverage: { year: 2030, month: 5 }, planTermsId: terms.id, policyVersionId: policy.id },
    ACTIVE_DEPS,
  );
  if (!olderObligation.ok) throw new Error(`fixture older obligation failed: ${olderObligation.error}`);
  const olderRecorded = await recordDuesPayment(
    { context: adminContext(), studentId: student.id, receivedOn: { year: 2030, month: 5, day: 10 }, tender: { currency: "USD", amount: "100.00" }, method: "EFECTIVO", obligationIds: [olderObligation.obligationId], maxBackdateDays: 60, notes: "an older private staff note that must never reach the portal either" },
    ACTIVE_DEPS,
  );
  if (!olderRecorded.ok) throw new Error("fixture older payment failed");
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
  if (student) await prisma.student.deleteMany({ where: { id: student.id } });
  if (studentUser) {
    await prisma.organizationMembership.deleteMany({ where: { userId: studentUser.id } });
    await prisma.user.deleteMany({ where: { id: studentUser.id } });
  }
  await a.drop();
}, 120_000);

async function renderPortal() {
  currentSession = { user: { id: studentUser.id }, activeOrganizationId: a.org.id };
  const page = await StudentPortalPage({ params: Promise.resolve({ locale: "en" }) });
  const html = renderToStaticMarkup(createElement(NextIntlClientProvider, { locale: "en", messages: enMessages } as never, page));
  currentSession = null;
  return html;
}

describe("portal/page.tsx: inactive-ledger render parity + active ledger cutover (brief §3.1)", () => {
  it("REQUIRED: inactive ledger renders ONLY the legacy payment card — no balance summary, no ledger history section — and calls the legacy helpers", async () => {
    mockActive = false;
    const getCurrentPeriodSpy = vi.spyOn(getCurrentPeriodModule, "getCurrentPaymentPeriod");
    const isOverdueSpy = vi.spyOn(overdueModule, "isOverdue");
    try {
      const html = await renderPortal();
      expect(html).toContain("Payment status"); // the legacy card's own heading
      expect(html).not.toContain("Current balance"); // the new balance-summary heading never leaks in
      expect(html).not.toContain("Ledger payment history");
      // Non-vacuous counterpart to the "unused when active" assertion below: the inactive path genuinely still
      // calls both legacy helpers, proving the spies themselves work before trusting their absence elsewhere.
      expect(getCurrentPeriodSpy).toHaveBeenCalled();
      expect(isOverdueSpy).toHaveBeenCalled();
    } finally {
      getCurrentPeriodSpy.mockRestore();
      isOverdueSpy.mockRestore();
    }
  });

  it("REQUIRED: active ledger replaces the legacy card with the new balance summary and adds the history section — the legacy helpers are never called at all", async () => {
    mockActive = true;
    const getCurrentPeriodSpy = vi.spyOn(getCurrentPeriodModule, "getCurrentPaymentPeriod");
    const isOverdueSpy = vi.spyOn(overdueModule, "isOverdue");
    try {
      const html = await renderPortal();
      expect(html).toContain("Current balance");
      expect(html).toContain("No outstanding debt."); // the fixture payments are SETTLED — genuinely no outstanding debt
      expect(html).toContain("Ledger payment history");
      expect(html).toContain("100.00"); // the real settled payments' own history rows
      expect(html).not.toContain("Payment status"); // the legacy card is gone, not shown alongside
      // Review fix: not merely "unused in the rendered card" — the underlying functions are never INVOKED at all
      // on the active path, not computed and discarded.
      expect(getCurrentPeriodSpy).not.toHaveBeenCalled();
      expect(isOverdueSpy).not.toHaveBeenCalled();
    } finally {
      getCurrentPeriodSpy.mockRestore();
      isOverdueSpy.mockRestore();
    }
  });

  it("REQUIRED: notes never reach the ACTUAL rendered portal page, through the real page-1 fetch path (brief §5.1)", async () => {
    mockActive = true;
    // Non-vacuous: first prove the note genuinely exists on the underlying row via the STAFF reader.
    const staffResult = await listPaymentHistoryForStudent(adminContext(), student.id, {}, ACTIVE_DEPS);
    if (!staffResult.ok) throw new Error("expected ok result");
    expect(staffResult.rows.some((r) => r.notes === "a private staff note that must never reach the portal")).toBe(true);

    const html = await renderPortal();
    expect(html).not.toContain("a private staff note that must never reach the portal");
  });

  it("REQUIRED: notes are absent from the ACTUAL PortalPaymentHistorySection props and their serialized payload (brief §5.1) — proving the boundary, not inferring it from HTML", async () => {
    mockActive = true;
    capturedHistoryProps = null;
    await renderPortal();
    expect(capturedHistoryProps).not.toBeNull();
    const rows = capturedHistoryProps!.initialRows as Array<Record<string, unknown>>;
    expect(rows.length).toBeGreaterThan(0); // non-vacuous: real rows were actually passed as props
    for (const row of rows) {
      expect(row).not.toHaveProperty("notes");
    }
    // Stronger than a property check: the real object graph never carries the note string anywhere, including
    // nested fields a property-by-property check could miss.
    expect(JSON.stringify(capturedHistoryProps)).not.toContain("a private staff note that must never reach the portal");
    expect(JSON.stringify(capturedHistoryProps)).not.toContain("an older private staff note that must never reach the portal either");
  });

  it(
    "REQUIRED: a genuinely nonempty SECOND page, fetched through the ACTUAL getOwnPaymentHistoryPage action with the REAL cursor it returned (not the library directly, not a fabricated cursor), also has no notes",
    async () => {
      // Self-contained: sets its own activation state rather than depending on a previous test's mockActive, and
      // seeds enough valid payments to exceed the action's real DEFAULT_LIMIT (25, payment-history-queries.ts) —
      // so a genuine no-cursor call produces a non-null nextCursor on its own, never a manually-supplied one.
      mockActive = true;

      // 25 filler payments, all dated TODAY (2030-06-15, the frozen clock) — strictly newer than `newerPaymentId`
      // (2030-06-10), so they fill page 1 entirely; `newerPaymentId` and the older May payment fall onto page 2.
      for (let i = 0; i < 25; i++) {
        const year = 2026 + Math.floor(i / 12);
        const month = (i % 12) + 1;
        const fillerObligation = await createMonthlyObligation(
          { context: adminContext(), studentId: student.id, coverage: { year, month }, planTermsId: sharedTerms.id, policyVersionId: sharedPolicy.id },
          ACTIVE_DEPS,
        );
        if (!fillerObligation.ok) throw new Error(`filler obligation ${i} failed: ${fillerObligation.error}`);
        const fillerRecorded = await recordDuesPayment(
          // Must exactly match the obligation's own real total as of "now" — each coverage month is years in the
          // past relative to the frozen 2030-06-15 clock, so every one is already well past its grace deadline:
          // the selectable total is priceAmount + the flat lateFeeAmount (100.00 + 20.00), never priceAmount alone.
          { context: adminContext(), studentId: student.id, receivedOn: { year: 2030, month: 6, day: 15 }, tender: { currency: "USD", amount: "120.00" }, method: "EFECTIVO", obligationIds: [fillerObligation.obligationId], maxBackdateDays: 30 },
          ACTIVE_DEPS,
        );
        if (!fillerRecorded.ok) throw new Error(`filler payment ${i} failed: ${fillerRecorded.error}`);
      }

      currentSession = { user: { id: studentUser.id }, activeOrganizationId: a.org.id };
      try {
        const page1 = await getOwnPaymentHistoryPage(a.org.id);
        expect(page1.ok).toBe(true);
        if (!page1.ok) throw new Error("expected ok result");
        expect(page1.nextCursor).not.toBeNull(); // proves a genuine second page exists, before fetching it

        const page2 = await getOwnPaymentHistoryPage(a.org.id, page1.nextCursor!);
        expect(page2.ok).toBe(true);
        if (!page2.ok) throw new Error("expected ok result");
        expect(page2.rows.length).toBeGreaterThan(0); // non-vacuous: a real second page, not an empty one
        // The exact expected payment — the one carrying the known private note — is present on this real page.
        expect(page2.rows.some((r) => r.id === newerPaymentId)).toBe(true);
        for (const row of page2.rows) {
          expect(row).not.toHaveProperty("notes");
        }
        expect(JSON.stringify(page2)).not.toContain("a private staff note that must never reach the portal");
        expect(JSON.stringify(page2)).not.toContain("an older private staff note that must never reach the portal either");
      } finally {
        currentSession = null;
      }
    },
    30_000,
  );
});
