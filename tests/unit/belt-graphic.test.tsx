/** @vitest-environment jsdom */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { BeltGraphic, type BeltVisualData } from "@/components/belt-graphic/belt-graphic";
import { BeltBar } from "@/components/belt-graphic/belt-bar";
import { visibleTapes } from "@/lib/belt-display";

const SOLID: BeltVisualData = {
  primaryColor: "#215DA5",
  centerStripeColor: null,
  barColor: "#111116",
  stripeColors: ["#FFFFFF", "#FFFFFF", "#FFFFFF", "#FFFFFF"],
  maxStripes: 4,
  visibleStripeSlots: 4,
};

const CENTER_STRIPE: BeltVisualData = {
  primaryColor: "#9CA3AF",
  centerStripeColor: "#F0EBE0",
  barColor: "#111116",
  stripeColors: ["#FFFFFF", "#FFFFFF", "#FFFFFF", "#FFFFFF", "#DC2626"],
  maxStripes: 5,
  visibleStripeSlots: 4,
};

const ELEVEN_DEGREE: BeltVisualData = {
  primaryColor: "#16A34A",
  centerStripeColor: null,
  barColor: "#111116",
  stripeColors: [
    "#FFFFFF",
    "#FFFFFF",
    "#FFFFFF",
    "#FFFFFF",
    "#DC2626",
    "#DC2626",
    "#DC2626",
    "#DC2626",
    "#FACC15",
    "#FACC15",
    "#FACC15",
  ],
  maxStripes: 11,
  visibleStripeSlots: 4,
};

/** Tapes are the only rects given a 0.75 stroke-width outline (revision
 * 21: "give every tape a thin contrasting outline") — the body fill, the
 * centre-stripe band, and the border/bar rects use different stroke
 * widths (1) or none, so this selector picks out exactly the tapes. */
function tapeRects(container: HTMLElement): NodeListOf<Element> {
  return container.querySelectorAll('rect[stroke-width="0.75"]');
}

describe("BeltGraphic — tape counts per rank and degree", () => {
  it.each([
    [0, 0],
    [2, 2],
    [4, 4],
  ])("solid 4-degree belt at degree %i draws exactly %i tapes", (stripes, expectedCount) => {
    const { container } = render(<BeltGraphic belt={SOLID} stripes={stripes} label="test" />);
    expect(tapeRects(container)).toHaveLength(expectedCount);
    expect(tapeRects(container)).toHaveLength(visibleTapes(SOLID, stripes).length);
  });

  it.each([
    [3, 3],
    [5, 4],
    [11, 4],
  ])(
    "an 11-degree belt at degree %i never draws more than visibleStripeSlots (draws %i)",
    (stripes, expectedCount) => {
      const { container } = render(<BeltGraphic belt={ELEVEN_DEGREE} stripes={stripes} label="test" />);
      expect(tapeRects(container)).toHaveLength(expectedCount);
      expect(tapeRects(container).length).toBeLessThanOrEqual(ELEVEN_DEGREE.visibleStripeSlots);
    },
  );

  it("degree 100 (far above maxStripes) still never draws more than visibleStripeSlots tapes", () => {
    const { container } = render(<BeltGraphic belt={ELEVEN_DEGREE} stripes={100} label="test" />);
    expect(tapeRects(container)).toHaveLength(ELEVEN_DEGREE.visibleStripeSlots);
  });
});

describe("BeltGraphic — centre-stripe band structure (revision 21: a band, not two halves)", () => {
  it("a centerStripeColor rank renders a band rect in that color through the middle third", () => {
    const { container } = render(<BeltGraphic belt={CENTER_STRIPE} stripes={0} label="test" />);
    const bandRect = Array.from(container.querySelectorAll("rect")).find(
      (r) => r.getAttribute("fill") === CENTER_STRIPE.centerStripeColor,
    );
    expect(bandRect).toBeDefined();
    // Middle third of the 40-unit-tall viewBox: y ≈ 13.33, height ≈ 13.33 —
    // not a 50/50 split, and not the full height.
    const y = Number(bandRect!.getAttribute("y"));
    const height = Number(bandRect!.getAttribute("height"));
    expect(y).toBeCloseTo(40 / 3, 1);
    expect(height).toBeCloseTo(40 / 3, 1);
  });

  it("a solid rank (no centerStripeColor) renders no extra band rect beyond its own body fill", () => {
    const { container } = render(<BeltGraphic belt={SOLID} stripes={0} label="test" />);
    const distinctFills = new Set(
      Array.from(container.querySelectorAll("rect"))
        .map((r) => r.getAttribute("fill"))
        .filter((fill) => fill && fill !== "none" && !fill.startsWith("url(")),
    );
    // Only the body (primaryColor) and the bar (barColor) are plain solid
    // fills on a belt with no centre stripe — never a third band color.
    expect(distinctFills.size).toBe(2);
    expect(distinctFills.has(SOLID.primaryColor)).toBe(true);
    expect(distinctFills.has(SOLID.barColor)).toBe(true);
  });

  it("on a centre-striped belt, no stitching line crosses the band", () => {
    const { container } = render(<BeltGraphic belt={CENTER_STRIPE} stripes={0} label="test" size="lg" />);
    const bandTop = 40 / 3;
    const bandBottom = (40 * 2) / 3;
    const stitchLines = container.querySelectorAll('line[stroke-dasharray="3 3"]');
    expect(stitchLines.length).toBeGreaterThan(0);
    for (const line of Array.from(stitchLines)) {
      const y = Number(line.getAttribute("y1"));
      expect(y <= bandTop || y >= bandBottom).toBe(true);
    }
  });
});

describe("BeltGraphic — unique SVG ids across many instances", () => {
  it("25 belts of different colors on one page never share a def id", () => {
    const belts = Array.from({ length: 25 }, (_, i) => ({
      ...SOLID,
      primaryColor: `#${(i * 12345).toString(16).padStart(6, "0").slice(0, 6)}`,
    }));
    const { container } = render(
      <>
        {belts.map((belt, i) => (
          <BeltGraphic key={i} belt={belt} stripes={i % 5} label={`belt ${i}`} />
        ))}
      </>,
    );
    const ids = Array.from(container.querySelectorAll("[id]")).map((el) => el.id);
    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("BeltGraphic — accessible label and visible degree text", () => {
  it("exposes the caller-supplied label via aria-label on the SVG, so color alone never carries meaning", () => {
    render(<BeltGraphic belt={SOLID} stripes={2} label="Blue belt, 2 stripes" />);
    expect(screen.getByRole("img", { name: "Blue belt, 2 stripes" })).toBeInTheDocument();
  });

  it("renders the degree number beside the graphic when the caller includes it in the label", () => {
    render(<BeltGraphic belt={ELEVEN_DEGREE} stripes={7} label="Grey 7/11" />);
    expect(screen.getByText("Grey 7/11")).toBeInTheDocument();
  });
});

describe("BeltGraphic — degree clamping", () => {
  it("clamps stripes above belt.maxStripes down to maxStripes", () => {
    render(<BeltGraphic belt={SOLID} stripes={9} label="Clamped high" />);
    const { container } = render(<BeltGraphic belt={SOLID} stripes={SOLID.maxStripes} label="At max" />);
    expect(tapeRects(container)).toHaveLength(SOLID.maxStripes);
    expect(screen.getByRole("img", { name: "Clamped high" })).toBeInTheDocument();
  });

  it("clamps negative stripes up to 0", () => {
    const { container } = render(<BeltGraphic belt={SOLID} stripes={-3} label="Clamped low" />);
    expect(tapeRects(container)).toHaveLength(0);
  });
});

describe("BeltBar — the compact list-row wrapper", () => {
  it("is aria-hidden (the caller's own adjacent text carries the accessible label, per REDESIGN_BRIEF.md Phase 3)", () => {
    const { container } = render(<BeltBar belt={SOLID} stripes={2} />);
    expect(container.querySelector("[aria-hidden]")).toBeInTheDocument();
    expect(container.querySelector("svg")).toHaveAttribute("aria-label", "");
  });

  it("still draws the correct tape count at xs size", () => {
    const { container } = render(<BeltBar belt={ELEVEN_DEGREE} stripes={9} />);
    expect(tapeRects(container)).toHaveLength(visibleTapes(ELEVEN_DEGREE, 9).length);
  });
});
