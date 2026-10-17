/**
 * The approved MATROOM cream/green appearance for an organization that has never explicitly saved
 * branding (`OrganizationBranding.brandingIsDefault === true`) or has no branding row at all. Values
 * copied verbatim from design/matroom/tokens.css's `:root`/`.dark` blocks (`--primary`/`--brand-gold`,
 * `--sidebar*`) — the single source of truth for the approved palette; `tests/unit/default-palette.test.ts`
 * reads that file directly and fails if this drifts.
 *
 * Two variants, not one: unlike a tenant's own stored colors (deliberately theme-invariant — see
 * BrandingScope's own doc comment, "gold does not invert between themes"), an org that has never
 * customized anything is meant to look exactly like the platform's own unbranded pages, which DO
 * invert between themes. This is the one place that distinction is represented as data.
 */
export interface DefaultBrandingPalette {
  primaryColor: string;
  primaryForeground: string;
  sidebarBackground: string;
  sidebarForeground: string;
  sidebarActiveBackground: string;
  sidebarActiveForeground: string;
  sidebarHoverBackground: string;
  sidebarHoverForeground: string;
  sidebarBorder: string;
}

export const MATROOM_DEFAULT_BRANDING: { light: DefaultBrandingPalette; dark: DefaultBrandingPalette } = {
  light: {
    primaryColor: "#254b35",
    primaryForeground: "#fffefa",
    sidebarBackground: "#fffefa",
    sidebarForeground: "#1d392b",
    sidebarActiveBackground: "#e6ebdd",
    sidebarActiveForeground: "#1d392b",
    sidebarHoverBackground: "#ecede7",
    sidebarHoverForeground: "#1d392b",
    sidebarBorder: "#d8ded3",
  },
  dark: {
    primaryColor: "#c9dfb4",
    primaryForeground: "#182a1e",
    sidebarBackground: "#202c25",
    sidebarForeground: "#eff1e9",
    sidebarActiveBackground: "#2b3e30",
    sidebarActiveForeground: "#eff1e9",
    sidebarHoverBackground: "#333e37",
    sidebarHoverForeground: "#eff1e9",
    sidebarBorder: "#3c4e40",
  },
};
