import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BrandingScope } from "@/components/branding/branding-scope";
import type { ResolvedBranding } from "@/lib/branding/get-branding";
import { resolvePrimaryTheme, resolveSidebarTheme } from "@/lib/theme";

function branding(primary: string, sidebarBackground: string, id = "org1"): ResolvedBranding {
  const p = resolvePrimaryTheme(primary);
  return {
    organizationId: id,
    displayName: "Test",
    initials: "T",
    logoUrl: null,
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
