import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MATROOM_DEFAULT_BRANDING } from "@/lib/branding/default-palette";
import { contrastRatio, AA_CONTRAST_RATIO } from "@/lib/theme";

/**
 * MATROOM_DEFAULT_BRANDING must equal design/matroom/tokens.css's own `:root`/`.dark` blocks
 * exactly — the approved palette, not a reimplementation of it. Same cross-check convention as
 * tests/unit/tenant-presentation.test.ts's THEME_SURFACES check: read the real token file, fail if
 * this constant ever drifts from it.
 */
describe("MATROOM_DEFAULT_BRANDING mirrors design/matroom/tokens.css (the authority)", () => {
  const css = readFileSync(join(__dirname, "..", "..", "design", "matroom", "tokens.css"), "utf8");
  const of = (selector: string, name: string) => {
    const start = css.indexOf(`\n${selector} {`);
    const body = css.slice(start, css.indexOf("\n}", start));
    return body.match(new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, "i"))?.[1];
  };

  for (const [theme, selector] of [["light", ":root"], ["dark", ".dark"]] as const) {
    it(`${theme}: primary, sidebar and hover tokens equal the token file`, () => {
      const palette = MATROOM_DEFAULT_BRANDING[theme];
      expect(palette.primaryColor).toBe(of(selector, "primary"));
      expect(palette.primaryForeground).toBe(of(selector, "primary-foreground"));
      expect(palette.sidebarBackground).toBe(of(selector, "sidebar"));
      expect(palette.sidebarForeground).toBe(of(selector, "sidebar-foreground"));
      expect(palette.sidebarActiveBackground).toBe(of(selector, "sidebar-primary"));
      expect(palette.sidebarActiveForeground).toBe(of(selector, "sidebar-primary-foreground"));
      expect(palette.sidebarHoverBackground).toBe(of(selector, "sidebar-accent"));
      expect(palette.sidebarHoverForeground).toBe(of(selector, "sidebar-accent-foreground"));
      expect(palette.sidebarBorder).toBe(of(selector, "sidebar-border"));
    });
  }

  for (const theme of ["light", "dark"] as const) {
    it(`${theme}: primary and sidebar foreground pairs pass WCAG AA (4.5:1)`, () => {
      const palette = MATROOM_DEFAULT_BRANDING[theme];
      expect(contrastRatio(palette.primaryForeground, palette.primaryColor)).toBeGreaterThanOrEqual(AA_CONTRAST_RATIO);
      expect(contrastRatio(palette.sidebarForeground, palette.sidebarBackground)).toBeGreaterThanOrEqual(AA_CONTRAST_RATIO);
      expect(contrastRatio(palette.sidebarActiveForeground, palette.sidebarActiveBackground)).toBeGreaterThanOrEqual(AA_CONTRAST_RATIO);
      expect(contrastRatio(palette.sidebarHoverForeground, palette.sidebarHoverBackground)).toBeGreaterThanOrEqual(AA_CONTRAST_RATIO);
    });
  }
});
