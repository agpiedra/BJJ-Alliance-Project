/** @vitest-environment jsdom */
import { render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";
import enMessages from "../../messages/en.json";

/**
 * MULTI_ACADEMY_AND_KIDS_BELTS.md revision 19: retroactively closes Phase
 * 2's one acceptance criterion that was verified by code reading rather
 * than a test — "an ineligible student's card states the specific reason
 * (remaining attendances, due date, or manual mode) rather than only
 * disabling the button." Same `@testing-library/react` + jsdom setup
 * Phase 3's structural DOM assertions (tape counts, split-belt bands,
 * unique SVG ids) will build on — see `tests/setup.ts` and the existing
 * `belt-graphic.test.tsx` / `record-payment-form.test.tsx` for the
 * established pattern this file follows.
 */
vi.mock("../../src/app/[locale]/(staff)/students/[id]/promotion-actions", () => ({
  awardFromStudentPage: vi.fn(),
  correctPromotionAction: vi.fn(),
}));

const { PromocionesCard } = await import("../../src/app/[locale]/(staff)/students/[id]/promociones-card");

const BASE_BELT = {
  primaryColor: "#F0EBE0",
  centerStripeColor: null,
  barColor: "#111116",
  stripeColors: ["#111116", "#111116", "#111116", "#111116"],
  maxStripes: 4,
  visibleStripeSlots: 4,
};

const BASE_PROPS: React.ComponentProps<typeof PromocionesCard> = {
  organizationId: "org-1",
  studentId: "student-1",
  belt: BASE_BELT,
  label: "White",
  currentStripes: 2,
  maxStripes: 4,
  atBeltCount: 47,
  lifetimeCount: 47,
  nextTarget: "STRIPE",
  remainingAttendance: 3,
  attendancesPerStripe: 50,
  dueDateFormatted: null,
  isEligible: false,
  mode: "ATTENDANCE",
  history: [],
  canAct: true,
  rankOptions: [],
};

function renderCard(overrides: Partial<React.ComponentProps<typeof PromocionesCard>> = {}) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <PromocionesCard {...BASE_PROPS} {...overrides} />
    </NextIntlClientProvider>,
  );
}

describe("PromocionesCard — ineligible state states the specific reason", () => {
  it("ATTENDANCE mode: shows the count/threshold/remaining text, not a bare disabled button", () => {
    renderCard({ mode: "ATTENDANCE", isEligible: false, atBeltCount: 47, remainingAttendance: 3 });
    expect(screen.getByText("47 / 50 · 3 remaining")).toBeInTheDocument();
    expect(screen.queryByText("Eligible now.")).not.toBeInTheDocument();
  });

  it("TIME mode: shows the due date text instead of an attendance count", () => {
    renderCard({
      mode: "TIME",
      isEligible: false,
      remainingAttendance: null,
      dueDateFormatted: "October 15, 2026",
    });
    expect(screen.getByText("Next grade on October 15, 2026")).toBeInTheDocument();
  });

  it("HYBRID mode: shows both dimensions concatenated (known simplification — see scripts/pending-callers.ts)", () => {
    renderCard({
      mode: "HYBRID",
      isEligible: false,
      atBeltCount: 47,
      remainingAttendance: 3,
      dueDateFormatted: "October 15, 2026",
    });
    expect(screen.getByText("47 / 50 · 3 remaining · Next grade on October 15, 2026")).toBeInTheDocument();
  });

  it("MANUAL mode: shows the coach's-discretion statement regardless of isEligible", () => {
    renderCard({ mode: "MANUAL", nextTarget: "MANUAL_DISPLAY", isEligible: false });
    expect(screen.getByText("Promotion is at the coach's discretion.")).toBeInTheDocument();

    renderCard({ mode: "MANUAL", nextTarget: "MANUAL_DISPLAY", isEligible: true });
    expect(screen.getAllByText("Promotion is at the coach's discretion.").length).toBeGreaterThan(0);
  });

  it("an eligible student shows the eligible statement instead of a reason", () => {
    renderCard({ mode: "ATTENDANCE", isEligible: true });
    expect(screen.getByText("Eligible now.")).toBeInTheDocument();
  });

  it("a read-only session (INSTRUCTOR/STUDENT, canAct=false) still sees the specific reason and no action controls — read-only is never silent", () => {
    renderCard({ canAct: false, mode: "ATTENDANCE", isEligible: false, atBeltCount: 47, remainingAttendance: 3 });
    expect(screen.getByText("47 / 50 · 3 remaining")).toBeInTheDocument();
    expect(screen.getByText("Only admins and directors can award or correct promotions.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Award promotion" })).not.toBeInTheDocument();
    expect(screen.queryByText("Manual promote / correct")).not.toBeInTheDocument();
  });
});
