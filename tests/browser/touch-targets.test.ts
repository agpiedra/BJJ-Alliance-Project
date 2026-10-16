import "dotenv/config";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SMOKE_BASE_URL } from "../helpers/smoke";

/**
 * Rendered-browser regression coverage for touch-target sizing (real Chrome, laid-out pixels, not class names).
 *
 * The regression this guards: Phase 1 gave the shared Button `pointer-coarse:h-11`, a FIXED 44px height. A variant-prefixed utility
 * outranks the unprefixed sizes callers pass, so on a touch tablet the kiosk keypad collapsed from 112 x 112 to 112 x 44 (numerals
 * overflowing their keys) and `h-auto` multi-line controls (class-picker rows, "Not this class?") were clipped at 44px. The rule is
 * now a minimum (`pointer-coarse:min-h-11`, plus `min-w-11` for icon sizes). Every assertion below is on measured boxes:
 *   - the keypad keys have their explicit size (both dimensions) under BOTH pointers,
 *   - multi-line / auto-height controls are at least 44px and CONTAIN their text (every text line box lies inside the control),
 *   - compact shared sizes still grow to 44 on a coarse pointer (both dimensions for icon buttons) and stay compact with a mouse.
 * The emulation is asserted, not assumed: each page confirms `pointer: coarse` matches the requested pointer.
 *
 * Runs against a running `pnpm dev` (SMOKE_BASE_URL, localhost only) like tests/smoke. Kiosk API replies are mocked at the network
 * layer (nothing is written): the real client component renders the picker and success screens from them.
 */
const POINTERS = [
  { name: "mouse", coarse: false },
  { name: "coarse (touch)", coarse: true },
] as const;

// Sizes of the kiosk keys are explicit in kiosk-client.tsx (KEY_SIZE_CLASS): 80 x 80 below the `sm` breakpoint (640px), 156 x 124 in
// portrait from it up, and 132 x 108 on a tablet in landscape (>= 900px wide) where the keypad sits beside the prompt. (Until the kiosk
// redesign they were 112 x 112.) Update these numbers together with that file.
const VIEWPORTS = [
  { name: "tablet landscape 1024x768", width: 1024, height: 768, key: { w: 132, h: 108 }, landscape: true },
  { name: "tablet portrait 768x1024", width: 768, height: 1024, key: { w: 156, h: 124 }, landscape: false },
  { name: "phone 390x844", width: 390, height: 844, key: { w: 80, h: 80 }, landscape: false },
] as const;

interface Measure {
  w: number;
  h: number;
  /** every text line box lies inside the element's own box (1px tolerance): nothing overflows or is clipped */
  fits: boolean;
}

const measure = new Function(
  "el",
  `const r = el.getBoundingClientRect();
   let fits = true;
   const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
   for (let n = walker.nextNode(); n; n = walker.nextNode()) {
     if (!n.nodeValue || !n.nodeValue.trim()) continue;
     const range = document.createRange();
     range.selectNodeContents(n);
     for (const t of range.getClientRects()) {
       if (t.top < r.top - 1 || t.bottom > r.bottom + 1 || t.left < r.left - 1 || t.right > r.right + 1) fits = false;
     }
   }
   return { w: r.width, h: r.height, fits };`,
) as (el: Element) => Measure;

const COMPLETE_CHECK_IN = {
  ok: true,
  student: {
    firstName: "Ana",
    lastName: "Sample",
    currentBelt: "WHITE",
    currentBeltVisual: { primaryColor: "#F0EBE0", centerStripeColor: null, barColor: "#111116", stripeColors: ["#FFFFFF"], maxStripes: 4, visibleStripeSlots: 4 },
    currentBeltLabelEs: "Blanco",
    currentBeltLabelEn: "White",
    currentStripes: 1,
  },
  summary: { atBeltCount: 20, remainingAttendance: 10, isEligible: false, nextTarget: "STRIPE", mode: "ATTENDANCE", target: 30, percent: 66.7, timeAnchorMissing: false, notConfigured: false, reachedOn: null },
  thresholdReached: false,
  progressOutcome: "counted",
  isVisitor: false,
  homeAcademyName: "Sample Academy",
  attendanceRecordId: "rec-1",
  canCorrect: true,
  matchedClass: { id: "c1", name: "Advanced", dayOfWeek: "TUESDAY", startTime: "18:00" },
};

// A name long enough to wrap to several lines at every width used here.
const LONG_CLASS = "Advanced Fundamentals Gi Class for Every Belt Level";
const OPEN_CLASSES = [
  { id: "c1", name: LONG_CLASS, startTime: "18:00", endTime: "19:15", type: "GI" },
  { id: "c2", name: "Open Mat", startTime: "18:00", endTime: "19:00", type: "OPEN_MAT" },
];

// Ordinary, realistic class names — short, no internal wrap opportunity needed for most of them — the exact shape
// that demonstrated the name/time overlap regression (see the test below), not a synthetic worst case.
const SHORT_NAME_CLASSES = [
  { id: "s1", name: "Fundamentals", startTime: "07:25", endTime: "08:55", type: "GI" },
  { id: "s2", name: "Advanced", startTime: "07:30", endTime: "09:00", type: "GI" },
];

let browser: Browser;
let kioskSlug: string;
const contexts: BrowserContext[] = [];

async function openPage(pointer: (typeof POINTERS)[number], viewport: { width: number; height: number }): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height }, hasTouch: pointer.coarse, isMobile: false });
  contexts.push(context);
  return context.newPage();
}

async function assertPointer(page: Page, pointer: (typeof POINTERS)[number]) {
  const coarse = await page.evaluate(() => window.matchMedia("(pointer: coarse)").matches);
  expect(coarse, `the ${pointer.name} emulation must actually set (pointer: coarse) = ${pointer.coarse}`).toBe(pointer.coarse);
}

async function openKiosk(page: Page, pointer: (typeof POINTERS)[number]) {
  await page.goto(`${SMOKE_BASE_URL}/en/kiosk/${kioskSlug}`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "1", exact: true }).waitFor();
  await assertPointer(page, pointer);
}

async function submitCode(page: Page) {
  for (const digit of "1234") await page.getByRole("button", { name: digit, exact: true }).click();
  await page.waitForFunction(() => [...document.querySelectorAll("button")].some((b) => b.textContent?.trim() === "Enter" && !b.disabled), null, { timeout: 15_000 });
  await page.getByRole("button", { name: "Enter", exact: true }).click();
}

beforeAll(async () => {
  browser = await chromium.launch({ channel: "chrome", executablePath: process.env.BROWSER_EXECUTABLE_PATH || undefined, headless: true });
  // The public kiosk page renders its keypad for any active academy (the token is only checked by the API, which is mocked below).
  // `escazu` is a deterministic seed academy (prisma/seed.ts); KIOSK_TEST_ACADEMY_SLUG points the suite at another one.
  kioskSlug = process.env.KIOSK_TEST_ACADEMY_SLUG || "escazu";
});

afterAll(async () => {
  for (const context of contexts) await context.close();
  await browser?.close();
});

describe.each(POINTERS)("kiosk under a $name pointer", (pointer) => {
  describe.each(VIEWPORTS)("$name", (viewport) => {
    it("keypad digits and Clear / Enter keep their explicit size in both dimensions and contain their label", async () => {
      const page = await openPage(pointer, viewport);
      await openKiosk(page, pointer);
      const keys = page.locator("main .grid-cols-3 button");
      expect(await keys.count()).toBe(12);
      for (let i = 0; i < 12; i++) {
        const key = keys.nth(i);
        const label = (await key.textContent())?.trim();
        const m = await key.evaluate(measure);
        expect(Math.round(m.w), `key "${label}" width`).toBe(viewport.key.w);
        expect(Math.round(m.h), `key "${label}" height (was 44 on a coarse pointer before PR #62)`).toBe(viewport.key.h);
        expect(m.fits, `key "${label}" must contain its label`).toBe(true);
      }
    });

    it("class-picker rows with wrapping text are at least 44px and contain their content", async () => {
      const page = await openPage(pointer, viewport);
      await page.route("**/api/kiosk/check-in", (route) =>
        route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ ok: false, error: "class_selection_required", openClasses: OPEN_CLASSES }) }),
      );
      await openKiosk(page, pointer);
      await submitCode(page);
      await page.getByRole("heading", { level: 1, name: "Which class did you attend?" }).waitFor();
      for (const entry of OPEN_CLASSES) {
        const row = page.locator("main button", { hasText: entry.name });
        const m = await row.evaluate(measure);
        // The redesign's rows are at least 104px (the kiosk passes a pointer-coarse twin so the shared 44px minimum does not replace it).
        expect(m.h, `picker row "${entry.name}" keeps its own 104px minimum`).toBeGreaterThanOrEqual(104);
        expect(m.fits, `picker row "${entry.name}" must contain its text (clipped at 44px before PR #62)`).toBe(true);
      }
      // the wrapped row is genuinely multi-line, so this also proves auto height survives on a coarse pointer
      const long = await page.locator("main button", { hasText: LONG_CLASS }).evaluate(measure);
      expect(long.h, "the wrapped row is taller than the 44px minimum").toBeGreaterThan(104);
      // the time range never wraps inside itself, however long the class name is: it is one line of text
      const time = await page.locator("main button", { hasText: LONG_CLASS }).locator(".font-mono").evaluate(measure);
      expect(time.h, "the time range is a single line").toBeLessThan(40);
      expect((await page.getByRole("button", { name: "Cancel" }).evaluate(measure)).h, "Cancel is a large target").toBeGreaterThanOrEqual(60);
    });

    it("class-picker rows: the class name is never squeezed narrower than its own text, even for an ordinary short name", async () => {
      // The regression this guards: the name span had no `break-words` and the row had no `flex-wrap`, so the
      // time range's shrink-0, non-shrinking width left the name column narrower than its own text needed — even
      // for a single short word like "Fundamentals". A squeezed box doesn't clip or wrap its text by itself (the
      // span has `overflow: visible`): the glyphs paint past the box edge and visually land on top of the time
      // range next to it. getBoundingClientRect()-based overlap checks CANNOT see this: the box Chrome reports
      // for the name span never actually grows to include the overflowing ink, so a name/time rectangle-
      // intersection test reports "no overlap" in both the broken and the fixed state — it was tried and
      // verified to pass against the unfixed code, which is exactly the false confidence a real but wrong
      // real-browser check gives. `scrollWidth > clientWidth` is the one measurement that is true only when the
      // element's own content needs more width than the box it was actually given — confirmed to fail against
      // the unfixed code and pass against the fix before being kept here.
      const page = await openPage(pointer, viewport);
      await page.route("**/api/kiosk/check-in", (route) =>
        route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ ok: false, error: "class_selection_required", openClasses: SHORT_NAME_CLASSES }) }),
      );
      await openKiosk(page, pointer);
      await submitCode(page);
      await page.getByRole("heading", { level: 1, name: "Which class did you attend?" }).waitFor();
      for (const entry of SHORT_NAME_CLASSES) {
        const row = page.locator("main button", { hasText: entry.name });
        const name = row.locator('[data-testid="picker-row-name"]');
        const widths = await name.evaluate((el) => ({ clientWidth: el.clientWidth, scrollWidth: el.scrollWidth }));
        expect(widths.scrollWidth, `"${entry.name}" must not need more width than its own box (${widths.scrollWidth} > ${widths.clientWidth})`).toBeLessThanOrEqual(widths.clientWidth);
        // the time range must still render on exactly one line (never wraps, never clipped)
        const time = await row.locator(".font-mono").evaluate(measure);
        expect(time.h, `time range for "${entry.name}" is a single line`).toBeLessThan(40);
        expect(time.fits, `time range for "${entry.name}" must contain its text`).toBe(true);
      }
    });

    it('the "Not this class?" control contains its label and is at least 44px', async () => {
      const page = await openPage(pointer, viewport);
      await page.route("**/api/kiosk/check-in", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(COMPLETE_CHECK_IN) }));
      await openKiosk(page, pointer);
      await submitCode(page);
      const control = page.getByRole("button", { name: "Not this class?" });
      await control.waitFor();
      const m = await control.evaluate(measure);
      // 60px minimum in the redesign (a pointer-coarse twin keeps it on touch); a forced 44px height squeezed it before PR #62
      expect(m.h, '"Not this class?" keeps its own 60px minimum, not a forced 44px').toBeGreaterThanOrEqual(60);
      expect(m.fits, '"Not this class?" must contain its label').toBe(true);
    });

    it.each([
      { state: "time_pending", summary: { mode: "TIME", target: null, remainingAttendance: null, percent: 20 }, text: "See your student portal for the details." },
      { state: "time_anchor_missing", summary: { mode: "TIME", target: null, remainingAttendance: null, percent: 20, timeAnchorMissing: true }, text: "date of your last promotion" },
      { state: "not_configured", summary: { mode: "TIME", target: null, remainingAttendance: null, percent: 20, notConfigured: true }, text: "not set up yet" },
    ])("a time-based degree ($state, MOCKED reply) shows context, never an unexplained count, and everything fits", async ({ summary, text }) => {
      const page = await openPage(pointer, viewport);
      const body = { ...COMPLETE_CHECK_IN, summary: { ...COMPLETE_CHECK_IN.summary, atBeltCount: 12, ...summary } };
      await page.route("**/api/kiosk/check-in", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) }));
      await openKiosk(page, pointer);
      await submitCode(page);
      const context = page.getByText(text);
      await context.waitFor();
      expect((await context.evaluate(measure)).fits, "the context line must fit its box").toBe(true);
      expect(await page.getByRole("progressbar").count(), "no attendance bar for a time-based degree").toBe(0);
      expect(await page.getByText("12", { exact: true }).count(), "no bare attendance count").toBe(0);
      expect(await page.locator("main").innerText(), "no fraction").not.toMatch(/\d+ \/ \d+/);
      const notThis = await page.getByRole("button", { name: "Not this class?" }).evaluate(measure);
      expect(notThis.h).toBeGreaterThanOrEqual(60);
      const scrolls = await page.evaluate(() => document.documentElement.scrollHeight > window.innerHeight + 1 || document.documentElement.scrollWidth > window.innerWidth + 1);
      expect(scrolls, "the success screen fits the viewport without scrolling").toBe(false);
    });

    it("the keypad screen fits the tablet without scrolling, and its layout follows the orientation", async () => {
      const page = await openPage(pointer, viewport);
      await openKiosk(page, pointer);
      const size = await page.evaluate(() => ({ h: document.documentElement.scrollHeight, w: document.documentElement.scrollWidth, ih: window.innerHeight, iw: window.innerWidth }));
      expect(size.w, "no horizontal scroll").toBeLessThanOrEqual(size.iw);
      expect(size.h, "the whole keypad screen fits without vertical scrolling").toBeLessThanOrEqual(size.ih);
      const prompt = (await page.getByRole("heading", { level: 1 }).boundingBox())!;
      const pad = (await page.locator("main .grid-cols-3").boundingBox())!;
      if (viewport.landscape) expect(pad.x, "landscape: the keypad is in its own column beside the prompt").toBeGreaterThanOrEqual(prompt.x + prompt.width - 1);
      else expect(pad.y, "portrait and phone: the keypad is under the prompt").toBeGreaterThan(prompt.y + prompt.height - 1);
    });

    it("says how many digits are in for assistive technology as they are pressed", async () => {
      const page = await openPage(pointer, viewport);
      await openKiosk(page, pointer);
      await page.getByText("0 of 4 digits entered").waitFor({ state: "attached" });
      await page.getByRole("button", { name: "1", exact: true }).click();
      await page.getByRole("button", { name: "2", exact: true }).click();
      await page.getByText("2 of 4 digits entered").waitFor({ state: "attached" });
      expect(await page.getByText("2 of 4 digits entered").getAttribute("aria-live")).toBe("polite");
    });

    it("the timeout bar drains over the real timeout (6 s for a confirmation, 30 s for the picker) and disappears for reduced motion", async () => {
      const page = await openPage(pointer, viewport);
      await page.route("**/api/kiosk/check-in", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(COMPLETE_CHECK_IN) }));
      await openKiosk(page, pointer);
      await submitCode(page);
      const bar = page.getByTestId("kiosk-timeout");
      await bar.waitFor();
      expect(await bar.getAttribute("data-timeout-ms")).toBe("6000");
      expect(await bar.locator("div").evaluate((el) => getComputedStyle(el).animationDuration), "the animation runs for exactly the timeout").toBe("6s");
      await page.emulateMedia({ reducedMotion: "reduce" });
      expect(await bar.isVisible(), "no moving bar for people who ask for reduced motion").toBe(false);

      const picker = await openPage(pointer, viewport);
      await picker.route("**/api/kiosk/check-in", (route) =>
        route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ ok: false, error: "class_selection_required", openClasses: OPEN_CLASSES }) }),
      );
      await openKiosk(picker, pointer);
      await submitCode(picker);
      await picker.getByTestId("kiosk-timeout").waitFor();
      expect(await picker.getByTestId("kiosk-timeout").getAttribute("data-timeout-ms")).toBe("30000");
      expect(await picker.getByTestId("kiosk-timeout").locator("div").evaluate((el) => getComputedStyle(el).animationDuration)).toBe("30s");
    });

    it("shows an Offline indicator in the banner while the browser is offline, and removes it when it is back", async () => {
      const page = await openPage(pointer, viewport);
      await openKiosk(page, pointer);
      const chip = page.getByText("Offline", { exact: true });
      expect(await chip.count()).toBe(0);
      await page.context().setOffline(true);
      await chip.waitFor({ state: "visible" });
      await page.context().setOffline(false);
      await chip.waitFor({ state: "detached" });
    });
  });
});

// A width long enough to need a line break on its own (no spaces), the same shape that caused the Entry
// open-now panel to push the whole page into horizontal scroll before this fix.
const UNBROKEN_OPEN_CLASS_NAME = "Superultraheavyweightdivisionintermediateclassforadults";
const ENTRY_OPEN_CLASSES_WITH_UNBROKEN_NAME = [
  { id: "e1", name: "Fundamentals", startTime: "09:00", endTime: "10:30", type: "GI" },
  { id: "e2", name: "Advanced", startTime: "09:05", endTime: "10:35", type: "GI" },
  { id: "e3", name: UNBROKEN_OPEN_CLASS_NAME, startTime: "09:10", endTime: "10:40", type: "KIDS" },
];

describe.each([
  { name: "320px portrait", width: 320, height: 690 },
  { name: "390px portrait", width: 390, height: 844 },
  { name: "1280px landscape", width: 1280, height: 800 },
])("Entry open-now panel at $name", (viewport) => {
  it("never pushes the page into horizontal scroll, even with an unbroken long class name among several open classes", async () => {
    // document.documentElement.clientWidth (not window.innerWidth): clientWidth excludes the vertical
    // scrollbar's own width, so it is the real available content width. Comparing scrollWidth against
    // innerWidth instead would have silently passed on a genuine few-pixel overflow this exact bug produced
    // (the vertical scrollbar happened to absorb just enough of the gap to hide it from that weaker check).
    const page = await openPage(POINTERS[0], viewport);
    await page.route("**/api/kiosk/open-classes", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, openClasses: ENTRY_OPEN_CLASSES_WITH_UNBROKEN_NAME, refreshAt: new Date(Date.now() + 60_000).toISOString(), serverNow: new Date().toISOString() }),
      }),
    );
    await openKiosk(page, POINTERS[0]);
    const panel = page.getByTestId("kiosk-open-now");
    await panel.waitFor();
    const names = page.getByTestId("kiosk-open-now-names");
    // complete names preserved, in order, joined by " · " — no truncation
    expect(await names.textContent()).toBe("Fundamentals · Advanced · " + UNBROKEN_OPEN_CLASS_NAME);
    const sizes = await page.evaluate(() => ({ clientWidth: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth }));
    expect(sizes.scrollWidth, `document must not need more width (${sizes.scrollWidth}) than it actually has (${sizes.clientWidth})`).toBeLessThanOrEqual(sizes.clientWidth);
    // the panel's own text must still fit inside its own box (no clipping) and the keypad stays reachable
    const nameMeasure = await names.evaluate(measure);
    expect(nameMeasure.fits, "the open-now names must fit inside their own box, not just inside the page").toBe(true);
    const keyOne = page.getByRole("button", { name: "1", exact: true });
    await expect.poll(async () => keyOne.isVisible()).toBe(true);
  });

  it("keeps the snug, content-hugging panel for ordinary short names unchanged", async () => {
    const page = await openPage(POINTERS[0], viewport);
    await page.route("**/api/kiosk/open-classes", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, openClasses: ENTRY_OPEN_CLASSES_WITH_UNBROKEN_NAME.slice(0, 2), refreshAt: new Date(Date.now() + 60_000).toISOString(), serverNow: new Date().toISOString() }),
      }),
    );
    await openKiosk(page, POINTERS[0]);
    const panel = page.getByTestId("kiosk-open-now");
    await panel.waitFor();
    const panelBox = await panel.boundingBox();
    // well short of the 20rem (320px) cap — proves the width fix didn't force the panel to always stretch
    expect(panelBox!.width, "the panel for two short names stays content-sized, not stretched to its max width").toBeLessThan(260);
  });
});

describe.each(POINTERS)("shared Button sizes under a $name pointer", (pointer) => {
  describe.each(VIEWPORTS.slice(0, 2))("$name", (viewport) => {
    const compact = { xs: 28, sm: 32, default: 36, lg: 40, "icon-xs": 28, "icon-sm": 32, icon: 36, "icon-lg": 40 } as const;

    it("compact sizes stay compact with a mouse and grow to 44 (both dimensions for icon buttons) with a coarse pointer", async () => {
      const page = await openPage(pointer, viewport);
      await page.goto(`${SMOKE_BASE_URL}/en/dev/components`, { waitUntil: "networkidle" });
      await page.getByTestId("button-sizes").waitFor();
      await assertPointer(page, pointer);
      for (const [size, fine] of Object.entries(compact)) {
        const m = await page.getByTestId(`size-${size}`).evaluate(measure);
        const isIcon = size.startsWith("icon");
        if (pointer.coarse) {
          expect(Math.round(m.h), `${size} height`).toBe(44);
          if (isIcon) expect(Math.round(m.w), `${size} width`).toBe(44);
        } else {
          expect(Math.round(m.h), `${size} height`).toBe(fine);
          if (isIcon) expect(Math.round(m.w), `${size} width`).toBe(fine);
        }
        expect(m.fits, `${size} must contain its content`).toBe(true);
      }
    });

    it("an explicit larger size and an auto-height multi-line control keep their own size on both pointers", async () => {
      const page = await openPage(pointer, viewport);
      await page.goto(`${SMOKE_BASE_URL}/en/dev/components`, { waitUntil: "networkidle" });
      await page.getByTestId("button-sizes").waitFor();
      await assertPointer(page, pointer);
      const large = await page.getByTestId("explicit-large").evaluate(measure);
      expect(Math.round(large.h), "h-20 button height").toBe(80);
      expect(Math.round(large.w), "w-28 button width").toBe(112);
      const multi = await page.getByTestId("auto-height-multiline").evaluate(measure);
      expect(multi.h, "auto-height multi-line control height").toBeGreaterThan(60);
      expect(multi.fits, "auto-height multi-line control must contain its text").toBe(true);
    });
  });
});
