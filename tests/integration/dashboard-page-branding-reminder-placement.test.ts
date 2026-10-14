import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { createTranslator, NextIntlClientProvider } from "next-intl";
import { getTestPrismaClient } from "../helpers/test-db";
import { makeAccountingOrg } from "../helpers/accounting-org";
import { hashSecret } from "../../src/lib/crypto";
import { revalidateBranding } from "../../src/lib/branding/get-branding";
import enMessages from "../../messages/en.json";

/**
 * Targeted coverage for what both other dashboard render tests mock away
 * (`BrandingReminderCard: () => null`, in dashboard-page-ledger-render.test.ts and
 * dashboard-page-inactive-baseline-comparison.test.ts): the real component's gate (ADMIN/DIRECTOR, no
 * logo, not dismissed) and its MATROOM v4 position (after every data section, before the ADMIN-only
 * "Administration" card). Confirmed via grep before writing this file: neither is established anywhere
 * else. `dismissBrandingReminder`'s own authorization/write behavior is already covered by
 * tests/integration/staff-utility-actions.test.ts — this file does not re-test that action, only the
 * page's rendering decision (whether/where `<BrandingReminderCard>` appears).
 */
const prisma = getTestPrismaClient();

type MockSession = { user: { id: string }; activeOrganizationId: string | null } | null;
let currentSession: MockSession = null;
vi.mock("@/auth", () => ({ auth: () => Promise.resolve(currentSession) }));
vi.mock("next-intl/server", () => ({
  getLocale: () => Promise.resolve("en"),
  getTranslations: async (namespace: string) => createTranslator({ locale: "en", messages: enMessages, namespace } as never),
}));
// Only the heavy/chart components are mocked — BrandingReminderCard stays REAL, the one thing this
// file exists specifically to cover.
vi.mock("../../src/app/[locale]/(staff)/dashboard/weekly-attendance-chart", () => ({ WeeklyAttendanceChart: () => null }));
vi.mock("../../src/app/[locale]/(staff)/dashboard/attendance-by-class-chart", () => ({ AttendanceByClassChart: () => null }));
vi.mock("../../src/app/[locale]/(staff)/dashboard/confirm-promotion-button", () => ({ ConfirmPromotionButton: () => null }));

const { default: DashboardPage } = await import("../../src/app/[locale]/(staff)/dashboard/page");

type Fixture = Awaited<ReturnType<typeof makeAccountingOrg>>;
const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
let org: Fixture;
let instructor: { id: string };

beforeAll(async () => {
  org = await makeAccountingOrg("CUMULATIVE", "dash-reminder");

  const instructorUser = await prisma.user.create({
    data: { email: `dash-reminder-instructor-${suffix}@example.com`, passwordHash: await hashSecret("irrelevant-password-123"), role: "INSTRUCTOR" },
  });
  await prisma.organizationMembership.create({ data: { userId: instructorUser.id, organizationId: org.org.id, role: "INSTRUCTOR" } });
  await prisma.staffAssignment.create({ data: { userId: instructorUser.id, organizationId: org.org.id, academyId: org.academy.id, role: "INSTRUCTOR" } });
  instructor = instructorUser;
}, 30_000);

afterAll(async () => {
  currentSession = null;
  if (instructor) {
    await prisma.staffAssignment.deleteMany({ where: { userId: instructor.id } });
    await prisma.organizationMembership.deleteMany({ where: { userId: instructor.id } });
    await prisma.user.deleteMany({ where: { id: instructor.id } });
  }
  if (org) await org.drop();
}, 60_000);

async function renderAs(userId: string, organizationId: string): Promise<string> {
  currentSession = { user: { id: userId }, activeOrganizationId: organizationId };
  const page = await DashboardPage();
  // BrandingReminderCard is REAL here (unlike the other two dashboard test files, which mock it away) and
  // calls the client `useTranslations`, which needs a `timeZone` on the provider — the project's own
  // standard zone (format-date.ts, attendance-rows.ts, etc.), not a new value invented for this test.
  const html = renderToStaticMarkup(
    createElement(NextIntlClientProvider, { locale: "en", messages: enMessages, timeZone: "America/Costa_Rica" } as never, page),
  );
  currentSession = null;
  return html;
}

// React escapes the apostrophe in "academy's" as `&#x27;` in rendered markup — this substring stops
// just before it, so the check doesn't depend on reproducing React's own escaping exactly.
const REMINDER_TITLE = "Finish setting up your academy";

describe("dashboard: branding reminder — real component, gate, and MATROOM v4 position", () => {
  it("REQUIRED: ADMIN, no logo, not dismissed — the real reminder renders, positioned after every data section and before Administration", async () => {
    const html = await renderAs(org.admin.id, org.org.id);
    expect(html).toContain(REMINDER_TITLE);

    // Position, not just presence: Weekly attendance (first data section) < Students to contact (last data
    // section) < the reminder < Administration (the ADMIN-only shortcuts card at the very end).
    const weeklyIdx = html.indexOf(">Weekly attendance<");
    const contactIdx = html.indexOf("Students to contact");
    const reminderIdx = html.indexOf(REMINDER_TITLE);
    const adminIdx = html.indexOf(">Administration<");
    expect(weeklyIdx).toBeGreaterThan(-1);
    expect(contactIdx).toBeGreaterThan(weeklyIdx);
    expect(reminderIdx).toBeGreaterThan(contactIdx);
    expect(adminIdx).toBeGreaterThan(reminderIdx);
  });

  it("REQUIRED: a logo on the organization hides the reminder — gate unchanged by the v4 move", async () => {
    // get-branding.ts's own hand-rolled in-process cache (its own doc comment, 60-minute TTL) only
    // invalidates when a real save action calls revalidateBranding() — a direct Prisma write (as this
    // fixture does) bypasses that, so the test must invalidate it itself, the same way the real
    // settings-save action does after writing.
    await prisma.organizationBranding.update({ where: { organizationId: org.org.id }, data: { logoUrl: "https://example.com/logo.png" } });
    revalidateBranding(org.org.id);
    try {
      const html = await renderAs(org.admin.id, org.org.id);
      expect(html).not.toContain(REMINDER_TITLE);
    } finally {
      await prisma.organizationBranding.update({ where: { organizationId: org.org.id }, data: { logoUrl: null } });
      revalidateBranding(org.org.id);
    }
  });

  it("REQUIRED: a prior dismissal hides the reminder — gate unchanged by the v4 move", async () => {
    await prisma.organization.update({ where: { id: org.org.id }, data: { brandingReminderDismissedAt: new Date() } });
    try {
      const html = await renderAs(org.admin.id, org.org.id);
      expect(html).not.toContain(REMINDER_TITLE);
    } finally {
      await prisma.organization.update({ where: { id: org.org.id }, data: { brandingReminderDismissedAt: null } });
    }
  });

  it("REQUIRED: INSTRUCTOR never sees the reminder, regardless of logo/dismissal state — gate unchanged by the v4 move", async () => {
    const html = await renderAs(instructor.id, org.org.id);
    expect(html).not.toContain(REMINDER_TITLE);
  });
});
