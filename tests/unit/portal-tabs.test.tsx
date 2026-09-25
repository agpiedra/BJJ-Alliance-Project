/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import enMessages from "../../messages/en.json";
import esMessages from "../../messages/es.json";
import { PortalTabs } from "../../src/app/[locale]/portal/portal-tabs";
import { ViewFullHistoryLink } from "../../src/app/[locale]/portal/view-history-link";

/**
 * The portal's three views as accessible tabs (WAI-ARIA tabs pattern): roles and relationships, keyboard (Left/Right wrap, Home/End,
 * Tab enters the panel), hash sync (deep link, back button, the "View full history" link), and the property the design depends on: every
 * view stays MOUNTED while hidden, so the attendance history keeps what it loaded and the check-in card keeps its state.
 */
function Counter({ label }: { label: string }) {
  const [n, setN] = useState(0);
  return (
    <button type="button" onClick={() => setN((v) => v + 1)}>
      {label}: {n}
    </button>
  );
}

function renderTabs(locale: "en" | "es" = "en") {
  const messages = locale === "en" ? enMessages : esMessages;
  const labels = { home: messages.portal.nav.home, attendance: messages.portal.nav.attendance, schedule: messages.portal.nav.schedule };
  return render(
    <NextIntlClientProvider locale={locale} messages={messages}>
      <PortalTabs
        listLabel={messages.portal.nav.label}
        labels={labels}
        panels={{
          home: (
            <div>
              <Counter label="home counter" />
              <ViewFullHistoryLink>{messages.portal.recent.viewAll}</ViewFullHistoryLink>
            </div>
          ),
          attendance: <Counter label="history counter" />,
          schedule: <p>schedule content</p>,
        }}
      />
    </NextIntlClientProvider>,
  );
}

const tab = (name: string) => screen.getByRole("tab", { name });

describe.each(["en", "es"] as const)("portal tabs (%s)", (locale) => {
  const names = locale === "en" ? ["Home", "Attendance", "Schedule"] : ["Inicio", "Asistencia", "Horario"];

  beforeEach(() => {
    window.location.hash = "";
  });
  afterEach(cleanup);

  it("is a labelled tablist with three tabs, the first selected, each controlling a labelled tabpanel", () => {
    renderTabs(locale);
    const list = screen.getByRole("tablist", { name: locale === "en" ? "Portal sections" : "Secciones del portal" });
    expect(list).toBeTruthy();
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((t) => t.textContent)).toEqual(names);
    expect(tabs.map((t) => t.getAttribute("aria-selected"))).toEqual(["true", "false", "false"]);
    // roving tabindex: only the selected tab is in the tab order
    expect(tabs.map((t) => t.getAttribute("tabindex"))).toEqual(["0", "-1", "-1"]);
    for (const t of tabs) {
      const panel = document.getElementById(t.getAttribute("aria-controls")!)!;
      expect(panel.getAttribute("role")).toBe("tabpanel");
      expect(panel.getAttribute("aria-labelledby")).toBe(t.id);
    }
    const visible = screen.getAllByRole("tabpanel");
    expect(visible).toHaveLength(1); // hidden panels are out of the accessibility tree
    expect(visible[0].id).toBe("portal-panel-home");
  });

  it("Left/Right move focus and activate, wrapping at both ends; Home and End jump", () => {
    renderTabs(locale);
    tab(names[0]).focus();
    fireEvent.keyDown(tab(names[0]), { key: "ArrowRight" });
    expect(document.activeElement).toBe(tab(names[1]));
    expect(tab(names[1]).getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(tab(names[1]), { key: "ArrowRight" });
    fireEvent.keyDown(tab(names[2]), { key: "ArrowRight" }); // wraps to the first
    expect(document.activeElement).toBe(tab(names[0]));
    fireEvent.keyDown(tab(names[0]), { key: "ArrowLeft" }); // wraps to the last
    expect(document.activeElement).toBe(tab(names[2]));
    fireEvent.keyDown(tab(names[2]), { key: "Home" });
    expect(document.activeElement).toBe(tab(names[0]));
    fireEvent.keyDown(tab(names[0]), { key: "End" });
    expect(document.activeElement).toBe(tab(names[2]));
    expect(tab(names[2]).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByText("schedule content")).toBeTruthy();
  });

  it("other keys do nothing (Tab and Enter stay native), and the panel itself is focusable so Tab enters it", () => {
    renderTabs(locale);
    fireEvent.keyDown(tab(names[0]), { key: "a" });
    expect(tab(names[0]).getAttribute("aria-selected")).toBe("true");
    expect(document.getElementById("portal-panel-home")!.getAttribute("tabindex")).toBe("0");
  });

  it("clicking a tab selects it and puts it in the URL hash (a shareable, back-button-friendly view)", async () => {
    renderTabs(locale);
    fireEvent.click(tab(names[1]));
    expect(tab(names[1]).getAttribute("aria-selected")).toBe("true");
    await waitFor(() => expect(window.location.hash).toBe("#attendance"));
  });

  it("opens the view named by the hash on load, and follows the hash when it changes (back / forward)", async () => {
    window.location.hash = "#schedule";
    renderTabs(locale);
    await waitFor(() => expect(tab(names[2]).getAttribute("aria-selected")).toBe("true"));
    act(() => {
      window.location.hash = "#attendance";
    });
    await waitFor(() => expect(tab(names[1]).getAttribute("aria-selected")).toBe("true"));
    act(() => {
      window.location.hash = "#nonsense";
    });
    await waitFor(() => expect(tab(names[0]).getAttribute("aria-selected")).toBe("true")); // an unknown hash is Home
  });

  it("keeps every view mounted: state inside a hidden view survives switching away and back", () => {
    renderTabs(locale);
    fireEvent.click(screen.getByText(/home counter/));
    fireEvent.click(screen.getByText(/home counter/));
    expect(screen.getByText("home counter: 2")).toBeTruthy();
    fireEvent.click(tab(names[1]));
    fireEvent.click(screen.getByText(/history counter/));
    fireEvent.click(tab(names[0]));
    expect(screen.getByText("home counter: 2")).toBeTruthy();
    fireEvent.click(tab(names[1]));
    expect(screen.getByText("history counter: 1")).toBeTruthy();
  });

  it('the "View full history" link opens Attendance and moves focus into that view', async () => {
    renderTabs(locale);
    const link = screen.getByRole("link", { name: locale === "en" ? "View full history" : "Ver historial completo" });
    expect(link.getAttribute("href")).toBe("#attendance"); // a real link, so it also works without the tabs
    fireEvent.click(link);
    expect(tab(names[1]).getAttribute("aria-selected")).toBe("true");
    await waitFor(() => expect(document.activeElement).toBe(document.getElementById("portal-panel-attendance")));
  });
});
