import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { writeFileSync, rmSync, existsSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { createTranslator, NextIntlClientProvider } from "next-intl";
import { getTestPrismaClient } from "../helpers/test-db";
import { makeAccountingOrg } from "../helpers/accounting-org";
import { hashSecret } from "../../src/lib/crypto";
import enMessages from "../../messages/en.json";

/**
 * STUDENT-PORTAL-LEDGER-INTEGRATION-BRIEF.md §3.1/§4: the real before/after render-equivalence proof for the
 * portal's own inactive path, reusing PR #96's proven git-extraction harness technique (including its
 * shallow-checkout fix) verbatim. `portal/page.tsx` was UNTOUCHED by PR #97 (`git diff a739d54 87c706b --
 * src/app/[locale]/portal/page.tsx` is empty) — so PR #97's merged head is exactly the pre-THIS-PR baseline.
 *
 * The baseline source is git-extracted to a throwaway SIBLING scratch file so its own `./relative` imports
 * (`./portal-top-bar`, `./todays-classes-card`, `./get-promotion-history`, etc. — none touched by this PR)
 * resolve against the real, unchanged neighboring files, deleted in `afterAll` regardless of outcome.
 *
 * Phase 2.6 PR 1 (bottom-phone/top-desktop tab bar) made exactly one approved, intentional change to this
 * page's own markup: `<main>`'s padding classes, to reserve room for `PortalTabs`' new fixed bottom bar below
 * `sm`. From this PR onward, the comparison below is equivalence AFTER that one explicitly-listed, narrowly
 * scoped normalization — not raw byte identity — see `normalizeApprovedMainPadding` below for exactly what it
 * does and does not touch.
 *
 * IMPORTANT caveat this test does NOT prove: only `page.tsx` is git-extracted for the baseline side. Its
 * `./portal-tabs` import is never extracted, so BOTH the "baseline" and "current" renders below import the
 * SAME real, current `PortalTabs` component — this comparison cannot independently demonstrate anything about
 * old-vs-new tab-bar rendering or behavior. That proof lives in `tests/unit/portal-tabs.test.tsx` and this PR's
 * own real-browser evidence. This test's job is strictly to prove the REST of the page — content, financial
 * data, everything besides the one approved padding difference — did not silently change.
 */
const prisma = getTestPrismaClient();
const BASELINE_REF = "87c706b33c6633ada6a003aa3d7ed105312cafd0";
const PORTAL_DIR = "src/app/[locale]/portal";
const BASELINE_FILE = `${PORTAL_DIR}/__portal_baseline_87c706b_page.tsx`;

function ensureCommitFetched(ref: string) {
  try {
    execFileSync("git", ["cat-file", "-e", `${ref}^{commit}`], { stdio: "ignore" });
  } catch {
    try {
      execFileSync("git", ["fetch", "--depth=1", "origin", ref], { stdio: ["ignore", "ignore", "pipe"], encoding: "utf8" });
    } catch (err) {
      // The probe above stays silent (its failure is the normal "not fetched yet" case), but a genuine
      // fetch failure is not expected — surface git's real reason, bounded and stripped of any
      // credential-bearing URL, instead of the opaque "Command failed" exit-code-only error.
      const rawStderr = err && typeof err === "object" && "stderr" in err ? String((err as { stderr?: unknown }).stderr ?? "") : "";
      const sanitized = rawStderr.replace(/https?:\/\/[^\s@/]+@/g, "https://[redacted]@").trim().slice(0, 1000);
      throw new Error(`git fetch --depth=1 origin ${ref} failed${sanitized ? `: ${sanitized}` : " (no stderr captured)"}`);
    }
  }
}
function writeBaseline(gitPath: string, diskPath: string) {
  const content = execFileSync("git", ["show", `${BASELINE_REF}:${gitPath}`], { encoding: "utf8" });
  if (!content.includes("export default")) {
    throw new Error(`Baseline extraction for ${gitPath} looks wrong — first 200 chars:\n${content.slice(0, 200)}`);
  }
  writeFileSync(diskPath, content, "utf8");
}
function removeIfExists(p: string) {
  if (existsSync(p)) rmSync(p);
}

type MockSession = { user: { id: string }; activeOrganizationId: string | null } | null;
let currentSession: MockSession = null;
vi.mock("@/auth", () => ({ auth: () => Promise.resolve(currentSession) }));
vi.mock("next-intl/server", () => ({
  getLocale: () => Promise.resolve("en"),
  getTranslations: async (namespace: string) => createTranslator({ locale: "en", messages: enMessages, namespace } as never),
}));
// Real, unchanged sibling files — a single mock applies identically to BOTH the baseline and current renders,
// since neither import path nor implementation changed for these two components in this PR.
vi.mock("../../src/app/[locale]/portal/portal-top-bar", () => ({ PortalTopBar: () => null }));
vi.mock("../../src/app/[locale]/portal/todays-classes-card", () => ({ TodaysClassesCard: () => null }));

type PortalPage = (props: { params: Promise<{ locale: string }> }) => Promise<unknown>;
let BaselinePortalPage: PortalPage;
let CurrentPortalPage: PortalPage;

const FROZEN_NOW = new Date("2030-06-15T12:00:00-06:00");
const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
type Fixture = Awaited<ReturnType<typeof makeAccountingOrg>>;
let a: Fixture;
let studentUser: { id: string };
let student: { id: string };

beforeAll(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(FROZEN_NOW);

  ensureCommitFetched(BASELINE_REF);
  writeBaseline(`${PORTAL_DIR}/page.tsx`, BASELINE_FILE);
  const baselineImport = "../../" + `${BASELINE_FILE.replace(/\.tsx$/, "")}`;
  ({ default: BaselinePortalPage } = await import(/* @vite-ignore */ baselineImport));
  ({ default: CurrentPortalPage } = await import("../../src/app/[locale]/portal/page"));

  a = await makeAccountingOrg("CUMULATIVE", "portalbaseline-a");
  studentUser = await prisma.user.create({ data: { email: `portalbaseline-student-${suffix}@example.com`, passwordHash: await hashSecret("irrelevant-password-123"), role: "STUDENT" } });
  await prisma.organizationMembership.create({ data: { userId: studentUser.id, organizationId: a.org.id, role: "STUDENT" } });
  student = await prisma.student.create({
    data: {
      organizationId: a.org.id, homeAcademyId: a.academy.id, userId: studentUser.id, firstName: "PortalBaseline", lastName: `S-${suffix}`, phone: "00000000",
      email: `portalbaseline-linked-${suffix}@example.com`, currentRankId: await a.rankId("WHITE"), codeHash: `portalbaseline-linked-${suffix}`, status: "ACTIVE",
    },
  });
  // Real legacy financial content (what's actually being verified) — frozen "today" is 2030-06-15, this month's
  // current period, giving the legacy card a definite, non-blank status in both renders.
  const plan = await prisma.paymentPlan.create({ data: { organizationId: a.org.id, academyId: a.academy.id, name: `PortalBaseline plan ${suffix}` } });
  await prisma.paymentPeriod.create({
    data: { studentId: student.id, academyId: a.academy.id, organizationId: a.org.id, year: 2030, month: 6, planId: plan.id, status: "PAID", amount: "100.00", currency: "USD", recordedById: a.admin.id },
  });
}, 60_000);

afterAll(async () => {
  vi.useRealTimers();
  currentSession = null;
  removeIfExists(BASELINE_FILE);
  if (!a) return;
  await prisma.paymentPeriod.deleteMany({ where: { organizationId: a.org.id } });
  await prisma.paymentPlan.deleteMany({ where: { organizationId: a.org.id } });
  if (student) await prisma.student.deleteMany({ where: { id: student.id } });
  if (studentUser) {
    await prisma.organizationMembership.deleteMany({ where: { userId: studentUser.id } });
    await prisma.user.deleteMany({ where: { id: studentUser.id } });
  }
  await a.drop();
}, 120_000);

function withProvider(page: unknown): string {
  return renderToStaticMarkup(createElement(NextIntlClientProvider, { locale: "en", messages: enMessages } as never, page as never));
}

/** Same ONE narrow, documented normalization PR #96's own harness established: React's `useId()` counter is
 * scoped to `renderToStaticMarkup` CALL ORDER within this process, not to page content — strips only React 19's
 * own `«...»` id format, touches no real text or financial content. */
function normalizeReactGeneratedIds(html: string): string {
  return html.replace(/«[^»]*»/g, "«ID»");
}

/** The ONE approved, intentional difference Phase 2.6 PR 1 introduces to this page's own markup — see the
 * file-level comment above and `page.tsx`'s own comment at this className. Scoped to the EXACT class string on
 * EXACTLY the one `<main>` element; this is a targeted string replacement, not a general class/whitespace
 * normalizer, and it touches nothing else in the rendered tree. */
const APPROVED_MAIN_CLASS_BASELINE = "mx-auto flex w-full max-w-[1120px] flex-col px-4 py-5 sm:px-6 lg:px-8 lg:py-6";
const APPROVED_MAIN_CLASS_CURRENT =
  "mx-auto flex w-full max-w-[1120px] flex-col px-4 pt-5 pb-[calc(3.5rem+env(safe-area-inset-bottom))] sm:px-6 sm:pt-5 sm:pb-5 lg:px-8 lg:pt-6 lg:pb-6";
function normalizeApprovedMainPadding(html: string): string {
  return html.split(APPROVED_MAIN_CLASS_BASELINE).join(APPROVED_MAIN_CLASS_CURRENT);
}

describe("portal/page.tsx: inactive-ledger render EQUIVALENCE against the pre-PR baseline (87c706b), after the one approved <main> padding normalization — not raw byte identity", () => {
  let baselineHtml: string;
  let currentHtml: string;

  beforeAll(async () => {
    currentSession = { user: { id: studentUser.id }, activeOrganizationId: a.org.id };
    baselineHtml = withProvider(await BaselinePortalPage({ params: Promise.resolve({ locale: "en" }) }));
    currentHtml = withProvider(await CurrentPortalPage({ params: Promise.resolve({ locale: "en" }) }));
    currentSession = null;
  });

  it("REQUIRED: real financial content is non-vacuously present in both renders", () => {
    expect(baselineHtml).toContain("Payment status");
    expect(baselineHtml).toContain("Paid");
  });

  it("REQUIRED: both the old and new <main> padding classes are exactly where expected, asserted BEFORE normalizing — unexpected drift on either side fails loudly instead of the normalization silently matching nothing", () => {
    expect(baselineHtml).toContain(APPROVED_MAIN_CLASS_BASELINE);
    expect(currentHtml).toContain(APPROVED_MAIN_CLASS_CURRENT);
  });

  it("REQUIRED: current render matches baseline once the one approved <main> padding difference is normalized — everything else is unchanged", () => {
    expect(normalizeReactGeneratedIds(currentHtml)).toBe(normalizeReactGeneratedIds(normalizeApprovedMainPadding(baselineHtml)));
  });

  it("REQUIRED: an unrelated class change is NOT swallowed by the normalization — comparison still fails", () => {
    const tamperedCurrent = currentHtml.replace("text-2xl font-bold", "text-2xl font-bold tampered-unrelated-class");
    expect(tamperedCurrent).not.toBe(currentHtml);
    expect(normalizeReactGeneratedIds(tamperedCurrent)).not.toBe(normalizeReactGeneratedIds(normalizeApprovedMainPadding(baselineHtml)));
  });

  it("REQUIRED: a financial text/value change is NOT swallowed by the normalization — comparison still fails", () => {
    const tamperedCurrent = currentHtml.replace("Paid", "Overdue");
    expect(tamperedCurrent).not.toBe(currentHtml);
    expect(normalizeReactGeneratedIds(tamperedCurrent)).not.toBe(normalizeReactGeneratedIds(normalizeApprovedMainPadding(baselineHtml)));
  });
});
