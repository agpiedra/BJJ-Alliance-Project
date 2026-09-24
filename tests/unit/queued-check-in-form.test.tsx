/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import enMessages from "../../messages/en.json";
import esMessages from "../../messages/es.json";

/**
 * The staff form for queued check-ins kept as untrusted evidence: the day defaults to the day the tablet CLAIMED (and is
 * EMPTY, so a person must choose it, when that claim was unreadable), the class list offers only classes scheduled on the
 * chosen weekday, and both actions post exactly what the coach chose. The server is the authority
 * (tests/integration/queued-check-in-resolution.test.ts).
 */
const resolveAction = vi.fn();
const dismissAction = vi.fn();
vi.mock("../../src/app/[locale]/(staff)/admin/kiosk-tokens/queued-check-in-actions", () => ({
  resolveQueuedCheckInAction: (...args: unknown[]) => resolveAction(...args),
  dismissQueuedCheckInAction: (...args: unknown[]) => dismissAction(...args),
}));

const { QueuedCheckInForm } = await import("../../src/app/[locale]/(staff)/admin/kiosk-tokens/queued-check-in-form");

const CLASSES = [
  { id: "cls-mon-a", name: "Fundamentals", startTime: "18:00", dayOfWeek: "MONDAY" },
  { id: "cls-mon-b", name: "Advanced", startTime: "19:00", dayOfWeek: "MONDAY" },
  { id: "cls-tue", name: "No-Gi", startTime: "18:00", dayOfWeek: "TUESDAY" },
];

function renderForm(props: Partial<React.ComponentProps<typeof QueuedCheckInForm>> = {}, locale: "en" | "es" = "en") {
  return render(
    <NextIntlClientProvider locale={locale} messages={locale === "en" ? enMessages : esMessages}>
      <QueuedCheckInForm organizationId="org-1" queuedCheckInId="q-1" defaultDate="2026-01-05" defaultTime="18:40" defaultClassId="cls-mon-b" classes={CLASSES} {...props} />
    </NextIntlClientProvider>,
  );
}

beforeEach(() => {
  resolveAction.mockReset();
  dismissAction.mockReset();
  resolveAction.mockResolvedValue({ ok: true });
  dismissAction.mockResolvedValue({ ok: true });
});
afterEach(cleanup);

describe("QueuedCheckInForm", () => {
  it("starts on the day the tablet claimed, with the class the tablet said selected among that weekday's classes only", () => {
    renderForm();
    expect((screen.getByLabelText("Day of the class") as HTMLInputElement).value).toBe("2026-01-05");
    const select = screen.getByLabelText("Class") as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual(["18:00 · Fundamentals", "19:00 · Advanced"]); // Monday's classes, not Tuesday's
    expect(select.value).toBe("cls-mon-b");
  });

  it("an unreadable claim leaves the day EMPTY (a person must choose it) and offers no class until then", () => {
    renderForm({ defaultDate: "", defaultClassId: null });
    expect((screen.getByLabelText("Day of the class") as HTMLInputElement).value).toBe("");
    expect(screen.getByText("Choose the day first.")).toBeTruthy();
    expect(screen.queryByLabelText("Class")).toBeNull();
    expect((screen.getByRole("button", { name: "Record attendance on this day" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("changing the day changes the classes offered to that weekday; a day with no classes says so and cannot be submitted", () => {
    renderForm();
    fireEvent.change(screen.getByLabelText("Day of the class"), { target: { value: "2026-01-06" } }); // a Tuesday
    expect([...(screen.getByLabelText("Class") as HTMLSelectElement).options].map((o) => o.textContent)).toEqual(["18:00 · No-Gi"]);
    fireEvent.change(screen.getByLabelText("Day of the class"), { target: { value: "2026-01-07" } }); // a Wednesday
    expect(screen.getByText("No active class on that day.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Record attendance on this day" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("posts exactly the chosen day and class to the record action, bound to the organization, and confirms", async () => {
    renderForm();
    fireEvent.change(screen.getByLabelText("Class"), { target: { value: "cls-mon-a" } });
    fireEvent.click(screen.getByRole("button", { name: "Record attendance on this day" }));
    await waitFor(() => expect(resolveAction).toHaveBeenCalledTimes(1));
    const [organizationId, , formData] = resolveAction.mock.calls[0] as [string, unknown, FormData];
    expect(organizationId).toBe("org-1");
    expect(Object.fromEntries(formData.entries())).toEqual({ queuedCheckInId: "q-1", date: "2026-01-05", time: "18:40", classSessionId: "cls-mon-a" });
    expect(await screen.findByText("Attendance recorded.")).toBeTruthy();
  });

  it("makes the confirmed timestamp explicit: a separate, required tap-time field that starts from the tablet's claim and can be corrected", async () => {
    renderForm({ defaultDate: "2026-01-06", defaultTime: "23:50", defaultClassId: null }); // a Monday-night tap for Tuesday's class: two different fields
    const time = screen.getByLabelText("Time of the tap (Costa Rica)") as HTMLInputElement;
    expect(time.type).toBe("time");
    expect(time.required).toBe(true);
    expect(time.value).toBe("23:50");
    expect(screen.getByText(/it is what gets recorded/)).toBeTruthy();
    fireEvent.change(time, { target: { value: "23:45" } });
    fireEvent.click(screen.getByRole("button", { name: "Record attendance on this day" }));
    await waitFor(() => expect(resolveAction).toHaveBeenCalledTimes(1));
    const [, , formData] = resolveAction.mock.calls[0] as [string, unknown, FormData];
    expect(Object.fromEntries(formData.entries())).toMatchObject({ date: "2026-01-06", time: "23:45" }); // the class day and the tap time are not the same value
  });

  it("an unreadable claim leaves the tap time EMPTY too (nothing is assumed from the class), and the refusals are explained in both languages", async () => {
    renderForm({ defaultDate: "", defaultTime: "", defaultClassId: null });
    expect((screen.getByLabelText("Time of the tap (Costa Rica)") as HTMLInputElement).value).toBe("");
    cleanup();
    resolveAction.mockResolvedValue({ error: "futureTime" });
    renderForm({}, "es");
    expect((screen.getByLabelText("Hora del registro (Costa Rica)") as HTMLInputElement).value).toBe("18:40");
    fireEvent.click(screen.getByRole("button", { name: "Registrar asistencia en este día" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Esa hora todavía no ocurrió. Registrala cuando haya pasado.");
  });

  it("shows a server refusal in the coach's language and keeps the form", async () => {
    resolveAction.mockResolvedValue({ error: "alreadyRecorded" });
    renderForm({}, "es");
    fireEvent.click(screen.getByRole("button", { name: "Registrar asistencia en este día" }));
    expect((await screen.findByRole("alert")).textContent).toBe("El alumno ya tiene asistencia en esa clase ese día.");
  });

  it("setting it aside needs a reason and posts it; the evidence is not deleted (the action only marks it)", async () => {
    renderForm();
    fireEvent.click(screen.getByText("Set aside", { selector: "summary" }));
    const reason = screen.getByLabelText("Reason") as HTMLInputElement;
    expect(reason.required).toBe(true);
    expect(reason.minLength).toBe(3);
    fireEvent.change(reason, { target: { value: "Student left early" } });
    fireEvent.click(screen.getByRole("button", { name: "Set aside" }));
    await waitFor(() => expect(dismissAction).toHaveBeenCalledTimes(1));
    const [, , formData] = dismissAction.mock.calls[0] as [string, unknown, FormData];
    expect(Object.fromEntries(formData.entries())).toEqual({ queuedCheckInId: "q-1", reason: "Student left early" });
    expect(await screen.findByText("Set aside. It stays on record.")).toBeTruthy();
  });
});
