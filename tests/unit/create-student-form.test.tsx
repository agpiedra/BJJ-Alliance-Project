/** @vitest-environment jsdom */
import { render, screen, fireEvent } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";
import enMessages from "../../messages/en.json";

/**
 * MULTI_ACADEMY_AND_KIDS_BELTS.md Phase 3c-i: "add a required track
 * control... selecting the track filters the rank dropdown to that
 * track's ranks." Same @testing-library/react + jsdom setup this repo's
 * other form tests use — see promociones-card.test.tsx / record-payment-
 * form.test.tsx for the established pattern.
 */
vi.mock("../../src/app/[locale]/(staff)/students/create-student-action", () => ({
  createStudent: vi.fn(),
}));

const { CreateStudentForm } = await import(
  "../../src/app/[locale]/(staff)/students/create-student-form"
);

const RANK_OPTIONS = [
  { id: "adult-white", code: "WHITE", track: "ADULT" as const, order: 1, maxStripes: 4, labelEs: "Blanco", labelEn: "White" },
  { id: "adult-blue", code: "BLUE", track: "ADULT" as const, order: 2, maxStripes: 4, labelEs: "Azul", labelEn: "Blue" },
  { id: "kids-white", code: "white", track: "KIDS" as const, order: 1, maxStripes: 5, labelEs: "Blanco", labelEn: "White" },
  { id: "kids-grey", code: "grey", track: "KIDS" as const, order: 3, maxStripes: 11, labelEs: "Gris", labelEn: "Grey" },
];

function renderForm() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <CreateStudentForm
        organizationId="org-1"
        academies={[{ id: "academy-1", name: "Alliance Escazú" }]}
        rankOptions={RANK_OPTIONS}
      />
    </NextIntlClientProvider>,
  );
}

function options(select: HTMLElement): string[] {
  return Array.from((select as HTMLSelectElement).options).map((o) => o.value);
}

describe("CreateStudentForm — track control filters the rank dropdown", () => {
  it("defaults to ADULT track, showing only adult ranks", () => {
    renderForm();
    expect(screen.getByLabelText("Student type")).toHaveValue("ADULT");
    const rankSelect = screen.getByLabelText("Current belt");
    expect(options(rankSelect)).toEqual(["adult-white", "adult-blue"]);
  });

  it("switching to KIDS filters the rank dropdown to kids ranks and resets to the first one", () => {
    renderForm();
    fireEvent.change(screen.getByLabelText("Student type"), { target: { value: "KIDS" } });

    const rankSelect = screen.getByLabelText("Current belt");
    expect(options(rankSelect)).toEqual(["kids-white", "kids-grey"]);
    expect(rankSelect).toHaveValue("kids-white");
  });

  it("the stripe range follows the selected rank's maxStripes, not a fixed 0-4", () => {
    renderForm();
    fireEvent.change(screen.getByLabelText("Student type"), { target: { value: "KIDS" } });
    fireEvent.change(screen.getByLabelText("Current belt"), { target: { value: "kids-grey" } });

    const stripesSelect = screen.getByLabelText("Current stripes");
    expect(options(stripesSelect)).toEqual(Array.from({ length: 12 }, (_, i) => String(i)));
  });

  it("changing rank resets the stripe selection back to 0", () => {
    renderForm();
    const stripesSelect = screen.getByLabelText("Current stripes") as HTMLSelectElement;
    fireEvent.change(stripesSelect, { target: { value: "3" } });
    expect(stripesSelect).toHaveValue("3");

    fireEvent.change(screen.getByLabelText("Current belt"), { target: { value: "adult-blue" } });
    expect(stripesSelect).toHaveValue("0");
  });
});
