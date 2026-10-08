import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
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
    execFileSync("git", ["fetch", "--depth=1", "origin", ref], { stdio: "ignore" });
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

  async function newStudent(label: string) {
    return prisma.student.create({
      data: {
        organizationId: a.org.id, homeAcademyId: a.academy.id, firstName: "DashBaseline", lastName: `${label}-${suffix}`, phone: "00000000",
        email: `dash-baseline-${label}-${suffix}@example.com`, currentRankId: await a.rankId("WHITE"), codeHash: `dash-baseline-${label}-${suffix}`, status: "ACTIVE",
      },
    });
  }
  const paidStudent = await newStudent("paid");
  // Real financial content: a PAID current-month row (so the legacy "Atrasado" tile and the contact list both
  // have something real to differ on, not an empty shell).
  await prisma.paymentPeriod.create({
    data: { studentId: paidStudent.id, academyId: a.academy.id, organizationId: a.org.id, year: 2030, month: 6, planId: plan.id, status: "PAID", amount: "100.00", currency: "USD", recordedById: a.admin.id },
  });

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

describe("dashboard/page.tsx: inactive-ledger render EQUIVALENCE against the pre-PR3 baseline", () => {
  it("REQUIRED: current inactive render is byte-identical to the real pre-PR3 implementation", async () => {
    currentSession = { user: { id: a.admin.id }, activeOrganizationId: a.org.id };
    const baselineHtml = withProvider(await BaselineDashboardPage());
    const currentHtml = withProvider(await CurrentDashboardPage());
    currentSession = null;

    // Non-vacuous: real financial content, not an empty shell.
    expect(baselineHtml).toContain("Overdue");
    expect(baselineHtml).toContain("Paid");
    expect(normalizeReactGeneratedIds(currentHtml)).toBe(normalizeReactGeneratedIds(baselineHtml));
  });
});
