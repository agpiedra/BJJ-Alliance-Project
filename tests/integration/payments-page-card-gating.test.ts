import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { createTranslator, NextIntlClientProvider } from "next-intl";
import { getTestPrismaClient } from "../helpers/test-db";
import { makeAccountingOrg } from "../helpers/accounting-org";
import { hashSecret } from "../../src/lib/crypto";
import enMessages from "../../messages/en.json";

/**
 * Regression for the bug briefly shipped in commit 4734ace and fixed in 631b31e: `payments/page.tsx`'s
 * `ledgerActive` was forced `true` (`const ledgerActive = true as boolean || ledgerActiveReal;`) regardless of
 * the real `inactiveLedgerActivation.isActive()` result, so both the ordinary ledger card and the ADMIN-only
 * package card would have rendered in production no matter the organization's real activation state.
 * `activation.ts`'s own file comment calls mocking it from a test file the SANCTIONED technique ("Tests inject
 * an active stub to exercise the writers") — this is not a workaround, it is the documented test seam.
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
// The real `next-intl/server` resolves to its react-server-guarded build under Vitest's plain "node" environment
// (no `react-server` resolve condition set, unlike Next's own bundler) and throws "not supported in Client
// Components" — so this must be a full replacement, not an `importOriginal` partial. `createTranslator` (the
// plain, non-server-gated `next-intl` core export) against the real `messages/en.json` gives `PaymentsPage()` a
// genuinely working `t(...)`, so its actual card headings render instead of the page crashing before producing
// any markup to inspect.
vi.mock("next-intl/server", () => ({
  getLocale: () => Promise.resolve("en"),
  getTranslations: async (namespace: string) => createTranslator({ locale: "en", messages: enMessages, namespace } as never),
}));

// The gate this test proves lives entirely in `payments/page.tsx` itself — both card headings
// (`t("packagePurchase.heading")`/`t("ledgerEntry.heading")`) are rendered directly by the page, OUTSIDE these
// child components. Stubbing them out keeps the test from depending on unrelated client-side machinery that has
// nothing to do with the role/activation gate (an app router for `PaymentsTable`'s `useRouter()`, full
// `useTranslations` context for `RecordPaymentForm`, this card's own internal form state) — none of which this
// regression is about.
vi.mock("../../src/app/[locale]/(staff)/payments/payment-entry-section", () => ({ PaymentEntrySection: () => null }));
vi.mock("../../src/app/[locale]/(staff)/payments/package-purchase-section", () => ({ PackagePurchaseSection: () => null }));
vi.mock("../../src/app/[locale]/(staff)/payments/payments-table", () => ({ PaymentsTable: () => null }));
vi.mock("@/components/payments/record-payment-form", () => ({ RecordPaymentForm: () => null }));
vi.mock("@/components/ui/toast", () => ({ Toaster: () => null }));

const { default: PaymentsPage } = await import("../../src/app/[locale]/(staff)/payments/page");

const PACKAGE_CARD_MARKER = "Sell a package";
const LEDGER_CARD_MARKER = "Record a ledger payment";

describe("payments/page.tsx: role + activation gate the new ledger cards", () => {
  let fixture: Awaited<ReturnType<typeof makeAccountingOrg>>;
  let director: { id: string };
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;

  beforeAll(async () => {
    fixture = await makeAccountingOrg("CUMULATIVE", "page-gate");
    const directorUser = await prisma.user.create({
      data: { email: `page-gate-director-${suffix}@example.com`, passwordHash: await hashSecret("irrelevant-password-123"), role: "DIRECTOR" },
    });
    await prisma.organizationMembership.create({ data: { userId: directorUser.id, organizationId: fixture.org.id, role: "DIRECTOR" } });
    await prisma.staffAssignment.create({ data: { userId: directorUser.id, organizationId: fixture.org.id, academyId: fixture.academy.id, role: "DIRECTOR" } });
    director = directorUser;
  }, 60_000);

  afterAll(async () => {
    currentSession = null;
    await prisma.staffAssignment.deleteMany({ where: { userId: director.id } });
    await prisma.organizationMembership.deleteMany({ where: { userId: director.id } });
    await prisma.user.deleteMany({ where: { id: director.id } });
    // Rendering the page for ADMIN/DIRECTOR runs `ensureCustomPromoPlan`, which creates a real `PaymentPlan` row
    // tied to this fixture's academy — `makeAccountingOrg`'s own `drop()` never anticipates that (most of its
    // callers never render this page), so it must be cleared first or `drop()`'s academy delete hits the
    // `PaymentPlan_organizationId_academyId_fkey` constraint.
    await prisma.paymentPlan.deleteMany({ where: { organizationId: fixture.org.id } });
    await fixture.drop();
  }, 120_000);

  // `RecordPaymentForm` (always rendered for ADMIN/DIRECTOR) calls `useTranslations` — a Client Component hook
  // that needs `NextIntlClientProvider`'s context, same as the real root layout provides in production.
  async function renderAs(userId: string) {
    currentSession = { user: { id: userId }, activeOrganizationId: fixture.org.id };
    const page = await PaymentsPage();
    const html = renderToStaticMarkup(createElement(NextIntlClientProvider, { locale: "en", messages: enMessages } as never, page));
    currentSession = null;
    return html;
  }

  it("REQUIRED: ADMIN + active organization sees BOTH the ordinary ledger card and the ADMIN-only package card", async () => {
    mockActive = true;
    const html = await renderAs(fixture.admin.id);
    expect(html).toContain(PACKAGE_CARD_MARKER);
    expect(html).toContain(LEDGER_CARD_MARKER);
  });

  it("REQUIRED: DIRECTOR + active organization sees the ordinary ledger card but NEVER the ADMIN-only package card", async () => {
    mockActive = true;
    const html = await renderAs(director.id);
    expect(html).toContain(LEDGER_CARD_MARKER);
    expect(html).not.toContain(PACKAGE_CARD_MARKER);
  });

  it("REQUIRED: ADMIN + INACTIVE organization sees NEITHER new card — the exact case the removed `true as boolean || ledgerActiveReal` bypass broke", async () => {
    mockActive = false;
    const html = await renderAs(fixture.admin.id);
    expect(html).not.toContain(PACKAGE_CARD_MARKER);
    expect(html).not.toContain(LEDGER_CARD_MARKER);
  });
});
