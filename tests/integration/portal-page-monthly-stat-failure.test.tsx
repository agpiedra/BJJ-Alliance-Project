import "dotenv/config";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { createTranslator, NextIntlClientProvider } from "next-intl";
import { getTestPrismaClient } from "../helpers/test-db";
import { makeAccountingOrg } from "../helpers/accounting-org";
import { hashSecret } from "../../src/lib/crypto";
import enMessages from "../../messages/en.json";

/**
 * Phase 2.6 PR 2 correction round, item 3: page.tsx wraps its new `getAttendanceMonthTotals` read in a
 * try/catch specifically so one failing read degrades to an explicit "Couldn't load this month's totals."
 * state (never a false "0", never an uncaught exception that takes the whole page down) and leaves the REST of
 * the portal — payments, schedule, the attendance history list itself — rendering normally. This test proves
 * that through a REAL render of the actual page.tsx, not a reading of its try/catch.
 *
 * Reuses `portal-page-ledger-render.test.tsx`'s own render harness (same mocks, same `makeAccountingOrg`
 * fixture shape, same `renderPortal()` pattern) rather than inventing a new one.
 */
const prisma = getTestPrismaClient();

type MockSession = { user: { id: string }; activeOrganizationId: string | null } | null;
let currentSession: MockSession = null;
vi.mock("@/auth", () => ({ auth: () => Promise.resolve(currentSession) }));
vi.mock("next-intl/server", () => ({
  getLocale: () => Promise.resolve("en"),
  getTranslations: async (namespace: string) => createTranslator({ locale: "en", messages: enMessages, namespace } as never),
}));
vi.mock("../../src/app/[locale]/portal/portal-top-bar", () => ({ PortalTopBar: () => null }));
vi.mock("../../src/app/[locale]/portal/todays-classes-card", () => ({ TodaysClassesCard: () => null }));

// The one function under test is forced to reject on demand; every other export of this module (including
// `getAttendanceHistoryPage`, which the attendance history LIST below depends on) passes through to the real
// implementation unchanged.
let monthlyStatsShouldFail = false;
vi.mock("@/lib/students/attendance-history", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/students/attendance-history")>();
  return {
    ...actual,
    getAttendanceMonthTotals: (...args: Parameters<typeof actual.getAttendanceMonthTotals>) => {
      if (monthlyStatsShouldFail) return Promise.reject(new Error("simulated monthly-stat read failure"));
      return actual.getAttendanceMonthTotals(...args);
    },
  };
});

const { default: StudentPortalPage } = await import("../../src/app/[locale]/portal/page");

const FROZEN_NOW = new Date("2030-06-15T12:00:00-06:00");
const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
type Fixture = Awaited<ReturnType<typeof makeAccountingOrg>>;
let a: Fixture;
let studentUser: { id: string };
let student: { id: string };

beforeAll(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(FROZEN_NOW);

  a = await makeAccountingOrg("CUMULATIVE", "portalstatfail-a");
  studentUser = await prisma.user.create({ data: { email: `portalstatfail-student-${suffix}@example.com`, passwordHash: await hashSecret("irrelevant-password-123"), role: "STUDENT" } });
  await prisma.organizationMembership.create({ data: { userId: studentUser.id, organizationId: a.org.id, role: "STUDENT" } });
  student = await prisma.student.create({
    data: {
      organizationId: a.org.id, homeAcademyId: a.academy.id, userId: studentUser.id, firstName: "PortalStatFail", lastName: `S-${suffix}`, phone: "00000000",
      email: `portalstatfail-linked-${suffix}@example.com`, currentRankId: await a.rankId("WHITE"), codeHash: `portalstatfail-linked-${suffix}`, status: "ACTIVE",
    },
  });

  // One real, non-vacuous CHECKIN this frozen "now" month — without this, `totals.entryCount === 0` and
  // AttendanceHistorySection renders its EmptyState instead of the month-stats row at all, which would make
  // this test unable to tell "the unavailable text renders" from "nothing rendered because there's no data".
  await prisma.attendanceRecord.create({
    data: {
      studentId: student.id, academyId: a.academy.id, organizationId: a.org.id,
      occurredAt: FROZEN_NOW, date: new Date(Date.UTC(2030, 5, 15)),
      type: "CHECKIN", delta: 1, source: "PORTAL", matchSource: "AUTO",
    },
  });

  // A real legacy payment fact, so "the rest of the portal still renders" has something concrete to assert
  // beyond static copy — mirrors the baseline-comparison test's own inactive-ledger fixture shape.
  const plan = await prisma.paymentPlan.create({ data: { organizationId: a.org.id, academyId: a.academy.id, name: `PortalStatFail plan ${suffix}` } });
  await prisma.paymentPeriod.create({
    data: { studentId: student.id, academyId: a.academy.id, organizationId: a.org.id, year: 2030, month: 6, planId: plan.id, status: "PAID", amount: "100.00", currency: "USD", recordedById: a.admin.id },
  });
}, 60_000);

afterEach(() => {
  monthlyStatsShouldFail = false;
});

afterAll(async () => {
  vi.useRealTimers();
  currentSession = null;
  if (!a) return;
  if (student) await prisma.attendanceRecord.deleteMany({ where: { studentId: student.id, organizationId: a.org.id } });
  await prisma.paymentPeriod.deleteMany({ where: { organizationId: a.org.id } });
  await prisma.paymentPlan.deleteMany({ where: { organizationId: a.org.id } });
  if (student) await prisma.student.deleteMany({ where: { id: student.id } });
  if (studentUser) {
    await prisma.organizationMembership.deleteMany({ where: { userId: studentUser.id } });
    await prisma.user.deleteMany({ where: { id: studentUser.id } });
  }
  await a.drop();
}, 120_000);

async function renderPortal() {
  currentSession = { user: { id: studentUser.id }, activeOrganizationId: a.org.id };
  const page = await StudentPortalPage({ params: Promise.resolve({ locale: "en" }) });
  const html = renderToStaticMarkup(createElement(NextIntlClientProvider, { locale: "en", messages: enMessages } as never, page));
  currentSession = null;
  return html;
}

describe("portal/page.tsx: the monthly attendance-stat read's failure is isolated", () => {
  it("REQUIRED: when the read succeeds, the real counts render (control case, proving the forced-failure case below is a genuine difference)", async () => {
    monthlyStatsShouldFail = false;
    const html = await renderPortal();
    expect(html).toContain("1 attendance this month");
    expect(html).not.toContain("Couldn&#x27;t load this month&#x27;s totals.");
  });

  it("REQUIRED: when the read rejects, the panel shows the explicit unavailable state - never a false 0, never an uncaught exception", async () => {
    monthlyStatsShouldFail = true;
    const html = await renderPortal();
    // Appears for both the this-month and last-month stats, since page.tsx's try/catch covers both reads in
    // the same Promise.all and fails them together. (React's SSR output HTML-escapes the apostrophes.)
    const occurrences = html.split("Couldn&#x27;t load this month&#x27;s totals.").length - 1;
    expect(occurrences).toBe(2);
    // Never a silently-wrong zero count standing in for the failure.
    expect(html).not.toContain("0 attendances this month");
    expect(html).not.toContain("1 attendance this month");
  });

  it("REQUIRED: the rest of the portal - payments, schedule, and the attendance history LIST itself - still renders correctly despite the one failed read", async () => {
    monthlyStatsShouldFail = true;
    const html = await renderPortal();
    // Payments: the real legacy fact from the fixture above.
    expect(html).toContain("Payment status");
    expect(html).toContain("Paid");
    expect(html).toContain(`PortalStatFail plan ${suffix}`);
    // Schedule: the panel's own static heading still renders (its own data/query path is untouched by this read).
    expect(html).toContain("This week&#x27;s schedule");
    // Attendance history: the real CHECKIN row from the fixture is still listed - `getAttendanceHistoryPage`
    // is a DIFFERENT function on the same mocked module, left to its real implementation, so this proves the
    // mock's passthrough genuinely works and the one targeted failure doesn't drag the whole module down.
    expect(html).toContain("Attendance history");
    expect(html).toContain("Attendance (no class matched)"); // the real fixture row's own kind label (no classSessionId)
  });
});
