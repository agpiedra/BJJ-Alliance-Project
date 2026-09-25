/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import enMessages from "../../messages/en.json";
import esMessages from "../../messages/es.json";

/**
 * The kiosk redesign's new behaviour, on top of the existing tests (kiosk-class-picker, kiosk-success-view) that pin the rules it must not
 * change: an accessible digit-count status, Clear secondary / Enter primary gating, ONE H1 per screen, the in-flow "could not sync" banner,
 * the offline indicator, and above all the timeout bar, which must show the REAL timeout: the number that arms the reset is the number the
 * bar carries, the keypad returns after exactly that long, and the bar is gone when no reset is pending (the lockout countdown, a correction
 * being saved). Real message files, both languages; the server is mocked at fetch.
 */
const enqueue = vi.fn();
const flush = vi.fn();
vi.mock("@/lib/kiosk/offline-queue", () => ({
  enqueueOfflineCheckIn: (...args: unknown[]) => enqueue(...args),
  flushOfflineQueue: () => flush(),
}));

const { KioskClient } = await import("../../src/app/[locale]/kiosk/[academySlug]/kiosk-client");
const { OfflineChip } = await import("../../src/app/[locale]/kiosk/[academySlug]/offline-chip");

const CLASS_A = { id: "cls-a", name: "Fundamentals", startTime: "18:00", endTime: "19:00", type: "GI" };
const CLASS_B = { id: "cls-b", name: "Advanced No-Gi", startTime: "19:00", endTime: "20:00", type: "NO_GI" };
const OPEN = [CLASS_A, CLASS_B];

const fetchMock = vi.fn();
const respond = (status: number, body: unknown) => Promise.resolve({ status, json: async () => body } as Response);

const SUCCESS = {
  ok: true,
  student: {
    firstName: "Carla", lastName: "Cartago", currentBelt: "WHITE", currentBeltLabelEs: "Blanco", currentBeltLabelEn: "White", currentStripes: 0,
    currentBeltVisual: { primaryColor: "#F0EBE0", centerStripeColor: null, barColor: "#111116", stripeColors: ["#000", "#000", "#000", "#000"], maxStripes: 4, visibleStripeSlots: 4 },
  },
  summary: { atBeltCount: 12, remainingAttendance: 18, isEligible: false, nextTarget: "STRIPE", mode: "ATTENDANCE", target: 30, percent: 40, timeAnchorMissing: false, notConfigured: false, reachedOn: null },
  thresholdReached: false, progressOutcome: "counted", isVisitor: false, homeAcademyName: "Heredia", attendanceRecordId: "att-1", canCorrect: true,
  matchedClass: { id: "cls-a", name: "Fundamentals", dayOfWeek: "MONDAY", startTime: "18:00" },
};

function renderKiosk(locale: "en" | "es" = "en") {
  return render(
    <NextIntlClientProvider locale={locale} messages={locale === "en" ? enMessages : esMessages}>
      <KioskClient academyId="acad-1" academyName="Heredia" academySlug="heredia" token="tok" />
    </NextIntlClientProvider>,
  );
}

const press = (name: string | RegExp) => fireEvent.click(screen.getByRole("button", { name }));
const enterCode = (locale: "en" | "es" = "en") => {
  for (const d of ["1", "2", "3", "4"]) press(d);
  press(locale === "en" ? "Enter" : "Entrar");
};
/** Let pending promises and timers settle (the suite uses fake timers so that a timeout can be crossed exactly). */
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const bar = () => screen.queryByTestId("kiosk-timeout");
const prompt = () => screen.queryByText("Enter your 4-digit code");

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  fetchMock.mockReset();
  enqueue.mockReset();
  flush.mockReset();
  flush.mockResolvedValue({ dropped: 0 });
  vi.stubGlobal("fetch", fetchMock);
  Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe.each(["en", "es"] as const)("digit-count status and keys (%s)", (locale) => {
  it("says how many digits are in, as they change (the dots are decorative)", () => {
    renderKiosk(locale);
    const text = (n: number) => (locale === "en" ? `${n} of 4 digits entered` : `${n} de 4 dígitos ingresados`);
    expect(screen.getByText(text(0))).toBeTruthy();
    press("1");
    press("2");
    expect(screen.getByText(text(2))).toBeTruthy();
    expect(screen.getByText(text(2)).getAttribute("aria-live")).toBe("polite");
    press(locale === "en" ? "Clear" : "Borrar");
    expect(screen.getByText(text(0))).toBeTruthy();
  });

  it("Enter stays disabled until four digits are in; Clear is disabled while there is nothing to clear", () => {
    renderKiosk(locale);
    const enter = () => screen.getByRole("button", { name: locale === "en" ? "Enter" : "Entrar" }) as HTMLButtonElement;
    const clear = () => screen.getByRole("button", { name: locale === "en" ? "Clear" : "Borrar" }) as HTMLButtonElement;
    expect(enter().disabled).toBe(true);
    expect(clear().disabled).toBe(true);
    press("1");
    press("2");
    press("3");
    expect(enter().disabled).toBe(true);
    expect(clear().disabled).toBe(false);
    press("4");
    expect(enter().disabled).toBe(false);
    expect((screen.getByRole("button", { name: "5" }) as HTMLButtonElement).disabled).toBe(true); // the digit keys stop at four
  });

  it("Enter is the primary action (the tenant's action fill), Clear is secondary, digits are outlined", () => {
    renderKiosk(locale);
    const key = (name: string) => screen.getByRole("button", { name }).className;
    expect(key(locale === "en" ? "Enter" : "Entrar")).toContain("bg-brand-gold");
    expect(key(locale === "en" ? "Clear" : "Borrar")).toContain("bg-secondary");
    expect(key(locale === "en" ? "Clear" : "Borrar")).not.toContain("bg-brand-gold");
    expect(key("7")).toContain("bg-card");
    expect(key("7")).not.toContain("bg-brand-gold");
  });
});

describe("one H1 per screen", () => {
  const headings = () => screen.getAllByRole("heading", { level: 1 }).map((h) => h.textContent);

  it("keypad: the prompt; picker: its heading; success: the student's name; refusal and lockout: the academy (for assistive technology)", async () => {
    renderKiosk();
    expect(headings()).toEqual(["Enter your 4-digit code"]);

    fetchMock.mockReturnValueOnce(respond(400, { ok: false, error: "class_selection_required", openClasses: OPEN }));
    enterCode();
    await advance(0);
    expect(headings()).toEqual(["Which class did you attend?"]);

    fetchMock.mockReturnValueOnce(respond(200, SUCCESS));
    press(/Fundamentals/);
    await advance(0);
    expect(headings()).toEqual(["You're checked in, Carla Cartago!"]);

    await advance(6000);
    fetchMock.mockReturnValueOnce(respond(400, { ok: false, error: "invalid_code" }));
    enterCode();
    await advance(0);
    expect(headings()).toEqual(["Heredia"]);
    expect(screen.getByRole("alert").textContent).toBe("Invalid code");

    await advance(4000);
    fetchMock.mockReturnValueOnce(respond(429, { ok: false, error: "rate_limited", retryAfterSeconds: 5 }));
    enterCode();
    await advance(0);
    expect(headings()).toEqual(["Heredia"]);
  });
});

describe("the timeout bar shows the REAL timeout", () => {
  it.each([
    ["a confirmation", () => respond(200, SUCCESS), 6000],
    ["an invalid code", () => respond(400, { ok: false, error: "invalid_code" }), 4000],
    ["already checked in", () => respond(400, { ok: false, error: "already_checked_in" }), 4000],
    ["no class open (asks for a coach, so it stays longer)", () => respond(400, { ok: false, error: "no_open_class" }), 9000],
    ["the class picker (a real decision, so much longer)", () => respond(400, { ok: false, error: "class_selection_required", openClasses: OPEN }), 30000],
  ] as const)("%s: the bar carries the number that arms the reset, and the keypad returns after exactly that long", async (_name, response, ms) => {
    fetchMock.mockReturnValueOnce(response());
    renderKiosk();
    expect(bar()).toBeNull(); // nothing pending on the keypad
    enterCode();
    await advance(0);

    const el = bar()!;
    expect(el.getAttribute("data-timeout-ms")).toBe(String(ms));
    expect((el.firstElementChild as HTMLElement).style.getPropertyValue("--kiosk-timeout-ms")).toBe(`${ms}ms`);
    expect(el.getAttribute("aria-hidden")).toBe("true"); // decorative: the message on screen is what is announced

    await advance(ms - 1);
    expect(prompt()).toBeNull(); // still on this screen one millisecond before
    expect(bar()).not.toBeNull();
    await advance(1);
    expect(prompt()).not.toBeNull(); // the keypad is back at exactly the number the bar carried
    expect(bar()).toBeNull();
  });

  it("an offline confirmation (saved on the device) carries 6 s", async () => {
    Object.defineProperty(navigator, "onLine", { configurable: true, value: false });
    enqueue.mockResolvedValue(true);
    renderKiosk();
    enterCode();
    await advance(0);
    expect(screen.getByText("Saved! You're offline — this will sync automatically once the connection is back.")).toBeTruthy();
    expect(bar()!.getAttribute("data-timeout-ms")).toBe("6000");
    await advance(6000);
    expect(prompt()).not.toBeNull();
  });

  it("the lockout has no bar: it shows its own countdown, and the keypad returns when that reaches zero", async () => {
    fetchMock.mockReturnValueOnce(respond(429, { ok: false, error: "rate_limited", retryAfterSeconds: 3 }));
    renderKiosk();
    enterCode();
    await advance(0);
    expect(bar()).toBeNull();
    expect(screen.getByText("3s")).toBeTruthy();
    await advance(1000);
    expect(screen.getByText("2s")).toBeTruthy();
    await advance(2000);
    expect(prompt()).not.toBeNull();
  });

  it("a correction being saved has no pending reset (no bar); a failed correction re-arms a fresh 30 s bar", async () => {
    fetchMock.mockReturnValueOnce(respond(200, SUCCESS)); // check-in
    renderKiosk();
    enterCode();
    await advance(0);
    expect(bar()!.getAttribute("data-timeout-ms")).toBe("6000");

    fetchMock.mockReturnValueOnce(respond(200, { ok: true, picklist: OPEN })); // "Not this class?" asks for the choices
    press("Not this class?");
    await advance(0);
    const first = bar()!;
    expect(first.getAttribute("data-timeout-ms")).toBe("30000");
    const firstFill = first.firstElementChild;

    let release: (r: Response) => void = () => undefined;
    fetchMock.mockReturnValueOnce(new Promise<Response>((r) => (release = r))); // the correction is in flight
    press(/Advanced No-Gi/);
    await advance(0);
    expect(bar()).toBeNull(); // the timer was cleared while saving, so no bar

    release({ status: 500, json: async () => ({ ok: false }) } as Response); // it fails
    await advance(0);
    expect(screen.getByText("We couldn't change the class. Please tell the front desk.")).toBeTruthy();
    const second = bar()!;
    expect(second.getAttribute("data-timeout-ms")).toBe("30000");
    expect(second.firstElementChild).not.toBe(firstFill); // a new bar, restarted from full
  });
});

describe.each(["en", "es"] as const)("sync warning banner (%s)", (locale) => {
  it("is in the page flow directly above the keypad (not a fixed overlay), says how many were lost, and stays until dismissed", async () => {
    flush.mockResolvedValue({ dropped: 2 });
    renderKiosk(locale);
    await advance(0);
    const text = locale === "en" ? "2 check-ins could not be synced — please tell the front desk" : "2 check-ins no se pudieron sincronizar — por favor avisa en la recepción";
    const banner = screen.getByText(text).closest('[role="status"]') as HTMLElement;
    expect(banner.className).not.toMatch(/\bfixed\b/);
    const heading = screen.getByRole("heading", { level: 1 });
    expect(banner.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy(); // above the content
    // it survives every screen change and only a person dismisses it
    fetchMock.mockReturnValueOnce(respond(400, { ok: false, error: "invalid_code" }));
    enterCode(locale);
    await advance(0);
    await advance(4000);
    expect(screen.getByText(text)).toBeTruthy();
    fireEvent.click(within(banner).getByRole("button", { name: locale === "en" ? "Dismiss" : "Descartar" }));
    expect(screen.queryByText(text)).toBeNull();
  });

  it("is not shown when nothing was dropped", async () => {
    renderKiosk(locale);
    await advance(0);
    expect(screen.queryByText(/could not be synced|no se pudieron sincronizar/)).toBeNull();
  });
});

describe.each(["en", "es"] as const)("offline indicator (%s)", (locale) => {
  const chip = () =>
    render(
      <NextIntlClientProvider locale={locale} messages={locale === "en" ? enMessages : esMessages}>
        <OfflineChip />
      </NextIntlClientProvider>,
    );
  const label = locale === "en" ? "Offline" : "Sin conexión";

  it("appears when the browser goes offline and goes away when it is back, in a live region that always exists", () => {
    chip();
    expect(screen.queryByText(label)).toBeNull();
    expect(screen.getByRole("status")).toBeTruthy();
    act(() => {
      Object.defineProperty(navigator, "onLine", { configurable: true, value: false });
      window.dispatchEvent(new Event("offline"));
    });
    expect(within(screen.getByRole("status")).getByText(label)).toBeTruthy();
    act(() => {
      Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
      window.dispatchEvent(new Event("online"));
    });
    expect(screen.queryByText(label)).toBeNull();
  });

  it("is shown from the start when the tablet loads offline", () => {
    Object.defineProperty(navigator, "onLine", { configurable: true, value: false });
    chip();
    expect(screen.getByText(label)).toBeTruthy();
  });
});
