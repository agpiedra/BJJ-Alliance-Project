import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { createTranslator, NextIntlClientProvider } from "next-intl";
import { getTestPrismaClient } from "../helpers/test-db";
import { makeAccountingOrg } from "../helpers/accounting-org";
import enMessages from "../../messages/en.json";

/**
 * REMAINING-LEDGER-CONSUMERS-BRIEF.md §2.6 (review fix): `students/[id]/page.tsx` renders the SAME shared
 * `RecordPaymentForm` the Pagos page does (`record-payment.toggle` — the "Record a payment" `<details>` toggle,
 * confirmed via `grep` as one of exactly three real `RecordPaymentForm` call sites in production: this page,
 * `payments/page.tsx`, and `payments-table.tsx`'s edit sheet). This proves it is hidden once the ledger is active
 * for this organization, reusing the page's own already-resolved `ledgerActive` value, and that the inactive
 * render still shows it (unchanged) — a marker-presence check, not a byte-for-byte equivalence claim; that
 * stronger claim for THIS page's inactive render is already established separately by
 * `students-pages-inactive-baseline-comparison.test.ts`'s own git-extracted baseline comparison, re-run
 * unmodified by this PR to confirm it still holds.
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

const { default: StudentDetailPage } = await import("../../src/app/[locale]/(staff)/students/[id]/page");

const LEGACY_FORM_TOGGLE_MARKER = "Record a payment";

const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
type Fixture = Awaited<ReturnType<typeof makeAccountingOrg>>;
let a: Fixture;
let student: { id: string };

beforeAll(async () => {
  a = await makeAccountingOrg("CUMULATIVE", "detail-form-gate");
  const plan = await prisma.paymentPlan.create({ data: { organizationId: a.org.id, academyId: a.academy.id, name: `DetailFormGate plan ${suffix}` } });
  student = await prisma.student.create({
    data: {
      organizationId: a.org.id, homeAcademyId: a.academy.id, firstName: "DetailFormGate", lastName: `S-${suffix}`, phone: "00000000",
      email: `detail-form-gate-${suffix}@example.com`, currentRankId: await a.rankId("WHITE"), codeHash: `detail-form-gate-${suffix}`, status: "ACTIVE",
    },
  });
  await prisma.paymentPeriod.create({
    data: { studentId: student.id, academyId: a.academy.id, organizationId: a.org.id, year: 2026, month: 9, planId: plan.id, status: "PAID", amount: "100.00", currency: "USD", recordedById: a.admin.id },
  });
}, 60_000);

afterAll(async () => {
  currentSession = null;
  if (!a) return;
  await prisma.paymentPeriod.deleteMany({ where: { organizationId: a.org.id } });
  await prisma.paymentPlan.deleteMany({ where: { organizationId: a.org.id } });
  await a.drop();
}, 120_000);

async function renderDetail() {
  currentSession = { user: { id: a.admin.id }, activeOrganizationId: a.org.id };
  const page = await StudentDetailPage({ params: Promise.resolve({ locale: "en", id: student.id }) });
  const html = renderToStaticMarkup(createElement(NextIntlClientProvider, { locale: "en", messages: enMessages } as never, page));
  currentSession = null;
  return html;
}

describe("students/[id]/page.tsx: the legacy RecordPaymentForm toggle is gated on ledgerActive", () => {
  it("REQUIRED: ADMIN + active organization no longer sees the legacy 'Record a payment' toggle's heading marker", async () => {
    mockActive = true;
    const html = await renderDetail();
    expect(html).not.toContain(LEGACY_FORM_TOGGLE_MARKER);
  });

  it("REQUIRED: ADMIN + INACTIVE organization still sees the legacy 'Record a payment' toggle's heading marker", async () => {
    mockActive = false;
    const html = await renderDetail();
    expect(html).toContain(LEGACY_FORM_TOGGLE_MARKER);
  });
});
