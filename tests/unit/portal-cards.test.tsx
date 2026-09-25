/** @vitest-environment jsdom */
import { cleanup, render, screen, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, describe, expect, it } from "vitest";
import enMessages from "../../messages/en.json";
import esMessages from "../../messages/es.json";
import { ProgressCard } from "../../src/app/[locale]/portal/progress-card";
import { RecentAttendanceCard } from "../../src/app/[locale]/portal/recent-attendance-card";
import { ScheduleDayList } from "../../src/app/[locale]/portal/schedule-day-list";
import { buildProgressView, type ProgressViewInput } from "../../src/lib/promotion/progress-view";
import type { AttendanceRow } from "../../src/lib/portal/attendance-rows";

const BELT = { primaryColor: "#F0EBE0", centerStripeColor: null, barColor: "#111116", stripeColors: ["#FFFFFF", "#FFFFFF", "#FFFFFF", "#FFFFFF"], maxStripes: 4, visibleStripeSlots: 4 };
const SUMMARY = { currentBeltVisual: BELT, currentStripes: 1, currentBeltLabelEn: "White", currentBeltLabelEs: "Blanco", lifetimeCount: 20 };

const base: ProgressViewInput = {
  nextTarget: "STRIPE", mode: "ATTENDANCE", isEligible: false, target: 30, percent: (20 / 30) * 100, atBeltCount: 20, remainingAttendance: 10,
  timeAnchorMissing: false, notConfigured: false, dueDate: null, reachedOn: null,
};

function show(locale: "en" | "es", input: ProgressViewInput, dueDateLabel: string | null = null) {
  return render(
    <NextIntlClientProvider locale={locale} messages={locale === "en" ? enMessages : esMessages}>
      <ProgressCard locale={locale} summary={SUMMARY} view={buildProgressView(input)} dueDateLabel={dueDateLabel} />
    </NextIntlClientProvider>,
  );
}

// "20 attendances counted toward your next promotion" / "20 asistencias contadas hacia tu próxima promoción"
const ATTENDANCE_COUNT_LINE = /counted toward your next promotion|contadas? hacia tu próxima promoción/;

describe.each(["en", "es"] as const)("ProgressCard (%s)", (locale) => {
  afterEach(cleanup);

  it("attendance rank, Per-interval numbers: a named progressbar, the count line, what remains and the lifetime total", () => {
    show(locale, base);
    const bar = screen.getByRole("progressbar");
    expect(bar.getAttribute("aria-valuenow")).toBe("20");
    expect(bar.getAttribute("aria-valuemax")).toBe("30");
    expect(bar.getAttribute("aria-label")).toBeTruthy();
    expect(screen.getByText(ATTENDANCE_COUNT_LINE)).toBeTruthy();
    expect(screen.getByText("20 / 30")).toBeTruthy();
    expect(screen.getByText(locale === "en" ? "10 attendances to go for your next stripe" : "Faltan 10 asistencias para tu siguiente grado")).toBeTruthy();
    expect(screen.getByText(locale === "en" ? "20 lifetime attendances" : "20 asistencias totales")).toBeTruthy();
    expect(screen.getByText(locale === "en" ? "White · 1 stripe" : "Blanco · 1 franja")).toBeTruthy();
  });

  it("Cumulative numbers render through the same display (the target is the engine's, not rebuilt: 20 / 60)", () => {
    show(locale, { ...base, target: 60, percent: (20 / 60) * 100, remainingAttendance: 40 });
    expect(screen.getByText("20 / 60")).toBeTruthy();
    expect(screen.getByRole("progressbar").getAttribute("aria-valuemax")).toBe("60");
  });

  it("eligible: a full bar capped at the target (never 32 / 30), the eligibility line, and no automatic-award wording", () => {
    show(locale, { ...base, isEligible: true, atBeltCount: 32, remainingAttendance: 0, percent: 100 });
    expect(screen.getByText("30 / 30")).toBeTruthy();
    expect(screen.queryByText("32 / 30")).toBeNull();
    expect(screen.getByText(locale === "en" ? "You're eligible for instructor review!" : "¡Ya puedes ser evaluado por tu instructor!")).toBeTruthy();
    expect(screen.queryByText(/promoted|ascendido/i)).toBeNull();
  });

  it("TIME-based degree (black belt, not yet due): the due date, the lifetime total, NO attendance count and NO bar", () => {
    show(locale, { ...base, nextTarget: "STRIPE", mode: "TIME", target: null, percent: 40, atBeltCount: 12, remainingAttendance: null, dueDate: new Date("2027-03-15T12:00:00Z") }, "03/15/2027");
    expect(screen.getByText(locale === "en" ? "Your next degree is due on 03/15/2027" : "Tu siguiente grado se cumple el 03/15/2027")).toBeTruthy();
    expect(screen.queryByText(ATTENDANCE_COUNT_LINE)).toBeNull(); // attendance does not decide eligibility for this rank
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(screen.getByText(locale === "en" ? "20 lifetime attendances" : "20 asistencias totales")).toBeTruthy(); // a plain fact
  });

  it("TIME-based degree that is due: says eligible for review, still no attendance count", () => {
    show(locale, { ...base, mode: "TIME", target: null, percent: 100, isEligible: true, atBeltCount: 12, remainingAttendance: null });
    expect(screen.getByText(locale === "en" ? "You're eligible for instructor review!" : "¡Ya puedes ser evaluado por tu instructor!")).toBeTruthy();
    expect(screen.queryByText(ATTENDANCE_COUNT_LINE)).toBeNull();
  });

  it("TIME-based degree with no last-promotion date, and a degree that is not configured: their own messages, no attendance count", () => {
    const { unmount } = show(locale, { ...base, mode: "TIME", target: null, timeAnchorMissing: true, atBeltCount: 12, remainingAttendance: null });
    expect(screen.getByText(locale === "en" ? /needs to enter the date of your last promotion/ : /debe ingresar la fecha de tu última promoción/)).toBeTruthy();
    expect(screen.queryByText(ATTENDANCE_COUNT_LINE)).toBeNull();
    unmount();
    show(locale, { ...base, mode: "TIME", target: null, notConfigured: true, atBeltCount: 12, remainingAttendance: null });
    expect(screen.getByText(locale === "en" ? "Your next degree is not set up yet." : "Tu siguiente grado aún no está configurado.")).toBeTruthy();
    expect(screen.queryByText(ATTENDANCE_COUNT_LINE)).toBeNull();
  });

  it("MANUAL and terminal ranks have no attendance target, so no attendance count either", () => {
    const { unmount } = show(locale, { ...base, mode: "MANUAL", target: null, remainingAttendance: null });
    expect(screen.queryByText(ATTENDANCE_COUNT_LINE)).toBeNull();
    expect(screen.queryByRole("progressbar")).toBeNull();
    unmount();
    show(locale, { ...base, nextTarget: "NONE", target: null, remainingAttendance: null });
    expect(screen.queryByText(ATTENDANCE_COUNT_LINE)).toBeNull();
  });

  it("HYBRID rank keeps its attendance target and count (attendance is part of what decides it)", () => {
    show(locale, { ...base, mode: "HYBRID", dueDate: new Date("2027-03-15T12:00:00Z") });
    expect(screen.getByText(ATTENDANCE_COUNT_LINE)).toBeTruthy();
    expect(screen.getByRole("progressbar")).toBeTruthy();
  });

  it("singular counts read correctly (1 attendance, not 1 attendances)", () => {
    show(locale, { ...base, atBeltCount: 1, remainingAttendance: 29, percent: 3 });
    expect(screen.getByText(locale === "en" ? "1 attendance counted toward your next promotion" : "1 asistencia contada hacia tu próxima promoción")).toBeTruthy();
  });
});

const row = (i: number, over: Partial<AttendanceRow> = {}): AttendanceRow => ({
  id: `r${i}`, iso: `2026-09-${String(20 - i).padStart(2, "0")}T18:00:00.000Z`, whenLabel: `09/${String(20 - i).padStart(2, "0")}/2026, 12:00`,
  kind: "class_checkin", className: "Advanced", reason: null, delta: 1, ...over,
});

describe.each(["en", "es"] as const)("RecentAttendanceCard (%s)", (locale) => {
  afterEach(cleanup);
  const render_ = (rows: AttendanceRow[]) =>
    render(
      <NextIntlClientProvider locale={locale} messages={locale === "en" ? enMessages : esMessages}>
        <RecentAttendanceCard rows={rows} />
      </NextIntlClientProvider>,
    );

  it("shows only the five newest entries and a link to the full history (Attendance view)", () => {
    render_(Array.from({ length: 8 }, (_, i) => row(i)));
    expect(within(screen.getByRole("list")).getAllByRole("listitem")).toHaveLength(5);
    const link = screen.getByRole("link", { name: locale === "en" ? "View full history" : "Ver historial completo" });
    expect(link.getAttribute("href")).toBe("#attendance");
    expect(screen.getByText(locale === "en" ? "Recent attendance" : "Asistencia reciente")).toBeTruthy();
  });

  it("each entry shows its time, its signed amount, what kind it was and the class or reason", () => {
    render_([row(0), row(1, { kind: "staff_day", className: null, reason: "Seminar day" })]);
    expect(screen.getByText("09/20/2026, 12:00").tagName).toBe("TIME");
    expect(screen.getAllByLabelText("+1")).toHaveLength(2);
    expect(screen.getByText(locale === "en" ? "Class attendance · Advanced" : "Asistencia a clase · Advanced")).toBeTruthy();
    expect(screen.getByText("Seminar day")).toBeTruthy();
  });

  it("with no attendance, the empty message and no link", () => {
    render_([]);
    expect(screen.getByText(locale === "en" ? "No attendance recorded yet." : "Todavía no hay asistencias registradas.")).toBeTruthy();
    expect(screen.queryByRole("link")).toBeNull();
  });
});

describe.each(["en", "es"] as const)("ScheduleDayList (%s)", (locale) => {
  afterEach(cleanup);
  const days = ["SUNDAY", "MONDAY", "TUESDAY", "WEDNESDAY"].map((key, i) => ({ key, label: key.slice(0, 3), dateNumber: 20 + i, isToday: key === "TUESDAY", isOff: false }));
  const block = (id: string, dayKey: string, title: string, startRow: number) => ({ id, dayKey, title, timeLabel: "18:00 – 19:00", startRow, endRow: startRow + 4, colorClassName: "bg-class-gi" });
  const render_ = (blocks: ReturnType<typeof block>[], sundayHasClasses: boolean) =>
    render(
      <NextIntlClientProvider locale={locale} messages={locale === "en" ? enMessages : esMessages}>
        <ScheduleDayList days={days} blocks={blocks} sundayHasClasses={sundayHasClasses} />
      </NextIntlClientProvider>,
    );

  it("lists each day's classes in time order, marks today with text and aria-current, and skips days with none", () => {
    const { container } = render_([block("b", "TUESDAY", "Late", 20), block("a", "TUESDAY", "Early", 4), block("c", "MONDAY", "Mon class", 8)], true);
    const headings = screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent);
    expect(headings).toHaveLength(2); // Wednesday has no classes and is left out
    const tuesday = container.querySelector('[aria-current="date"]') as HTMLElement;
    expect(within(tuesday).getByText(locale === "en" ? "Today" : "Hoy")).toBeTruthy();
    expect(within(tuesday).getAllByRole("listitem").map((li) => li.textContent)).toEqual([expect.stringContaining("Early"), expect.stringContaining("Late")]);
  });

  it("keeps the calendar's Sunday note when Sunday has no classes", () => {
    render_([block("c", "MONDAY", "Mon class", 8)], false);
    expect(screen.getByText(locale === "en" ? "No classes on Sunday" : "Domingo sin clases")).toBeTruthy();
  });
});
