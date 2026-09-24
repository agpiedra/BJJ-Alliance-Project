/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import enMessages from "../../messages/en.json";
import esMessages from "../../messages/es.json";

/**
 * The kiosk screen for the two owner-approved rules: when SEVERAL classes are open the student is asked which one they
 * attended BEFORE anything is written (name, scheduled range, real class type); cancelling writes nothing; a class that
 * closed while the picker was up is explained and the choices are refreshed; with no class open check-in is unavailable
 * and a coach can record the attendance; offline, a recorded selection travels with the queued entry. The server is the
 * authority (tests/integration/kiosk-window-rules.test.ts); this pins what the screen shows and sends.
 */
const enqueue = vi.fn();
const flush = vi.fn();
vi.mock("@/lib/kiosk/offline-queue", () => ({
  enqueueOfflineCheckIn: (...args: unknown[]) => enqueue(...args),
  flushOfflineQueue: () => flush(),
}));

const { KioskClient } = await import("../../src/app/[locale]/kiosk/[academySlug]/kiosk-client");

const CLASS_A = { id: "cls-a", name: "Fundamentals", startTime: "18:00", endTime: "19:00", type: "GI" };
const CLASS_B = { id: "cls-b", name: "Advanced No-Gi", startTime: "19:00", endTime: "20:00", type: "NO_GI" };

const fetchMock = vi.fn();
const respond = (status: number, body: unknown) => Promise.resolve({ status, json: async () => body } as Response);

function successBody(matched: typeof CLASS_B, canCorrect: boolean) {
  return {
    ok: true,
    student: {
      firstName: "Carla",
      lastName: "Cartago",
      currentBelt: "WHITE",
      currentBeltVisual: { primaryColor: "#F0EBE0", centerStripeColor: null, barColor: "#111116", stripeColors: ["#000", "#000", "#000", "#000"], maxStripes: 4, visibleStripeSlots: 4 },
      currentBeltLabelEs: "Blanco",
      currentBeltLabelEn: "White",
      currentStripes: 0,
    },
    summary: { atBeltCount: 1, remainingAttendance: 29, isEligible: false, nextTarget: "STRIPE", mode: "ATTENDANCE", target: 30, percent: 3, timeAnchorMissing: false, notConfigured: false, reachedOn: null },
    thresholdReached: false,
    progressOutcome: "counted",
    isVisitor: false,
    homeAcademyName: "Heredia",
    attendanceRecordId: "att-1",
    canCorrect,
    matchedClass: { id: matched.id, name: matched.name, dayOfWeek: "MONDAY", startTime: matched.startTime },
  };
}

function renderKiosk(locale: "en" | "es" = "en") {
  return render(
    <NextIntlClientProvider locale={locale} messages={locale === "en" ? enMessages : esMessages}>
      <KioskClient academyId="acad-1" academyName="Heredia" academySlug="heredia" token="tok" />
    </NextIntlClientProvider>,
  );
}

async function enterCode(locale: "en" | "es" = "en") {
  for (const digit of ["1", "2", "3", "4"]) fireEvent.click(screen.getByRole("button", { name: digit }));
  fireEvent.click(screen.getByRole("button", { name: locale === "en" ? "Enter" : "Entrar" }));
}

const bodies = () => fetchMock.mock.calls.map(([, init]) => JSON.parse((init as RequestInit).body as string) as Record<string, unknown>);

beforeEach(() => {
  fetchMock.mockReset();
  enqueue.mockReset();
  flush.mockReset();
  flush.mockResolvedValue({ dropped: 0 });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("several classes are open: the student is asked BEFORE anything is written", () => {
  it("shows every open class with its name, scheduled range and real class type, and has sent only the one request that asked", async () => {
    fetchMock.mockReturnValueOnce(respond(400, { ok: false, error: "class_selection_required", openClasses: [CLASS_A, CLASS_B] }));
    renderKiosk();
    await enterCode();

    expect(await screen.findByRole("heading", { name: "Which class did you attend?" })).toBeTruthy();
    expect(screen.getByText("More than one class is open right now. Pick the one you attended to save your attendance.")).toBeTruthy();
    const rowA = screen.getByRole("button", { name: /Fundamentals/ });
    expect(within(rowA).getByText("Gi")).toBeTruthy();
    expect(within(rowA).getByText("18:00 – 19:00")).toBeTruthy();
    const rowB = screen.getByRole("button", { name: /Advanced No-Gi/ });
    expect(within(rowB).getByText("No-Gi")).toBeTruthy();
    expect(within(rowB).getByText("19:00 – 20:00")).toBeTruthy();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(bodies()[0].pickedClassSessionId).toBeUndefined(); // the first request carried no selection
  });

  it("cancelling returns to the keypad and sends NOTHING more (no attendance is created)", async () => {
    fetchMock.mockReturnValueOnce(respond(400, { ok: false, error: "class_selection_required", openClasses: [CLASS_A, CLASS_B] }));
    renderKiosk();
    await enterCode();
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));

    expect(await screen.findByText("Enter your 4-digit code")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("choosing a class re-submits the code WITH exactly that class, and shows the confirmation naming it", async () => {
    fetchMock
      .mockReturnValueOnce(respond(400, { ok: false, error: "class_selection_required", openClasses: [CLASS_A, CLASS_B] }))
      .mockReturnValueOnce(respond(200, successBody(CLASS_B, true)));
    renderKiosk();
    await enterCode();
    fireEvent.click(await screen.findByRole("button", { name: /Advanced No-Gi/ }));

    expect(await screen.findByText("Advanced No-Gi")).toBeTruthy();
    expect(screen.getByText("Attendance saved to")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(bodies()[1]).toMatchObject({ academySlug: "heredia", token: "tok", code: "1234", pickedClassSessionId: "cls-b" });
  });

  it("a class that closed while the picker was open is explained, and the choices are REFRESHED (only what is open now)", async () => {
    fetchMock
      .mockReturnValueOnce(respond(400, { ok: false, error: "class_selection_required", openClasses: [CLASS_A, CLASS_B] }))
      .mockReturnValueOnce(respond(400, { ok: false, error: "class_not_open", openClasses: [CLASS_B] }));
    renderKiosk();
    await enterCode();
    fireEvent.click(await screen.findByRole("button", { name: /Fundamentals/ }));

    expect(await screen.findByText("That class just closed. These are the classes open now.")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Advanced No-Gi/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Fundamentals/ })).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2); // nothing was recorded
  });

  it("if the chosen class closed and nothing is open any more, the student is told check-in is unavailable and a coach can record it", async () => {
    fetchMock
      .mockReturnValueOnce(respond(400, { ok: false, error: "class_selection_required", openClasses: [CLASS_A, CLASS_B] }))
      .mockReturnValueOnce(respond(400, { ok: false, error: "class_not_open", openClasses: [] }));
    renderKiosk();
    await enterCode();
    fireEvent.click(await screen.findByRole("button", { name: /Fundamentals/ }));
    expect(await screen.findByText("Check-in isn't available right now: no class is open. Ask a coach to record your attendance.")).toBeTruthy();
  });

  it("is fully translated: the Spanish picker shows the class type in Spanish and a Spanish cancel", async () => {
    fetchMock.mockReturnValueOnce(respond(400, { ok: false, error: "class_selection_required", openClasses: [{ ...CLASS_A, type: "KIDS" }, CLASS_B] }));
    renderKiosk("es");
    await enterCode("es");
    expect(await screen.findByText(esMessages.kiosk.pickClassDescription)).toBeTruthy();
    expect(screen.getByText(esMessages.classType.KIDS)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cancelar" })).toBeTruthy();
  });
});

describe("no class is open, and the other outcomes", () => {
  it("no_open_class: check-in is unavailable and a coach can record the attendance (English and Spanish); nothing else is sent", async () => {
    fetchMock.mockReturnValueOnce(respond(400, { ok: false, error: "no_open_class" }));
    renderKiosk();
    await enterCode();
    expect(await screen.findByText("Check-in isn't available right now: no class is open. Ask a coach to record your attendance.")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    cleanup();

    fetchMock.mockReset();
    fetchMock.mockReturnValueOnce(respond(400, { ok: false, error: "no_open_class" }));
    renderKiosk("es");
    await enterCode("es");
    expect(await screen.findByText(esMessages.kiosk.noOpenClass)).toBeTruthy();
  });

  it("exactly one open class is checked in without any picker", async () => {
    fetchMock.mockReturnValueOnce(respond(200, successBody(CLASS_A, false)));
    renderKiosk();
    await enterCode();
    expect(await screen.findByText("Attendance saved to")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Which class did you attend?" })).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("'Not this class?' is offered only when another class was open at the same instant", async () => {
    fetchMock.mockReturnValueOnce(respond(200, successBody(CLASS_A, false)));
    renderKiosk();
    await enterCode();
    await screen.findByText("Attendance saved to");
    expect(screen.queryByRole("button", { name: "Not this class?" })).toBeNull();
    cleanup();

    fetchMock.mockReset();
    fetchMock.mockReturnValueOnce(respond(200, successBody(CLASS_A, true)));
    renderKiosk();
    await enterCode();
    expect(await screen.findByRole("button", { name: "Not this class?" })).toBeTruthy();
  });
});

describe("offline", () => {
  it("an ordinary offline tap is queued without any selection (the server judges it at its original instant)", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    enqueue.mockResolvedValue(true);
    renderKiosk();
    await enterCode();
    await waitFor(() => expect(enqueue).toHaveBeenCalledTimes(1));
    expect(enqueue).toHaveBeenCalledWith({ academySlug: "heredia", token: "tok", code: "1234", pickedClassSessionId: undefined });
    expect(await screen.findByText(enMessages.kiosk.queuedOffline)).toBeTruthy();
  });

  it("if the connection drops AFTER the student chose a class, the choice is recorded with the queued entry", async () => {
    fetchMock
      .mockReturnValueOnce(respond(400, { ok: false, error: "class_selection_required", openClasses: [CLASS_A, CLASS_B] }))
      .mockRejectedValueOnce(new TypeError("Failed to fetch"));
    enqueue.mockResolvedValue(true);
    renderKiosk();
    await enterCode();
    fireEvent.click(await screen.findByRole("button", { name: /Advanced No-Gi/ }));
    await waitFor(() => expect(enqueue).toHaveBeenCalledTimes(1));
    expect(enqueue).toHaveBeenCalledWith({ academySlug: "heredia", token: "tok", code: "1234", pickedClassSessionId: "cls-b" });
    expect(await screen.findByText(enMessages.kiosk.queuedOffline)).toBeTruthy();
  });

  it("if the tap cannot be saved on the device, the student is told (never the reassuring 'will sync' message)", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    enqueue.mockResolvedValue(false);
    renderKiosk();
    await enterCode();
    expect(await screen.findByText(enMessages.kiosk.queueFailed)).toBeTruthy();
    expect(screen.queryByText(enMessages.kiosk.queuedOffline)).toBeNull();
  });
});
