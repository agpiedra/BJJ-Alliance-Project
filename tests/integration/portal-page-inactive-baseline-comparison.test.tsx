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
 */
const prisma = getTestPrismaClient();
const BASELINE_REF = "87c706b33c6633ada6a003aa3d7ed105312cafd0";
const PORTAL_DIR = "src/app/[locale]/portal";
const BASELINE_FILE = `${PORTAL_DIR}/__portal_baseline_87c706b_page.tsx`;

function ensureCommitFetched(ref: string) {
  try {
    execFileSync("git", ["cat-file", "-e", `${ref}^{commit}`], { stdio: "ignore" });
  } catch {
    execFileSync("git", ["fetch", "--depth=1", "origin", ref], { stdio: "ignore" });
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

describe("portal/page.tsx: inactive-ledger render EQUIVALENCE against the pre-PR baseline (87c706b)", () => {
  it("REQUIRED: current inactive render is byte-identical to the real pre-integration implementation", async () => {
    currentSession = { user: { id: studentUser.id }, activeOrganizationId: a.org.id };
    const baselineHtml = withProvider(await BaselinePortalPage({ params: Promise.resolve({ locale: "en" }) }));
    const currentHtml = withProvider(await CurrentPortalPage({ params: Promise.resolve({ locale: "en" }) }));
    currentSession = null;

    // Non-vacuous: real financial content is actually present in both renders.
    expect(baselineHtml).toContain("Payment status");
    expect(baselineHtml).toContain("Paid");
    expect(normalizeReactGeneratedIds(currentHtml)).toBe(normalizeReactGeneratedIds(baselineHtml));
  });
});
