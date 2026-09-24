/** @vitest-environment jsdom */
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import enMessages from "../../messages/en.json";
import esMessages from "../../messages/es.json";
import type { TodaysClass } from "../../src/lib/portal/todays-classes";

/**
 * The portal's "check in to a class" card (PR 3): today's classes, each with its honest state, a check-in button only
 * where the server would accept it, the class id posted explicitly, per-row feedback, and an in-place refresh after
 * success. Real message files, both languages.
 */
const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

const selfCheckIn = vi.fn();
vi.mock("../../src/app/[locale]/portal/self-check-in-action", () => ({
  selfCheckIn: (...args: unknown[]) => selfCheckIn(...args),
}));

const { TodaysClassesCard } = await import("../../src/app/[locale]/portal/todays-classes-card");

const CLASSES: TodaysClass[] = [
  { id: "c-morning", name: "Morning", type: "GI", startTime: "06:00", endTime: "07:00", countsTowardPromotion: true, state: { kind: "closed" } },
  { id: "c-striking", name: "Striking", type: "STRIKING", startTime: "12:00", endTime: "13:00", countsTowardPromotion: false, state: { kind: "closed" } },
  { id: "c-early", name: "Early", type: "NO_GI", startTime: "18:00", endTime: "19:00", countsTowardPromotion: true, state: { kind: "checked_in" } },
  { id: "c-later", name: "Later", type: "GI", startTime: "19:00", endTime: "20:00", countsTowardPromotion: true, state: { kind: "open" } },
  { id: "c-mat", name: "Mat", type: "OPEN_MAT", startTime: "20:00", endTime: "21:00", countsTowardPromotion: true, state: { kind: "not_open_yet", opensAt: "19:30" } },
];

/** By default the next boundary is a day away, so a test that does not care about time never sees a refresh. */
function renderCard(locale: "en" | "es", classes: TodaysClass[], timing?: { serverNow: string; nextChangeAt: string }) {
  const messages = locale === "en" ? enMessages : esMessages;
  const now = Date.now();
  const { serverNow, nextChangeAt } = timing ?? { serverNow: new Date(now).toISOString(), nextChangeAt: new Date(now + 86_400_000).toISOString() };
  return render(
    <NextIntlClientProvider locale={locale} messages={messages}>
      <TodaysClassesCard organizationId="org-1" classes={classes} serverNow={serverNow} nextChangeAt={nextChangeAt} />
    </NextIntlClientProvider>,
  );
}

beforeEach(() => {
  refresh.mockClear();
  selfCheckIn.mockReset();
});

describe("TodaysClassesCard", () => {
  it("shows every class with its time, its real modality and an honest state (English)", () => {
    renderCard("en", CLASSES);
    const items = within(screen.getByRole("list", { name: "Today's classes" })).getAllByRole("listitem");
    expect(items).toHaveLength(5);
    const byName = (name: string) => items.find((li) => li.textContent?.includes(name))!;

    expect(byName("Morning")).toHaveTextContent("06:00 – 07:00");
    expect(byName("Morning")).toHaveTextContent("Closed");
    expect(byName("Early")).toHaveTextContent("Attendance recorded");
    expect(byName("Later")).toHaveTextContent("Open now");
    expect(byName("Mat")).toHaveTextContent("Opens at 19:30");
    // Real modalities, nothing relabelled GI/No-Gi:
    expect(byName("Striking")).toHaveTextContent("Striking");
    expect(byName("Mat")).toHaveTextContent("Open Mat");
    expect(byName("Early")).toHaveTextContent("No-Gi");
    // A class that does not count toward promotion says so.
    expect(byName("Striking")).toHaveTextContent("Does not count toward promotion");
    expect(byName("Later")).not.toHaveTextContent("Does not count");
  });

  it("offers a check-in button ONLY on the open class, with an accessible name that says which class and when", () => {
    renderCard("en", CLASSES);
    const buttons = screen.getAllByRole("button");
    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toHaveAccessibleName("Check in to Later at 19:00");
  });

  it("is fully translated: the same list in Spanish", () => {
    renderCard("es", CLASSES);
    const items = within(screen.getByRole("list", { name: "Clases de hoy" })).getAllByRole("listitem");
    const byName = (name: string) => items.find((li) => li.textContent?.includes(name))!;
    expect(byName("Morning")).toHaveTextContent("Cerrada");
    expect(byName("Early")).toHaveTextContent("Asistencia registrada");
    expect(byName("Later")).toHaveTextContent("Abierta ahora");
    expect(byName("Mat")).toHaveTextContent("Abre a las 19:30");
    expect(byName("Striking")).toHaveTextContent("No cuenta para la promoción");
    expect(screen.getByRole("button")).toHaveAccessibleName("Registrar asistencia en Later a las 19:00");
  });

  it("explains a day with no classes instead of showing an empty card", () => {
    renderCard("en", []);
    expect(screen.getByText("There are no classes today. Check the weekly schedule below.")).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Today's classes" })).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("states the availability rule once, above the list (until 30 minutes after the class ENDS), in both languages", () => {
    const { unmount } = renderCard("en", CLASSES);
    expect(screen.getByText("You can check in from 30 minutes before a class starts until 30 minutes after it ends.")).toBeInTheDocument();
    unmount();
    renderCard("es", CLASSES);
    expect(screen.getByText("Puedes registrar tu asistencia desde 30 minutos antes de que empiece la clase hasta 30 minutos después de que termine.")).toBeInTheDocument();
  });

  it("posts the EXACT class id of the row that was clicked", async () => {
    selfCheckIn.mockResolvedValue({ error: "class_not_open" });
    renderCard("en", CLASSES);
    fireEvent.click(screen.getByRole("button", { name: "Check in to Later at 19:00" }));
    await waitFor(() => expect(selfCheckIn).toHaveBeenCalledTimes(1));
    const [orgId, , formData] = selfCheckIn.mock.calls[0] as [string, unknown, FormData];
    expect(orgId).toBe("org-1");
    expect(formData.get("classSessionId")).toBe("c-later");
  });

  it("shows a refusal on the row that was submitted, in the student's language", async () => {
    selfCheckIn.mockResolvedValue({ error: "class_not_open" });
    renderCard("es", CLASSES);
    fireEvent.click(screen.getByRole("button"));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Esa clase no está abierta para registrar asistencia en este momento.");
    expect(within(screen.getAllByRole("listitem").find((li) => li.textContent?.includes("Later"))!).getByRole("alert")).toBe(alert);
    // A refusal means the screen was stale: the card re-reads the truth from the server.
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it("on success shows the truthful result and refreshes the page data in place (no full reload)", async () => {
    selfCheckIn.mockResolvedValue({
      ok: true,
      classSessionId: "c-later",
      student: { firstName: "A", lastName: "B", currentBelt: "WHITE", currentStripes: 0 },
      progressOutcome: "already_counted_today",
      thresholdReached: false,
      summary: {
        currentBelt: "WHITE", currentBeltLabelEs: "Blanco", currentBeltLabelEn: "White", currentBeltVisual: {}, currentStripes: 0, atBeltCount: 3, creditedClasses: 0, lifetimeCount: 3,
        attendancesPerStripe: 30, maxStripes: 4, attendancesForExam: 30, nextTarget: "STRIPE", remainingAttendance: 27, isEligible: false, accounting: "PER_INTERVAL", target: 30, percent: 10,
        timeAnchorMissing: false, notConfigured: false, reachedOn: null, progressBaselineAt: new Date(), progressBaselineKind: "SYSTEM_BASELINE", mode: "ATTENDANCE", dueDate: null,
        currentRankId: "r", track: "ADULT", currentRankOrder: 1,
      },
    });
    renderCard("en", CLASSES);
    await act(async () => {
      fireEvent.click(screen.getByRole("button"));
    });
    expect(await screen.findByText("You're checked in!")).toBeInTheDocument();
    expect(screen.getByText("Class recorded. Today's attendance already counted toward your progress, so this one adds nothing more.")).toBeInTheDocument();
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });
});

/**
 * Time-driven availability (PR 3 follow-up): the page left open must move from "opens at" to open to closed, and
 * roll over at Costa Rica midnight, WITHOUT a manual reload. The server hands the card the next instant the list can
 * change (`nextChangeAt`) and its own clock (`serverNow`); the card refreshes the server data at exactly that
 * instant, measured on the SERVER's clock (so a wrong browser clock cannot make it early or late), and again when the
 * tab or window becomes active. Nothing is submitted in any of these tests, and the refresh only re-reads server
 * state: the buttons still come from the server's list and every check-in is re-validated there.
 */
describe("TodaysClassesCard refreshes itself at the boundaries", () => {
  const SERVER_NOW = "2026-01-06T00:00:00.000Z"; // Monday 18:00 CR
  const OPENS = "2026-01-06T00:30:00.000Z"; // 18:30 CR
  const at = (iso: string) => new Date(iso).getTime();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(at(SERVER_NOW));
  });
  afterEach(() => {
    vi.useRealTimers();
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  });

  const advance = async (ms: number) => {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  };

  it("does nothing before the boundary and refreshes exactly once when it is reached", async () => {
    renderCard("en", CLASSES, { serverNow: SERVER_NOW, nextChangeAt: OPENS });
    await advance(29 * 60_000 + 59_000); // 29:59 in
    expect(refresh).not.toHaveBeenCalled();
    await advance(2_000); // past 30:00
    expect(refresh).toHaveBeenCalledTimes(1);
    await advance(60 * 60_000); // nothing else is scheduled by the same props
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("measures the boundary on the SERVER's clock: a browser clock 10 minutes fast does not make it early", async () => {
    vi.setSystemTime(at(SERVER_NOW) + 10 * 60_000); // the browser thinks it is already 18:10
    renderCard("en", CLASSES, { serverNow: SERVER_NOW, nextChangeAt: OPENS });
    await advance(20 * 60_000); // the browser's clock now says 18:30, the server's says 18:20
    expect(refresh).not.toHaveBeenCalled();
    await advance(10 * 60_000 + 2_000);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("measures it on the server's clock when the browser clock is SLOW too (it does not wait for its own 18:30)", async () => {
    vi.setSystemTime(at(SERVER_NOW) - 10 * 60_000); // the browser thinks it is 17:50
    renderCard("en", CLASSES, { serverNow: SERVER_NOW, nextChangeAt: OPENS });
    await advance(30 * 60_000 + 2_000); // 30 minutes after render = the server's 18:30
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("refreshes when the tab becomes visible again after the boundary passed while it was asleep (timers frozen)", async () => {
    renderCard("en", CLASSES, { serverNow: SERVER_NOW, nextChangeAt: OPENS });
    vi.setSystemTime(at(OPENS) + 5 * 60_000); // the laptop slept through the boundary: the clock moved, no timer ran
    expect(refresh).not.toHaveBeenCalled();
    await act(async () => {
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("refreshes when the window regains focus after the boundary, and does NOT when the boundary has not passed yet", async () => {
    renderCard("en", CLASSES, { serverNow: SERVER_NOW, nextChangeAt: OPENS });
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(refresh).not.toHaveBeenCalled(); // 18:00 - still before 18:30
    vi.setSystemTime(at(OPENS) + 1_000);
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("a hidden tab does not refresh on the visibility event (only when it becomes visible)", async () => {
    renderCard("en", CLASSES, { serverNow: SERVER_NOW, nextChangeAt: OPENS });
    vi.setSystemTime(at(OPENS) + 5 * 60_000);
    await act(async () => {
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(refresh).not.toHaveBeenCalled();
  });

  it("new server data (a later boundary) replaces the old timer: the old boundary does not fire again, the new one does", async () => {
    const { rerender } = renderCard("en", CLASSES, { serverNow: SERVER_NOW, nextChangeAt: OPENS });
    await advance(30 * 60_000 + 2_000);
    expect(refresh).toHaveBeenCalledTimes(1);
    // The refresh delivered fresh props: the next boundary is 19:30:00.001 CR (the class closes).
    rerender(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <TodaysClassesCard organizationId="org-1" classes={CLASSES} serverNow="2026-01-06T00:30:02.000Z" nextChangeAt="2026-01-06T01:30:00.001Z" />
      </NextIntlClientProvider>,
    );
    await advance(59 * 60_000);
    expect(refresh).toHaveBeenCalledTimes(1);
    await advance(2 * 60_000);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("handles the Costa Rica midnight boundary (Monday 23:59:30 -> 00:00): refreshes when the day rolls over", async () => {
    const mon2359 = "2026-01-06T05:59:30.000Z";
    vi.setSystemTime(at(mon2359));
    renderCard("en", CLASSES, { serverNow: mon2359, nextChangeAt: "2026-01-06T06:00:00.000Z" });
    await advance(29_000);
    expect(refresh).not.toHaveBeenCalled();
    await advance(2_000);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("stops when the card unmounts: no refresh after the page is left", async () => {
    const { unmount } = renderCard("en", CLASSES, { serverNow: SERVER_NOW, nextChangeAt: OPENS });
    unmount();
    await advance(60 * 60_000);
    expect(refresh).not.toHaveBeenCalled();
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(refresh).not.toHaveBeenCalled();
  });

  it("server stays authoritative: a click on a row that closed meanwhile is refused by the server, and the card re-syncs", async () => {
    vi.useRealTimers();
    selfCheckIn.mockResolvedValue({ error: "class_not_open" });
    renderCard("en", CLASSES);
    fireEvent.click(screen.getByRole("button", { name: "Check in to Later at 19:00" }));
    await waitFor(() => expect(refresh).toHaveBeenCalled()); // re-reads the truth from the server after the refusal
    expect(await screen.findByRole("alert")).toHaveTextContent("That class isn't open for check-in right now.");
  });
});
