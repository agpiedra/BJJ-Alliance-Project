/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import enMessages from "../../messages/en.json";
import esMessages from "../../messages/es.json";
import { ScheduleDayList } from "../../src/app/[locale]/portal/schedule-day-list";
import type { WeekCalendarBlock, WeekCalendarDay } from "@/components/ui/week-calendar";

/**
 * The phone-only day-at-a-time picker as ACCESSIBLE TABS (WAI-ARIA tabs pattern, automatic activation), same
 * convention as `portal-tabs.test.tsx`: roving tabindex, Left/Right wrap, Home/End jump, and the tab/panel
 * id-linking via aria-controls/aria-labelledby. Presentation-only props, so no server/query mocking is needed.
 *
 * MOCKED vs. REAL evidence: jsdom has no ResizeObserver and no real layout engine (offsetLeft/offsetWidth/
 * clientWidth are plain assignable test doubles here, not computed from CSS). The tests below using
 * `MockResizeObserver`/`setGeometry` prove the FIX'S OWN LOGIC - which branch it takes given a geometry, that
 * it reads `isOff` correctly, that it disconnects on unmount - never that a real browser actually renders this
 * correctly. That is proven separately, in a real browser against the isolated test DB (see this project's
 * `design/matroom/verification/portal-schedule-reconciliation/README.md`), not by anything in this file.
 */
class MockResizeObserver {
  static instances: MockResizeObserver[] = [];
  disconnected = false;
  observedEl: Element | null = null;
  constructor(private callback: ResizeObserverCallback) {
    MockResizeObserver.instances.push(this);
  }
  observe(el: Element) {
    this.observedEl = el;
  }
  unobserve() {}
  disconnect() {
    this.disconnected = true;
  }
  /** Simulates a real resize-observer entry (e.g. a `hidden`/`md:hidden` boundary clearing). */
  trigger(width: number) {
    this.callback(
      [{ contentRect: { width } } as ResizeObserverEntry],
      this as unknown as ResizeObserver,
    );
  }
}

/** jsdom computes no real layout - these four properties are plain, independently assignable test doubles on
 * a real DOM element, the standard way to drive layout-dependent component logic in jsdom.
 *
 * `rect` stubs `getBoundingClientRect()` (viewport-relative, as the real fix itself reads) rather
 * than `offsetLeft`/`offsetWidth` - an element's `offsetLeft` is relative to its nearest POSITIONED
 * ancestor, which this tablist (no `position` set) does not establish, so `offsetLeft` resolved
 * against an unrelated ancestor the very first time this fix was checked in a real browser. Mocking
 * `getBoundingClientRect()` instead keeps these tests honest about which coordinate space the real
 * implementation actually uses. */
function setGeometry(el: HTMLElement, geo: { rect?: { left: number; right: number }; clientWidth?: number; scrollLeft?: number }) {
  if (geo.rect !== undefined) {
    const { left, right } = geo.rect;
    el.getBoundingClientRect = () => ({ left, right, width: right - left, top: 0, bottom: 0, height: 0, x: left, y: 0, toJSON: () => ({}) }) as DOMRect;
  }
  if (geo.clientWidth !== undefined) Object.defineProperty(el, "clientWidth", { value: geo.clientWidth, configurable: true });
  if (geo.scrollLeft !== undefined) el.scrollLeft = geo.scrollLeft;
}

const DAYS: WeekCalendarDay[] = [
  { key: "MONDAY", label: "Mon", dateNumber: "22", isOff: true },
  { key: "TUESDAY", label: "Tue", dateNumber: "23", isToday: true },
  { key: "WEDNESDAY", label: "Wed", dateNumber: "24" },
  { key: "THURSDAY", label: "Thu", dateNumber: "25" },
];

const BLOCKS: WeekCalendarBlock[] = [
  { id: "b1", dayKey: "WEDNESDAY", title: "No-Gi", timeLabel: "18:00", startRow: 1, endRow: 2, colorClassName: "bg-class-nogi", meta: "No-Gi class" },
];

const DATE_HEADINGS: Record<string, string> = {
  MONDAY: "Monday, September 22",
  TUESDAY: "Tuesday, September 23",
  WEDNESDAY: "Wednesday, September 24",
  THURSDAY: "Thursday, September 25",
};

function renderList(locale: "en" | "es" = "en") {
  const messages = locale === "en" ? enMessages : esMessages;
  return render(
    <NextIntlClientProvider locale={locale} messages={messages}>
      <ScheduleDayList days={DAYS} blocks={BLOCKS} sundayHasClasses={false} dateHeadings={DATE_HEADINGS} />
    </NextIntlClientProvider>,
  );
}

const tab = (name: RegExp) => screen.getByRole("tab", { name });

describe.each(["en", "es"] as const)("schedule day list (%s)", (locale) => {
  beforeEach(() => {
    MockResizeObserver.instances = [];
    (globalThis as unknown as { ResizeObserver: typeof MockResizeObserver }).ResizeObserver = MockResizeObserver;
  });
  afterEach(cleanup);

  it("is a labelled tablist with a roving tabindex, each tab controlling a labelled tabpanel", () => {
    renderList(locale);
    const list = screen.getByRole("tablist");
    expect(list).toBeTruthy();
    const tabs = screen.getAllByRole("tab");
    expect(tabs).toHaveLength(4);
    // today (Tuesday) is the initial selection, not the first day
    expect(tabs.map((t) => t.getAttribute("aria-selected"))).toEqual(["false", "true", "false", "false"]);
    expect(tabs.map((t) => t.getAttribute("tabindex"))).toEqual(["-1", "0", "-1", "-1"]);
    for (const t of tabs) {
      const panelId = t.getAttribute("aria-controls")!;
      // only the active day's panel exists/is in the tree at a time
      if (t.getAttribute("aria-selected") === "true") {
        const panel = document.getElementById(panelId)!;
        expect(panel.getAttribute("role")).toBe("tabpanel");
        expect(panel.getAttribute("aria-labelledby")).toBe(t.id);
      }
    }
  });

  it("Left/Right move focus and activate, wrapping at both ends; Home and End jump", () => {
    renderList(locale);
    tab(/^Mon/).focus();
    fireEvent.keyDown(tab(/^Mon/), { key: "ArrowRight" });
    expect(document.activeElement).toBe(tab(/^Tue/));
    expect(tab(/^Tue/).getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(tab(/^Tue/), { key: "ArrowRight" });
    fireEvent.keyDown(tab(/^Wed/), { key: "ArrowRight" });
    fireEvent.keyDown(tab(/^Thu/), { key: "ArrowRight" }); // wraps to the first
    expect(document.activeElement).toBe(tab(/^Mon/));
    fireEvent.keyDown(tab(/^Mon/), { key: "ArrowLeft" }); // wraps to the last
    expect(document.activeElement).toBe(tab(/^Thu/));
    fireEvent.keyDown(tab(/^Thu/), { key: "Home" });
    expect(document.activeElement).toBe(tab(/^Mon/));
    fireEvent.keyDown(tab(/^Mon/), { key: "End" });
    expect(document.activeElement).toBe(tab(/^Thu/));
    expect(tab(/^Thu/).getAttribute("aria-selected")).toBe("true");
  });

  it("activating a day via keyboard shows that day's own full date heading and classes", () => {
    renderList(locale);
    // Tuesday is the initial selection (today). ArrowRight moves to Wednesday, which both focuses AND
    // selects it (schedule-day-list.tsx:17) - no click anywhere in this test.
    tab(/^Tue/).focus();
    fireEvent.keyDown(tab(/^Tue/), { key: "ArrowRight" });
    expect(document.activeElement).toBe(tab(/^Wed/));
    expect(tab(/^Wed/).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByText("Wednesday, September 24")).toBeTruthy();
    expect(screen.getByText("No-Gi")).toBeTruthy();
  });

  it("clicking an empty day shows the explicit no-classes message, never an abbreviated heading", () => {
    renderList(locale);
    fireEvent.click(tab(/^Mon/));
    expect(tab(/^Mon/).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByText("Monday, September 22")).toBeTruthy();
    expect(screen.getByText(locale === "en" ? "No classes that day." : "No hay clases ese día.")).toBeTruthy();
  });

  it("other keys do nothing (Tab and Enter stay native)", () => {
    renderList(locale);
    fireEvent.keyDown(tab(/^Tue/), { key: "a" });
    expect(tab(/^Tue/).getAttribute("aria-selected")).toBe("true");
  });

  it("shows a has-classes dot on every day except the one with isOff, reading WeekCalendarDay.isOff directly - no separate hasClasses state", () => {
    renderList(locale);
    const dot = (t: HTMLElement) => t.querySelector('span[aria-hidden="true"]');
    expect(dot(tab(/^Mon/))).toBeNull(); // Monday: isOff: true - no dot
    expect(dot(tab(/^Tue/))).not.toBeNull();
    expect(dot(tab(/^Wed/))).not.toBeNull();
    expect(dot(tab(/^Thu/))).not.toBeNull();
  });

  it("renders a class as a bordered card with its own colored left bar and localized type meta line, never as a solid-colored block", () => {
    renderList(locale);
    fireEvent.click(tab(/^Wed/));
    const item = screen.getByText("No-Gi").closest("li")!;
    expect(item.className).toContain("border-border");
    expect(item.className).toContain("bg-card");
    expect(item.className).not.toContain("text-white"); // the old solid-block treatment
    const bar = item.querySelector("span.bg-class-nogi");
    expect(bar).not.toBeNull();
    expect(screen.getByText("No-Gi class")).toBeTruthy(); // the real meta text, not invented eligibility wording
  });

  it("MOCKED: observes the tablist on mount and disconnects on unmount (lifecycle, not real layout)", () => {
    const { unmount } = renderList(locale);
    expect(MockResizeObserver.instances).toHaveLength(1);
    const ro = MockResizeObserver.instances[0]!;
    expect(ro.observedEl).toBe(screen.getByRole("tablist"));
    expect(ro.disconnected).toBe(false);
    unmount();
    expect(ro.disconnected).toBe(true);
  });

  it("MOCKED: a hidden-to-visible transition scrolls an out-of-view selected tab into view by adjusting ONLY the tablist's own scrollLeft", () => {
    renderList(locale);
    const tablist = screen.getByRole("tablist");
    const selectedTab = tab(/^Tue/); // today, the initial selection
    // Today's tab sits to the right of the visible range - mirrors the real narrow-width defect.
    // scrollLeft is still 0, so the tab's viewport-relative rect IS its content-relative position.
    setGeometry(tablist, { clientWidth: 100, scrollLeft: 0 });
    setGeometry(selectedTab, { rect: { left: 150, right: 210 } });
    const ro = MockResizeObserver.instances[0]!;
    ro.trigger(100); // becomes visible: width goes from 0 (jsdom default) to 100
    expect(tablist.scrollLeft).toBe(210 - 100); // nearest edge, not centered
  });

  it("MOCKED: does not move scrollLeft when the selected tab is already fully visible - never recenters an already-visible tab", () => {
    renderList(locale);
    const tablist = screen.getByRole("tablist");
    const selectedTab = tab(/^Tue/);
    setGeometry(tablist, { clientWidth: 400, scrollLeft: 20 });
    // Already scrolled 20px in: a content-relative position of [50, 110] renders, viewport-relative, at
    // [50-20, 110-20] = [30, 90] - fully inside the visible [20, 420] window either way.
    setGeometry(selectedTab, { rect: { left: 30, right: 90 } });
    const ro = MockResizeObserver.instances[0]!;
    ro.trigger(400);
    expect(tablist.scrollLeft).toBe(20); // untouched
  });

  it("MOCKED: the visibility correction never touches page scroll position or keyboard focus", () => {
    renderList(locale);
    const tablist = screen.getByRole("tablist");
    const selectedTab = tab(/^Tue/);
    setGeometry(tablist, { clientWidth: 100, scrollLeft: 0 });
    setGeometry(selectedTab, { rect: { left: 150, right: 210 } });
    // jsdom has no real scrolling (`window.scrollTo` is a documented no-op there) - set the page's
    // scroll position directly so the assertion below is checking OUR fix, not jsdom's limitation.
    Object.defineProperty(window, "scrollY", { value: 500, configurable: true });
    document.body.focus();
    const activeBefore = document.activeElement;
    const ro = MockResizeObserver.instances[0]!;
    ro.trigger(100);
    expect(window.scrollY).toBe(500); // page scroll unchanged
    expect(document.activeElement).toBe(activeBefore); // focus unchanged
  });
});
