import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { writeFileSync, rmSync, existsSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { createTranslator, NextIntlClientProvider } from "next-intl";
import { getTestPrismaClient } from "../helpers/test-db";
import { makeAccountingOrg } from "../helpers/accounting-org";
import enMessages from "../../messages/en.json";

/**
 * REMAINING-LEDGER-CONSUMERS-BRIEF.md §2.2/§6.1 Decision 3 (PR 6, "include baseline dependencies that change in
 * this PR" — the lesson from PR 4's own digest review fix): a real before/after equivalence proof for the
 * analytics page's INACTIVE path.
 *
 * This PR changes THREE files the page's own render tree reaches, not just `page.tsx` itself:
 * `headline-tiles.ts` (return shape — new fields, `paymentHealthPercent` widened to `number | null`) and
 * `locations.ts` (same new fields, propagated per academy), both called by `page.tsx`. If only `page.tsx` were
 * git-extracted and left to import the CURRENT (post-PR6) `headline-tiles.ts`/`locations.ts`, both the baseline
 * and current renders would run through the SAME current data layer — a regression inside the preserved
 * INACTIVE branch of either file would affect both identically and never show up as a difference. So the chain
 * is extracted three deep: `page.tsx` -> `locations.ts` -> `headline-tiles.ts`, each baseline sibling's own
 * import of the next rewritten to point at ITS sibling, exactly like the digest baseline test's
 * `weekly-digest.ts -> dispatch.ts -> templates.ts` chain.
 *
 * `locations-panel.tsx` (the one other PR6-changed file this page renders) is NOT re-extracted: `git diff
 * d594e03 HEAD -- src/app/'[locale]'/'(staff)'/dashboard/analytics/locations-panel.tsx` shows only an ADDITIVE
 * change (a new `paymentHealthDisplay` function that falls back to the exact old `${row.paymentHealthPercent}%`
 * string whenever `paymentHealthPopulationCount > 0` and `paymentHealthUnknownCount === 0` — true for every
 * INACTIVE-path academy in this fixture, since the legacy calculation never withholds a nonzero-population
 * result). The CURRENT `locations-panel.tsx` is therefore behavior-preserving for every case this fixture
 * exercises, confirmed by inspection rather than assumed — reusing it is not a shortcut that could hide a
 * regression in this PR's own shape change there, unlike the two files that DO need their own baseline chain.
 *
 * Every other file `page.tsx` imports (`class-popularity.ts`, `progression.ts`, `retention.ts`, `filters.ts`,
 * the `ClassPopularityPanel`/`ProgressionPanel`/`RetentionPanel` client components, tenant/scoped-client/
 * branding/zone/staff-shell modules) is confirmed unchanged since BASELINE_REF (`git diff d594e03 HEAD --
 * <those paths>` is empty) — reusing the current, real versions of those is not a shortcut either.
 *
 * Deterministic time: `page.tsx`'s own `now = DateTime.now().setZone(ZONE)` has no injection point, and
 * `getHeadlineTiles`'s legacy `paymentHealthPercent` path keys off `currentCrDateParts()` (also real wall-clock)
 * — both frozen via `vi.useFakeTimers()`/`vi.setSystemTime`, the same technique the digest/Pagos baseline tests
 * already use, so both the baseline and current renders see identical "today"/"this month".
 */
const prisma = getTestPrismaClient();
const BASELINE_REF = "d594e034697af0aa32b9833532ce220bc32963bb";

const PAGE_PATH = "src/app/[locale]/(staff)/dashboard/analytics/page.tsx";
const PAGE_BASELINE_FILE = "src/app/[locale]/(staff)/dashboard/analytics/__pr6_baseline_d594e03_page.tsx";
const LOCATIONS_PATH = "src/lib/analytics/locations.ts";
const LOCATIONS_BASELINE_FILE = "src/lib/analytics/__pr6_baseline_d594e03_locations.ts";
const HEADLINE_PATH = "src/lib/analytics/headline-tiles.ts";
const HEADLINE_BASELINE_FILE = "src/lib/analytics/__pr6_baseline_d594e03_headline-tiles.ts";

const BASELINE_FILES = [PAGE_BASELINE_FILE, LOCATIONS_BASELINE_FILE, HEADLINE_BASELINE_FILE];

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

/** Posix-style relative import path (no trailing slash, always forward slashes, always starts with "."). */
function relativeImportDir(fromFile: string, toDir: string): string {
  const rel = path.relative(path.dirname(fromFile), toDir).replace(/\\/g, "/");
  return rel === "" ? "." : rel.startsWith(".") ? rel : `./${rel}`;
}

type MockSession = { user: { id: string }; activeOrganizationId: string | null } | null;
let currentSession: MockSession = null;
vi.mock("@/auth", () => ({ auth: () => Promise.resolve(currentSession) }));
vi.mock("next-intl/server", () => ({
  getLocale: () => Promise.resolve("en"),
  getTranslations: async (namespace: string) => createTranslator({ locale: "en", messages: enMessages, namespace } as never),
}));

type PageFn = (args: { searchParams: Promise<Record<string, string>> }) => Promise<unknown>;
let BaselinePage: PageFn;
let CurrentPage: PageFn;

const FROZEN_NOW = new Date("2030-06-15T12:00:00-06:00");
type Fixture = Awaited<ReturnType<typeof makeAccountingOrg>>;
let org: Fixture;
let plan: { id: string };

beforeAll(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(FROZEN_NOW);

  ensureCommitFetched(BASELINE_REF);

  // headline-tiles.ts: leaf of the chain — no internal rewrite needed. Every import it has (prisma, tenant
  // context/scoped-client, get-current-period, zone, Prisma types, filters types) is confirmed unchanged since
  // BASELINE_REF, and the pre-PR6 version imports no ledger module at all.
  const headlineContent = extractBaseline(HEADLINE_PATH);
  if (!headlineContent.includes("export async function getHeadlineTiles")) {
    throw new Error(`Baseline extraction for ${HEADLINE_PATH} looks wrong — first 200 chars:\n${headlineContent.slice(0, 200)}`);
  }
  writeFileSync(HEADLINE_BASELINE_FILE, headlineContent, "utf8");

  // locations.ts: narrowly rewrite its one import of headline-tiles.ts to the baseline sibling above (same dir).
  const locationsContent = extractBaseline(LOCATIONS_PATH);
  if (!locationsContent.includes("export async function getLocationComparison")) {
    throw new Error(`Baseline extraction for ${LOCATIONS_PATH} looks wrong — first 200 chars:\n${locationsContent.slice(0, 200)}`);
  }
  const headlineFromLocations = relativeImportDir(LOCATIONS_BASELINE_FILE, path.dirname(HEADLINE_BASELINE_FILE));
  const rewrittenLocations = locationsContent.replace(
    '"@/lib/analytics/headline-tiles"',
    `"${headlineFromLocations}/__pr6_baseline_d594e03_headline-tiles"`,
  );
  if (rewrittenLocations === locationsContent) {
    throw new Error("Expected to rewrite the baseline locations.ts's headline-tiles import, but no replacement occurred.");
  }
  writeFileSync(LOCATIONS_BASELINE_FILE, rewrittenLocations, "utf8");

  // page.tsx: narrowly rewrite its two imports (headline-tiles.ts, locations.ts) to their baseline siblings.
  // Every other import (class-popularity/progression/retention/filters, the three client panels,
  // tenant/scoped-client/branding/zone/staff-shell) is confirmed unchanged since BASELINE_REF and stays real.
  const pageContent = extractBaseline(PAGE_PATH);
  if (!pageContent.includes("export default async function AnalyticsPage")) {
    throw new Error(`Baseline extraction for ${PAGE_PATH} looks wrong — first 200 chars:\n${pageContent.slice(0, 200)}`);
  }
  const headlineFromPage = relativeImportDir(PAGE_BASELINE_FILE, path.dirname(HEADLINE_BASELINE_FILE));
  const locationsFromPage = relativeImportDir(PAGE_BASELINE_FILE, path.dirname(LOCATIONS_BASELINE_FILE));
  const rewrittenPage = pageContent
    .replace('"@/lib/analytics/headline-tiles"', `"${headlineFromPage}/__pr6_baseline_d594e03_headline-tiles"`)
    .replace('"@/lib/analytics/locations"', `"${locationsFromPage}/__pr6_baseline_d594e03_locations"`);
  if (rewrittenPage === pageContent) {
    throw new Error("Expected to rewrite the baseline page.tsx's headline-tiles/locations imports, but no replacement occurred.");
  }
  writeFileSync(PAGE_BASELINE_FILE, rewrittenPage, "utf8");

  // Non-literal specifier on purpose — the baseline file doesn't exist on disk until the writes above run, so a
  // literal `import("...")` path here would make `tsc --noEmit` try (and fail) to statically resolve a module
  // that is only ever materialized at test runtime (same reasoning the digest/Pagos baseline tests document).
  const pageBaselineImport = "../../" + PAGE_BASELINE_FILE.replace(/\.tsx$/, "");
  ({ default: BaselinePage } = await import(/* @vite-ignore */ pageBaselineImport));
  ({ default: CurrentPage } = await import("../../src/app/[locale]/(staff)/dashboard/analytics/page"));

  org = await makeAccountingOrg("CUMULATIVE", "analytics-baseline");
  plan = await prisma.paymentPlan.create({ data: { organizationId: org.org.id, academyId: org.academy.id, name: `Analytics baseline plan` } });

  async function newStudent(label: string) {
    return prisma.student.create({
      data: {
        organizationId: org.org.id, homeAcademyId: org.academy.id, firstName: "AnalyticsBaseline", lastName: label, phone: "00000000",
        email: `analytics-baseline-${label}@example.com`, currentRankId: await org.rankId("WHITE"), codeHash: `analytics-baseline-${label}`, status: "ACTIVE",
      },
    });
  }
  async function checkin(studentId: string, daysAgo: number) {
    const occurredAt = new Date(FROZEN_NOW.getTime() - daysAgo * 86_400_000);
    await prisma.attendanceRecord.create({
      data: { organizationId: org.org.id, academyId: org.academy.id, studentId, type: "CHECKIN", source: "KIOSK", occurredAt, date: occurredAt },
    });
  }

  // Meaningful nonzero content on every tile at once: paidActive (active + payment-health healthy), unpaidActive
  // (active, no PaymentPeriod row — doesn't count toward payment health) — the same non-vacuous shape
  // `headline-tiles.test.ts`'s own sA/sD fixture already establishes.
  const paidActive = await newStudent("paid-active");
  await checkin(paidActive.id, 2);
  await prisma.paymentPeriod.create({
    data: { studentId: paidActive.id, academyId: org.academy.id, organizationId: org.org.id, year: 2030, month: 6, planId: plan.id, status: "PAID", amount: "100.00", currency: "USD", recordedById: org.admin.id },
  });
  const unpaidActive = await newStudent("unpaid-active");
  await checkin(unpaidActive.id, 3);
  // No PaymentPeriod row for unpaidActive — the legacy rule never counts it as healthy.
}, 60_000);

afterAll(async () => {
  vi.useRealTimers();
  currentSession = null;
  for (const f of BASELINE_FILES) removeIfExists(f);
  if (!org) return;
  await prisma.paymentPeriod.deleteMany({ where: { organizationId: org.org.id } });
  await prisma.paymentPlan.deleteMany({ where: { organizationId: org.org.id } });
  await org.drop();
}, 120_000);

/** React's own `useId()`-generated `«...»` ids (`belt-graphic.tsx`, rendered inside the belt-distribution panel
 * this page always includes) are per-render and would otherwise make an exact `toBe` comparison flaky even
 * between two renders of the IDENTICAL implementation — normalized away on BOTH sides, the same technique
 * `dashboard-page-inactive-baseline-comparison.test.ts` already documents for its own identical belt-graphic
 * rendering. Nothing else is normalized. */
function normalizeReactGeneratedIds(html: string): string {
  return html.replace(/«[^»]*»/g, "«id»");
}

function withProvider(page: unknown): string {
  return renderToStaticMarkup(createElement(NextIntlClientProvider, { locale: "en", messages: enMessages } as never, page as never));
}

/** MATROOM Phase 3 (approved prototype, stage E/H filters-row breakpoint): the quick-range control's `<a>`/group
 * `<div>` gained purely-additive `max-[400px]:*` utility classes (a sub-400px 2x2 pill-grid layout) — an
 * intentional, approved responsive change, not present at BASELINE_REF. These tokens never change which
 * element exists or its text content, only its class list, so stripping them (and the double space left behind)
 * is enough to keep comparing every real byte of content and markup structure, while staying blind to the one
 * already-approved class-list addition. */
function stripNarrowFilterClasses(html: string): string {
  return html.replace(/\s?max-\[400px\]:[^\s"]+/g, "").replace(/ {2,}/g, " ");
}

describe("dashboard/analytics/page.tsx: inactive-path render against the pre-PR6 baseline (main@d594e03, narrow-filter classes normalized)", () => {
  it("REQUIRED: current inactive render matches the real pre-PR6 implementation byte-for-byte once the approved sub-400px filter classes are normalized away", async () => {
    currentSession = { user: { id: org.admin.id }, activeOrganizationId: org.org.id };
    const baselineHtml = normalizeReactGeneratedIds(withProvider(await BaselinePage({ searchParams: Promise.resolve({}) })));
    const currentHtml = normalizeReactGeneratedIds(withProvider(await CurrentPage({ searchParams: Promise.resolve({}) })));
    currentSession = null;

    // Non-vacuous: real, meaningful nonzero content, not an empty shell.
    expect(baselineHtml).toContain("Payment health (current month)");
    expect(baselineHtml).toContain("50%"); // 1 healthy (paidActive) / 2 enrolled, the legacy formula's own exact value
    expect(stripNarrowFilterClasses(currentHtml)).toBe(stripNarrowFilterClasses(baselineHtml));
    // The approved addition itself, asserted directly rather than merely tolerated away.
    expect(currentHtml).toContain("max-[400px]:grid");
    expect(baselineHtml).not.toContain("max-[400px]:grid");
  });
});
