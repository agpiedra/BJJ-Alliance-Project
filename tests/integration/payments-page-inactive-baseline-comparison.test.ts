import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { writeFileSync, rmSync, existsSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { createTranslator, NextIntlClientProvider } from "next-intl";
import { getTestPrismaClient } from "../helpers/test-db";
import { makeAccountingOrg } from "../helpers/accounting-org";
import enMessages from "../../messages/en.json";

/**
 * REMAINING-LEDGER-CONSUMERS-BRIEF.md §2.4 (PR 5): a real before/after equivalence proof for the Pagos page's
 * INACTIVE path — the real pre-PR5 `payments/page.tsx` source, git-extracted from `main` at PR 4's own merge
 * commit (BASELINE_REF, the pinned "main at a6bec7b" ref this PR starts from), written to a throwaway sibling
 * module and dynamically imported, compared against the current, real page under the same fixture.
 *
 * "Include baseline dependencies that change in this PR" (review feedback learned from PR 4's own digest fix):
 * checked explicitly, before writing this file — `git diff a6bec7b HEAD -- payments-table.tsx
 * list-current-status.ts record-payment-form.tsx list-plans.ts ensure-custom-promo-plan.ts
 * payment-entry-queries.ts dues/ledger/activation.ts ui/toast.tsx` is empty. PR 5 only changes `page.tsx`
 * itself (restructuring its own data-fetch order and adding a ledger-active branch) and adds two brand-new
 * files (`list-ledger-payment-status.ts`, `ledger-payments-table.tsx`) the OLD baseline page never imports —
 * there is no shared rendering dependency that ALSO changed, unlike the digest's `templates.ts`/messages case,
 * so no deeper extraction chain is needed here: only `page.tsx` itself.
 *
 * Every client sub-component is REAL here (unlike `payments-page-ledger-render.test.ts`'s own stubs, which
 * exist only to avoid unrelated noise for ledger-specific assertions) — this test's whole point is proving the
 * INACTIVE render, including the real `PaymentsTable`, is unaffected by this PR. `next/navigation`'s
 * `useRouter()` has no app-router context outside a real Next.js request (`PaymentsTable`'s own hook); mocked
 * the same minimal way `payments-table-edit-sheet.test.tsx` already does, identically for both the baseline and
 * current render (the mock is one real module, shared by both dynamic imports).
 *
 * Deterministic time: the legacy OVERDUE bucket depends on `today.day > 5` (the default grace-day cutoff) —
 * frozen via `vi.useFakeTimers()`/`vi.setSystemTime` (day 15) so this fixture is unambiguously overdue
 * regardless of which real calendar day this suite happens to run on, the same reasoning
 * `dashboard-page-inactive-baseline-comparison.test.ts` already documents for its own identical fixture shape.
 *
 * Normalization: NONE applied, and none was found necessary — no React `useId()`-generated ids appear in this
 * page's own markup path (unlike the dashboard's belt-graphic components elsewhere on that page).
 */
const prisma = getTestPrismaClient();
const BASELINE_REF = "a6bec7b50c504a5bf07a2b4f3379424ecbe10d8b";
const PAGE_PATH = "src/app/[locale]/(staff)/payments/page.tsx";
const BASELINE_FILE = "src/app/[locale]/(staff)/payments/__pr5_baseline_a6bec7b_page.tsx";

function ensureCommitFetched(ref: string) {
  try {
    execFileSync("git", ["cat-file", "-e", `${ref}^{commit}`], { stdio: "ignore" });
  } catch {
    execFileSync("git", ["fetch", "--depth=1", "origin", ref], { stdio: "ignore" });
  }
}

function extractBaseline(gitPath: string): string {
  return execFileSync("git", ["show", `${BASELINE_REF}:${gitPath}`], { encoding: "utf8" });
}

function removeIfExists(p: string) {
  if (existsSync(p)) rmSync(p);
}

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

type MockSession = { user: { id: string }; activeOrganizationId: string | null } | null;
let currentSession: MockSession = null;
vi.mock("@/auth", () => ({ auth: () => Promise.resolve(currentSession) }));
vi.mock("next-intl/server", () => ({
  getLocale: () => Promise.resolve("en"),
  getTranslations: async (namespace: string) => createTranslator({ locale: "en", messages: enMessages, namespace } as never),
}));

type PageFn = () => Promise<unknown>;
let BaselinePage: PageFn;
let CurrentPage: PageFn;

const FROZEN_NOW = new Date("2030-06-15T12:00:00-06:00"); // day 15 — past the legacy day-5 overdue cutoff
type Fixture = Awaited<ReturnType<typeof makeAccountingOrg>>;
let a: Fixture;
let plan: { id: string };

beforeAll(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(FROZEN_NOW);

  ensureCommitFetched(BASELINE_REF);
  const content = extractBaseline(PAGE_PATH);
  if (!content.includes("export default")) {
    throw new Error(`Baseline extraction for ${PAGE_PATH} looks wrong — first 200 chars:\n${content.slice(0, 200)}`);
  }
  writeFileSync(BASELINE_FILE, content, "utf8");

  // Non-literal specifier on purpose: the baseline file doesn't exist on disk until the write above runs, so a
  // literal `import("...")` path here would make `tsc --noEmit` try (and fail) to statically resolve a module
  // that is only ever materialized at test runtime — same reasoning the dashboard baseline test documents.
  const baselineImport = "../../" + BASELINE_FILE.replace(/\.tsx$/, "");
  ({ default: BaselinePage } = await import(/* @vite-ignore */ baselineImport));
  ({ default: CurrentPage } = await import("../../src/app/[locale]/(staff)/payments/page"));

  a = await makeAccountingOrg("CUMULATIVE", "pagos-baseline");
  plan = await prisma.paymentPlan.create({ data: { organizationId: a.org.id, academyId: a.academy.id, name: `Pagos baseline plan` } });

  async function newStudent(label: string) {
    return prisma.student.create({
      data: {
        organizationId: a.org.id, homeAcademyId: a.academy.id, firstName: "PagosBaseline", lastName: label, phone: "00000000",
        email: `pagos-baseline-${label}@example.com`, currentRankId: await a.rankId("WHITE"), codeHash: `pagos-baseline-${label}`, status: "ACTIVE",
      },
    });
  }

  const paidStudent = await newStudent("paid");
  await prisma.paymentPeriod.create({
    data: { studentId: paidStudent.id, academyId: a.academy.id, organizationId: a.org.id, year: 2030, month: 6, planId: plan.id, status: "PAID", amount: "100.00", currency: "USD", recordedById: a.admin.id },
  });
  // overdueStudent: no PaymentPeriod row at all — the legacy `isOverdue` rule reports OVERDUE automatically
  // once `today.day > 5` (frozen day 15).
  await newStudent("overdue");
}, 60_000);

afterAll(async () => {
  vi.useRealTimers();
  currentSession = null;
  removeIfExists(BASELINE_FILE);
  if (!a) return;
  await prisma.paymentPeriod.deleteMany({ where: { organizationId: a.org.id } });
  await prisma.paymentPlan.deleteMany({ where: { organizationId: a.org.id } });
  await a.drop();
}, 120_000);

function withProvider(page: unknown): string {
  return renderToStaticMarkup(createElement(NextIntlClientProvider, { locale: "en", messages: enMessages } as never, page as never));
}

/** React's own `useId()`-generated `«...»` ids are scoped to render CALL ORDER within this process, not to page
 * content — same documented normalization `dashboard-page-inactive-baseline-comparison.test.ts` applies. */
function normalizeReactGeneratedIds(html: string): string {
  return html.replace(/«[^»]*»/g, "«ID»");
}

describe("payments/page.tsx: inactive-path render EQUIVALENCE against the pre-PR5 baseline (main@a6bec7b)", () => {
  it("REQUIRED: current inactive render is byte-identical to the real pre-PR5 implementation", async () => {
    currentSession = { user: { id: a.admin.id }, activeOrganizationId: a.org.id };
    const baselineHtml = withProvider(await BaselinePage());
    const currentHtml = withProvider(await CurrentPage());
    currentSession = null;

    // Non-vacuous: real financial content, not an empty shell.
    expect(baselineHtml).toContain("Overdue");
    expect(baselineHtml).toContain("Current");
    expect(normalizeReactGeneratedIds(currentHtml)).toBe(normalizeReactGeneratedIds(baselineHtml));
  });
});
