/** @vitest-environment jsdom */
import { readFileSync } from "node:fs";
import path from "node:path";
import { render, screen, cleanup } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, describe, expect, it, vi } from "vitest";
import enMessages from "../../messages/en.json";
import type { AtBeltSummary } from "../../src/lib/students/attendance-summary";

/**
 * Every real kiosk check-in showed "1 / NaN" and "NaN attendances to go for your
 * next stripe": the success screen read `remainingToNextStripe` / `examEligible`,
 * fields the API has never returned — it returns an `AtBeltSummary`
 * (`remainingAttendance`, `isEligible`). `undefined` is not `null`, so
 * `1 + undefined` rendered as NaN. Nothing caught it because no test rendered the
 * screen from the API's own shape, and the client's hand-written type could drift
 * from the server's without a compile error.
 *
 * So: the client's `summary` is now a `Pick` of the server's `AtBeltSummary` (a
 * rename becomes a compile error), and these fixtures are `satisfies`-checked
 * against that same type, so a fixture cannot describe a shape the server does
 * not produce.
 *
 * The screen now reads the SHARED display shaping (`buildProgressView`): an
 * eligible student sees a capped "30 / 30" and "eligible for instructor review"
 * (never an overflowing 42 / 30), and an extra same-day class is reported as
 * recorded-but-not-another-progress-day.
 */
vi.mock("@/lib/kiosk/offline-queue", () => ({ enqueueOfflineCheckIn: vi.fn(), flushOfflineQueue: vi.fn() }));

const { SuccessView } = await import("../../src/app/[locale]/kiosk/[academySlug]/kiosk-client");

type Summary = Pick<
  AtBeltSummary,
  | "atBeltCount"
  | "remainingAttendance"
  | "isEligible"
  | "nextTarget"
  | "mode"
  | "target"
  | "percent"
  | "timeAnchorMissing"
  | "notConfigured"
  | "reachedOn"
>;

const STRIPE_SUMMARY = {
  atBeltCount: 0,
  remainingAttendance: 30,
  isEligible: false,
  nextTarget: "STRIPE",
  mode: "ATTENDANCE",
  target: 30,
  percent: 0,
  timeAnchorMissing: false,
  notConfigured: false,
  reachedOn: null,
} satisfies Summary;

function summary(overrides: Partial<Summary>): Summary {
  return { ...STRIPE_SUMMARY, ...overrides };
}

function success(sum: Summary, extra: { thresholdReached?: boolean; progressOutcome?: "counted" | "already_counted_today" | "not_promotion_class" } = {}) {
  return {
    ok: true as const,
    student: {
      firstName: "Carla",
      lastName: "Cartago",
      currentBelt: "WHITE",
      currentBeltVisual: {
        primaryColor: "#F0EBE0",
        centerStripeColor: null,
        barColor: "#111116",
        stripeColors: ["#000000", "#000000", "#000000", "#000000"],
        maxStripes: 4,
        visibleStripeSlots: 4,
      },
      currentBeltLabelEs: "Blanco",
      currentBeltLabelEn: "White",
      currentStripes: 0,
    },
    summary: sum,
    thresholdReached: extra.thresholdReached ?? false,
    progressOutcome: extra.progressOutcome ?? ("counted" as const),
    isVisitor: false,
    homeAcademyName: "Heredia",
    attendanceRecordId: "att-1",
    matchedClass: null,
  };
}

function renderView(sum: Summary, extra: Parameters<typeof success>[1] = {}) {
  render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <SuccessView result={success(sum, extra)} onCorrect={() => {}} />
    </NextIntlClientProvider>,
  );
}

describe("the kiosk success screen, rendered from the API's own summary shape", () => {
  afterEach(cleanup);

  it("REQUIRED: mid-belt shows the real progress — '1 / 30' and 29 to go — and never NaN", () => {
    renderView(summary({ atBeltCount: 1, remainingAttendance: 29, percent: 3 }));

    expect(screen.getByText("1 / 30")).toBeTruthy();
    expect(screen.getByText("29 attendances to go for your next stripe")).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/NaN|undefined/);
  });

  it("one to go uses the singular", () => {
    renderView(summary({ atBeltCount: 29, remainingAttendance: 1, percent: 97 }));
    expect(screen.getByText("29 / 30")).toBeTruthy();
    expect(screen.getByText("1 attendance to go for your next stripe")).toBeTruthy();
  });

  it("REQUIRED: eligible says 'eligible for instructor review' and shows a capped fraction - never 42 / 30", () => {
    renderView(summary({ atBeltCount: 42, remainingAttendance: 0, isEligible: true, percent: 100 }), { thresholdReached: true });
    expect(screen.getByText("30 / 30")).toBeTruthy();
    expect(screen.getByText(enMessages.kiosk.eligibleForReview)).toBeTruthy();
    expect(screen.getByText("Ready for review, Carla Cartago!")).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/42 \/ 30|NaN|undefined/);
  });

  it("REQUIRED: belt-exam eligibility (legacy: no remaining count) is also 'eligible for instructor review', capped", () => {
    renderView(summary({ atBeltCount: 151, remainingAttendance: null, isEligible: true, nextTarget: "BELT", target: 150, percent: 100 }));
    expect(screen.getByText("150 / 150")).toBeTruthy();
    expect(screen.getByText(enMessages.kiosk.eligibleForReview)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/NaN|undefined/);
  });

  it("a terminal belt with no further progress shows just the count — no NaN, no eligibility claim", () => {
    renderView(summary({ atBeltCount: 12, remainingAttendance: null, isEligible: false, nextTarget: "NONE", target: null, percent: null }));
    expect(screen.getByText("12")).toBeTruthy();
    expect(screen.queryByText(enMessages.kiosk.eligibleForReview)).toBeNull();
    expect(document.body.textContent).not.toMatch(/NaN|undefined/);
  });

  it("a time-based black belt shows the attendance count and no attendance fraction", () => {
    renderView(
      summary({ atBeltCount: 80, remainingAttendance: null, isEligible: false, mode: "TIME", target: null, percent: 20 }),
    );
    expect(screen.getByText("80")).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/ \/ |NaN|undefined/);
  });
});

describe("what this tap did for progress is said truthfully", () => {
  afterEach(cleanup);

  it("an extra class the same day is recorded but is not presented as another progress contribution", () => {
    renderView(summary({ atBeltCount: 5, remainingAttendance: 25, percent: 17 }), { progressOutcome: "already_counted_today" });
    expect(screen.getByText(enMessages.kiosk.progressAlreadyCounted)).toBeTruthy();
    // The displayed progress is the real (unchanged) count.
    expect(screen.getByText("5 / 30")).toBeTruthy();
  });

  it("a class that does not count toward promotion says so", () => {
    renderView(summary({}), { progressOutcome: "not_promotion_class" });
    expect(screen.getByText(enMessages.kiosk.progressNotPromotionClass)).toBeTruthy();
  });

  it("a counted attendance adds no extra explanation line", () => {
    renderView(summary({ atBeltCount: 1, remainingAttendance: 29 }), { progressOutcome: "counted" });
    expect(screen.queryByText(enMessages.kiosk.progressAlreadyCounted)).toBeNull();
    expect(screen.queryByText(enMessages.kiosk.progressNotPromotionClass)).toBeNull();
  });
});

describe("the client's summary type is the server's, not a copy", () => {
  const source = readFileSync(path.join(process.cwd(), "src/app/[locale]/kiosk/[academySlug]/kiosk-client.tsx"), "utf8");

  it("REQUIRED: kiosk-client.tsx derives `summary` from AtBeltSummary and declares no fields of its own", () => {
    expect(source).toMatch(/summary:\s*Pick<\s*AtBeltSummary,/);
    expect(source).not.toMatch(/remainingToNextStripe\s*:/);
    expect(source).not.toMatch(/examEligible\s*:/);
  });
});
