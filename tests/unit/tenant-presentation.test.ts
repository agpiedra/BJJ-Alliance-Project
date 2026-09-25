import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { contrastRatio, NON_TEXT_CONTRAST_RATIO, resolveDataFill, resolveTenantPresentation, THEME_SURFACES, tenantNeedsActionEdge } from "@/lib/theme";

const hue = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  if (d === 0) return 0;
  const h = max === r ? ((g - b) / d + (g < b ? 6 : 0)) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return h * 60;
};
const luminanceOrder = (a: string, b: string) => contrastRatio(a, "#000000") - contrastRatio(b, "#000000"); // > 0: a is lighter than b
const ALL_SURFACES = (theme: "light" | "dark") => [THEME_SURFACES[theme].track, THEME_SURFACES[theme].card, THEME_SURFACES[theme].ground];

describe("THEME_SURFACES mirror design/matroom/tokens.css (the authority)", () => {
  const css = readFileSync(join(__dirname, "..", "..", "design", "matroom", "tokens.css"), "utf8");
  const of = (selector: string, name: string) => {
    const start = css.indexOf(`\n${selector} {`);
    const body = css.slice(start, css.indexOf("\n}", start));
    return body.match(new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, "i"))?.[1];
  };
  for (const [theme, selector] of [["light", ":root"], ["dark", ".dark"]] as const) {
    it(`${theme}: ground, card, track and boundary equal the token file`, () => {
      expect(THEME_SURFACES[theme]).toEqual({ ground: of(selector, "background"), card: of(selector, "card"), track: of(selector, "data-track"), boundary: of(selector, "input") });
    });
  }
});

describe("resolveDataFill: a tenant colour that colours data is adjusted for presentation only", () => {
  it("keeps a colour that already clears 3:1 on the track, the card and the ground exactly as stored", () => {
    expect(resolveDataFill("#C2410C", "light")).toBe("#C2410C"); // the fictional Harbor orange, light theme
    expect(resolveDataFill("#254B35", "light")).toBe("#254B35");
  });

  it("lightens a mid-tone colour in dark until every surface clears 3:1, keeping its hue", () => {
    const out = resolveDataFill("#C2410C", "dark");
    expect(out).not.toBe("#C2410C");
    for (const s of ALL_SURFACES("dark")) expect(contrastRatio(out, s)).toBeGreaterThanOrEqual(NON_TEXT_CONTRAST_RATIO);
    expect(luminanceOrder(out, "#C2410C")).toBeGreaterThan(0);
    expect(Math.abs(hue(out) - hue("#C2410C"))).toBeLessThan(4);
  });

  it("darkens a pale colour in light (Alliance's default gold is the real case), keeping its hue", () => {
    const out = resolveDataFill("#FACC15", "light");
    for (const s of ALL_SURFACES("light")) expect(contrastRatio(out, s)).toBeGreaterThanOrEqual(NON_TEXT_CONTRAST_RATIO);
    expect(luminanceOrder("#FACC15", out)).toBeGreaterThan(0);
    expect(Math.abs(hue(out) - hue("#FACC15"))).toBeLessThan(6);
  });

  it("terminates with a valid hex for extremes in both themes", () => {
    for (const c of ["#000000", "#ffffff", "#808080", "#FACC15", "#123B4A"]) {
      for (const t of ["light", "dark"] as const) {
        const out = resolveDataFill(c, t);
        expect(out).toMatch(/^#[0-9a-fA-F]{6}$/);
        for (const s of ALL_SURFACES(t)) expect(contrastRatio(out, s)).toBeGreaterThanOrEqual(NON_TEXT_CONTRAST_RATIO);
      }
    }
  });
});

describe("tenantNeedsActionEdge: the 1px boundary on a tenant's button", () => {
  it("is needed when the fill is under 3:1 against the card or the ground", () => {
    expect(tenantNeedsActionEdge("#C2410C", "dark")).toBe(true); // 2.80:1 on the dark card (approved case)
    expect(tenantNeedsActionEdge("#FACC15", "light")).toBe(true); // pale gold on ivory paper
  });

  it("is not needed when the fill separates on its own", () => {
    expect(tenantNeedsActionEdge("#254B35", "light")).toBe(false);
    expect(tenantNeedsActionEdge("#FACC15", "dark")).toBe(false);
    expect(tenantNeedsActionEdge("#C2410C", "light")).toBe(false);
  });
});

describe("resolveTenantPresentation", () => {
  it("returns per-theme presentation tokens and never a changed stored colour", () => {
    const p = resolveTenantPresentation("#C2410C");
    expect(p.light).toEqual({ actionEdge: "transparent", brandData: "#C2410C" });
    expect(p.dark.actionEdge).toBe("var(--input)");
    expect(p.dark.brandData).not.toBe("#C2410C");
  });
});
