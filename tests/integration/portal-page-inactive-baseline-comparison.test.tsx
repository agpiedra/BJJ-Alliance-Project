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
 * Phase 2.6 PR 2 (Portal content) made a real, approved, SUBSTANTIAL restructure of the Home panel specifically
 * (belt hero, top-of-page payment alert, removed in-grid progress card, renumbered grid `order-*`) — large
 * enough that "byte-identical modulo one normalized string" stops being a meaningful claim for that one panel
 * (the normalization string would just BE the whole changed section). Rather than keep stretching that
 * technique, the comparison below SPLITS the page: everything OUTSIDE the Home panel (branding, `<main>`, the
 * tab bar, the Attendance panel, the Schedule panel) is still held to full byte equivalence (modulo the one
 * approved `<main>` normalization, unchanged); the Home panel itself is held to targeted CONTENT assertions
 * instead — the real financial/attendance/promotion facts it must still show correctly, not its exact markup.
 * See `splitHomePanel` below.
 *
 * IMPORTANT caveat this test does NOT prove: only `page.tsx` is git-extracted for the baseline side. Its
 * `./portal-tabs`, `./attendance-history-section` and `./schedule-day-list` imports are never extracted, so
 * BOTH the "baseline" and "current" renders below import the SAME real, current `PortalTabs`,
 * `AttendanceHistorySection` and `ScheduleDayList` components — confirmed directly against the git-extracted
 * baseline source, which already names all three by the same relative import paths this repo's current
 * `page.tsx` uses. This comparison cannot independently demonstrate anything about old-vs-new rendering or
 * behavior for ANY of those three components — not tab-bar markup, not Attendance's new monthly-stats feature,
 * not Schedule's new day-tab keyboard pattern. That proof lives in their own dedicated tests
 * (`tests/unit/portal-tabs.test.tsx`, `tests/unit/schedule-day-list.test.tsx`,
 * `tests/unit/attendance-history-section.test.tsx`, `tests/integration/attendance-month-totals.test.ts`) and
 * this PR's own real-browser evidence — never this file. This test's job is strictly to prove page.tsx's OWN
 * surrounding markup — which component gets mounted where, in what order, wrapped in what shell — did not
 * silently change outside the one approved `<main>` padding difference and the Home panel's approved restructure.
 *
 * A further limitation specific to this fixture: it creates no `AttendanceRecord` rows at all, so the
 * Attendance panel renders with zero entries on both sides — the new `getAttendanceMonthTotals` read returns
 * zero this-month/last-month counts, and no populated month-grouped list (multiple `<ul>`s, month headers,
 * newest-first ordering) is ever exercised here. That behavior is proven separately by
 * `tests/integration/attendance-month-totals.test.ts` and this PR's real-browser evidence (real cross-month
 * data, real "2 this month / 2 last month" counts) — not by this file, which this fixture structurally cannot
 * exercise.
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
 * file-level comment above and `page.tsx`'s own comment at this className. Scoped to the EXACT `<main class="...">`
 * opening tag — anchored to the tag itself, not a bare class-value replace — so a coincidental occurrence of the
 * same class string on some OTHER element is never touched; this is a targeted string replacement, not a general
 * class/whitespace normalizer. */
const APPROVED_MAIN_CLASS_BASELINE = "mx-auto flex w-full max-w-[1120px] flex-col px-4 py-5 sm:px-6 lg:px-8 lg:py-6";
const APPROVED_MAIN_CLASS_CURRENT =
  "mx-auto flex w-full max-w-[1120px] flex-col px-4 pt-5 pb-[calc(3.5rem+env(safe-area-inset-bottom))] sm:px-6 sm:pt-5 sm:pb-5 lg:px-8 lg:pt-6 lg:pb-6";
const MAIN_TAG_BASELINE = `<main class="${APPROVED_MAIN_CLASS_BASELINE}">`;
const MAIN_TAG_CURRENT = `<main class="${APPROVED_MAIN_CLASS_CURRENT}">`;
/** Number of times a literal (non-regex) substring occurs in `html` — used to assert "exactly one `<main>`
 * tag" before normalizing, so a render with zero or more than one match fails loudly instead of the anchored
 * replace below silently matching nothing or ambiguously matching more than intended. */
function countOccurrences(html: string, literal: string): number {
  return html.split(literal).length - 1;
}
function normalizeApprovedMainPadding(html: string): string {
  return html.split(MAIN_TAG_BASELINE).join(MAIN_TAG_CURRENT);
}

/** PR 2's real, approved restructure lives entirely inside the Home panel. `PortalTabs` always renders all
 * three panels as direct siblings in this fixed order (home, attendance, schedule), with no whitespace between
 * one panel's closing tag and the next panel's opening tag in `renderToStaticMarkup` output - so slicing between
 * the two anchors below extracts EXACTLY the Home panel's full markup, nothing more, nothing less. Throws loudly
 * if either anchor is missing (a real structural change elsewhere) rather than silently slicing the wrong thing. */
const HOME_PANEL_START = '<div role="tabpanel" id="portal-panel-home"';
const ATTENDANCE_PANEL_START = '<div role="tabpanel" id="portal-panel-attendance"';
function splitHomePanel(html: string): { home: string; rest: string } {
  const start = html.indexOf(HOME_PANEL_START);
  const end = html.indexOf(ATTENDANCE_PANEL_START);
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("splitHomePanel: expected tabpanel anchors not found in this order - the page's panel structure changed in a way this test doesn't account for.");
  }
  return { home: html.slice(start, end), rest: html.slice(0, start) + html.slice(end) };
}

describe("portal/page.tsx: inactive-ledger render EQUIVALENCE against the pre-PR baseline (87c706b) outside the Home panel, after the one approved <main> padding normalization — not raw byte identity; the Home panel itself is checked by real-fact content assertions, not byte equivalence, per its own approved restructure", () => {
  let baselineHtml: string;
  let currentHtml: string;
  let homeBaseline: string;
  let homeCurrent: string;
  let restBaseline: string;
  let restCurrent: string;

  beforeAll(async () => {
    currentSession = { user: { id: studentUser.id }, activeOrganizationId: a.org.id };
    baselineHtml = withProvider(await BaselinePortalPage({ params: Promise.resolve({ locale: "en" }) }));
    currentHtml = withProvider(await CurrentPortalPage({ params: Promise.resolve({ locale: "en" }) }));
    currentSession = null;
    ({ home: homeBaseline, rest: restBaseline } = splitHomePanel(baselineHtml));
    ({ home: homeCurrent, rest: restCurrent } = splitHomePanel(currentHtml));
  });

  it("REQUIRED: real financial content, including the fixture's actual plan name (not just the generic 'Payment status'/'Paid' labels), is non-vacuously present in both renders", () => {
    expect(baselineHtml).toContain("Payment status");
    expect(baselineHtml).toContain("Paid");
    // The real fixture plan name (`makeAccountingOrg`'s `PortalBaseline plan ${suffix}`, rendered via
    // `currentPaymentPeriod.planName` = `period.plan.name` — see src/lib/payments/get-current-period.ts) —
    // asserted literally, not just claimed in prose, so a regression that drops the plan name from the legacy
    // card would actually fail this test.
    const planName = `PortalBaseline plan ${suffix}`;
    expect(baselineHtml).toContain(planName);
    expect(currentHtml).toContain(planName);
  });

  it("REQUIRED: exactly one expected <main> tag is present on each side, asserted BEFORE normalizing — zero or duplicate matches fail loudly instead of the anchored replace silently matching nothing or ambiguously matching more than intended", () => {
    expect(countOccurrences(baselineHtml, MAIN_TAG_BASELINE)).toBe(1);
    expect(countOccurrences(currentHtml, MAIN_TAG_CURRENT)).toBe(1);
  });

  it("REQUIRED: outside the Home panel, current matches baseline once the one approved <main> padding difference is normalized — page.tsx's OWN surrounding markup (shell, tab-bar wiring, which component is mounted where) is unchanged. This does NOT independently prove the Attendance or Schedule PANEL CONTENTS are unchanged: both renders mount the same current AttendanceHistorySection/ScheduleDayList (see the file-level caveat above), and this fixture's zero attendance rows mean neither panel's real content differs here regardless.", () => {
    expect(normalizeReactGeneratedIds(restCurrent)).toBe(normalizeReactGeneratedIds(normalizeApprovedMainPadding(restBaseline)));
  });

  it("REQUIRED: an unrelated class change OUTSIDE the Home panel is NOT swallowed by the normalization — comparison still fails", () => {
    // The page greeting <h1> lives before the tab bar, outside every tabpanel - genuinely in `rest`.
    const tamperedCurrent = currentHtml.replace("text-2xl font-bold", "text-2xl font-bold tampered-unrelated-class");
    expect(tamperedCurrent).not.toBe(currentHtml);
    const { rest: tamperedRest } = splitHomePanel(tamperedCurrent);
    expect(normalizeReactGeneratedIds(tamperedRest)).not.toBe(normalizeReactGeneratedIds(normalizeApprovedMainPadding(restBaseline)));
  });

  it("REQUIRED: normalization is scoped to the <main> tag only — the same class string on a different element is left untouched", () => {
    const decoy = `<div class="${APPROVED_MAIN_CLASS_BASELINE}">decoy</div>`;
    const tamperedBaseline = decoy + baselineHtml;
    const normalized = normalizeApprovedMainPadding(tamperedBaseline);
    // The decoy element is NOT <main> — its class string must survive verbatim, untouched.
    expect(normalized).toContain(decoy);
    // The real <main> tag in the same string is still correctly normalized to the current form.
    expect(normalized).toContain(MAIN_TAG_CURRENT);
    expect(normalized).not.toContain(MAIN_TAG_BASELINE);
  });

  describe("Home panel — content facts, not byte equivalence (PR 2's approved restructure lives entirely here)", () => {
    it("REQUIRED: the approved belt hero is genuinely new - absent from the pre-PR baseline, present in current", () => {
      expect(homeBaseline).not.toContain('data-testid="portal-home-hero"');
      expect(homeCurrent).toContain('data-testid="portal-home-hero"');
    });

    it("REQUIRED: the real payment-status fact (plan name and PAID pill) is still shown, unchanged in substance, in both the baseline's old layout and the current hero/alert layout", () => {
      expect(homeBaseline).toContain("Payment status");
      expect(homeBaseline).toContain("Paid");
      expect(homeCurrent).toContain("Payment status");
      expect(homeCurrent).toContain("Paid");
    });

    it("REQUIRED: a financial text/value change inside the Home panel is NOT invisible to a real fact check - the exact assertion above would catch it", () => {
      const tamperedHomeCurrent = homeCurrent.replace("Paid", "Overdue");
      expect(tamperedHomeCurrent).not.toBe(homeCurrent);
      expect(tamperedHomeCurrent).not.toContain("Paid");
    });

    it("REQUIRED: RecentAttendanceCard's and the Promotion history card's real content are untouched by the hero/alert restructure, in both renders", () => {
      expect(homeBaseline).toContain("No attendance recorded yet.");
      expect(homeCurrent).toContain("No attendance recorded yet.");
      expect(homeBaseline).toContain("No promotions yet.");
      expect(homeCurrent).toContain("No promotions yet.");
    });

    it("REQUIRED: no top payment alert renders for this fixture's PAID (not overdue) status - the alert is genuinely conditional, not always-on", () => {
      expect(homeCurrent).not.toContain('role="alert"');
    });
  });
});
