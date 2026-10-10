import "dotenv/config";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../../src/lib/prisma";
import { hashSecret, generateRandomToken } from "../../src/lib/crypto";
import { seedOrganizationDefaults } from "../../src/lib/organizations/seed-defaults";
import { SMOKE_BASE_URL, mintSessionCookie } from "../helpers/smoke";
import { cleanupDisposableOrgFixture } from "../helpers/fixture-cleanup";

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
// 260, not a rounder number: platform's real content (header + 3 links +
// theme toggle + sign out) measures ~301px tall. 560 (a plausible "short
// phone" guess) never actually got tight enough to need the overflow-y-auto
// fix below — empirically confirmed by trying to break it at 560 and failing.
// 260 is the first height where the real Sign out button's bottom edge
// (measured via getBoundingClientRect, not isVisible()) sits below the
// viewport when the fix is removed, with body's scroll lock (overflow:
// hidden) making it genuinely unreachable, not just scrolled offscreen.
const SHORT = { width: 390, height: 260 } as const;

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
  it("REQUIRED: Sign out's real box sits inside the viewport after scrolling, and it passes an actionability check — not just isVisible()", async () => {
    const page = await pageWithCookie(superAdminCookie, SHORT);
    await page.goto(`${SMOKE_BASE_URL}/en/platform`, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "Menu" }).click();
    const signOut = page.getByRole("button", { name: "Sign out" });
    await signOut.scrollIntoViewIfNeeded();

    // isVisible() only checks CSS visibility/display, not actual on-screen position — an
    // element can be "visible" and still sit outside the viewport or behind another node.
    // Measure the real box and require it to fit entirely inside SHORT's dimensions.
    const box = await signOut.boundingBox();
    expect(box, "Sign out must have a real, measurable box after scrolling").not.toBeNull();
    expect(box!.y, "top edge is on-screen").toBeGreaterThanOrEqual(0);
    expect(box!.x, "left edge is on-screen").toBeGreaterThanOrEqual(0);
    expect(box!.y + box!.height, "bottom edge is on-screen, not clipped below the short viewport").toBeLessThanOrEqual(SHORT.height);
    expect(box!.x + box!.width, "right edge is on-screen").toBeLessThanOrEqual(SHORT.width);

    // trial:true runs Playwright's actionability checks (visible, stable, receives pointer
    // events — i.e. nothing else is stacked on top of it) and stops before performing the
    // click, so this proves it is really reachable/clickable without actually signing out.
    await signOut.click({ trial: true });
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

describe("StaffTopBar: a long organization name does not overflow or overlap controls (real render, isolated fixture)", () => {
  // An isolated, disposable organization — NOT a rename of Alliance or any other
  // seeded dev org. Created fresh here and torn down in afterAll, same convention
  // tests/integration/describe-invitation.test.ts already uses for scoped fixtures.
  // No seeded org's real name is long enough to force this at a phone width, and
  // renaming one to find out would leave dev data in a state nobody asked for.
  const LONG_ORG_NAME = "Academia Internacional de Artes Marciales Mixtas y Jiu-Jitsu Brasileño del Pacífico Sur";
  const suffix = `long-name-${Date.now()}`;
  let longOrgId: string;
  let longOrgUserId: string;
  let longOrgCookie: string;

  beforeAll(async () => {
    // Organization + its OrganizationBranding row created together, in one transaction —
    // the real shape every org has (seed-defaults.ts's own doc comment: "created
    // transactionally alongside every Organization"), not an org missing the row it
    // should never be missing. Without this, orgName falls back to a generic default
    // string instead of this org's real (long) name, defeating the whole test.
    const org = await prisma.$transaction(async (tx) => {
      const created = await tx.organization.create({
        data: {
          slug: `browser-test-${suffix}`,
          name: LONG_ORG_NAME,
          status: "ACTIVE",
          contactEmail: `browser-test-${suffix}@example.test`,
          onboardingCompletedAt: new Date(),
        },
      });
      await seedOrganizationDefaults(tx, created.id);
      return created;
    });
    longOrgId = org.id;
    await prisma.academy.create({
      data: {
        organizationId: org.id,
        name: "Sede Central",
        slug: `${org.slug}-sede`,
        kioskTokenHash: await hashSecret(`unused-${suffix}`),
      },
    });
    const user = await prisma.user.create({
      data: {
        email: `browser-test-${suffix}-admin@example.test`,
        passwordHash: await hashSecret(generateRandomToken()),
        role: "ADMIN",
        active: true,
      },
    });
    longOrgUserId = user.id;
    await prisma.organizationMembership.create({ data: { userId: user.id, organizationId: org.id, role: "ADMIN" } });
    longOrgCookie = await mintSessionCookie(user.id);
  });

  afterAll(async () => {
    // Guarded: see fixture-cleanup.ts — never issues a deleteMany/delete with
    // an undefined id, which Prisma would silently turn into an unscoped
    // table-wide delete when setup fails before longOrgId/longOrgUserId is
    // assigned.
    await cleanupDisposableOrgFixture(prisma, { organizationId: longOrgId, userId: longOrgUserId });
  });

  it("REQUIRED: no horizontal overflow, the breadcrumb never overlaps the theme/notification/avatar controls, and the header genuinely grows", async () => {
    const page = await pageWithCookie(longOrgCookie, MOBILE);
    await page.goto(`${SMOKE_BASE_URL}/en/dashboard`, { waitUntil: "networkidle" });
    await page.getByRole("heading", { name: "Dashboard" }).waitFor();

    // Real StaffTopBar, real right-side controls (ThemeToggle + the NotificationBell
    // slot + the avatar dropdown) — not a prototype mock and not a class-name check.
    const result = await page.evaluate(() => {
      const header = document.querySelector("header");
      if (!header) return null;
      const crumb = header.querySelector("span.font-mono");
      const controls = header.lastElementChild;
      if (!crumb || !controls) return null;
      const h = header.getBoundingClientRect();
      const c = crumb.getBoundingClientRect();
      const r = controls.getBoundingClientRect();
      const overlaps = !(c.right < r.left || c.left > r.right || c.bottom < r.top || c.top > r.bottom);
      return {
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
        headerHeight: h.height,
        crumbText: crumb.textContent,
        controlsChildCount: controls.children.length,
        overlaps,
      };
    });

    expect(result, "header, breadcrumb and controls must all be present in the real DOM").not.toBeNull();
    expect(result!.crumbText, "the long organization name must actually be the one rendered").toContain("Academia Internacional de Artes Marciales Mixtas");
    expect(result!.controlsChildCount, "the real right-side controls (theme/notifications/avatar) must be present, not an empty stand-in").toBeGreaterThan(0);
    expect(result!.scrollWidth, "the long name must not force horizontal page overflow").toBeLessThanOrEqual(result!.innerWidth);
    expect(result!.overlaps, "the wrapped breadcrumb must not overlap the theme/notification/avatar controls").toBe(false);
    expect(result!.headerHeight, "the header must grow beyond the single-line 48px (min-h-12) baseline to fit the wrapped name").toBeGreaterThan(48);
  });
});
