import { contrastRatio, AA_CONTRAST_RATIO, type ResolvedPrimaryTheme, type ResolvedSidebarTheme } from "@/lib/theme";
import type { DefaultBrandingPalette } from "@/lib/branding/default-palette";

/**
 * Builds a fully-resolved theme directly from the approved exact MATROOM tokens — never through
 * `resolvePrimaryTheme`/`resolveSidebarTheme`'s generic derivation, which exists for an ARBITRARY
 * tenant-chosen color and would only get close (picks from a fixed two-color ink pair), not the
 * exact approved hex `MATROOM_DEFAULT_BRANDING` already specifies. Shared by `get-branding.ts` and
 * `platform-lookups.ts` so the two branding read paths can never compute this differently.
 */
export function resolveDefaultBrandingVariant(palette: DefaultBrandingPalette): { primary: ResolvedPrimaryTheme; sidebar: ResolvedSidebarTheme } {
  const primaryRatio = contrastRatio(palette.primaryForeground, palette.primaryColor);
  return {
    primary: { background: palette.primaryColor, foreground: palette.primaryForeground, ratio: primaryRatio, passesAA: primaryRatio >= AA_CONTRAST_RATIO },
    sidebar: {
      background: palette.sidebarBackground,
      foreground: palette.sidebarForeground,
      activeBackground: palette.sidebarActiveBackground,
      activeForeground: palette.sidebarActiveForeground,
      hoverBackground: palette.sidebarHoverBackground,
      hoverForeground: palette.sidebarHoverForeground,
      border: palette.sidebarBorder,
    },
  };
}
