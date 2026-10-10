/** @vitest-environment jsdom */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { OrgRow } from "../../src/components/auth/org-row";

/**
 * MATROOM Phase 1 round 3 — the approved prototype's `.org-meta .name`/`.role`
 * have no overflow/ellipsis/nowrap rule (design/matroom/preview/auth-access-phase-prototype.html);
 * a long organization name is meant to wrap, not hide the text that distinguishes
 * it from another row. Round 2 shipped `truncate` by mistake; this guards the fix.
 */
describe("OrgRow", () => {
  it("REQUIRED: renders a long organization name in full, not truncated", () => {
    const longName = "Northgate International Jiu-Jitsu and Mixed Martial Arts Academy";
    render(<OrgRow mark="NI" name={longName} role="Owner" />);

    const nameEl = screen.getByText(longName);
    expect(nameEl.className).not.toMatch(/\btruncate\b/);
    expect(nameEl.className).not.toMatch(/\bwhitespace-nowrap\b/);
    expect(nameEl.className).not.toMatch(/\btext-ellipsis\b/);
  });

  it("renders the mark and role", () => {
    render(<OrgRow mark="AJ" name="Alliance Jiu-Jitsu Costa Rica" role="Instructor" />);
    expect(screen.getByText("AJ")).toBeTruthy();
    expect(screen.getByText("Alliance Jiu-Jitsu Costa Rica")).toBeTruthy();
    expect(screen.getByText("Instructor")).toBeTruthy();
  });

  it("uses the secondary mark tone when requested", () => {
    render(<OrgRow mark="NI" markTone="secondary" name="Org" role="Owner" />);
    expect(screen.getByText("NI").className).toMatch(/\bbg-secondary\b/);
  });
});
