/** @vitest-environment jsdom */
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { beforeEach, describe, expect, it, vi } from "vitest";
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

function renderCard(locale: "en" | "es", classes: TodaysClass[]) {
  const messages = locale === "en" ? enMessages : esMessages;
  return render(
    <NextIntlClientProvider locale={locale} messages={messages}>
      <TodaysClassesCard organizationId="org-1" classes={classes} />
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
    expect(byName("Early")).toHaveTextContent("Checked in");
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

  it("states the availability rule once, above the list", () => {
    renderCard("en", CLASSES);
    expect(screen.getByText("You can check in from 30 minutes before a class starts until 30 minutes after it starts.")).toBeInTheDocument();
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
    expect(refresh).not.toHaveBeenCalled();
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
