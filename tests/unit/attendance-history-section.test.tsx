/** @vitest-environment jsdom */
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { beforeEach, describe, expect, it, vi } from "vitest";
import enMessages from "../../messages/en.json";
import esMessages from "../../messages/es.json";
import type { AttendanceRow } from "../../src/lib/portal/attendance-rows";

/**
 * The portal's attendance history section (PR 3): a defined total that is not the loaded page length, a plain
 * "showing X of Y", stable "show older" loading, announcements and focus for keyboard and screen-reader users, and
 * honest labels for what each entry is. Real message files, both languages.
 */
const loadMoreAttendance = vi.fn();
vi.mock("../../src/app/[locale]/portal/attendance-history-actions", () => ({
  loadMoreAttendance: (...args: unknown[]) => loadMoreAttendance(...args),
}));

const { AttendanceHistorySection } = await import("../../src/app/[locale]/portal/attendance-history-section");

const row = (n: number, over: Partial<AttendanceRow> = {}): AttendanceRow => ({
  id: `r${n}`, iso: `2026-01-${String(30 - n).padStart(2, "0")}T18:00:00.000Z`, whenLabel: `01/${String(30 - n).padStart(2, "0")}/2026, 12:00`,
  kind: "class_checkin", className: "Evening GI", reason: null, delta: 1, ...over,
});

const TOTALS = { total: 61, entryCount: 60, checkIns: 50, staffDays: 10, otherAdjustments: { count: 1, net: 1 } };

function renderSection(locale: "en" | "es", props: Partial<React.ComponentProps<typeof AttendanceHistorySection>> = {}) {
  return render(
    <NextIntlClientProvider locale={locale} messages={locale === "en" ? enMessages : esMessages}>
      <AttendanceHistorySection
        organizationId="org-1"
        initialRows={[row(1), row(2, { kind: "staff_day", className: null, reason: "makeup class" }), row(3, { kind: "unmatched_checkin", className: null })]}
        initialCursor="cursor-1"
        totals={TOTALS}
        creditedClasses={0}
        {...props}
      />
    </NextIntlClientProvider>,
  );
}

beforeEach(() => loadMoreAttendance.mockReset());

describe("AttendanceHistorySection", () => {
  it("shows the DEFINED total and its parts, and 'showing X of Y' from the whole ledger, not from the loaded page", () => {
    renderSection("en");
    expect(screen.getByText("61 attendances in total")).toBeInTheDocument();
    expect(screen.getByText("50 attendances checked in, 10 days added by staff")).toBeInTheDocument();
    expect(screen.getByText("1 other adjustment, net 1")).toBeInTheDocument();
    expect(screen.getByText("Showing 3 of 60 entries")).toBeInTheDocument();
  });

  it("says plainly what each entry is: a class check-in (with the class), a check-in with no class, a staff-added day (with its reason)", () => {
    renderSection("en");
    const items = within(screen.getByRole("list", { name: "Attendance entries" })).getAllByRole("listitem");
    expect(items[0]).toHaveTextContent("Class attendance · Evening GI");
    expect(items[1]).toHaveTextContent("Added by staff");
    expect(items[1]).toHaveTextContent("makeup class");
    expect(items[2]).toHaveTextContent("Attendance (no class matched)");
    // Real <time> elements carry the instant.
    expect(items[0].querySelector("time")?.getAttribute("datetime")).toBe("2026-01-29T18:00:00.000Z");
  });

  it("keeps head-start credit apart from attendance, and only when there is some", () => {
    const { unmount } = renderSection("en", { creditedClasses: 45 });
    expect(screen.getByText("Head-start credit, counted separately and not attendance: 45 classes")).toBeInTheDocument();
    unmount();
    renderSection("en", { creditedClasses: 0 });
    expect(screen.queryByText(/Head-start credit/)).toBeNull();
  });

  it("an empty ledger shows the empty state and no load control", () => {
    renderSection("en", { initialRows: [], initialCursor: null, totals: { total: 0, entryCount: 0, checkIns: 0, staffDays: 0, otherAdjustments: { count: 0, net: 0 } } });
    expect(screen.getByText("No attendance recorded yet.")).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("'Show older attendance' appends the next page, announces how many were loaded, moves focus to the first new entry, and asks for the right cursor", async () => {
    loadMoreAttendance.mockResolvedValue({ ok: true, rows: [row(4), row(5)], nextCursor: null });
    renderSection("en");
    fireEvent.click(screen.getByRole("button", { name: "Show older attendance" }));

    await waitFor(() => expect(screen.getByText("Showing 5 of 60 entries")).toBeInTheDocument());
    expect(loadMoreAttendance).toHaveBeenCalledWith("org-1", "cursor-1");
    expect(screen.getByRole("status")).toHaveTextContent("2 older entries loaded.");
    const items = within(screen.getByRole("list", { name: "Attendance entries" })).getAllByRole("listitem");
    expect(items).toHaveLength(5);
    // Focus is applied in a passive effect after the rows commit, which can land a tick after the text above is on screen (it did
    // not on a slow CI runner), so wait for it rather than asserting at the instant the text appears.
    await waitFor(() => expect(items[3]).toHaveFocus());
    // The last page ends the control and says so.
    expect(screen.queryByRole("button", { name: "Show older attendance" })).toBeNull();
    expect(screen.getByText("That is the start of your attendance history.")).toBeInTheDocument();
  });

  it("never repeats an entry the student already sees, even if the server returns one again", async () => {
    loadMoreAttendance.mockResolvedValue({ ok: true, rows: [row(3), row(4)], nextCursor: "cursor-2" });
    renderSection("en");
    fireEvent.click(screen.getByRole("button", { name: "Show older attendance" }));
    await waitFor(() => expect(screen.getByText("Showing 4 of 60 entries")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Show older attendance" })).toBeInTheDocument(); // more pages remain
  });

  it("a failed load shows a retryable error and keeps what was already loaded", async () => {
    loadMoreAttendance.mockResolvedValueOnce({ ok: false, error: "failed" });
    renderSection("en");
    fireEvent.click(screen.getByRole("button", { name: "Show older attendance" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't load older attendance. Please try again.");
    expect(screen.getByText("Showing 3 of 60 entries")).toBeInTheDocument();

    loadMoreAttendance.mockResolvedValueOnce({ ok: true, rows: [row(4)], nextCursor: null });
    fireEvent.click(screen.getByRole("button", { name: "Show older attendance" }));
    await waitFor(() => expect(screen.getByText("Showing 4 of 60 entries")).toBeInTheDocument());
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("is fully translated: Spanish total, breakdown, entry labels and control", () => {
    renderSection("es");
    expect(screen.getByText("61 asistencias en total")).toBeInTheDocument();
    expect(screen.getByText("50 asistencias registradas, 10 días agregados por el personal")).toBeInTheDocument();
    expect(screen.getByText("Mostrando 3 de 60 registros")).toBeInTheDocument();
    const items = within(screen.getByRole("list", { name: "Registros de asistencia" })).getAllByRole("listitem");
    expect(items[0]).toHaveTextContent("Asistencia a clase · Evening GI");
    expect(items[1]).toHaveTextContent("Agregado por el personal");
    expect(items[2]).toHaveTextContent("Asistencia (sin clase asignada)");
    expect(screen.getByRole("button", { name: "Mostrar asistencias anteriores" })).toBeInTheDocument();
  });
});
