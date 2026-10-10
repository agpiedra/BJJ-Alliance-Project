import "dotenv/config";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../../src/lib/prisma";
import { SMOKE_BASE_URL, mintSessionCookie } from "../helpers/smoke";

/**
 * Rendered-browser coverage for the Phase 2.5 shell & navigation phone pattern
 * (review findings 1-4) — real Chrome, the seeded admin@alliancecr.com (ADMIN,
 * Alliance's own custom branding + 2 academies), director@test.com (DIRECTOR,
 * scoped to one academy), and superadmin@alliancecr.com. Not covered by, and
 * not a duplicate of, tests/browser/portal.test.ts or touch-targets.test.ts —
 * those exist for the student portal and touch-target sizing respectively and
 * happen to also exercise BrandingScope/Sheet incidentally; this file is the
 * dedicated, focused coverage for this phase's own behaviour.
 */
const MOBILE = { width: 390, height: 844 } as const;
const DESKTOP = { width: 1280, height: 900 } as const;
const SHORT = { width: 390, height: 560 } as const;

let browser: Browser;
let adminCookie: string;
let adminCookieEs: string;
let directorCookie: string;
let superAdminCookie: string;
let allianceOrgId: string;
const contexts: BrowserContext[] = [];

async function pageWithCookie(cookie: string, viewport: { width: number; height: number }): Promise<Page> {
  const context = await browser.newContext({ viewport });
  contexts.push(context);
  const [name, ...rest] = cookie.split("=");
  await context.addCookies([{ name, value: rest.join("="), url: SMOKE_BASE_URL }]);
  return context.newPage();
}

beforeAll(async () => {
  browser = await chromium.launch({ channel: "chrome", executablePath: process.env.BROWSER_EXECUTABLE_PATH || undefined, headless: true });
  const [admin, director, superAdmin] = await Promise.all([
    prisma.user.findFirstOrThrow({ where: { email: "admin@alliancecr.com" }, select: { id: true } }),
    prisma.user.findFirstOrThrow({ where: { email: "director@test.com" }, select: { id: true } }),
    prisma.user.findFirstOrThrow({ where: { email: "superadmin@alliancecr.com" }, select: { id: true } }),
  ]);
  adminCookie = await mintSessionCookie(admin.id);
  adminCookieEs = adminCookie; // same session; locale is a URL prefix, not a cookie, for these routes
  directorCookie = await mintSessionCookie(director.id);
  superAdminCookie = await mintSessionCookie(superAdmin.id);
  const org = await prisma.organization.findUniqueOrThrow({ where: { slug: "alliance-cr" }, select: { id: true } });
  allianceOrgId = org.id;
});

afterAll(async () => {
  for (const context of contexts) await context.close();
  await browser?.close();
  await prisma.$disconnect();
});

describe("tenant-colour fix (DESIGN.md section 7.10)", () => {
  it("REQUIRED: the mobile sheet renders in the SAME colour as the desktop sidebar, not the unbranded default", async () => {
    const desktopPage = await pageWithCookie(adminCookie, DESKTOP);
    await desktopPage.goto(`${SMOKE_BASE_URL}/en/dashboard`, { waitUntil: "networkidle" });
    const desktopBg = await desktopPage.evaluate(() => {
      const sidebar = document.querySelector('[data-slot="sidebar-inner"], [data-sidebar="sidebar"]');
      return sidebar ? getComputedStyle(sidebar).backgroundColor : null;
    });
    expect(desktopBg, "the desktop sidebar must be found and themed").toBeTruthy();

    const mobilePage = await pageWithCookie(adminCookie, MOBILE);
    await mobilePage.goto(`${SMOKE_BASE_URL}/en/dashboard`, { waitUntil: "networkidle" });
    await mobilePage.getByRole("button", { name: "Menu" }).click();
    const dialog = mobilePage.getByRole("dialog");
    await dialog.waitFor();
    const mobileBg = await dialog.evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(mobileBg, "the mobile sheet must match the branded desktop sidebar's colour, not escape to the unthemed default").toBe(desktopBg);
  });
});

describe("nested academy-switcher dropdown inside the mobile sheet", () => {
  it("REQUIRED: opens, offers both branches, selecting one updates the trigger, and the sheet itself stays open", async () => {
    const page = await pageWithCookie(adminCookie, MOBILE);
    await page.goto(`${SMOKE_BASE_URL}/en/dashboard`, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "Menu" }).click();
    await page.getByRole("dialog").waitFor();

    // getByTestId, not an accessible-name match on "All locations": the label itself is
    // what changes under test, so a name-based locator goes stale the moment it updates.
    const switcher = page.getByTestId("academy-switcher");
    await switcher.click();
    const menu = page.getByRole("menu");
    await menu.waitFor();
    const items = await menu.getByRole("menuitem").allTextContents();
    expect(items, "both Alliance academies must be offered").toEqual(expect.arrayContaining(["Alliance Escazú", "Alliance Escalante"]));

    await menu.getByRole("menuitem", { name: "Alliance Escazú" }).click();

    await expect.poll(() => switcher.textContent(), { timeout: 15000 }).toContain("Alliance Escazú");
    expect(await page.getByRole("dialog").isVisible(), "selecting a branch must not close the parent sheet").toBe(true);
  });

  it("REQUIRED: keyboard (arrows + Enter) also selects a branch — the dropdown is really operable, not just clickable", async () => {
    const page = await pageWithCookie(adminCookie, MOBILE);
    await page.goto(`${SMOKE_BASE_URL}/en/dashboard`, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "Menu" }).click();
    await page.getByRole("dialog").waitFor();

    const switcher = page.getByTestId("academy-switcher");
    const before = await switcher.textContent();
    await switcher.click();
    const menu = page.getByRole("menu");
    await menu.waitFor();
    // page.keyboard, not a locator's own .press(): Base UI's menu manages focus on the
    // individual menuitems (roving tabindex), not the role=menu container itself, so a
    // locator-scoped press() on the container doesn't reach them. Which item gets
    // auto-highlighted first (the first item vs. the currently selected one) is its own
    // implementation detail, not something this test should pin — only that arrow keys
    // move the highlight and Enter actually selects, changing the trigger's label.
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");

    await expect
      .poll(() => switcher.textContent(), { timeout: 15000 })
      .toMatch(/^(Alliance Escazú|Alliance Escalante)View all locations$/);
    expect(await switcher.textContent(), "keyboard selection must actually change the label, not no-op back to the same value").not.toBe(before);
  });
});

describe("Escape closes the sheet and restores focus", () => {
  it("REQUIRED: Escape closes the dialog and focus returns to the Menu trigger", async () => {
    const page = await pageWithCookie(adminCookie, MOBILE);
    await page.goto(`${SMOKE_BASE_URL}/en/dashboard`, { waitUntil: "networkidle" });
    const trigger = page.getByRole("button", { name: "Menu" });
    await trigger.click();
    await page.getByRole("dialog").waitFor();
    await page.keyboard.press("Escape");
    await expect.poll(() => page.getByRole("dialog").count()).toBe(0);
    const focused = await page.evaluate(() => document.activeElement?.getAttribute("aria-label"));
    expect(focused, "focus must return to the Menu trigger, not get lost").toBe("Menu");
  });
});

describe("accessible dialog names (review finding 2)", () => {
  it("REQUIRED: the staff mobile sheet has a localized accessible name (EN)", async () => {
    const page = await pageWithCookie(adminCookie, MOBILE);
    await page.goto(`${SMOKE_BASE_URL}/en/dashboard`, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "Menu" }).click();
    await page.getByRole("dialog").waitFor();
    expect(await page.getByRole("dialog", { name: "Navigation" }).count(), "the dialog's accessible name must be the localized title, not unlabeled").toBe(1);
  });

  it("REQUIRED: the staff mobile sheet has a localized accessible name (ES)", async () => {
    const page = await pageWithCookie(adminCookieEs, MOBILE);
    await page.goto(`${SMOKE_BASE_URL}/es/dashboard`, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "Menú" }).click();
    await page.getByRole("dialog").waitFor();
    expect(await page.getByRole("dialog", { name: "Navegación" }).count()).toBe(1);
  });

  it("REQUIRED: the platform mobile sheet has a localized accessible name", async () => {
    const page = await pageWithCookie(superAdminCookie, MOBILE);
    await page.goto(`${SMOKE_BASE_URL}/en/platform`, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "Menu" }).click();
    await page.getByRole("dialog").waitFor();
    expect(await page.getByRole("dialog", { name: "Navigation" }).count()).toBe(1);
  });
});

describe("mobile to desktop resize while the sheet is open (review finding 3)", () => {
  it("REQUIRED: staff sheet - resizing past the breakpoint closes it and releases the scroll lock; resizing back to mobile does not reopen it", async () => {
    const page = await pageWithCookie(adminCookie, MOBILE);
    await page.goto(`${SMOKE_BASE_URL}/en/dashboard`, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "Menu" }).click();
    await page.getByRole("dialog").waitFor();

    await page.setViewportSize(DESKTOP);
    await expect.poll(() => page.getByRole("dialog").count(), { timeout: 5000 }).toBe(0);
    const bodyOverflow = await page.evaluate(() => getComputedStyle(document.body).overflow);
    expect(bodyOverflow, "the modal scroll lock must be released once the sheet is gone").not.toBe("hidden");

    await page.setViewportSize(MOBILE);
    await page.waitForTimeout(300); // let the isMobile media-query listener settle
    expect(await page.getByRole("dialog").count(), "returning to mobile must not unexpectedly reopen the sheet").toBe(0);
  });

  it("REQUIRED: platform sheet - same resize behaviour (the bug this finding named)", async () => {
    const page = await pageWithCookie(superAdminCookie, MOBILE);
    await page.goto(`${SMOKE_BASE_URL}/en/platform`, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "Menu" }).click();
    await page.getByRole("dialog").waitFor();

    await page.setViewportSize(DESKTOP);
    await expect.poll(() => page.getByRole("dialog").count(), { timeout: 5000 }).toBe(0);
    const bodyOverflow = await page.evaluate(() => getComputedStyle(document.body).overflow);
    expect(bodyOverflow, "the modal scroll lock must be released once the sheet is gone").not.toBe("hidden");

    await page.setViewportSize(MOBILE);
    await page.waitForTimeout(300);
    expect(await page.getByRole("dialog").count(), "returning to mobile must not unexpectedly reopen the sheet").toBe(0);
  });
});

describe("platform short-screen footer reachability (review finding 3)", () => {
  it("REQUIRED: Sign out is reachable (visible, or reachable by scrolling the nav) on a short viewport", async () => {
    const page = await pageWithCookie(superAdminCookie, SHORT);
    await page.goto(`${SMOKE_BASE_URL}/en/platform`, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "Menu" }).click();
    const signOut = page.getByRole("button", { name: "Sign out" });
    await signOut.scrollIntoViewIfNeeded();
    expect(await signOut.isVisible(), "Sign out must be reachable, not clipped off the short viewport with no scroll path").toBe(true);
  });
});

describe("platform active navigation from the real pathname (review finding 1)", () => {
  it("REQUIRED: Overview is active on /platform, and nowhere else", async () => {
    const page = await pageWithCookie(superAdminCookie, DESKTOP);
    await page.goto(`${SMOKE_BASE_URL}/en/platform`, { waitUntil: "networkidle" });
    expect(await page.getByRole("link", { name: "Overview" }).getAttribute("aria-current")).toBe("page");
    expect(await page.getByRole("link", { name: "Organizations" }).getAttribute("aria-current")).toBeNull();
    expect(await page.getByRole("link", { name: "Platform admins" }).getAttribute("aria-current")).toBeNull();
  });

  it("REQUIRED: Organizations is active on /platform/organizations", async () => {
    const page = await pageWithCookie(superAdminCookie, DESKTOP);
    await page.goto(`${SMOKE_BASE_URL}/en/platform/organizations`, { waitUntil: "networkidle" });
    expect(await page.getByRole("link", { name: "Organizations" }).getAttribute("aria-current")).toBe("page");
    expect(await page.getByRole("link", { name: "Overview" }).getAttribute("aria-current")).toBeNull();
  });

  it("REQUIRED: Organizations stays active on the nested /platform/organizations/[id] route", async () => {
    const page = await pageWithCookie(superAdminCookie, DESKTOP);
    await page.goto(`${SMOKE_BASE_URL}/en/platform/organizations/${allianceOrgId}`, { waitUntil: "networkidle" });
    expect(await page.getByRole("link", { name: "Organizations" }).getAttribute("aria-current")).toBe("page");
    expect(await page.getByRole("link", { name: "Overview" }).getAttribute("aria-current")).toBeNull();
  });

  it("REQUIRED: Platform admins is active on /platform/admins", async () => {
    const page = await pageWithCookie(superAdminCookie, DESKTOP);
    await page.goto(`${SMOKE_BASE_URL}/en/platform/admins`, { waitUntil: "networkidle" });
    expect(await page.getByRole("link", { name: "Platform admins" }).getAttribute("aria-current")).toBe("page");
    expect(await page.getByRole("link", { name: "Overview" }).getAttribute("aria-current")).toBeNull();
  });
});

describe("role visibility and server authorization are unchanged (preserved, not re-litigated)", () => {
  it("REQUIRED: DIRECTOR's mobile sheet still has no Schedule/Staff/Locations and a read-only (non-dropdown) switcher", async () => {
    const page = await pageWithCookie(directorCookie, MOBILE);
    await page.goto(`${SMOKE_BASE_URL}/en/dashboard`, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "Menu" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.waitFor();
    for (const label of ["Schedule", "Staff", "Locations"]) {
      expect(await dialog.getByRole("link", { name: label }).count(), `DIRECTOR must not see ${label}`).toBe(0);
    }
    expect(await dialog.getByRole("button", { name: /Alliance Escaz/ }).count(), "the switcher must be read-only text, not a button, for DIRECTOR").toBe(0);
    expect(await dialog.getByText("Alliance Escazú").isVisible()).toBe(true);
  });
});
