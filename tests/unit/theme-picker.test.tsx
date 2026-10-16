/** @vitest-environment jsdom */
import { render, fireEvent, cleanup, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, describe, expect, it } from "vitest";
import enMessages from "../../messages/en.json";
import type { ThemePickerInitialValues } from "../../src/components/branding/theme-picker";

const { ThemePicker } = await import("../../src/components/branding/theme-picker");

const DEFAULT_INITIAL: ThemePickerInitialValues = {
  displayName: "Test Academy",
  primaryColor: "#254b35",
  sidebarBackground: "#fffefa",
  sidebarForeground: null,
  sidebarActiveBackground: null,
  sidebarActiveForeground: null,
  sidebarBorder: null,
  isDefaultMode: true,
};

async function noopAction() {
  return {};
}

function renderPicker(initial: ThemePickerInitialValues = DEFAULT_INITIAL) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <ThemePicker organizationId="org-1" initial={initial} action={noopAction} />
    </NextIntlClientProvider>,
  );
}

afterEach(cleanup);

/**
 * Covers the bug the user caught during planning: `initial.isDefaultMode && !customizeSidebar`
 * was frozen at mount, so editing primaryColor/sidebarBackground while leaving overrides
 * unchecked left the preview showing the OLD default even though Save would flip to stored
 * mode. Fixed with `draftMatchesDefault`, recomputed live on every render — these tests prove
 * the live recompute, not just the formula in isolation.
 */
describe("ThemePicker — preview/draft-match (default-mode theme-scoped preview)", () => {
  it("an untouched default-mode org previews via the theme-scoped CSS vars, not literal hex", () => {
    renderPicker();

    const buttonPreview = screen.getByText("Button");
    expect(buttonPreview.getAttribute("style")).toContain("var(--brand-gold)");

    const sidebarPreviewLabel = screen.getByText("Preview");
    expect(sidebarPreviewLabel.parentElement?.getAttribute("style")).toContain("var(--sidebar)");
  });

  it("editing primaryColor away from the default flips the preview to the computed literal value live, with no save in between", () => {
    renderPicker();
    const primaryInput = document.querySelector('input[name="primaryColor"]') as HTMLInputElement;

    fireEvent.change(primaryInput, { target: { value: "#215da5" } });

    const buttonPreview = screen.getByText("Button");
    expect(buttonPreview.getAttribute("style")).not.toContain("var(--brand-gold)");
  });

  it("editing sidebarBackground away from the default flips the WHOLE preview (one shared gate) — the button preview flips too, even though primaryColor itself was never touched", () => {
    renderPicker();
    const sidebarBgInput = document.querySelector('input[name="sidebarBackground"]') as HTMLInputElement;

    fireEvent.change(sidebarBgInput, { target: { value: "#0b2545" } });

    const sidebarPreviewLabel = screen.getByText("Preview");
    expect(sidebarPreviewLabel.parentElement?.getAttribute("style")).not.toContain("var(--sidebar)");
    const buttonPreview = screen.getByText("Button");
    expect(buttonPreview.getAttribute("style")).not.toContain("var(--brand-gold)");
  });

  it('checking "Customize sidebar" alone (no swatch touched) flips the preview too — enabling overrides is itself an edit, matching the server save guard', () => {
    renderPicker();
    const checkbox = screen.getByRole("checkbox");

    fireEvent.click(checkbox);

    const sidebarPreviewLabel = screen.getByText("Preview");
    expect(sidebarPreviewLabel.parentElement?.getAttribute("style")).not.toContain("var(--sidebar)");
  });

  it("unchecking it again reverts the preview back to the theme-scoped vars (draft now matches the default exactly again)", () => {
    renderPicker();
    const checkbox = screen.getByRole("checkbox");

    fireEvent.click(checkbox);
    fireEvent.click(checkbox);

    const sidebarPreviewLabel = screen.getByText("Preview");
    expect(sidebarPreviewLabel.parentElement?.getAttribute("style")).toContain("var(--sidebar)");
  });

  it("a row that did NOT start in default mode never previews as default-mode, even if every draft value happens to match the shared default exactly", () => {
    renderPicker({ ...DEFAULT_INITIAL, isDefaultMode: false });

    const buttonPreview = screen.getByText("Button");
    expect(buttonPreview.getAttribute("style")).not.toContain("var(--brand-gold)");
  });
});
