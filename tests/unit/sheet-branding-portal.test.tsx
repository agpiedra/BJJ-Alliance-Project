/** @vitest-environment jsdom */
import { useRef } from "react";
import { render, screen, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { BrandingPortalContext } from "@/components/branding/branding-portal-context";

/**
 * Regression coverage for DESIGN.md §7.10's fix (review finding 4): a
 * portaled Sheet must become a real DOM descendant of the nearest
 * BrandingScope wrapper when one exists, so the tenant's sidebar/brand-gold
 * token overrides reach it — and must still render at all (not
 * silently disappear) with no BrandingScope ancestor. The second case is a
 * direct regression guard for a bug caught before this ever shipped: Base
 * UI's Dialog.Portal treats an explicit `container={null}` as "not
 * resolved yet, render nothing," not "use the default" — only `undefined`
 * falls through to document.body. Real browser coverage (actual tenant
 * colours reaching the mobile sheet) lives in tests/browser/shell-navigation.test.ts;
 * this file proves the DOM wiring itself, fast and deterministically.
 */
afterEach(cleanup);

function BrandedWrapper({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  return (
    <div data-testid="branding-wrapper" ref={ref}>
      <BrandingPortalContext.Provider value={ref}>{children}</BrandingPortalContext.Provider>
    </div>
  );
}

describe("Sheet's branding-aware portal placement", () => {
  it("REQUIRED: portals into the BrandingScope wrapper when one is present, not document.body", () => {
    render(
      <BrandedWrapper>
        <Sheet open>
          <SheetContent>sheet content</SheetContent>
        </Sheet>
      </BrandedWrapper>,
    );
    const content = screen.getByText("sheet content");
    const wrapper = screen.getByTestId("branding-wrapper");
    expect(wrapper.contains(content), "the sheet's content must be a DOM descendant of the branded wrapper").toBe(true);
  });

  it("REQUIRED: still renders (falls back to the default portal target) with no BrandingScope ancestor — the container={null} regression", () => {
    render(
      <Sheet open>
        <SheetContent>unbranded content</SheetContent>
      </Sheet>,
    );
    // The real bug this guards: passing the context's raw `null` default straight through to
    // Base UI's `container` prop made the Dialog treat it as "not resolved yet" and render
    // nothing at all, for every Sheet with no BrandingScope ancestor — not just unthemed ones.
    const content = screen.getByText("unbranded content");
    expect(content).toBeInTheDocument();
    expect(document.body.contains(content)).toBe(true);
  });

  it("REQUIRED: an unrelated Sheet consumer (no BrandingScope anywhere in the tree) is unaffected by this feature existing", () => {
    render(
      <Sheet open>
        <SheetContent showCloseButton={false}>plain sheet, matching the schedule-calendar-view.tsx / payments-table.tsx usage pattern</SheetContent>
      </Sheet>,
    );
    expect(screen.getByText(/plain sheet/)).toBeInTheDocument();
  });
});
