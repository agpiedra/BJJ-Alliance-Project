/** @vitest-environment jsdom */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LogoMark } from "@/components/brand/logo-mark";
import { MatroomMark, MatroomWordmark } from "@/components/brand/matroom-mark";
import manifest from "@/app/manifest";
import { PLATFORM_NAME } from "@/lib/platform";

describe("MATROOM identity", () => {
  it("PLATFORM_NAME is MATROOM, the one place the name is defined", () => {
    expect(PLATFORM_NAME).toBe("MATROOM");
  });

  it("the mark is two skewed rules, decorative (aria-hidden) and sized by its width", () => {
    const { container } = render(<MatroomMark size={48} />);
    const svg = container.querySelector("svg")!;
    expect(svg.getAttribute("aria-hidden")).toBe("true");
    expect(svg.getAttribute("width")).toBe("48");
    expect(svg.querySelectorAll("polygon")).toHaveLength(2);
    expect(svg.getAttribute("fill")).toBe("currentColor"); // takes its colour from the surface, so it works on any theme
  });

  it("the wordmark carries the platform name as real text", () => {
    render(<MatroomWordmark />);
    expect(screen.getByText("MATROOM")).toBeInTheDocument();
  });

  it("LogoMark with no organization shows the MATROOM wordmark, never another name", () => {
    const { container } = render(<LogoMark />);
    expect(screen.getByText("MATROOM")).toBeInTheDocument();
    expect(container.querySelector("svg")).not.toBeNull();
  });

  it("LogoMark with an organization's logo or initials still shows the organization, not the platform", () => {
    const { rerender } = render(<LogoMark logoUrl="https://example.com/l.png" alt="Harbor" />);
    expect(screen.getByAltText("Harbor")).toBeInTheDocument();
    expect(screen.queryByText("MATROOM")).toBeNull();
    rerender(<LogoMark initials="HJ" initialsBackground="#123B4A" initialsForeground="#fbfaf6" />);
    expect(screen.getByText("HJ")).toBeInTheDocument();
    expect(screen.queryByText("MATROOM")).toBeNull();
  });

  it("the PWA manifest names the platform and uses the MATROOM ground colour", () => {
    const m = manifest();
    expect(m.name).toBe("MATROOM");
    expect(m.short_name).toBe("MATROOM");
    expect(m.background_color).toBe("#f5f3ec");
    expect(m.theme_color).toBe("#f5f3ec");
  });
});
