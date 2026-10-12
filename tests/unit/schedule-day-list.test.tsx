/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, describe, expect, it } from "vitest";
import enMessages from "../../messages/en.json";
import esMessages from "../../messages/es.json";
import { ScheduleDayList } from "../../src/app/[locale]/portal/schedule-day-list";
import type { WeekCalendarBlock, WeekCalendarDay } from "@/components/ui/week-calendar";

/**
 * The phone-only day-at-a-time picker as ACCESSIBLE TABS (WAI-ARIA tabs pattern, automatic activation), same
 * convention as `portal-tabs.test.tsx`: roving tabindex, Left/Right wrap, Home/End jump, and the tab/panel
 * id-linking via aria-controls/aria-labelledby. Presentation-only props, so no server/query mocking is needed.
 */
const DAYS: WeekCalendarDay[] = [
  { key: "MONDAY", label: "Mon", dateNumber: "22" },
  { key: "TUESDAY", label: "Tue", dateNumber: "23", isToday: true },
  { key: "WEDNESDAY", label: "Wed", dateNumber: "24" },
  { key: "THURSDAY", label: "Thu", dateNumber: "25" },
];

const BLOCKS: WeekCalendarBlock[] = [
  { id: "b1", dayKey: "WEDNESDAY", title: "No-Gi", timeLabel: "18:00", startRow: 1, endRow: 2, colorClassName: "bg-class-nogi" },
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
    tab(/^Wed/).focus();
    fireEvent.keyDown(tab(/^Mon/), { key: "ArrowRight" }); // start from Monday: Right -> Tuesday, so go via click first
    fireEvent.click(tab(/^Wed/));
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
});
