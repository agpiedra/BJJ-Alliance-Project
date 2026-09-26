import "dotenv/config";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { DateTime } from "luxon";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../../src/lib/prisma";
import { SMOKE_BASE_URL, mintSessionCookie } from "../helpers/smoke";

/**
 * Rendered-browser coverage of the student portal (real Chrome, the seeded student, a real session minted through the dev-only bypass):
 * responsive layout (no sideways scroll at 360 / 390 / 768 / 1280; two columns from 1024, priority order below), the compact class rows
 * that keep the progress card reachable, touch targets under a coarse pointer, and the keyboard model of the Home / Attendance / Schedule
 * tabs. Two classes that are open RIGHT NOW (overlapping windows) are inserted for the student's academy and removed afterwards, so the
 * class rows are always present whatever day the suite runs.
 */
const ZONE = "America/Costa_Rica";
const FIXTURE_PREFIX = "Browser Test";
const WIDTHS = [360, 390, 768, 1280] as const;

let browser: Browser;
let sessionCookie: string;
let organizationId: string;
let academyId: string;
const contexts: BrowserContext[] = [];
const fixtureIds: string[] = [];

async function open(width: number, height: number, coarse: boolean): Promise<Page> {
  const context = await browser.newContext({ viewport: { width, height }, hasTouch: coarse, isMobile: false });
  contexts.push(context);
  const [name, ...rest] = sessionCookie.split("=");
  await context.addCookies([{ name, value: rest.join("="), url: SMOKE_BASE_URL }]);
  const page = await context.newPage();
  await page.goto(`${SMOKE_BASE_URL}/en/portal`, { waitUntil: "networkidle" });
  await page.getByRole("tablist").waitFor();
  expect(await page.evaluate(() => window.matchMedia("(pointer: coarse)").matches), "the pointer emulation must really be in effect").toBe(coarse);
  return page;
}

const box = async (page: Page, testId: string) => {
  const b = await page.getByTestId(testId).first().boundingBox();
  if (!b) throw new Error(`${testId} is not visible`);
  return b;
};

beforeAll(async () => {
  browser = await chromium.launch({ channel: "chrome", executablePath: process.env.BROWSER_EXECUTABLE_PATH || undefined, headless: true });
  const user = await prisma.user.findFirst({ where: { email: "student@test.com" }, select: { id: true } });
  if (!user) throw new Error("The portal browser suite needs the seeded student@test.com.");
  sessionCookie = await mintSessionCookie(user.id);
  const rows = await prisma.$queryRaw<Array<{ organizationId: string; homeAcademyId: string }>>`SELECT "organizationId", "homeAcademyId" FROM "Student" WHERE "userId" = ${user.id}`;
  if (!rows[0]) throw new Error("The seeded student has no student record.");
  organizationId = rows[0].organizationId;
  academyId = rows[0].homeAcademyId;

  // Two classes open right now (each opens 30 minutes before its start and closes 30 minutes after its end, so these overlap).
  const now = DateTime.now().setZone(ZONE);
  const day = now.setLocale("en").toFormat("cccc").toUpperCase();
  const specs = [
    { suffix: "A", start: now.minus({ minutes: 10 }) },
    { suffix: "B", start: now.plus({ minutes: 5 }) },
  ];
  for (const { suffix, start } of specs) {
    const id = `browser-test-${suffix}-${Date.now()}`;
    fixtureIds.push(id);
    await prisma.$executeRaw`INSERT INTO "ClassSession" (id, "academyId", "organizationId", "dayOfWeek", "startTime", "durationMinutes", name, type, "countsTowardPromotion", active, "createdAt", "updatedAt")
      VALUES (${id}, ${academyId}, ${organizationId}, ${day}::"DayOfWeek", ${start.toFormat("HH:mm")}, 60, ${`${FIXTURE_PREFIX} ${suffix}`}, 'GI'::"ClassType", true, true, now(), now())`;
  }
});

afterAll(async () => {
  for (const context of contexts) await context.close();
  await browser?.close();
  for (const id of fixtureIds) await prisma.$executeRaw`DELETE FROM "ClassSession" WHERE id = ${id}`;
  await prisma.$disconnect();
});

describe.each(WIDTHS)("portal layout at %ipx", (width) => {
  it("does not scroll sideways, has the three tabs, and shows the two open classes as compact rows", async () => {
    const page = await open(width, width >= 1024 ? 900 : 844, false);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "no horizontal scroll").toBe(true);
    expect(await page.getByRole("tab").allTextContents()).toEqual(["Home", "Attendance", "Schedule"]);
    const rows = page.getByTestId("class-row");
    expect(await rows.count()).toBeGreaterThanOrEqual(2);
    for (const name of ["A", "B"]) {
      const row = page.getByTestId("class-row").filter({ hasText: `${FIXTURE_PREFIX} ${name}` });
      const b = (await row.boundingBox())!;
      expect(b.height, `open class row ${name} is compact`).toBeLessThanOrEqual(width >= 1024 ? 90 : 110);
      const button = await row.getByRole("button", { name: /Check in to/ }).boundingBox();
      expect(button!.height, "the check-in button is a real target").toBeGreaterThanOrEqual(36); // mouse: compact; coarse asserted below
      expect(button!.width).toBeGreaterThanOrEqual(64);
    }
  });

  it(width >= 1024 ? "puts progress beside the check-in card (two columns)" : "stacks progress directly under the check-in card, before recent attendance", async () => {
    const page = await open(width, width >= 1024 ? 900 : 844, false);
    const progress = await box(page, "portal-progress");
    const checkIn = (await page.getByRole("list", { name: "Today's classes" }).boundingBox())!;
    const recent = await box(page, "portal-recent-attendance");
    if (width >= 1024) {
      expect(progress.x, "progress is in the right-hand column").toBeGreaterThan(checkIn.x + checkIn.width - 1);
      expect(Math.abs(progress.y - checkIn.y), "both columns start together").toBeLessThan(140);
    } else {
      expect(progress.y, "progress is below the check-in card").toBeGreaterThan(checkIn.y);
      expect(recent.y, "recent attendance comes after progress").toBeGreaterThan(progress.y);
      // The point of the compact rows: progress starts on the first screen of a phone even with several classes today.
      if (width <= 390) expect(progress.y, "progress is reachable without scrolling").toBeLessThan(844);
    }
  });
});

describe.each([390, 768])("portal touch targets under a coarse pointer at %ipx", (width) => {
  it("the check-in buttons are at least 48px tall, tabs and the account menu at least 44px", async () => {
    const page = await open(width, 844, true);
    const buttons = page.getByRole("button", { name: /Check in to/ });
    expect(await buttons.count()).toBeGreaterThanOrEqual(2);
    for (let i = 0; i < (await buttons.count()); i++) expect((await buttons.nth(i).boundingBox())!.height, `check-in button ${i}`).toBeGreaterThanOrEqual(48);
    for (const tab of await page.getByRole("tab").all()) expect((await tab.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    const menu = await page.getByRole("button", { name: "Account menu" }).boundingBox();
    expect(menu!.width).toBeGreaterThanOrEqual(44);
    expect(menu!.height).toBeGreaterThanOrEqual(44);
  });
});

describe("portal tabs in a real browser", () => {
  it("Arrow keys move and activate tabs, Tab enters the panel, the URL hash follows, and hidden views leave the page", async () => {
    const page = await open(1280, 900, false);
    await page.getByRole("tab", { name: "Home" }).focus();
    await page.keyboard.press("ArrowRight");
    expect(await page.evaluate(() => document.activeElement?.textContent)).toBe("Attendance");
    expect(await page.getByRole("tab", { name: "Attendance" }).getAttribute("aria-selected")).toBe("true");
    expect(await page.evaluate(() => window.location.hash)).toBe("#attendance");
    expect(await page.locator("#portal-panel-attendance").isVisible()).toBe(true);
    expect(await page.locator("#portal-panel-home").isVisible(), "the Home view is hidden, not merely covered").toBe(false);
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => document.activeElement?.id), "Tab enters the visible panel").toBe("portal-panel-attendance");
    await page.getByRole("tab", { name: "Attendance" }).focus();
    await page.keyboard.press("End");
    expect(await page.locator("#portal-panel-schedule").isVisible()).toBe(true);
    await page.keyboard.press("Home");
    expect(await page.locator("#portal-panel-home").isVisible()).toBe(true);
  });

  it('"View full history" opens the Attendance view and puts focus in it; the back button returns to Home', async () => {
    const page = await open(1280, 900, false);
    await page.getByRole("link", { name: "View full history" }).click();
    expect(await page.locator("#portal-panel-attendance").isVisible()).toBe(true);
    await page.waitForFunction(() => document.activeElement?.id === "portal-panel-attendance");
    await page.goBack();
    await page.waitForFunction(() => document.getElementById("portal-panel-home")?.hidden === false);
  });

  it("opens straight onto the view named in the URL", async () => {
    const page = await open(390, 844, false);
    await page.goto(`${SMOKE_BASE_URL}/en/portal#schedule`, { waitUntil: "networkidle" });
    await page.waitForFunction(() => document.getElementById("portal-panel-schedule")?.hidden === false);
    // phone: the day-by-day list, not the seven-column grid
    expect(await page.getByTestId("schedule-day-list").isVisible()).toBe(true);
  });

  it("the account menu switches the theme (the same html.dark class and stored preference as the staff toggle) and offers sign out", async () => {
    const page = await open(1280, 900, false);
    const dark = () => page.evaluate(() => document.documentElement.classList.contains("dark"));
    const before = await dark();
    await page.getByRole("button", { name: "Account menu" }).click();
    await page.getByRole("menuitem", { name: "Theme" }).click();
    expect(await dark()).toBe(!before);
    expect(await page.evaluate(() => localStorage.getItem("theme"))).toBe(before ? "light" : "dark");
    await page.getByRole("button", { name: "Account menu" }).click();
    // isVisible() answers immediately and does not wait, so reading it straight after the click is a synchronization weakness
    // (it failed once in CI with `false`). waitFor() is a bounded wait for the same visible state; the assertion below is kept.
    const signOut = page.getByRole("menuitem", { name: "Sign out" });
    await signOut.waitFor({ state: "visible" });
    expect(await signOut.isVisible()).toBe(true);
  });
});
