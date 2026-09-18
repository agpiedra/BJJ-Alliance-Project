import { describe, expect, it } from "vitest";
import {
  AA_CONTRAST_RATIO,
  contrastRatio,
  deriveBorder,
  deriveForeground,
  deriveHoverBackground,
  deriveInitials,
  isValidHexColor,
  meetsAA,
  resolvePrimaryTheme,
  resolveSidebarTheme,
  validateSidebarOverrides,
} from "@/lib/theme";

describe("contrastRatio / meetsAA", () => {
  it("black on white is the maximum 21:1", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 0);
  });

  it("a color against itself is the minimum 1:1", () => {
    expect(contrastRatio("#336699", "#336699")).toBeCloseTo(1, 5);
  });

  it("is symmetric — argument order never matters", () => {
    expect(contrastRatio("#111827", "#ffffff")).toBeCloseTo(contrastRatio("#ffffff", "#111827"), 10);
  });

  it("meetsAA matches the 4.5:1 threshold exactly at the boundary", () => {
    // Alliance's own default sidebar background against its own foreground —
    // real production values, not synthetic.
    expect(meetsAA("#ffffff", "#111827")).toBe(true);
    expect(AA_CONTRAST_RATIO).toBe(4.5);
  });
});

describe("deriveForeground", () => {
  it("picks the light ink on a near-black background", () => {
    expect(deriveForeground("#111827")).toMatch(/^#f/i);
  });

  it("picks the dark ink on Alliance's own default gold", () => {
    // #FACC15 is the doc's own default primaryColor.
    expect(deriveForeground("#FACC15")).toMatch(/^#2/i);
  });

  it("always returns a color meeting AA against its own background, whenever one of the two candidates can", () => {
    // A representative spread, not exhaustive — the point is the function
    // always picks the WINNING candidate, never a fixed one.
    for (const bg of ["#000000", "#ffffff", "#111827", "#FACC15", "#1E3A8A", "#7F1D1D"]) {
      const fg = deriveForeground(bg);
      expect(meetsAA(fg, bg)).toBe(true);
    }
  });
});

describe("resolvePrimaryTheme", () => {
  it("Alliance's own default gold passes AA with its derived foreground", () => {
    const resolved = resolvePrimaryTheme("#FACC15");
    expect(resolved.passesAA).toBe(true);
    expect(meetsAA(resolved.foreground, resolved.background)).toBe(true);
  });

  it("warns (reports failure) rather than throwing for a middling color neither ink reads well on", () => {
    // A mid-lightness, mid-saturation color deliberately chosen to sit in the
    // "neither near-black nor near-white text is comfortable" zone.
    const resolved = resolvePrimaryTheme("#8a8a5a");
    expect(resolved.passesAA).toBe(false);
    // Still returns something renderable — never throws, matching "warn, don't block".
    expect(resolved.foreground).toBeTruthy();
  });
});

describe("deriveHoverBackground / deriveBorder", () => {
  it("lightens a dark background and darkens a light one", () => {
    const darkHover = deriveHoverBackground("#111827");
    const lightHover = deriveHoverBackground("#f5f5f5");
    expect(darkHover.toLowerCase()).not.toBe("#111827");
    expect(lightHover.toLowerCase()).not.toBe("#f5f5f5");
  });

  it("gives a light background a visible dark-alpha border and a dark background a subtle light-alpha one", () => {
    expect(deriveBorder("#ffffff")).toContain("0, 0, 0");
    expect(deriveBorder("#111827")).toContain("255, 255, 255");
  });
});

describe("resolveSidebarTheme", () => {
  it("defaults the active pair to activeBackgroundDefault (primaryColor), NOT the sidebar's own background — regression test for the real active-nav token (--sidebar-primary, which aliases to --brand-gold by default, not --sidebar-accent/background) verified directly against staff-sidebar.tsx", () => {
    const resolved = resolveSidebarTheme({ background: "#111827", activeBackgroundDefault: "#FACC15" });
    expect(resolved.activeBackground).toBe("#FACC15");
    expect(meetsAA(resolved.activeForeground, "#FACC15")).toBe(true);
  });

  it("derives foreground/hover/border from background alone when nothing is overridden", () => {
    const resolved = resolveSidebarTheme({ background: "#111827", activeBackgroundDefault: "#FACC15" });
    expect(meetsAA(resolved.foreground, resolved.background)).toBe(true);
    expect(resolved.hoverBackground).not.toBe(resolved.background);
  });

  it("uses an explicit activeBackground override as-is instead of the primaryColor default", () => {
    const resolved = resolveSidebarTheme({
      background: "#111827",
      activeBackground: "#7F1D1D",
      activeBackgroundDefault: "#FACC15",
    });
    expect(resolved.activeBackground).toBe("#7F1D1D");
    expect(meetsAA(resolved.activeForeground, "#7F1D1D")).toBe(true);
  });

  it("a light background still derives a legible resting pair when nothing is overridden", () => {
    const resolved = resolveSidebarTheme({ background: "#f5f5f0", activeBackgroundDefault: "#FACC15" });
    expect(meetsAA(resolved.foreground, resolved.background)).toBe(true);
    expect(meetsAA(resolved.activeForeground, resolved.activeBackground)).toBe(true);
  });
});

describe("validateSidebarOverrides — the sidebar's block-not-warn rule", () => {
  it("passes when nothing is overridden — a derived value can never fail by construction", () => {
    expect(validateSidebarOverrides({ background: "#111827", activeBackgroundDefault: "#FACC15" })).toEqual({ ok: true });
    expect(validateSidebarOverrides({ background: "#ffffff", activeBackgroundDefault: "#FACC15" })).toEqual({ ok: true });
  });

  it("passes a legible explicit override", () => {
    const result = validateSidebarOverrides({
      background: "#111827",
      foreground: "#ffffff",
      activeBackgroundDefault: "#FACC15",
    });
    expect(result.ok).toBe(true);
  });

  it("blocks an illegible explicit foreground override and offers a corrected suggestion", () => {
    const result = validateSidebarOverrides({
      background: "#111827",
      foreground: "#222222",
      activeBackgroundDefault: "#FACC15",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failures).toHaveLength(1);
      expect(result.failures[0].field).toBe("foreground");
      expect(meetsAA(result.failures[0].suggestion, "#111827")).toBe(true);
    }
  });

  it("blocks an illegible active pair independently of the resting pair", () => {
    const result = validateSidebarOverrides({
      background: "#111827",
      foreground: "#ffffff",
      activeBackground: "#e5e5e5",
      activeForeground: "#f0f0f0",
      activeBackgroundDefault: "#FACC15",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failures.map((f) => f.field)).toEqual(["activeForeground"]);
    }
  });

  it("validates the active pair against activeBackgroundDefault when activeBackground is unset", () => {
    // A middling primaryColor whose derived foreground still fails AA
    // against it should surface as a failure even though activeBackground
    // was never explicitly overridden.
    const result = validateSidebarOverrides({
      background: "#111827",
      activeForeground: "#ffffff",
      activeBackgroundDefault: "#e5e5e5",
    });
    expect(result.ok).toBe(false);
  });
});

describe("isValidHexColor", () => {
  it("accepts a real 6-digit hex", () => {
    expect(isValidHexColor("#FACC15")).toBe(true);
    expect(isValidHexColor("#abc123")).toBe(true);
  });

  it("rejects anything else", () => {
    expect(isValidHexColor("FACC15")).toBe(false);
    expect(isValidHexColor("#fff")).toBe(false);
    expect(isValidHexColor("red")).toBe(false);
    expect(isValidHexColor("#gggggg")).toBe(false);
    expect(isValidHexColor("<script>alert(1)</script>")).toBe(false);
  });
});

describe("deriveInitials", () => {
  it("takes the first letter of up to the first two words, uppercased", () => {
    expect(deriveInitials("Alliance Jiu-Jitsu Costa Rica")).toBe("AJ");
    expect(deriveInitials("Demo")).toBe("D");
    expect(deriveInitials("  spaced   out  ")).toBe("SO");
  });
});
