/** @vitest-environment jsdom */
import { render, screen, fireEvent } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";
import enMessages from "../../messages/en.json";

/**
 * MULTI_ACADEMY_AND_KIDS_BELTS.md Phase 3c-ii: the explicit track-change
 * flow's rank/stripe controls. Same @testing-library/react + jsdom pattern
 * as create-student-form.test.tsx / promotion-correction-form's siblings.
 */
vi.mock("../../src/app/[locale]/(staff)/students/[id]/track-change-actions", () => ({
  changeTrackAction: vi.fn(),
}));

const { TrackChangeForm } = await import(
  "../../src/app/[locale]/(staff)/students/[id]/track-change-form"
);

const ADULT_RANK_OPTIONS = [
  { id: "adult-white", code: "WHITE", order: 1, maxStripes: 4, labelEs: "Blanco", labelEn: "White" },
  { id: "adult-blue", code: "BLUE", order: 2, maxStripes: 4, labelEs: "Azul", labelEn: "Blue" },
];

function renderForm(overrides: Partial<React.ComponentProps<typeof TrackChangeForm>> = {}) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <TrackChangeForm
        organizationId="org-1"
        studentId="student-1"
        rankOptions={ADULT_RANK_OPTIONS}
        defaultRankId={null}
        isTransition={false}
        {...overrides}
      />
    </NextIntlClientProvider>,
  );
}

describe("TrackChangeForm", () => {
  it("shows the generic toggle label when isTransition is false", () => {
    renderForm({ isTransition: false });
    expect(screen.getByText("Change track", { selector: "summary" })).toBeInTheDocument();
    expect(screen.queryByText("Transition to adult")).not.toBeInTheDocument();
  });

  it("shows the Transition to adult label when isTransition is true", () => {
    renderForm({ isTransition: true });
    expect(screen.getByText("Transition to adult", { selector: "summary" })).toBeInTheDocument();
  });

  it("with no defaultRankId, the rank select has no real selection and the submit button stays disabled", () => {
    renderForm({ defaultRankId: null });
    const rankSelect = screen.getByLabelText("Destination rank") as HTMLSelectElement;
    expect(rankSelect).toHaveValue("");
    expect(screen.getByRole("button", { name: "Change track" })).toBeDisabled();
  });

  it("with a defaultRankId (green_black -> adult blue), the rank select is preselected and submit is enabled", () => {
    renderForm({ defaultRankId: "adult-blue" });
    const rankSelect = screen.getByLabelText("Destination rank") as HTMLSelectElement;
    expect(rankSelect).toHaveValue("adult-blue");
    expect(screen.getByRole("button", { name: "Change track" })).not.toBeDisabled();
  });

  it("the stripe range follows the selected rank's maxStripes and resets to 0 when the rank changes", () => {
    renderForm({ defaultRankId: null });
    const rankSelect = screen.getByLabelText("Destination rank");
    fireEvent.change(rankSelect, { target: { value: "adult-blue" } });

    const stripesSelect = screen.getByLabelText("Degrees") as HTMLSelectElement;
    expect(Array.from(stripesSelect.options).map((o) => o.value)).toEqual(["0", "1", "2", "3", "4"]);
    expect(stripesSelect).toHaveValue("0");

    fireEvent.change(stripesSelect, { target: { value: "3" } });
    expect(stripesSelect).toHaveValue("3");
    fireEvent.change(rankSelect, { target: { value: "adult-white" } });
    expect(stripesSelect).toHaveValue("0");
  });
});
