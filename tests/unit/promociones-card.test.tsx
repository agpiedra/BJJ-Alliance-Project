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
 *
 * The card no longer derives anything: it renders the shared
 * `buildProgressView` result (docs/PROMOTION_PROGRESS_PROPOSAL.md), so these
 * tests feed it view-models and assert the wording per display state.
 */
vi.mock("../../src/app/[locale]/(staff)/students/[id]/promotion-actions", () => ({
  awardFromStudentPage: vi.fn(),
  correctPromotionAction: vi.fn(),
}));
vi.mock("../../src/app/[locale]/(staff)/students/[id]/track-change-actions", () => ({
  changeTrackAction: vi.fn(),
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

type Props = React.ComponentProps<typeof PromocionesCard>;
type View = Props["view"];

const IN_PROGRESS: View = {
  state: "in_progress",
  nextTarget: "STRIPE",
  current: 47,
  target: 50,
  percent: 94,
  remaining: 3,
  actualCount: 47,
  reachedOn: null,
};

const BASE_PROPS: Props = {
  organizationId: "org-1",
  studentId: "student-1",
  belt: BASE_BELT,
  label: "White",
  currentStripes: 2,
  maxStripes: 4,
  lifetimeCount: 47,
  view: IN_PROGRESS,
  dueDateFormatted: null,
  reachedOnFormatted: null,
  history: [],
  creditHistory: [],
  canAct: true,
  rankOptions: [],
  trackChange: null,
};

function renderCard(overrides: Partial<Props> = {}) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <PromocionesCard {...BASE_PROPS} {...overrides} />
    </NextIntlClientProvider>,
  );
}

describe("PromocionesCard — ineligible state states the specific reason", () => {
  it("attendance rank: shows the count/threshold/remaining text, not a bare disabled button", () => {
    renderCard();
    expect(screen.getByText("47 / 50 · 3 remaining")).toBeInTheDocument();
    expect(screen.queryByText("Eligible for instructor review.")).not.toBeInTheDocument();
  });

  it("time-based rank: shows the due date text instead of an attendance count", () => {
    renderCard({
      view: { ...IN_PROGRESS, state: "time_pending", current: null, target: null, remaining: null, percent: 20 },
      dueDateFormatted: "October 15, 2026",
    });
    expect(screen.getByText("Next grade on October 15, 2026")).toBeInTheDocument();
  });

  it("HYBRID: shows both dimensions concatenated (known simplification — see scripts/pending-callers.ts)", () => {
    renderCard({ dueDateFormatted: "October 15, 2026" });
    expect(screen.getByText("47 / 50 · 3 remaining · Next grade on October 15, 2026")).toBeInTheDocument();
  });

  it("MANUAL mode: shows the coach's-discretion statement", () => {
    renderCard({ view: { ...IN_PROGRESS, state: "manual", current: null, target: null, remaining: null, percent: null } });
    expect(screen.getByText("Promotion is at the coach's discretion.")).toBeInTheDocument();
  });

  it("a black belt with no known last-promotion date says the date is needed - no due date, and attendance is still shown", () => {
    renderCard({
      view: { ...IN_PROGRESS, state: "time_anchor_missing", current: null, target: null, remaining: null, percent: null, actualCount: 12 },
    });
    expect(screen.getByText(enMessages.students.detail.promociones.lastPromotionDateNeeded)).toBeInTheDocument();
    expect(screen.getByText("12")).toBeInTheDocument();
    expect(screen.queryByText(/Next grade on/)).not.toBeInTheDocument();
  });

  it("a degree with no configured interval says it is not configured yet - never impossible or eligible", () => {
    renderCard({
      view: { ...IN_PROGRESS, state: "not_configured", current: null, target: null, remaining: null, percent: null },
    });
    expect(screen.getByText(enMessages.students.detail.promociones.nextDegreeNotConfigured)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Award promotion" })).toBeDisabled();
  });
});

describe("PromocionesCard — eligible state", () => {
  const ELIGIBLE: View = { ...IN_PROGRESS, state: "eligible", current: 50, target: 50, percent: 100, remaining: 0, actualCount: 57 };

  it("says eligible for instructor review (never an award), with no overflowing fraction, and the real count on its own line", () => {
    renderCard({ view: ELIGIBLE });
    expect(screen.getByText("Eligible for instructor review.")).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/57 \/ 50/);
    expect(screen.getByText("57")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Award promotion" })).toBeEnabled();
  });

  it("shows the reconstructed threshold date, labelled as recalculated from current records", () => {
    renderCard({ view: ELIGIBLE, reachedOnFormatted: "03/12/2026" });
    expect(screen.getByText("Threshold reached on 03/12/2026 (recalculated from current records)")).toBeInTheDocument();
  });

  it("shows no threshold date when there is none", () => {
    renderCard({ view: ELIGIBLE, reachedOnFormatted: null });
    expect(screen.queryByText(/recalculated from current records/)).not.toBeInTheDocument();
  });
});

describe("PromocionesCard — read-only", () => {
  it("a read-only session (INSTRUCTOR/STUDENT, canAct=false) still sees the specific reason and no action controls — read-only is never silent", () => {
    renderCard({ canAct: false });
    expect(screen.getByText("47 / 50 · 3 remaining")).toBeInTheDocument();
    expect(screen.getByText("Only admins and directors can award or correct promotions.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Award promotion" })).not.toBeInTheDocument();
    expect(screen.queryByText("Manual promote / correct")).not.toBeInTheDocument();
  });

  it("no credit-entry control exists on the card (no head-start credits)", () => {
    renderCard();
    expect(screen.queryByText("Correct onboarding credit")).not.toBeInTheDocument();
  });
});
