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
function normalizeApprovedPhase4DetailDiffs(html: string): string {
  return html
    // 1. <main>'s own grid utilities — appended after its existing base classes. (<main> itself never gained
    //    `min-w-0` — only its children did, rules 2-8 below.)
    .replace(
      '<main class="flex flex-col gap-6 p-6 lg:grid lg:grid-cols-[3fr_2fr] lg:items-start lg:gap-6"',
      '<main class="flex flex-col gap-6 p-6"',
    )
    // 2. The header row's grid placement, plus the clipping-fix `lg:min-w-0` (correction round 4) —
    //    appended after its existing base classes.
    .replace(
      '<div class="flex flex-wrap items-center justify-between gap-3 lg:col-span-2 lg:row-start-1 lg:min-w-0"',
      '<div class="flex flex-wrap items-center justify-between gap-3"',
    )
    // 3. PromocionesCard's 1:1 positioning wrapper (the component itself takes no className). Its opening
    //    tag is a unique literal; its closing tag is anchored by the one thing that always immediately
    //    follows it — the Profile <Card>'s own opening tag (also grid-placed, stripped by rule 4 below, but
    //    matched here in its PRE-strip form since replacements run top to bottom against the unmodified
    //    string at this point).
    .replace('<div class="lg:col-start-1 lg:row-start-2 lg:min-w-0">', "")
    .replace(
      '</div><div data-slot="card" data-size="default" class="group/card flex flex-col gap-(--card-spacing) overflow-hidden rounded-lg border border-border bg-card py-(--card-spacing) text-sm text-card-foreground [--card-spacing:--spacing(4)] has-data-[slot=card-footer]:pb-0 has-[&gt;img:first-child]:pt-0 data-[size=sm]:[--card-spacing:--spacing(3)] data-[size=sm]:has-data-[slot=card-footer]:pb-0 *:[img:first-child]:rounded-t-xl *:[img:last-child]:rounded-b-xl lg:col-start-2 lg:row-start-2 lg:min-w-0">',
      '<div data-slot="card" data-size="default" class="group/card flex flex-col gap-(--card-spacing) overflow-hidden rounded-lg border border-border bg-card py-(--card-spacing) text-sm text-card-foreground [--card-spacing:--spacing(4)] has-data-[slot=card-footer]:pb-0 has-[&gt;img:first-child]:pt-0 data-[size=sm]:[--card-spacing:--spacing(3)] data-[size=sm]:has-data-[slot=card-footer]:pb-0 *:[img:first-child]:rounded-t-xl *:[img:last-child]:rounded-b-xl">',
    )
    // 4. Profile and Attendance/Legacy-Payment-History <Card>s — grid placement + `lg:min-w-0` appended
    //    after their shared base class string, one variant per grid cell.
    .replaceAll(
      ' *:[img:first-child]:rounded-t-xl *:[img:last-child]:rounded-b-xl lg:col-start-2 lg:row-start-2 lg:min-w-0"',
      ' *:[img:first-child]:rounded-t-xl *:[img:last-child]:rounded-b-xl"',
    )
    .replaceAll(
      ' *:[img:first-child]:rounded-t-xl *:[img:last-child]:rounded-b-xl lg:col-start-1 lg:row-start-3 lg:min-w-0"',
      ' *:[img:first-child]:rounded-t-xl *:[img:last-child]:rounded-b-xl"',
    )
    .replaceAll(
      ' *:[img:first-child]:rounded-t-xl *:[img:last-child]:rounded-b-xl lg:col-start-2 lg:row-start-3 lg:min-w-0"',
      ' *:[img:first-child]:rounded-t-xl *:[img:last-child]:rounded-b-xl"',
    )
    // 5. The Ledger section's fragment-to-<div> change (StudentBalanceSummary + PaymentHistorySection), plus
    //    the clipping-fix `lg:min-w-0 lg:[&>*]:min-w-0` (correction round 4) — only reachable when
    //    `ledgerActive`, not exercised by this file's always-inactive fixture (confirmed: the real production
    //    default), so this rule is defined by direct reading of the unmodified source (page.tsx's own JSX),
    //    not confirmed against this file's own render. Included for completeness and correctness, not
    //    vacuously — a safe no-op against both renders here either way.
    .replace('<div class="flex flex-col gap-6 lg:col-start-2 lg:row-start-4 lg:min-w-0 lg:[&amp;&gt;*]:min-w-0">', "")
    // 6. RegenerateCodeButton's 1:1 positioning wrapper — opening tag unique; closing tag anchored by the
    //    AddAdjustmentForm wrapper's own opening tag, which always immediately follows it.
    .replace('<div class="lg:col-start-1 lg:row-start-4 lg:min-w-0">', "")
    .replace(
      '</div><div class="lg:col-start-1 lg:row-start-5 lg:min-w-0">',
      '<div class="lg:col-start-1 lg:row-start-5 lg:min-w-0">',
    )
    // 7. AddAdjustmentForm's 1:1 positioning wrapper — opening tag unique; closing tag anchored by the gated
    //    action/form block's own opening tag, which always immediately follows it when `canEdit`.
    .replace('<div class="lg:col-start-1 lg:row-start-5 lg:min-w-0">', "")
    .replace(
      '</div><div class="flex flex-col gap-4 lg:col-span-2 lg:row-start-6 lg:min-w-0">',
      '<div class="flex flex-col gap-4 lg:col-span-2 lg:row-start-6 lg:min-w-0">',
    )
    // 8. The gated action/form block's own grid placement + `lg:min-w-0` — appended after its existing base
    //    classes.
    .replace(
      '<div class="flex flex-col gap-4 lg:col-span-2 lg:row-start-6 lg:min-w-0">',
      '<div class="flex flex-col gap-4">',
    );
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
   * Phase 4 student-detail correction: the grid-placement classes/wrapper divs (§2/§5 of
   * `design/matroom/verification/phase4-student-detail-proposal/README.md`) are an approved, intentional
   * visual change to this same inactive-ledger render path — the prior literal byte-identity assertion is
   * now correctly false for the same legitimate reason the roster case above already documents.
   * `normalizeApprovedPhase4DetailDiffs` strips ONLY the grid-placement diffs (exact anchored literal
   * strings, confirmed against a real render — see its own doc comment), restoring real byte-for-byte
   * equivalence over everything else: every field, every history row, every role-gated control, every
   * condition.
   */
  it("REQUIRED: student-detail page — current inactive render is byte-identical to the real pre-PR2 implementation, after normalizing ONLY the approved Phase 4 grid-placement diffs", async () => {
    currentSession = { user: { id: a.admin.id }, activeOrganizationId: a.org.id };
    const baselineHtml = withProvider(await BaselineStudentDetailPage({ params: Promise.resolve({ locale: "en", id: paidStudent.id }) }));
    const currentHtml = withProvider(await CurrentStudentDetailPage({ params: Promise.resolve({ locale: "en", id: paidStudent.id }) }));
    currentSession = null;

    expect(baselineHtml).toContain("100.00");

    // The grid-placement diff is genuinely present in current and genuinely absent from the true pre-PR2
    // baseline — proven before normalizing it away, so the equality assertion below isn't vacuous.
    expect(currentHtml).toContain("lg:grid lg:grid-cols-[3fr_2fr]");
    expect(baselineHtml).not.toContain("lg:grid lg:grid-cols-[3fr_2fr]");

    const normalizedBaseline = normalizeReactGeneratedIds(normalizeApprovedPhase4DetailDiffs(baselineHtml));
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
describe("normalizeApprovedPhase4DetailDiffs — guard tests (prove the detail baseline comparison cannot pass vacuously)", () => {
  const CARD_CLASS =
    'class="group/card flex flex-col gap-(--card-spacing) overflow-hidden rounded-lg border border-border bg-card py-(--card-spacing) text-sm text-card-foreground [--card-spacing:--spacing(4)] has-data-[slot=card-footer]:pb-0 has-[&gt;img:first-child]:pt-0 data-[size=sm]:[--card-spacing:--spacing(3)] data-[size=sm]:has-data-[slot=card-footer]:pb-0 *:[img:first-child]:rounded-t-xl *:[img:last-child]:rounded-b-xl"';

  const BASELINE_DETAIL = [
    '<main class="flex flex-col gap-6 p-6">',
    '<div class="flex flex-wrap items-center justify-between gap-3"><h1>Ana Pérez</h1></div>',
    '<div data-slot="card"><div>Promociones content</div></div>',
    `<div data-slot="card" data-size="default" ${CARD_CLASS}><dd>8888 1111</dd></div>`,
    `<div data-slot="card" data-size="default" ${CARD_CLASS}><div>Attendance content</div></div>`,
    `<div data-slot="card" data-size="default" ${CARD_CLASS}><td>Paid</td></div>`,
    "<button>Regenerate</button>",
    "<details><summary>Add adjustment</summary></details>",
    '<div class="flex flex-col gap-4"><button>Edit</button></div>',
    "</main>",
  ].join("");

  function currentDetailWithApprovedDiffsOnly(): string {
    const cardClassWith = (suffix: string) => `${CARD_CLASS.slice(0, -1)} ${suffix}"`;
    return [
      '<main class="flex flex-col gap-6 p-6 lg:grid lg:grid-cols-[3fr_2fr] lg:items-start lg:gap-6">',
      '<div class="flex flex-wrap items-center justify-between gap-3 lg:col-span-2 lg:row-start-1 lg:min-w-0"><h1>Ana Pérez</h1></div>',
      '<div class="lg:col-start-1 lg:row-start-2 lg:min-w-0"><div data-slot="card"><div>Promociones content</div></div></div>',
      `<div data-slot="card" data-size="default" ${cardClassWith("lg:col-start-2 lg:row-start-2 lg:min-w-0")}><dd>8888 1111</dd></div>`,
      `<div data-slot="card" data-size="default" ${cardClassWith("lg:col-start-1 lg:row-start-3 lg:min-w-0")}><div>Attendance content</div></div>`,
      `<div data-slot="card" data-size="default" ${cardClassWith("lg:col-start-2 lg:row-start-3 lg:min-w-0")}><td>Paid</td></div>`,
      '<div class="lg:col-start-1 lg:row-start-4 lg:min-w-0"><button>Regenerate</button></div>',
      '<div class="lg:col-start-1 lg:row-start-5 lg:min-w-0"><details><summary>Add adjustment</summary></details></div>',
      '<div class="flex flex-col gap-4 lg:col-span-2 lg:row-start-6 lg:min-w-0"><button>Edit</button></div>',
      "</main>",
    ].join("");
  }

  it("REQUIRED: the approved grid-placement diffs alone normalize to equal the baseline (the real, intended case)", () => {
    expect(normalizeApprovedPhase4DetailDiffs(currentDetailWithApprovedDiffsOnly())).toBe(BASELINE_DETAIL);
  });

  it("REQUIRED: a changed field value still fails after normalization — not masked", () => {
    const corrupted = currentDetailWithApprovedDiffsOnly().replace("<dd>8888 1111</dd>", "<dd>9999 2222</dd>");
    expect(normalizeApprovedPhase4DetailDiffs(corrupted)).not.toBe(BASELINE_DETAIL);
  });

  it("REQUIRED: a missing section still fails after normalization — not masked", () => {
    const corrupted = currentDetailWithApprovedDiffsOnly().replace(
      '<div class="lg:col-start-1 lg:row-start-5 lg:min-w-0"><details><summary>Add adjustment</summary></details></div>',
      "",
    );
    expect(normalizeApprovedPhase4DetailDiffs(corrupted)).not.toBe(BASELINE_DETAIL);
  });

  it("REQUIRED: an unrelated, unexpected markup addition still fails after normalization — not masked", () => {
    const corrupted = currentDetailWithApprovedDiffsOnly().replace(
      "<button>Regenerate</button>",
      "<button>Regenerate</button><span>Beta</span>",
    );
    expect(normalizeApprovedPhase4DetailDiffs(corrupted)).not.toBe(BASELINE_DETAIL);
  });

  it("REQUIRED: a student name change still fails after normalization — not masked", () => {
    const corrupted = currentDetailWithApprovedDiffsOnly().replace("Ana Pérez", "Beatriz López");
    expect(normalizeApprovedPhase4DetailDiffs(corrupted)).not.toBe(BASELINE_DETAIL);
  });
});
