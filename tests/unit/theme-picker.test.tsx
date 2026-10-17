/** @vitest-environment jsdom */
import { render, fireEvent, cleanup, screen, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, describe, expect, it } from "vitest";
import enMessages from "../../messages/en.json";
import { resolveSidebarTheme, resolvePrimaryTheme } from "../../src/lib/theme";
import { MATROOM_DEFAULT_BRANDING } from "../../src/lib/branding/default-palette";
import type { ActionState } from "../../src/lib/action-state";
import type { ThemePickerInitialValues } from "../../src/components/branding/theme-picker";

const { ThemePicker } = await import("../../src/components/branding/theme-picker");

/** jsdom normalizes any inline hex style to rgb(...) — compare through its own parser both ways
 * instead of a raw string comparison, so formatting differences never cause a false mismatch. */
function cssColor(hex: string): string {
  const probe = document.createElement("div");
  probe.style.backgroundColor = hex;
  document.body.appendChild(probe);
  const resolved = getComputedStyle(probe).backgroundColor;
  document.body.removeChild(probe);
  return resolved;
}

function captureSubmit(): {
  action: (organizationId: string, prevState: ActionState, formData: FormData) => Promise<ActionState>;
  peek: () => FormData | null;
  get: () => FormData;
} {
  let captured: FormData | null = null;
  return {
    action: async (_organizationId, _prevState, formData) => {
      captured = formData;
      return {};
    },
    peek: () => captured,
    get: () => {
      if (!captured) throw new Error("form was not submitted");
      return captured;
    },
  };
}

async function submitForm(submit: { peek: () => FormData | null }) {
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(submit.peek()).not.toBeNull());
}

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

/**
 * Confirmed blocker: checking "Customize sidebar" on a default-mode academy exposes inputs whose
 * DISPLAYED/SUBMITTED values fall back to MATROOM_DEFAULT_BRANDING.light, but the preview/validation
 * (`sidebarInput`) read the raw, still-empty override state and passed `null` to
 * `resolveSidebarTheme` instead — so the preview showed one theme while a DIFFERENT one was actually
 * submitted (e.g. activeBackground previewed as derived-from-primaryColor while the real submitted
 * value was the literal `#e6ebdd`). These tests read the REAL FormData a Save submits and assert the
 * preview equals the theme `resolveSidebarTheme` resolves from THAT payload — not merely that the
 * theme-scoped CSS vars disappeared (every one of these states already has customizeSidebar checked,
 * so the earlier describe block's "flips the preview" tests are satisfied vacuously here; that is not
 * the bug this covers).
 */
describe("ThemePicker — enabled-override preview must equal what Save actually submits", () => {
  function activeItemBg() {
    return getComputedStyle(screen.getByText("Active item")).backgroundColor;
  }
  function activeItemFg() {
    return getComputedStyle(screen.getByText("Active item")).color;
  }
  function buttonBg() {
    return getComputedStyle(screen.getByText("Button")).backgroundColor;
  }

  it("enabling Customize sidebar without touching any swatch: the preview's active item matches the theme resolved from the real submitted FormData", async () => {
    const submit = captureSubmit();
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <ThemePicker organizationId="org-1" initial={DEFAULT_INITIAL} action={submit.action} />
      </NextIntlClientProvider>,
    );

    fireEvent.click(screen.getByRole("checkbox"));
    await submitForm(submit);

    const fd = submit.get();
    const primary = resolvePrimaryTheme(fd.get("primaryColor") as string);
    const expected = resolveSidebarTheme({
      background: fd.get("sidebarBackground") as string,
      foreground: fd.get("sidebarForeground") as string,
      activeBackground: fd.get("sidebarActiveBackground") as string,
      activeForeground: fd.get("sidebarActiveForeground") as string,
      activeBackgroundDefault: primary.background,
      border: fd.get("sidebarBorder") as string,
    });

    // The confirmed example: untouched sidebarActiveBackground must submit the approved literal
    // (#e6ebdd), not silently derive from primaryColor.
    expect(fd.get("sidebarActiveBackground")).toBe(MATROOM_DEFAULT_BRANDING.light.sidebarActiveBackground);
    expect(activeItemBg()).toBe(cssColor(expected.activeBackground));
    expect(activeItemFg()).toBe(cssColor(expected.activeForeground));
    expect(buttonBg()).toBe(cssColor(primary.background));
  });

  it("editing only sidebarActiveBackground, leaving the other three overrides untouched: the untouched activeForeground re-derives from the EDITED activeBackground, and the preview matches the submitted payload", async () => {
    const submit = captureSubmit();
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <ThemePicker organizationId="org-1" initial={DEFAULT_INITIAL} action={submit.action} />
      </NextIntlClientProvider>,
    );

    fireEvent.click(screen.getByRole("checkbox"));
    const activeBgInput = document.querySelector('input[name="sidebarActiveBackground"]') as HTMLInputElement;
    fireEvent.change(activeBgInput, { target: { value: "#0b2545" } });
    await submitForm(submit);

    const fd = submit.get();
    expect(fd.get("sidebarActiveBackground")).toBe("#0b2545");
    // The untouched sibling must NOT still be the approved literal paired with the OLD
    // activeBackground (#e6ebdd's own approved foreground) — it must pair with the NEW one.
    expect(fd.get("sidebarActiveForeground")).not.toBe(MATROOM_DEFAULT_BRANDING.light.sidebarActiveForeground);

    const primary = resolvePrimaryTheme(fd.get("primaryColor") as string);
    const expected = resolveSidebarTheme({
      background: fd.get("sidebarBackground") as string,
      foreground: fd.get("sidebarForeground") as string,
      activeBackground: fd.get("sidebarActiveBackground") as string,
      activeForeground: fd.get("sidebarActiveForeground") as string,
      activeBackgroundDefault: primary.background,
      border: fd.get("sidebarBorder") as string,
    });
    expect(activeItemBg()).toBe(cssColor(expected.activeBackground));
    expect(activeItemFg()).toBe(cssColor(expected.activeForeground));

    // The three untouched overrides must still submit SOMETHING consistent with the preview, not be
    // silently dropped.
    expect(fd.get("sidebarForeground")).toBe(MATROOM_DEFAULT_BRANDING.light.sidebarForeground);
    expect(fd.get("sidebarBorder")).toBe(MATROOM_DEFAULT_BRANDING.light.sidebarBorder);
  });

  it("a stored-mode (non-default) org: enabling overrides without touching swatches still previews exactly what gets submitted (existing self-consistent behavior, unaffected)", async () => {
    const submit = captureSubmit();
    const storedInitial: ThemePickerInitialValues = {
      displayName: "Stored Org",
      primaryColor: "#7F1D1D",
      sidebarBackground: "#1A0505",
      sidebarForeground: null,
      sidebarActiveBackground: null,
      sidebarActiveForeground: null,
      sidebarBorder: null,
      isDefaultMode: false,
    };
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <ThemePicker organizationId="org-1" initial={storedInitial} action={submit.action} />
      </NextIntlClientProvider>,
    );

    fireEvent.click(screen.getByRole("checkbox"));
    await submitForm(submit);

    const fd = submit.get();
    const primary = resolvePrimaryTheme(fd.get("primaryColor") as string);
    const expected = resolveSidebarTheme({
      background: fd.get("sidebarBackground") as string,
      foreground: fd.get("sidebarForeground") as string,
      activeBackground: fd.get("sidebarActiveBackground") as string,
      activeForeground: fd.get("sidebarActiveForeground") as string,
      activeBackgroundDefault: primary.background,
      border: fd.get("sidebarBorder") as string,
    });
    expect(activeItemBg()).toBe(cssColor(expected.activeBackground));
    expect(activeItemFg()).toBe(cssColor(expected.activeForeground));
  });
});
