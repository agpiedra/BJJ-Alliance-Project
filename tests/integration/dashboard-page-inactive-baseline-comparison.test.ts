import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { JSDOM } from "jsdom";
import { execFileSync } from "node:child_process";
import { writeFileSync, rmSync, existsSync } from "node:fs";
import { relative, dirname } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { createTranslator, NextIntlClientProvider } from "next-intl";
import { getTestPrismaClient } from "../helpers/test-db";
import { makeAccountingOrg } from "../helpers/accounting-org";
import enMessages from "../../messages/en.json";

/**
 * REMAINING-LEDGER-CONSUMERS-BRIEF.md PR 3's own pinned starting commit (the user's "starting from main"
 * instruction) doubles as this file's baseline: a real render of the actual pre-PR3 `dashboard/page.tsx`
 * (git-extracted, same throwaway-sibling-file technique `students-pages-inactive-baseline-comparison.test.ts`
 * already established) compared BYTE-FOR-BYTE against the CURRENT page, under the ledger's real, unmocked, always-
 * inactive production default (`inactiveLedgerActivation = { isActive: async () => false }`) — no activation mock
 * needed here, so this exercises the genuine production code path. The baseline calls `listStudentsToContact(context)`
 * with its own one-argument pre-PR3 signature against the CURRENT (now two-argument) `contact-list.ts` — `ledgerActive`
 * resolves to `undefined`, which is exactly as falsy as the explicit `false` the current page passes, so this is a
 * real equivalence proof, not a coincidence of the two files happening to agree.
 *
 * PR3 ALSO changed `contact-list.ts`'s own `paymentStatus` return shape unconditionally (plain
 * `ContactPaymentStatus` string → `ContactPaymentInfo` discriminated union), unlike PR2's baseline comparison,
 * which could safely import the real CURRENT `./actions`/`./get-student` because PR2 never touched their return
 * shape. The baseline dashboard page's own rendering code (`paymentStatusLabel(entry.paymentStatus, ...)`) expects
 * the OLD plain-string shape, so running it against the CURRENT library produces a real contract mismatch, not a
 * usable equivalence signal — this never exists in production, where the baseline page only ever ran against the
 * baseline library. So this file ALSO git-extracts a baseline sibling of `contact-list.ts` and rewrites the
 * baseline page's one import line to point at it, keeping every other byte of the extracted page untouched.
 */
const prisma = getTestPrismaClient();
const BASELINE_REF = "ed8c2937ffdb83bee9cf204419c1b451f11aa5b2";
const DASHBOARD_DIR = "src/app/[locale]/(staff)/dashboard";
const DASHBOARD_BASELINE_FILE = `${DASHBOARD_DIR}/__pr3_baseline_ed8c293_page.tsx`;
const CONTACT_LIST_PATH = "src/lib/students/contact-list.ts";
const CONTACT_LIST_BASELINE_FILE = "src/lib/students/__pr3_baseline_ed8c293_contact-list.ts";

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

function extractBaseline(gitPath: string): string {
  return execFileSync("git", ["show", `${BASELINE_REF}:${gitPath}`], { encoding: "utf8" });
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
// Real sibling files, untouched by PR3 — a single real module each, so mocking here applies identically to both
// the baseline and current page's own `./…` imports of them.
vi.mock("../../src/app/[locale]/(staff)/dashboard/weekly-attendance-chart", () => ({ WeeklyAttendanceChart: () => null }));
vi.mock("../../src/app/[locale]/(staff)/dashboard/attendance-by-class-chart", () => ({ AttendanceByClassChart: () => null }));
vi.mock("../../src/app/[locale]/(staff)/dashboard/confirm-promotion-button", () => ({ ConfirmPromotionButton: () => null }));
vi.mock("../../src/app/[locale]/(staff)/dashboard/branding-reminder-card", () => ({ BrandingReminderCard: () => null }));

type DashboardPageFn = () => Promise<unknown>;
let BaselineDashboardPage: DashboardPageFn;
let CurrentDashboardPage: DashboardPageFn;

const FROZEN_NOW = new Date("2030-06-15T12:00:00-06:00");
const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
type Fixture = Awaited<ReturnType<typeof makeAccountingOrg>>;
let a: Fixture;

beforeAll(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(FROZEN_NOW);

  ensureCommitFetched(BASELINE_REF);

  const contactListContent = extractBaseline(CONTACT_LIST_PATH);
  if (!contactListContent.includes("export async function listStudentsToContact")) {
    throw new Error(`Baseline extraction for ${CONTACT_LIST_PATH} looks wrong — first 200 chars:\n${contactListContent.slice(0, 200)}`);
  }
  writeFileSync(CONTACT_LIST_BASELINE_FILE, contactListContent, "utf8");

  const dashboardContent = extractBaseline(`${DASHBOARD_DIR}/page.tsx`);
  if (!dashboardContent.includes("export default")) {
    throw new Error(`Baseline extraction for ${DASHBOARD_DIR}/page.tsx looks wrong — first 200 chars:\n${dashboardContent.slice(0, 200)}`);
  }
  // The one deliberate rewrite: point the baseline page's own `contact-list` import at its OWN baseline sibling
  // (extracted above), not at the current, contract-changed library — see this file's own header comment.
  const importSpecifier = relative(dirname(DASHBOARD_BASELINE_FILE), CONTACT_LIST_BASELINE_FILE).replace(/\\/g, "/").replace(/\.ts$/, "");
  const rewritten = dashboardContent.replace('"@/lib/students/contact-list"', `"${importSpecifier.startsWith(".") ? importSpecifier : `./${importSpecifier}`}"`);
  if (rewritten === dashboardContent) {
    throw new Error("Expected to rewrite the baseline page's contact-list import, but no replacement occurred.");
  }
  writeFileSync(DASHBOARD_BASELINE_FILE, rewritten, "utf8");

  // Non-literal specifier on purpose: the baseline file doesn't exist on disk until the writes above run, so a
  // literal `import("...")` path here would make `tsc --noEmit` try (and fail) to statically resolve a module
  // that is only ever materialized at test runtime.
  const dashboardBaselineImport = "../../" + `${DASHBOARD_BASELINE_FILE.replace(/\.tsx$/, "")}`;
  ({ default: BaselineDashboardPage } = await import(/* @vite-ignore */ dashboardBaselineImport));
  ({ default: CurrentDashboardPage } = await import("../../src/app/[locale]/(staff)/dashboard/page"));

  a = await makeAccountingOrg("CUMULATIVE", "dash-baseline");
  const plan = await prisma.paymentPlan.create({ data: { organizationId: a.org.id, academyId: a.academy.id, name: `DashBaseline plan ${suffix}` } });

  // Belt codes differ by track: ADULT ranks are uppercase ("WHITE"), KIDS ranks are lowercase ("white") — see
  // default-belt-ranks.ts's own KIDS_RANKS/ADULT_RANKS. `rankCode` picks the right one per track so a KIDS
  // fixture doesn't look up a nonexistent uppercase KIDS rank.
  async function newStudent(label: string, track: "ADULT" | "KIDS" = "ADULT") {
    const rankCode = track === "KIDS" ? "white" : "WHITE";
    return prisma.student.create({
      data: {
        organizationId: a.org.id, homeAcademyId: a.academy.id, firstName: "DashBaseline", lastName: `${label}-${suffix}`, phone: "00000000",
        email: `dash-baseline-${label}-${suffix}@example.com`, currentRankId: await a.rankId(rankCode, track), track,
        codeHash: `dash-baseline-${label}-${suffix}`, status: "ACTIVE",
      },
    });
  }
  const paidStudent = await newStudent("paid");
  // Real financial content: a PAID current-month row (so the legacy "Atrasado" tile and the contact list both
  // have something real to differ on, not an empty shell).
  await prisma.paymentPeriod.create({
    data: { studentId: paidStudent.id, academyId: a.academy.id, organizationId: a.org.id, year: 2030, month: 6, planId: plan.id, status: "PAID", amount: "100.00", currency: "USD", recordedById: a.admin.id },
  });

  // Distinct, non-equal adult/kid counts (2 adults: paid + overdue below; 1 kid) — the exact breakdown
  // assertion in the v4 restructure test further down needs counts that would visibly swap or go missing on
  // a regression; two equal counts (e.g. 1-and-1) can't prove a category swap, since "1 adult · 1 kid"
  // swapped is still "1 adult · 1 kid".
  await newStudent("kid", "KIDS");

  const overdueStudent = await newStudent("overdue");
  // No PaymentPeriod row at all + frozen "today" (day 15) past the default overdue cutoff (day 5) → the legacy
  // `isOverdue` rule reports OVERDUE automatically — the same rule `contact-list.test.ts`'s own inactive-path test
  // already relies on, so no extra fixture row is needed to exercise the real overdue tile/contact-list pill.
  await prisma.attendanceRecord.create({
    data: {
      organizationId: a.org.id, academyId: a.academy.id, studentId: overdueStudent.id, type: "CHECKIN", source: "KIOSK",
      occurredAt: new Date("2030-06-01T12:00:00-06:00"), date: new Date("2030-06-01T12:00:00-06:00"),
    },
  });
}, 60_000);

afterAll(async () => {
  vi.useRealTimers();
  currentSession = null;
  removeIfExists(DASHBOARD_BASELINE_FILE);
  removeIfExists(CONTACT_LIST_BASELINE_FILE);
  if (!a) return;
  await prisma.attendanceRecord.deleteMany({ where: { organizationId: a.org.id } });
  await prisma.paymentPeriod.deleteMany({ where: { organizationId: a.org.id } });
  await prisma.paymentPlan.deleteMany({ where: { organizationId: a.org.id } });
  await a.drop();
}, 120_000);

function withProvider(page: unknown): string {
  return renderToStaticMarkup(createElement(NextIntlClientProvider, { locale: "en", messages: enMessages } as never, page as never));
}

/** Same documented normalization `students-pages-inactive-baseline-comparison.test.ts` applies: React's own
 * `useId()`-generated `«...»` ids are scoped to render CALL ORDER within this process, not to page content. */
function normalizeReactGeneratedIds(html: string): string {
  return html.replace(/«[^»]*»/g, "«ID»");
}

/** MATROOM Phase 3 (approved prototype stage A) restructured the stat-tile region twice, both approved, neither
 * present at BASELINE_REF: (1) each StatTile's colour flag became conditional on its own value instead of a
 * static prop; (2) the single 6-tile row split into a general-activity row plus a separate "Needs attention"
 * row under its own heading. Neither is a regression this test should catch — they're the change this PR ships
 * — so true byte-identity against the pre-PR3 baseline is no longer possible for that one region. This file is
 * NOT a byte-identical comparison any more: it normalizes the stat-tile region explicitly (this function), then
 * falls back to a value-level comparison there (same tiles, same values, same notes, just regrouped) while
 * keeping a genuine byte-for-byte comparison for literally everything else on the page — proving Phase 3
 * touched only the stat-tile region and nothing downstream (financial calculations, contact list, role gating,
 * charts, promotion queue) regressed. */
function stripStatTileFlagMarkup(html: string): string {
  return html
    .replace(/ pl-5(?=")/g, "")
    .replace(/<span aria-hidden="true" class="absolute inset-y-0 left-0 w-\[3px\] bg-(?:bad|brand-gold)"><\/span>/g, "");
}

/** The next unchanged section heading after the header/stat-tile region on both sides — marks where the
 * region this PR (and Phase 3 before it) restructures ends, and genuine byte-for-byte proof begins. */
const NEXT_SECTION_MARKER = ">Weekly attendance<";

/** The region-split below depends on this marker appearing EXACTLY ONCE in each render — a missing marker
 * (the page stopped rendering that section, or its markup changed) or a duplicated one (e.g. the heading
 * text now also appears as a caption or chart label elsewhere) would silently pick the wrong split point
 * rather than fail loudly. Throws explicitly instead of trusting indexOf's first match. */
function uniqueMarkerIndex(html: string, marker: string): number {
  const first = html.indexOf(marker);
  if (first === -1) {
    throw new Error(`Expected marker ${JSON.stringify(marker)} to appear exactly once — found 0 occurrences`);
  }
  const second = html.indexOf(marker, first + 1);
  if (second !== -1) {
    throw new Error(`Expected marker ${JSON.stringify(marker)} to appear exactly once — found at least 2 occurrences`);
  }
  return first;
}

describe("uniqueMarkerIndex: the region-split boundary guard fails loudly on 0 or 2+ occurrences", () => {
  it("REQUIRED: a missing marker throws, not -1 silently accepted as a valid split point", () => {
    expect(() => uniqueMarkerIndex("<div>no marker here</div>", ">Weekly attendance<")).toThrow(/0 occurrences/);
  });

  it("REQUIRED: a duplicated marker throws, not silently resolved to its first occurrence", () => {
    const html = "<div>before>Weekly attendance<mid>Weekly attendance<after</div>";
    expect(() => uniqueMarkerIndex(html, ">Weekly attendance<")).toThrow(/at least 2 occurrences/);
  });

  it("REQUIRED: exactly one occurrence returns its real index, same as indexOf", () => {
    const html = "<div>before>Weekly attendance<after</div>";
    expect(uniqueMarkerIndex(html, ">Weekly attendance<")).toBe(html.indexOf(">Weekly attendance<"));
  });
});

/** MATROOM v4: reads one "Needs attention" `AttentionCard`'s (value, note) by its rendered label —
 * `extractStatTiles`'s job, scoped to the new Card-based region instead of a `StatRow`. */
function attentionCardFacts(html: string, label: string): { value: string; note: string | null } {
  const dom = new JSDOM(html);
  const labelEl = Array.from(dom.window.document.querySelectorAll('[data-slot="attention-label"]')).find(
    (el) => el.textContent === label,
  );
  if (!labelEl) throw new Error(`Attention card "${label}" not found`);
  const card = labelEl.closest('[data-testid="attention-card"]');
  if (!card) throw new Error(`Attention card "${label}" has no enclosing card markup`);
  return {
    value: card.querySelector('[data-slot="attention-value"]')?.textContent ?? "",
    note: card.querySelector('[data-slot="attention-note"]')?.textContent ?? null,
  };
}

interface TileTuple {
  label: string;
  value: string;
  deltaDirection: "up" | "down" | null;
  deltaLabel: string | null;
  note: string | null;
}

/** Pulls every StatTile's (label, value, delta, note) out of a stat-tile region, ignoring which row/wrapper it
 * sits in and ignoring the flag span (already stripped by the caller) — the content-level equivalence this test
 * falls back to once byte-identity is no longer possible for this region. `StatTile` (stat-tile.tsx) can render
 * BOTH a delta div (`text-[11.5px] text-ok|text-bad`) and a note div (`text-[11.5px] text-muted-foreground`) on
 * the same tile — two independent optional groups, each anchored on its own distinguishing class, not one shared
 * slot that only ever captures whichever comes first. */
function extractStatTiles(statsRegionHtml: string): TileTuple[] {
  const tileRe =
    /<div class="text-xs text-muted-foreground">([^<]*)<\/div><div class="font-heading text-\[30px\] leading-none font-semibold tabular-nums">([^<]*)<\/div>(?:<div class="text-\[11\.5px\] (text-ok|text-bad)">([^<]*)<\/div>)?(?:<div class="text-\[11\.5px\] text-muted-foreground">([^<]*)<\/div>)?/g;
  const tiles: TileTuple[] = [];
  let match: RegExpExecArray | null;
  while ((match = tileRe.exec(statsRegionHtml))) {
    tiles.push({
      label: match[1]!,
      value: match[2]!,
      deltaDirection: match[3] === "text-ok" ? "up" : match[3] === "text-bad" ? "down" : null,
      deltaLabel: match[4] ?? null,
      note: match[5] ?? null,
    });
  }
  return tiles.sort((x, y) => x.label.localeCompare(y.label));
}

/** Builds the exact two-to-four-div fragment `StatTile` renders for one tile (stat-tile.tsx), so the unit tests
 * below exercise `extractStatTiles` against real markup shape rather than a toy string. */
function fakeStatTileHtml(opts: {
  label: string;
  value: string;
  deltaDirection?: "up" | "down" | null;
  deltaLabel?: string | null;
  note?: string | null;
}): string {
  const deltaHtml = opts.deltaDirection
    ? `<div class="text-[11.5px] ${opts.deltaDirection === "up" ? "text-ok" : "text-bad"}">${opts.deltaLabel}</div>`
    : "";
  const noteHtml = opts.note ? `<div class="text-[11.5px] text-muted-foreground">${opts.note}</div>` : "";
  return `<div class="text-xs text-muted-foreground">${opts.label}</div><div class="font-heading text-[30px] leading-none font-semibold tabular-nums">${opts.value}</div>${deltaHtml}${noteHtml}`;
}

describe("extractStatTiles: delta and note are captured independently (regression for a shared single-slot capture)", () => {
  it("REQUIRED: a non-vacuous tile with both delta and note captures both, not just whichever comes first", () => {
    const html = fakeStatTileHtml({ label: "Both", value: "7", deltaDirection: "up", deltaLabel: "+2 vs last week", note: "Escazú" });
    expect(extractStatTiles(html)).toEqual([
      { label: "Both", value: "7", deltaDirection: "up", deltaLabel: "+2 vs last week", note: "Escazú" },
    ]);
  });

  it("REQUIRED: changing delta direction alone is detected, note untouched", () => {
    const up = extractStatTiles(fakeStatTileHtml({ label: "Both", value: "7", deltaDirection: "up", deltaLabel: "+2 vs last week", note: "Escazú" }));
    const down = extractStatTiles(fakeStatTileHtml({ label: "Both", value: "7", deltaDirection: "down", deltaLabel: "+2 vs last week", note: "Escazú" }));
    expect(down).not.toEqual(up);
    expect(down[0]!.deltaDirection).toBe("down");
    expect(down[0]!.note).toBe(up[0]!.note);
  });

  it("REQUIRED: removing the note alone is detected, delta untouched", () => {
    const withNote = extractStatTiles(fakeStatTileHtml({ label: "Both", value: "7", deltaDirection: "up", deltaLabel: "+2 vs last week", note: "Escazú" }));
    const withoutNote = extractStatTiles(fakeStatTileHtml({ label: "Both", value: "7", deltaDirection: "up", deltaLabel: "+2 vs last week", note: null }));
    expect(withoutNote).not.toEqual(withNote);
    expect(withoutNote[0]!.note).toBeNull();
    expect(withoutNote[0]!.deltaLabel).toBe(withNote[0]!.deltaLabel);
  });

  it("REQUIRED: removing the delta alone is detected, note untouched", () => {
    const withDelta = extractStatTiles(fakeStatTileHtml({ label: "Both", value: "7", deltaDirection: "up", deltaLabel: "+2 vs last week", note: "Escazú" }));
    const withoutDelta = extractStatTiles(fakeStatTileHtml({ label: "Both", value: "7", deltaDirection: null, deltaLabel: null, note: "Escazú" }));
    expect(withoutDelta).not.toEqual(withDelta);
    expect(withoutDelta[0]!.deltaDirection).toBeNull();
    expect(withoutDelta[0]!.note).toBe(withDelta[0]!.note);
  });
});

/**
 * This test REPLACES Phase 3's own version of this comparison (it no longer exists as a separate test in
 * this file — the diff that introduced this block deleted it, not kept it alongside this one). Phase 3's
 * version asserted "nothing before or after the stat-tile region moved" and compared one contiguous
 * `StatRow`-based region for byte/tile equality. MATROOM v4 (this PR) legitimately moves/restyles content
 * BEFORE that region too (the header subtitle, and "Needs attention" leaving `StatRow` entirely) — Phase 3's
 * own boundary claim no longer holds, by design, not by regression, so it could not simply be kept as-is.
 * This test re-proves the same financial-content equivalence Phase 3's version proved (same tiles, same
 * values, same notes) plus the new header/card-region changes, widening the "restructured by approval"
 * region by exactly the margin v4 actually changed, while keeping genuine byte-for-byte proof for literally
 * everything from "Weekly attendance" onward.
 *
 * MATROOM v4 restructures the header AND the stat-tile region a second time (both approved, neither present
 * at BASELINE_REF or at Phase 3's own commit): the restated-count subtitle became a plain date+location line;
 * "Needs attention" moved from a `StatRow` into independently bordered `AttentionCard`s, first on the page;
 * the general-activity row collapsed into a 2-tile "This week" `StatRow` (kids/adults become a note on
 * "Active students" instead of two peer tiles); and the standalone pending-approvals text+link row moved into
 * its own "Awaiting approval" card.
 *
 * What this test does NOT prove: the branding reminder is one of v4's approved changes too (moved from
 * directly under the header to below the data sections) — but `BrandingReminderCard` is mocked to `() =>
 * null` in this file (see the `vi.mock` block above), on both the baseline and current renders alike, so its
 * real content never appears on either side regardless of where `<BrandingReminderCard>` sits in the JSX.
 * This org (`a`, from `makeAccountingOrg`) has no logo and no dismissal recorded, so `showBrandingReminder`
 * would genuinely evaluate `true` for it — the reminder's real gate and its approved new position are
 * covered instead, with the real (unmocked) component, by
 * `tests/integration/dashboard-page-branding-reminder-placement.test.ts`. "Everything from 'Weekly
 * attendance' onward is byte-identical" below is therefore a true statement about what this file's own mocks
 * let it observe, not a claim that the reminder's move was independently verified here.
 */
describe("dashboard/page.tsx: v4 header/needs-attention/this-week restructure against the pre-PR3 baseline (region widened by approval, everything downstream still byte-for-byte)", () => {
  it("REQUIRED: everything from 'Weekly attendance' onward is byte-identical — v4 touches only the header/stat-tile region above it", async () => {
    currentSession = { user: { id: a.admin.id }, activeOrganizationId: a.org.id };
    const baselineHtml = normalizeReactGeneratedIds(withProvider(await BaselineDashboardPage()));
    const currentHtml = normalizeReactGeneratedIds(withProvider(await CurrentDashboardPage()));
    currentSession = null;

    const baselineMarkerIdx = uniqueMarkerIndex(baselineHtml, NEXT_SECTION_MARKER);
    const currentMarkerIdx = uniqueMarkerIndex(currentHtml, NEXT_SECTION_MARKER);

    const baselineAfter = baselineHtml.slice(baselineMarkerIdx);
    const currentAfter = currentHtml.slice(currentMarkerIdx);
    expect(baselineAfter.length).toBeGreaterThan(0);
    expect(currentAfter).toBe(baselineAfter);

    const baselineRegion = baselineHtml.slice(0, baselineMarkerIdx);
    const currentRegion = currentHtml.slice(0, currentMarkerIdx);

    // --- Header/subtitle: the restated-count sentence is gone; a plain date + location line replaces it,
    //     using the SAME academy name and the SAME real financial facts (restated nowhere now, but still
    //     present as their own cards below), not a new, disconnected piece of copy. ---
    expect(baselineRegion).toContain("check-ins this week");
    expect(currentRegion).not.toContain("check-ins this week");
    expect(currentRegion).toContain("dash-baseline Academy");

    // --- Needs attention: the exact same financial facts the baseline's StatRow showed, now in independent
    //     AttentionCards instead of a joined strip — value and note both unchanged. ---
    const baselineGeneral = extractStatTiles(stripStatTileFlagMarkup(baselineRegion));
    const baselineOverdue = baselineGeneral.find((tile) => tile.label === "Overdue monthly dues");
    const baselineReady = baselineGeneral.find((tile) => tile.label === "Ready to grade");
    const baselineActive = baselineGeneral.find((tile) => tile.label === "Active students");
    const baselineKids = baselineGeneral.find((tile) => tile.label === "Active kids");
    const baselineAdults = baselineGeneral.find((tile) => tile.label === "Active adults");
    const baselineCheckins = baselineGeneral.find((tile) => tile.label === "Check-ins");
    if (!baselineOverdue || !baselineReady || !baselineActive || !baselineKids || !baselineAdults || !baselineCheckins) {
      throw new Error("Baseline general/needs-attention stat tiles not found — fixture or marker drifted");
    }

    const currentOverdue = attentionCardFacts(currentRegion, "Overdue monthly dues");
    expect(currentOverdue.value).toBe(baselineOverdue.value);
    expect(currentOverdue.note).toBe(baselineOverdue.note);

    const currentReady = attentionCardFacts(currentRegion, "Ready to grade");
    expect(currentReady.value).toBe(baselineReady.value);
    expect(currentReady.note).toBe(baselineReady.note);

    // New in v4 (approved): the pending-approvals card. No baseline card exists to compare it against (it was
    // a plain text+link row before) — asserted directly instead: same `pendingCount` data source (zero in
    // this fixture, no PENDING student created), same preserved link and destination.
    const currentPending = attentionCardFacts(currentRegion, "Awaiting approval");
    expect(currentPending.value).toBe("0");
    expect(currentRegion).toContain('href="/en/students?status=PENDING"');
    expect(currentRegion).toContain("View pending students");

    // --- This week: same Active-students/Check-ins values and the same up/down delta: kids/adults are no
    //     longer separate peer tiles, but both counts are still present, now inside Active students' own
    //     note instead of being lost. ---
    const currentWeek = extractStatTiles(stripStatTileFlagMarkup(currentRegion));
    const currentActive = currentWeek.find((tile) => tile.label === "Active students");
    const currentCheckins = currentWeek.find((tile) => tile.label === "Check-ins");
    if (!currentActive || !currentCheckins) throw new Error("Current 'This week' stat tiles not found");

    // Exact total and check-in delta — preserved unchanged from the original version of this test.
    expect(currentActive.value).toBe(baselineActive.value);
    expect(currentCheckins.value).toBe(baselineCheckins.value);
    expect(currentCheckins.deltaDirection).toBe(baselineCheckins.deltaDirection);
    expect(currentCheckins.deltaLabel).toBe(baselineCheckins.deltaLabel);

    // Exact breakdown, not a substring check on each number independently: the fixture (beforeAll) deliberately
    // seeds UNEQUAL adult/kid counts (2 adults — paidStudent + overdueStudent — and 1 kid) specifically so a
    // category swap ("1 adult · 2 kids") or a missing category ("2 adults" alone) would produce a DIFFERENT
    // string here and fail this assertion — two separate `.toContain()` checks on the raw numbers could not
    // have caught either, since "2" and "1" would each still individually appear in a swapped or malformed
    // string. Cross-checked against the baseline's own two peer tiles first, then asserted as the known
    // literal EN ICU output for exactly (2 adults, 1 kid) — "1 kid" singular, "2 adults" plural (not derived
    // via a hand-written plural suffix here, which would just re-encode the same assumption it's meant to test).
    expect(baselineAdults.value).toBe("2");
    expect(baselineKids.value).toBe("1");
    expect(currentActive.note).toBe("2 adults · 1 kid");

    // --- The approved structural changes themselves, asserted directly rather than merely tolerated. ---
    expect(baselineRegion).not.toContain(">This week<");
    expect(currentRegion).toContain(">This week<");
    expect(currentRegion).toContain(">Needs attention<");
  });
});
