/** @vitest-environment jsdom */
import { render } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";
import enMessages from "../../messages/en.json";
import esMessages from "../../messages/es.json";

/**
 * The coach's "add an attendance day" form must explain the counting rule of the student's OWN track accounting.
 * PER_INTERVAL (the decided rule): a day counts once toward progress. CUMULATIVE (the legacy rule an existing
 * organization still runs): every entry counts, there is no daily limit. The hint and the response the action gives
 * (pinned in tests/integration/coach-attendance-accounting.test.ts) must never contradict each other.
 */
vi.mock("../../src/app/[locale]/(staff)/students/[id]/adjustment-actions", () => ({
  addAttendanceAdjustment: vi.fn(),
}));

const { AddAdjustmentForm } = await import("../../src/app/[locale]/(staff)/students/[id]/add-adjustment-form");

const LOCALES = {
  en: { messages: enMessages, once: /counts once/i, everyEntry: /every entry counts/i },
  es: { messages: esMessages, once: /cuenta una sola vez/i, everyEntry: /cada registro cuenta/i },
} as const;

/** The help text under the date field for the given locale and accounting. */
function dateHint(locale: keyof typeof LOCALES, accounting: "PER_INTERVAL" | "CUMULATIVE"): string {
  const { container, unmount } = render(
    <NextIntlClientProvider locale={locale} messages={LOCALES[locale].messages}>
      <AddAdjustmentForm organizationId="org-1" studentId="student-1" todayCr="2026-09-23" accounting={accounting} />
    </NextIntlClientProvider>,
  );
  const text = container.querySelector("input[name=date]")!.closest("label")!.querySelector("span:last-child")!.textContent ?? "";
  unmount();
  return text;
}

/** Every string this form (labels, hints, success, informational and error responses) can show. */
const FORM_KEYS = [
  "toggle", "date", "dateHintPerInterval", "dateHintCumulative", "dateInvalid", "reason", "reasonRequired", "submit", "success",
  "alreadyCountedThatDay", "beforeLastPromotion", "beforeTrackingStart", "promotionDayHistoryOnly", "trackingStartDayHistoryOnly",
  "beforeBeltDate", "invalid", "notFound", "archived",
] as const;
/** What the action answers under each accounting (pinned in tests/integration/coach-attendance-accounting.test.ts). */
const PER_INTERVAL_ONLY = ["alreadyCountedThatDay", "beforeLastPromotion", "beforeTrackingStart", "promotionDayHistoryOnly", "trackingStartDayHistoryOnly", "dateHintPerInterval"] as const;
const CUMULATIVE_ONLY = ["beforeBeltDate", "dateHintCumulative"] as const;

describe.each(["en", "es"] as const)("the add-day form's strings are complete and never state the other mode's rule (%s)", (locale) => {
  const adjustment = (LOCALES[locale].messages as unknown as { students: { detail: { adjustment: Record<string, string> } } }).students.detail.adjustment;

  it("every string the form can show exists and is non-empty (no key falls back to its name)", () => {
    for (const key of FORM_KEYS) expect(adjustment[key], key).toBeTruthy();
  });

  it("the removed single hint is really gone (a leftover would be read by nothing and drift)", () => {
    expect(adjustment.dateHint).toBeUndefined();
  });

  it("CUMULATIVE-only messages never claim a daily limit or a history-only day", () => {
    const dailyLimit = locale === "en" ? /counts once|already counted|history only/i : /una sola vez|ya hab[ií]a contado|solo en el historial/i;
    for (const key of CUMULATIVE_ONLY) expect(adjustment[key], key).not.toMatch(dailyLimit);
  });

  it("PER_INTERVAL-only messages never claim that every entry counts", () => {
    const everyEntry = locale === "en" ? /every entry counts/i : /cada registro cuenta/i;
    for (const key of PER_INTERVAL_ONLY) expect(adjustment[key], key).not.toMatch(everyEntry);
  });

  it("a tracking-start message never mentions a promotion as the boundary, and the promotion messages always do", () => {
    const promotion = locale === "en" ? /promotion/i : /promoci[oó]n/i;
    expect(adjustment.beforeLastPromotion).toMatch(promotion);
    expect(adjustment.promotionDayHistoryOnly).toMatch(promotion);
    // "before the last promotion" would be false for a system tracking start; these must name tracking instead.
    const tracking = locale === "en" ? /tracking/i : /seguimiento/i;
    expect(adjustment.beforeTrackingStart).toMatch(tracking);
    expect(adjustment.trackingStartDayHistoryOnly).toMatch(tracking);
    expect(adjustment.beforeTrackingStart).not.toMatch(/last promotion|[uú]ltima promoci[oó]n/i);
  });
});

describe.each(["en", "es"] as const)("AddAdjustmentForm help text (%s)", (locale) => {
  const { once, everyEntry } = LOCALES[locale];

  it("PER_INTERVAL: explains the one-contribution-per-day limit and never claims every entry counts", () => {
    const hint = dateHint(locale, "PER_INTERVAL");
    expect(hint).toMatch(once);
    expect(hint).not.toMatch(everyEntry);
  });

  it("CUMULATIVE: explains that every entry counts (no daily limit) and never claims a one-per-day limit", () => {
    const hint = dateHint(locale, "CUMULATIVE");
    expect(hint).toMatch(everyEntry);
    expect(hint).not.toMatch(once);
  });

  it("the two modes render different help text", () => {
    expect(dateHint(locale, "CUMULATIVE")).not.toBe(dateHint(locale, "PER_INTERVAL"));
  });
});
