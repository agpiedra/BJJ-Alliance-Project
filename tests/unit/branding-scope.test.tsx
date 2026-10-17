import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BrandingScope } from "@/components/branding/branding-scope";
import type { ResolvedBranding } from "@/lib/branding/get-branding";
import { resolvePrimaryTheme, resolveSidebarTheme } from "@/lib/theme";
import { MATROOM_DEFAULT_BRANDING } from "@/lib/branding/default-palette";
import { resolveDefaultBrandingVariant } from "@/lib/branding/resolve-default-variant";

function branding(primary: string, sidebarBackground: string, id = "org1"): ResolvedBranding {
  const p = resolvePrimaryTheme(primary);
  return {
    organizationId: id,
    displayName: "Test",
    initials: "T",
    logoUrl: null,
    isDefaultMode: false,
    primary: p,
    sidebar: resolveSidebarTheme({ background: sidebarBackground, activeBackgroundDefault: p.background }),
  };
}
const css = (b: ResolvedBranding) => /<style>([\s\S]*?)<\/style>/.exec(renderToStaticMarkup(<BrandingScope branding={b}>x</BrandingScope>))![1];

describe("BrandingScope", () => {
  it("still emits the stored primary and sidebar colours exactly, never a presentation-adjusted value", () => {
    const b = branding("#C2410C", "#123B4A");
    const out = css(b);
    expect(out).toContain("--brand-gold: #C2410C;");
    expect(out).toContain(`--brand-gold-foreground: ${b.primary.foreground};`);
    expect(out).toContain("--sidebar: #123B4A;");
    expect(out).toContain(`--sidebar-primary: ${b.sidebar.activeBackground};`);
  });

  it("adds a 1px edge only in the theme where the tenant's button would blend into the surface (dark orange)", () => {
    const out = css(branding("#C2410C", "#123B4A"));
    const [lightRule, darkRule] = out.split(".dark ");
    expect(lightRule).toContain("--action-edge: transparent;");
    expect(darkRule).toContain("--action-edge: var(--input);");
  });

  it("adds it in light for a pale tenant colour (Alliance's stored gold) and not in dark", () => {
    const out = css(branding("#FACC15", "#111827"));
    const [lightRule, darkRule] = out.split(".dark ");
    expect(lightRule).toContain("--action-edge: var(--input);");
    expect(darkRule).toContain("--action-edge: transparent;");
  });

  it("emits the data colour per theme, unchanged where it already clears 3:1 and adjusted where it does not", () => {
    const [lightRule, darkRule] = css(branding("#C2410C", "#123B4A")).split(".dark ");
    expect(lightRule).toContain("--brand-data: #C2410C;");
    expect(darkRule).toMatch(/--brand-data: #[0-9a-f]{6};/i);
    expect(darkRule).not.toContain("--brand-data: #C2410C;");
  });

  it("re-declares --sidebar-muted from the TENANT's sidebar colours (a var() resolves where it is declared)", () => {
    const b = branding("#C2410C", "#123B4A");
    expect(css(b)).toContain(`--sidebar-muted: color-mix(in srgb, ${b.sidebar.foreground} 74%, ${b.sidebar.background});`);
  });

  it("scopes every rule to this organization's wrapper", () => {
    const out = css(branding("#C2410C", "#123B4A", "abc"));
    expect(out).toContain('[data-branding="org-abc"] {');
    expect(out).toContain('.dark [data-branding="org-abc"] {');
  });
});

/**
 * The one deliberate exception to "gold does not invert between themes"
 * (see this component's own doc comment): a never-customized org renders
 * like the platform's own unbranded pages, which DO invert. Light-mode
 * values come from the normal rule block (unchanged); the SECOND,
 * dark-specific value set emitted under `.dark` only for `isDefaultMode`
 * orgs is what these tests cover.
 */
describe("BrandingScope — default-mode orgs (isDefaultMode: true)", () => {
  function defaultModeBranding(id = "org1"): ResolvedBranding {
    const p = resolvePrimaryTheme(MATROOM_DEFAULT_BRANDING.light.primaryColor);
    return {
      organizationId: id,
      displayName: "Test",
      initials: "T",
      logoUrl: null,
      isDefaultMode: true,
      primary: p,
      sidebar: resolveSidebarTheme({ background: MATROOM_DEFAULT_BRANDING.light.sidebarBackground, activeBackgroundDefault: p.background }),
      dark: resolveDefaultBrandingVariant(MATROOM_DEFAULT_BRANDING.dark),
    };
  }

  it("emits the exact dark-palette values under .dark, not the light-mode values repeated", () => {
    const out = css(defaultModeBranding());
    const [, darkRule] = out.split(".dark ");
    expect(darkRule).toContain(`--brand-gold: ${MATROOM_DEFAULT_BRANDING.dark.primaryColor};`);
    expect(darkRule).toContain(`--sidebar: ${MATROOM_DEFAULT_BRANDING.dark.sidebarBackground};`);
    expect(darkRule).toContain(`--sidebar-primary: ${MATROOM_DEFAULT_BRANDING.dark.sidebarActiveBackground};`);
    expect(darkRule).toContain(`--sidebar-border: ${MATROOM_DEFAULT_BRANDING.dark.sidebarBorder};`);
  });

  it("the light-mode rule still uses the resolved light primary/sidebar, same code path as a customized org", () => {
    const out = css(defaultModeBranding());
    const [lightRule] = out.split(".dark ");
    expect(lightRule).toContain(`--brand-gold: ${MATROOM_DEFAULT_BRANDING.light.primaryColor};`);
    expect(lightRule).toContain(`--sidebar: ${MATROOM_DEFAULT_BRANDING.light.sidebarBackground};`);
  });

  it("a customized org (isDefaultMode: false) never emits the second dark value set, even if branding.dark were somehow present", () => {
    const b = branding("#C2410C", "#123B4A");
    const out = css(b);
    const [, darkRule] = out.split(".dark ");
    // Customized orgs keep "gold does not invert" — the dark rule carries
    // only --action-edge/--brand-data, never a second --brand-gold/--sidebar set.
    expect(darkRule).not.toContain("--brand-gold:");
    expect(darkRule).not.toContain("--sidebar:");
  });
});
