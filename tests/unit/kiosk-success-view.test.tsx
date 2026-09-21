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
 */
vi.mock("@/lib/kiosk/offline-queue", () => ({ enqueueOfflineCheckIn: vi.fn(), flushOfflineQueue: vi.fn() }));

const { SuccessView } = await import("../../src/app/[locale]/kiosk/[academySlug]/kiosk-client");

type Summary = Pick<AtBeltSummary, "atBeltCount" | "remainingAttendance" | "isEligible" | "nextTarget">;

function success(summary: Summary) {
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
    summary,
    earnedStripe: false,
    isVisitor: false,
    homeAcademyName: "Heredia",
    attendanceRecordId: "att-1",
    matchedClass: null,
  };
}

function renderView(summary: Summary) {
  render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <SuccessView result={success(summary)} onCorrect={() => {}} />
    </NextIntlClientProvider>,
  );
}

describe("the kiosk success screen, rendered from the API's own summary shape", () => {
  afterEach(cleanup);

  it("REQUIRED: mid-belt shows the real progress — '1 / 30' and 29 to go — and never NaN", () => {
    renderView({ atBeltCount: 1, remainingAttendance: 29, isEligible: false, nextTarget: "STRIPE" } satisfies Summary);

    expect(screen.getByText("1 / 30")).toBeTruthy();
    expect(screen.getByText("29 attendances to go for your next stripe")).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/NaN|undefined/);
  });

  it("one to go uses the singular", () => {
    renderView({ atBeltCount: 29, remainingAttendance: 1, isEligible: false, nextTarget: "STRIPE" } satisfies Summary);
    expect(screen.getByText("29 / 30")).toBeTruthy();
    expect(screen.getByText("1 attendance to go for your next stripe")).toBeTruthy();
  });

  it("eligible for the next stripe says so", () => {
    renderView({ atBeltCount: 30, remainingAttendance: 0, isEligible: true, nextTarget: "STRIPE" } satisfies Summary);
    expect(screen.getByText("You're eligible for your next stripe")).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/NaN|undefined/);
  });

  it("REQUIRED: exam-eligible at the belt threshold says so (no remaining count, next target is the belt)", () => {
    renderView({ atBeltCount: 150, remainingAttendance: null, isEligible: true, nextTarget: "BELT" } satisfies Summary);
    expect(screen.getByText("150")).toBeTruthy();
    expect(screen.getByText(enMessages.kiosk.examEligible)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/NaN|undefined/);
  });

  it("a terminal belt with no further progress shows just the count — no NaN, no eligibility claim", () => {
    renderView({ atBeltCount: 12, remainingAttendance: null, isEligible: false, nextTarget: "NONE" } satisfies Summary);
    expect(screen.getByText("12")).toBeTruthy();
    expect(screen.queryByText(enMessages.kiosk.examEligible)).toBeNull();
    expect(document.body.textContent).not.toMatch(/NaN|undefined/);
  });
});

describe("the client's summary type is the server's, not a copy", () => {
  const source = readFileSync(path.join(process.cwd(), "src/app/[locale]/kiosk/[academySlug]/kiosk-client.tsx"), "utf8");

  it("REQUIRED: kiosk-client.tsx derives `summary` from AtBeltSummary and declares no fields of its own", () => {
    expect(source).toMatch(/summary:\s*Pick<AtBeltSummary,/);
    expect(source).not.toMatch(/remainingToNextStripe\s*:/);
    expect(source).not.toMatch(/examEligible\s*:/);
  });
});
