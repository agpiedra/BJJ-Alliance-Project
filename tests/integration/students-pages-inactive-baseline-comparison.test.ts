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
 * Review-fix: `students-page-ledger-render.test.ts` proves GATING markers (new surface absent when inactive,
 * present when active) — useful, but not the promised before/after EQUIVALENCE proof. This file compares the
 * ACTUAL pre-PR2 implementation (commit 83fed6f, the merged state immediately before PR2's own first commit
 * 430dd45) against the CURRENT code for BOTH pages, rendered with IDENTICAL fixtures, a frozen clock, locale, and
 * external-service mocks, under the ledger's real, unmocked, always-inactive production default
 * (`inactiveLedgerActivation = { isActive: async () => false }` — see activation.ts; no activation mock is used or
 * needed here, so this exercises the genuine production code path, not a stand-in for it).
 *
 * The baseline source is git-extracted and written to a throwaway SIBLING file — same real directory as the real
 * page.tsx — purely so its own `./relative` imports (`./actions`, `./get-student`, etc., none of which PR2 touched)
 * resolve against the real, unchanged neighboring files. It is never a route (Next.js only treats a file literally
 * named `page.tsx`/`route.tsx` as one — see dues-ledger-not-exposed.test.ts's own identical route-naming check),
 * never committed, and deleted in `afterAll` regardless of outcome. This is test-only scaffolding that exists only
 * for the duration of this file's test run, not production code.
 */
const prisma = getTestPrismaClient();
// The FULL sha, not the abbreviated "83fed6f" — CI's checkout step (actions/checkout@v4, default fetch-depth: 1)
// is a SHALLOW clone that doesn't have this commit's object locally at all, and an unreachable short SHA is not
// safe to assume is unambiguous against the remote's full object space. `ensureCommitFetched` below fetches it
// explicitly first, so this works under both a full local clone and CI's shallow one.
const BASELINE_REF = "83fed6fb4a6219b6282c907d523f06d3b9e1b964";
const ROSTER_DIR = "src/app/[locale]/(staff)/students";
const DETAIL_DIR = "src/app/[locale]/(staff)/students/[id]";
const ROSTER_BASELINE_FILE = `${ROSTER_DIR}/__pr2_baseline_83fed6f_page.tsx`;
const DETAIL_BASELINE_FILE = `${DETAIL_DIR}/__pr2_baseline_83fed6f_page.tsx`;

function ensureCommitFetched(ref: string) {
  try {
    execFileSync("git", ["cat-file", "-e", `${ref}^{commit}`], { stdio: "ignore" });
  } catch {
    // Not present locally (a shallow CI clone) — fetch exactly this one commit from origin.
    try {
      execFileSync("git", ["fetch", "--depth=1", "origin", ref], { stdio: ["ignore", "ignore", "pipe"], encoding: "utf8" });
    } catch (err) {
      // A genuine fetch failure is not expected — surface git's real reason, bounded and stripped of
      // any credential-bearing URL, instead of the opaque "Command failed" exit-code-only error.
      const rawStderr = err && typeof err === "object" && "stderr" in err ? String((err as { stderr?: unknown }).stderr ?? "") : "";
      const sanitized = rawStderr.replace(/https?:\/\/[^\s@/]+@/g, "https://[redacted]@").trim().slice(0, 1000);
      throw new Error(`git fetch --depth=1 origin ${ref} failed${sanitized ? `: ${sanitized}` : " (no stderr captured)"}`);
    }
  }
}

function writeBaseline(gitPath: string, diskPath: string) {
  const content = execFileSync("git", ["show", `${BASELINE_REF}:${gitPath}`], { encoding: "utf8" });
  // Fail loudly here, not with a cryptic downstream bundler parse error, if git ever again returns something
  // that isn't the expected TSX source (e.g. a commit/diff dump instead of a blob).
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
// Same reasoning `payments-page-card-gating.test.ts` documents: the real `next-intl/server` throws under Vitest's
// plain "node" environment outside a real request scope, so this is a full replacement, not a partial.
vi.mock("next-intl/server", () => ({
  getLocale: () => Promise.resolve("en"),
  getTranslations: async (namespace: string) => createTranslator({ locale: "en", messages: enMessages, namespace } as never),
}));
// Unrelated client-side machinery (the create-student form's own hooks/action-state) that both page versions
// import identically — a single real sibling file, so mocking it here applies uniformly to baseline and current.
vi.mock("../../src/app/[locale]/(staff)/students/create-student-form", () => ({ CreateStudentForm: () => null }));

type RosterPage = (props: { searchParams: Promise<Record<string, string>> }) => Promise<unknown>;
type DetailPage = (props: { params: Promise<{ locale: string; id: string }> }) => Promise<unknown>;
let BaselineStudentsPage: RosterPage;
let BaselineStudentDetailPage: DetailPage;
let CurrentStudentsPage: RosterPage;
let CurrentStudentDetailPage: DetailPage;

const FROZEN_NOW = new Date("2030-06-15T12:00:00-06:00");
const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
type Fixture = Awaited<ReturnType<typeof makeAccountingOrg>>;
let a: Fixture;
let paidStudent: { id: string };
let pendingStudent: { id: string };

beforeAll(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(FROZEN_NOW);

  ensureCommitFetched(BASELINE_REF);
  writeBaseline(`${ROSTER_DIR}/page.tsx`, ROSTER_BASELINE_FILE);
  writeBaseline(`${DETAIL_DIR}/page.tsx`, DETAIL_BASELINE_FILE);

  // Non-literal specifiers on purpose: the baseline files don't exist on disk until the `writeBaseline` calls
  // above run, so a literal `import("...")` path here would make `tsc --noEmit` try (and fail) to statically
  // resolve a module that is only ever materialized at test runtime.
  const rosterBaselineImport = "../../" + `${ROSTER_BASELINE_FILE.replace(/\.tsx$/, "")}`;
  const detailBaselineImport = "../../" + `${DETAIL_BASELINE_FILE.replace(/\.tsx$/, "")}`;
  ({ default: BaselineStudentsPage } = await import(/* @vite-ignore */ rosterBaselineImport));
  ({ default: BaselineStudentDetailPage } = await import(/* @vite-ignore */ detailBaselineImport));
  ({ default: CurrentStudentsPage } = await import("../../src/app/[locale]/(staff)/students/page"));
  ({ default: CurrentStudentDetailPage } = await import("../../src/app/[locale]/(staff)/students/[id]/page"));

  a = await makeAccountingOrg("CUMULATIVE", "baseline-render");
  const plan = await prisma.paymentPlan.create({ data: { organizationId: a.org.id, academyId: a.academy.id, name: `Baseline plan ${suffix}` } });

  async function newStudent(label: string) {
    return prisma.student.create({
      data: {
        organizationId: a.org.id, homeAcademyId: a.academy.id, firstName: "Baseline", lastName: `${label}-${suffix}`, phone: "00000000",
        email: `baseline-render-${label}-${suffix}@example.com`, currentRankId: await a.rankId("WHITE"), codeHash: `baseline-render-${label}-${suffix}`, status: "ACTIVE",
      },
    });
  }
  paidStudent = await newStudent("paid");
  pendingStudent = await newStudent("pending");
  // Real financial content (the thing being verified) — frozen "today" is 2030-06-15, so these are both THIS
  // month's current period, giving every row a definite, non-blank payment status in both renders.
  await prisma.paymentPeriod.create({
    data: { studentId: paidStudent.id, academyId: a.academy.id, organizationId: a.org.id, year: 2030, month: 6, planId: plan.id, status: "PAID", amount: "100.00", currency: "USD", recordedById: a.admin.id },
  });
  await prisma.paymentPeriod.create({
    data: { studentId: pendingStudent.id, academyId: a.academy.id, organizationId: a.org.id, year: 2030, month: 6, planId: plan.id, status: "PENDING", amount: "50.00", currency: "USD", recordedById: a.admin.id },
  });
}, 60_000);

afterAll(async () => {
  vi.useRealTimers();
  currentSession = null;
  removeIfExists(ROSTER_BASELINE_FILE);
  removeIfExists(DETAIL_BASELINE_FILE);
  if (!a) return;
  await prisma.paymentPeriod.deleteMany({ where: { organizationId: a.org.id } });
  await prisma.paymentPlan.deleteMany({ where: { organizationId: a.org.id } });
  await a.drop();
}, 120_000);

function withProvider(page: unknown): string {
  return renderToStaticMarkup(createElement(NextIntlClientProvider, { locale: "en", messages: enMessages } as never, page as never));
}

/**
 * The ONE narrow, documented normalization this file applies for ID churn: React's `useId()` (used internally by
 * a presentational SVG component's own clipPath id — e.g. `BeltBar`/`BeltVisual` — nothing ledger-related)
 * assigns ids from a counter scoped to `renderToStaticMarkup` CALL ORDER within this process, not to page
 * content. Rendering baseline then current back-to-back in the same test run gives them different id sequences
 * purely from that call order — confirmed by re-running this suite and observing the SAME row's id change
 * between runs even with no code change at all. Strips only React 19's own `«...»` id format; touches no real
 * text or financial content.
 */
function normalizeReactGeneratedIds(html: string): string {
  return html.replace(/«[^»]*»/g, "«ID»");
}

/**
 * Phase 4 roster correction: the two approved, intentional visual diffs between the pre-PR2 baseline and
 * current, normalized away — precisely, by anchored literal-string removal, not a loose regex — so everything
 * else in the page remains a byte-for-byte comparison. Each replacement targets an EXACT, unique string this
 * PR's own JSX is known to produce (confirmed by reading `page.tsx` and a real render before writing this), not
 * a pattern broad enough to also swallow an unrelated change. Applying this to the BASELINE html is a safe
 * no-op: neither literal string exists there (confirmed by `expect(baselineHtml).not.toContain(...)` below), so
 * `.replace()` simply finds no match. See `__normalizeApprovedPhase4Diffs guard tests` below for proof this
 * does NOT mask an unrelated, unexpected change — a corrupted fixture still fails equality after normalization.
 */
function normalizeApprovedPhase4Diffs(html: string): string {
  return html
    // 1. Header/CreateStudentForm regrouping wrapper (`page.tsx`'s own `has-[details[open]]:flex-col` div):
    //    CreateStudentForm is mocked to `() => null` in this file, so the wrapper's only content is `<header>`;
    //    its closing tag is therefore always immediately followed by `<Card>`'s root (`data-slot="card"`).
    .replace(
      '<div class="flex flex-wrap items-start justify-between gap-3 has-[details[open]]:flex-col has-[details[open]]:items-stretch"><header',
      "<header",
    )
    .replace('</header></div><div data-slot="card"', '</header><div data-slot="card"')
    // 2. Belt sizing (`w-[140px]` on the wrapping span and the <svg> itself — `BeltVisual` called directly
    //    instead of through `BeltBar`, which never forwarded a className to its <svg> at all).
    .replaceAll('<span aria-hidden="true" class="w-[140px] shrink-0">', '<span aria-hidden="true">')
    .replaceAll('aria-label="" class="w-[140px]" style=', 'aria-label="" style=');
}

/**
 * Phase 4 student-detail correction: the approved, intentional grid-placement diffs between the pre-PR2
 * baseline and current, normalized away by the same discipline as `normalizeApprovedPhase4Diffs` above —
 * anchored literal strings confirmed against a real render (`pnpm exec vitest run` on this file, inspecting
 * the failure diff) before writing this, not a loose regex. Applying this to the baseline is a safe no-op:
 * none of these literal strings exist there.
 */
/**
 * Round 5 (Option B, explicitly approved): the detail page's shared-row grid is replaced by two INDEPENDENT
 * column containers, and Profile/Attendance/Legacy/RegenerateCode/AddAdjustment are genuinely REORDERED in the
 * DOM (left column: Promotions → Attendance → RegenerateCode → AddAdjustment; right column: Profile → Legacy
 * → Ledger). A simple "strip the added classes" normalization — sufficient for every prior round's pure
 * className diff — can no longer produce byte-identity on its own, because the underlying CONTENT SEQUENCE
 * itself differs between this PR's current render and the true pre-PR2 baseline (whose order is the OLD
 * Promotions → Profile → Attendance → Legacy → RegenerateCode → AddAdjustment). Proving "every field, every
 * row, every role-gated control is unchanged — only their position moved" therefore requires TWO paired
 * transforms, confirmed against this PR's own real rendered output (not guessed):
 *
 * 1. `normalizeApprovedPhase4DetailDiffs` strips the CURRENT render's added structural classes (the two-
 *    column-row wrapper, the two column wrappers, the three 1:1 sizing wrappers, and the `lg:min-w-0` clipping
 *    fix) — anchored, position-aware literal-string removal, run in an order that keeps each anchor unique
 *    even where two cards share an otherwise-identical class string (see inline comments).
 * 2. `reorderBaselineToPhase4DetailColumns` cuts the TRUE baseline's 5 reorderable sections (Profile,
 *    Attendance, Legacy, RegenerateCode, AddAdjustment — Promotions and the gated block are untouched, since
 *    they are first/last in both orders) by their own unique heading/content anchors, and re-concatenates them
 *    in THIS PR's approved new order.
 *
 * The two results are then compared with `.toBe()` for real byte equality — not a looser, "contains" style
 * check. See the guard tests below for proof this cannot pass vacuously.
 */
function normalizeApprovedPhase4DetailDiffs(html: string): string {
  const CARD_OPEN_BARE =
    '<div data-slot="card" data-size="default" class="group/card flex flex-col gap-(--card-spacing) overflow-hidden rounded-lg border border-border bg-card py-(--card-spacing) text-sm text-card-foreground [--card-spacing:--spacing(4)] has-data-[slot=card-footer]:pb-0 has-[&gt;img:first-child]:pt-0 data-[size=sm]:[--card-spacing:--spacing(3)] data-[size=sm]:has-data-[slot=card-footer]:pb-0 *:[img:first-child]:rounded-t-xl *:[img:last-child]:rounded-b-xl">';
  const CARD_SUFFIXED = CARD_OPEN_BARE.replace('">', ' lg:min-w-0"');
  const CARD_TAIL_SUFFIXED = ' *:[img:first-child]:rounded-t-xl *:[img:last-child]:rounded-b-xl lg:min-w-0"';
  const CARD_TAIL_BARE = ' *:[img:first-child]:rounded-t-xl *:[img:last-child]:rounded-b-xl"';

  return (
    html
      // 1. The two-column-row wrapper's opening tag (carries the 3fr/2fr grid — `<main>` itself is unchanged).
      .replace('<div class="flex flex-col gap-6 lg:grid lg:grid-cols-[3fr_2fr] lg:items-start lg:gap-6">', "")
      // 2. The LEFT column wrapper's opening tag (1st of 2 byte-identical occurrences — `.replace` without
      //    `g` always consumes the earliest remaining one, so calling it twice, in document order, correctly
      //    targets left then right).
      .replace('<div class="flex flex-col gap-6 lg:min-w-0">', "")
      // 3. Promotions' 1:1 sizing wrapper opening tag (1st of 3 byte-identical bare `lg:min-w-0` wrappers —
      //    same earliest-match discipline).
      .replace('<div class="lg:min-w-0">', "")
      // 4. Close of Promotions' sizing wrapper, anchored to Attendance Card's STILL-SUFFIXED opening tag —
      //    deliberately matched BEFORE stripping Attendance's own suffix (rule 5), because Promotions' own
      //    (always bare, no suffix) card would otherwise be an equally-valid, WRONG match for an unsuffixed
      //    anchor at this position.
      .replace("</div>" + CARD_SUFFIXED, CARD_SUFFIXED)
      // 5. Attendance Card's own `lg:min-w-0` suffix, now safe to strip.
      .replace(CARD_TAIL_SUFFIXED, CARD_TAIL_BARE)
      // 6. RegenerateCodeButton's 1:1 sizing wrapper opening tag (now the earliest remaining bare occurrence).
      .replace('<div class="lg:min-w-0">', "")
      // 7. Close of RegenerateCode's wrapper, adjacent to AddAdjustment's wrapper opening tag — both bare, no
      //    card involved, no ambiguity.
      .replace('</div><div class="lg:min-w-0">', '<div class="lg:min-w-0">')
      // 8. AddAdjustmentForm's 1:1 sizing wrapper opening tag (the remaining bare occurrence).
      .replace('<div class="lg:min-w-0">', "")
      // 9. Close of AddAdjustment's wrapper + close of the LEFT column wrapper + the RIGHT column wrapper's
      //    OWN opening tag, all anchored together against Profile Card's STILL-SUFFIXED opening tag (same
      //    before-stripping-its-suffix discipline as rule 4).
      .replace('</div></div><div class="flex flex-col gap-6 lg:min-w-0">' + CARD_SUFFIXED, CARD_SUFFIXED)
      // 10. Profile Card's own `lg:min-w-0` suffix.
      .replace(CARD_TAIL_SUFFIXED, CARD_TAIL_BARE)
      // 11. Legacy Payment History Card's own `lg:min-w-0` suffix (the next remaining occurrence).
      .replace(CARD_TAIL_SUFFIXED, CARD_TAIL_BARE)
      // 12. The Ledger section's fragment-to-<div> change (StudentBalanceSummary + PaymentHistorySection),
      //     plus the clipping-fix `lg:min-w-0 lg:[&>*]:min-w-0` — only reachable when `ledgerActive`, not
      //     exercised by this file's always-inactive fixture (confirmed by direct reading of page.tsx, not
      //     exercised here — a safe no-op either way).
      .replace('<div class="flex flex-col gap-6 lg:min-w-0 lg:[&amp;&gt;*]:min-w-0">', "")
      // 13. Close of the RIGHT column wrapper + close of the two-column-row wrapper, anchored to the gated
      //     action/form block's own opening tag.
      .replace('</div></div><div class="flex flex-col gap-4">', '<div class="flex flex-col gap-4">')
  );
}

/**
 * Cuts the TRUE pre-PR2 baseline's 5 reorderable sections (Profile, Attendance, Legacy Payment History,
 * RegenerateCode, AddAdjustment) by their own unique anchors, and re-concatenates them in this PR's approved
 * new order. Promotions (always first) and the gated action/form block (always last) are left untouched —
 * their position is unchanged in both the old and new order, so they need no cutting.
 */
function reorderBaselineToPhase4DetailColumns(html: string): string {
  const promotionsStart = html.indexOf('<div data-slot="card" data-size="default"');
  const profileStart = html.lastIndexOf('<div data-slot="card" data-size="default"', html.indexOf(">Profile</div>"));
  const attendanceStart = html.lastIndexOf(
    '<div data-slot="card" data-size="default"',
    html.indexOf(">Attendance history</div>"),
  );
  const legacyStart = html.lastIndexOf(
    '<div data-slot="card" data-size="default"',
    html.indexOf(">Payment history</div>"),
  );
  const regenerateStart = html.indexOf("<form", html.indexOf(">Payment history</div>"));
  const addAdjustmentStart = html.indexOf("<details", html.indexOf(">Regenerate code</button>"));
  const gatedBlockStart = html.indexOf('<div class="flex flex-col gap-4">');

  const header = html.slice(0, promotionsStart);
  const promotions = html.slice(promotionsStart, profileStart);
  const profile = html.slice(profileStart, attendanceStart);
  const attendance = html.slice(attendanceStart, legacyStart);
  const legacy = html.slice(legacyStart, regenerateStart);
  const regenerateCode = html.slice(regenerateStart, addAdjustmentStart);
  const addAdjustment = html.slice(addAdjustmentStart, gatedBlockStart);
  const gatedBlock = html.slice(gatedBlockStart);

  // Approved order: Header → Promotions → Attendance → RegenerateCode → AddAdjustment → Profile → Legacy →
  // (Ledger, absent in this always-inactive fixture) → gated block.
  return header + promotions + attendance + regenerateCode + addAdjustment + profile + legacy + gatedBlock;
}

describe("inactive-ledger render EQUIVALENCE against the pre-PR2 baseline (review fix)", () => {
  /**
   * Phase 4 roster correction note: this suite's roster case originally asserted BYTE-IDENTICAL output against
   * the pre-PR2 baseline — a true claim back when the ONLY thing separating `83fed6f` from `main` was PR2's
   * ledger-integration gating logic, which this file exists to prove made zero visual change. That premise no
   * longer holds: the Phase 4 roster correction (header/CreateStudentForm regrouping, BeltVisual sizing) is an
   * approved, intentional visual change to this same inactive-ledger render path.
   *
   * Review-fix: an earlier version of this correction replaced byte-identity with loose `.toContain("Paid")` /
   * `.toContain(studentId)` presence checks — those do not prove a student's name/row is actually paired with
   * the RIGHT payment status, or that no OTHER, unexpected markup changed elsewhere on the page; a student ID
   * appearing anywhere in the HTML (e.g. in an unrelated attribute) would satisfy them. Restored to real
   * equivalence instead: `normalizeApprovedPhase4Diffs` strips ONLY the two approved, anchored diffs (exact
   * literal strings, not a loose pattern — see its own doc comment), and the two renders are then asserted
   * BYTE-IDENTICAL via `.toBe()` — the same rigor the student-detail case below already has, restored here.
   * `__normalizeApprovedPhase4Diffs guard tests` below proves this normalization cannot be satisfied by a
   * corrupted/wrong render — it is not a test that vacuously passes.
   */
  it("REQUIRED: roster page — current inactive render is byte-identical to the real pre-PR2 implementation, after normalizing ONLY the two approved Phase 4 diffs", async () => {
    currentSession = { user: { id: a.admin.id }, activeOrganizationId: a.org.id };
    const baselineHtml = withProvider(await BaselineStudentsPage({ searchParams: Promise.resolve({}) }));
    const currentHtml = withProvider(await CurrentStudentsPage({ searchParams: Promise.resolve({}) }));
    currentSession = null;

    // Non-vacuous: the comparison actually carries real financial content, not an empty shell. The roster's
    // legacy pill shows the STATUS label, never a raw amount (that only appears in the detail page's history
    // table, checked below) — "Paid"/"Overdue" are this page's own real financial content.
    expect(baselineHtml).toContain("Paid");
    expect(baselineHtml).toContain("Overdue");

    // The two approved Phase 4 diffs are genuinely present in current and genuinely absent from the true
    // pre-PR2 baseline — proven BEFORE normalizing them away, so the equality assertion below isn't vacuous
    // (i.e. normalizing away something that was never there in the first place).
    expect(currentHtml).toContain("has-[details[open]]:flex-col");
    expect(baselineHtml).not.toContain("has-[details[open]]:flex-col");
    expect(currentHtml).toContain("w-[140px]");
    expect(baselineHtml).not.toContain("w-[140px]");

    // Everything else — every student row, every column, every payment status, the filter bar, academy scope,
    // progress bars, eligibility pills, role-gated controls — is asserted BYTE-IDENTICAL to the true pre-PR2
    // baseline, not merely "contains the same substrings somewhere."
    const normalizedBaseline = normalizeReactGeneratedIds(normalizeApprovedPhase4Diffs(baselineHtml));
    const normalizedCurrent = normalizeReactGeneratedIds(normalizeApprovedPhase4Diffs(currentHtml));
    expect(normalizedCurrent).toBe(normalizedBaseline);
  });

  /**
   * Phase 4 student-detail correction, round 5 (Option B, explicitly approved): the shared-row grid is
   * replaced by two independent column containers, and 5 of the page's 9 sections are genuinely REORDERED in
   * the DOM (see `reorderBaselineToPhase4DetailColumns`'s own doc comment for the full approved sequence).
   * The prior literal byte-identity assertion is now correctly false for a structural reason, not merely a
   * className diff — `normalizeApprovedPhase4DetailDiffs` strips CURRENT's added structural classes, and
   * `reorderBaselineToPhase4DetailColumns` cuts and re-sequences the TRUE baseline's reorderable sections into
   * that same approved order, confirmed against a real render (see each function's own doc comment) — not
   * guessed. Byte-for-byte equivalence is restored over everything else: every field, every history row,
   * every role-gated control, every condition — regardless of which approved position it now renders in.
   */
  it("REQUIRED: student-detail page — current inactive render is byte-identical (content-wise) to the real pre-PR2 implementation, after stripping the approved structural diffs and reordering the baseline into the approved column sequence", async () => {
    currentSession = { user: { id: a.admin.id }, activeOrganizationId: a.org.id };
    const baselineHtml = withProvider(await BaselineStudentDetailPage({ params: Promise.resolve({ locale: "en", id: paidStudent.id }) }));
    const currentHtml = withProvider(await CurrentStudentDetailPage({ params: Promise.resolve({ locale: "en", id: paidStudent.id }) }));
    currentSession = null;

    expect(baselineHtml).toContain("100.00");

    // The structural diff is genuinely present in current and genuinely absent from the true pre-PR2
    // baseline — proven before normalizing it away, so the equality assertion below isn't vacuous.
    expect(currentHtml).toContain("lg:grid lg:grid-cols-[3fr_2fr]");
    expect(baselineHtml).not.toContain("lg:grid lg:grid-cols-[3fr_2fr]");

    // DOM-order proof the reorder is real, not assumed: in baseline, "Profile" appears before "Attendance
    // history" (the old order); in current, "Attendance history" appears before "Profile" (the new, approved
    // order) — confirmed directly on the raw, unnormalized strings.
    expect(baselineHtml.indexOf(">Profile</div>")).toBeLessThan(baselineHtml.indexOf(">Attendance history</div>"));
    expect(currentHtml.indexOf(">Attendance history</div>")).toBeLessThan(currentHtml.indexOf(">Profile</div>"));

    const normalizedBaseline = normalizeReactGeneratedIds(reorderBaselineToPhase4DetailColumns(baselineHtml));
    const normalizedCurrent = normalizeReactGeneratedIds(normalizeApprovedPhase4DetailDiffs(currentHtml));
    expect(normalizedCurrent).toBe(normalizedBaseline);
  });
});

/**
 * Guard tests, synthetic fixtures only (no DB, no render — fast, deterministic): prove
 * `normalizeApprovedPhase4Diffs` cannot be satisfied by a wrong/corrupted render. Each fixture below is built
 * from the SAME literal patterns the real baseline/current renders use (confirmed against a real render before
 * writing this file), so these guard tests exercise the actual normalization logic, not a stand-in for it.
 */
describe("normalizeApprovedPhase4Diffs — guard tests (prove the baseline comparison cannot pass vacuously)", () => {
  const BASELINE_ROW = [
    "<header class=\"flex flex-col gap-1\"><h1>Students</h1></header>",
    '<div data-slot="card"><table><tbody>',
    '<tr><td><a href="/en/students/stu_1">Ana Pérez</a></td>',
    '<td><span aria-hidden="true"><svg viewBox="0 0 360 40" width="64" role="img" aria-label="" style="aspect-ratio:360 / 40;height:auto"></svg></span></td>',
    "<td>Paid</td></tr>",
    "</tbody></table></div>",
  ].join("");

  function currentRowWithApprovedDiffsOnly(): string {
    return [
      '<div class="flex flex-wrap items-start justify-between gap-3 has-[details[open]]:flex-col has-[details[open]]:items-stretch"><header class="flex flex-col gap-1"><h1>Students</h1></header></div>',
      '<div data-slot="card"><table><tbody>',
      '<tr><td><a href="/en/students/stu_1">Ana Pérez</a></td>',
      '<td><span aria-hidden="true" class="w-[140px] shrink-0"><svg viewBox="0 0 360 40" width="64" role="img" aria-label="" class="w-[140px]" style="aspect-ratio:360 / 40;height:auto"></svg></span></td>',
      "<td>Paid</td></tr>",
      "</tbody></table></div>",
    ].join("");
  }

  it("REQUIRED: the two approved diffs alone normalize to equal the baseline (the real, intended case)", () => {
    expect(normalizeApprovedPhase4Diffs(currentRowWithApprovedDiffsOnly())).toBe(BASELINE_ROW);
  });

  it("REQUIRED: a changed payment-status association still fails after normalization — not masked", () => {
    const corrupted = currentRowWithApprovedDiffsOnly().replace("<td>Paid</td>", "<td>Pending</td>");
    expect(normalizeApprovedPhase4Diffs(corrupted)).not.toBe(BASELINE_ROW);
  });

  it("REQUIRED: a missing row still fails after normalization — not masked", () => {
    const corrupted = currentRowWithApprovedDiffsOnly().replace(
      '<tr><td><a href="/en/students/stu_1">Ana Pérez</a></td><td><span aria-hidden="true" class="w-[140px] shrink-0"><svg viewBox="0 0 360 40" width="64" role="img" aria-label="" class="w-[140px]" style="aspect-ratio:360 / 40;height:auto"></svg></span></td><td>Paid</td></tr>',
      "",
    );
    expect(normalizeApprovedPhase4Diffs(corrupted)).not.toBe(BASELINE_ROW);
  });

  it("REQUIRED: an unrelated, unexpected markup addition elsewhere still fails after normalization — not masked", () => {
    const corrupted = currentRowWithApprovedDiffsOnly().replace("<h1>Students</h1>", "<h1>Students</h1><span>Beta</span>");
    expect(normalizeApprovedPhase4Diffs(corrupted)).not.toBe(BASELINE_ROW);
  });

  it("REQUIRED: a student name change still fails after normalization — not masked", () => {
    const corrupted = currentRowWithApprovedDiffsOnly().replace("Ana Pérez", "Beatriz López");
    expect(normalizeApprovedPhase4Diffs(corrupted)).not.toBe(BASELINE_ROW);
  });
});

/**
 * Guard tests for the student-detail grid normalization, same discipline as the roster guard tests above:
 * synthetic fixtures built from the SAME literal patterns the real baseline/current detail-page renders use
 * (confirmed against a real render before writing this file — the production test above passed against the
 * actual rendered HTML, not just these synthetic fixtures).
 */
describe("normalizeApprovedPhase4DetailDiffs + reorderBaselineToPhase4DetailColumns — guard tests (prove the detail baseline comparison cannot pass vacuously)", () => {
  const CARD_CLASS =
    'class="group/card flex flex-col gap-(--card-spacing) overflow-hidden rounded-lg border border-border bg-card py-(--card-spacing) text-sm text-card-foreground [--card-spacing:--spacing(4)] has-data-[slot=card-footer]:pb-0 has-[&gt;img:first-child]:pt-0 data-[size=sm]:[--card-spacing:--spacing(3)] data-[size=sm]:has-data-[slot=card-footer]:pb-0 *:[img:first-child]:rounded-t-xl *:[img:last-child]:rounded-b-xl"';
  const cardClassWith = (suffix: string) => `${CARD_CLASS.slice(0, -1)} ${suffix}"`;
  const card = (title: string, body: string, cls: string = CARD_CLASS) =>
    `<div data-slot="card" data-size="default" ${cls}><div data-slot="card-title">${title}</div>${body}</div>`;

  // OLD order (the true pre-PR2 baseline, before any Phase 4 work): Header → Promotions → Profile →
  // Attendance → Legacy → RegenerateCode → AddAdjustment → gated block. No extra wrapper divs anywhere.
  function baselineDetail(): string {
    return [
      '<main class="flex flex-col gap-6 p-6">',
      '<div class="flex flex-wrap items-center justify-between gap-3"><h1>Ana Pérez</h1></div>',
      card("Promotions", "<div>Promociones content</div>"),
      card("Profile", "<dd>8888 1111</dd>"),
      card("Attendance history", "<div>Attendance content</div>"),
      card("Payment history", "<td>Paid</td>"),
      '<form class="flex flex-col items-start gap-2"><button>Regenerate code</button></form>',
      "<details><summary>Add an attendance day</summary></details>",
      '<div class="flex flex-col gap-4"><button>Edit</button></div>',
      "</main>",
    ].join("");
  }

  // NEW order (round 5, approved Option B): Header → [left: Promotions → Attendance → RegenerateCode →
  // AddAdjustment] → [right: Profile → Legacy] → gated block, each column its own independent container.
  function currentDetailWithApprovedDiffsOnly(): string {
    return [
      '<main class="flex flex-col gap-6 p-6">',
      '<div class="flex flex-wrap items-center justify-between gap-3"><h1>Ana Pérez</h1></div>',
      '<div class="flex flex-col gap-6 lg:grid lg:grid-cols-[3fr_2fr] lg:items-start lg:gap-6">',
      '<div class="flex flex-col gap-6 lg:min-w-0">',
      '<div class="lg:min-w-0">' + card("Promotions", "<div>Promociones content</div>") + "</div>",
      card("Attendance history", "<div>Attendance content</div>", cardClassWith("lg:min-w-0")),
      '<div class="lg:min-w-0"><form class="flex flex-col items-start gap-2"><button>Regenerate code</button></form></div>',
      '<div class="lg:min-w-0"><details><summary>Add an attendance day</summary></details></div>',
      "</div>",
      '<div class="flex flex-col gap-6 lg:min-w-0">',
      card("Profile", "<dd>8888 1111</dd>", cardClassWith("lg:min-w-0")),
      card("Payment history", "<td>Paid</td>", cardClassWith("lg:min-w-0")),
      "</div>",
      "</div>",
      '<div class="flex flex-col gap-4"><button>Edit</button></div>',
      "</main>",
    ].join("");
  }

  it("REQUIRED: the approved structural diffs alone, after stripping current and reordering baseline, normalize to equal each other (the real, intended case)", () => {
    expect(normalizeApprovedPhase4DetailDiffs(currentDetailWithApprovedDiffsOnly())).toBe(
      reorderBaselineToPhase4DetailColumns(baselineDetail()),
    );
  });

  it("REQUIRED: a changed field value still fails after normalization — not masked", () => {
    const corrupted = currentDetailWithApprovedDiffsOnly().replace("<dd>8888 1111</dd>", "<dd>9999 2222</dd>");
    expect(normalizeApprovedPhase4DetailDiffs(corrupted)).not.toBe(reorderBaselineToPhase4DetailColumns(baselineDetail()));
  });

  it("REQUIRED: a missing section still fails after normalization — not masked", () => {
    const corrupted = currentDetailWithApprovedDiffsOnly().replace(
      '<div class="lg:min-w-0"><details><summary>Add an attendance day</summary></details></div>',
      "",
    );
    expect(normalizeApprovedPhase4DetailDiffs(corrupted)).not.toBe(reorderBaselineToPhase4DetailColumns(baselineDetail()));
  });

  it("REQUIRED: an unrelated, unexpected markup addition still fails after normalization — not masked", () => {
    const corrupted = currentDetailWithApprovedDiffsOnly().replace(
      "<button>Regenerate code</button>",
      "<button>Regenerate code</button><span>Beta</span>",
    );
    expect(normalizeApprovedPhase4DetailDiffs(corrupted)).not.toBe(reorderBaselineToPhase4DetailColumns(baselineDetail()));
  });

  it("REQUIRED: a student name change still fails after normalization — not masked", () => {
    const corrupted = currentDetailWithApprovedDiffsOnly().replace("Ana Pérez", "Beatriz López");
    expect(normalizeApprovedPhase4DetailDiffs(corrupted)).not.toBe(reorderBaselineToPhase4DetailColumns(baselineDetail()));
  });

  it("REQUIRED: a legacy-history field value altered only in the baseline source still fails — proves reorderBaselineToPhase4DetailColumns carries baseline's real content through, not a hardcoded copy", () => {
    const alteredBaseline = baselineDetail().replace("<td>Paid</td>", "<td>Overdue</td>");
    expect(normalizeApprovedPhase4DetailDiffs(currentDetailWithApprovedDiffsOnly())).not.toBe(
      reorderBaselineToPhase4DetailColumns(alteredBaseline),
    );
  });
});
