/**
 * MULTI_ACADEMY_AND_KIDS_BELTS.md Phase 4 — pure color derivation and WCAG
 * contrast math. No DB, no Node-only APIs: this must be importable from a
 * client component (the settings page's live preview) as well as server
 * code, and unit-tested directly.
 *
 * "Derive, don't store both": every foreground/hover/border value here is
 * computed from a single stored background at READ time, never persisted —
 * a future improvement to the derivation applies to every organization
 * automatically instead of needing a backfill (see OrganizationBranding's
 * own schema doc comment).
 */

/** WCAG 2.1's own AA threshold for normal-size text (large text is 3:1, not used here — every surface this app validates is normal-size nav/button/body text). */
export const AA_CONTRAST_RATIO = 4.5;

/**
 * The two foreground candidates a color is ever painted with — this app's
 * own existing "ink" pair (globals.css `:root --foreground` / `--primary-
 * foreground`), not generic pure black/white, so branded text stays visually
 * consistent with the rest of the app's typography color rather than
 * clashing with it.
 */
export const INK_DARK = "#28241c";
export const INK_LIGHT = "#fbfaf6";

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

export function isValidHexColor(value: string): boolean {
  return /^#[0-9a-fA-F]{6}$/.test(value.trim());
}

interface Rgb {
  r: number;
  g: number;
  b: number;
}

function hexToRgb(hex: string): Rgb {
  const normalized = hex.trim().replace(/^#/, "");
  return {
    r: parseInt(normalized.slice(0, 2), 16),
    g: parseInt(normalized.slice(2, 4), 16),
    b: parseInt(normalized.slice(4, 6), 16),
  };
}

function rgbToHex({ r, g, b }: Rgb): string {
  const toHex = (n: number) => Math.round(clamp01(n / 255) * 255).toString(16).padStart(2, "0");
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

/** WCAG 2.1 relative luminance (the exact formula the spec's contrast ratio is defined against — not an approximation). */
function relativeLuminance({ r, g, b }: Rgb): number {
  const channel = (c: number) => {
    const srgb = c / 255;
    return srgb <= 0.03928 ? srgb / 12.92 : Math.pow((srgb + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG 2.1 contrast ratio, symmetric — order of the two colors never matters. */
export function contrastRatio(hexA: string, hexB: string): number {
  const lumA = relativeLuminance(hexToRgb(hexA));
  const lumB = relativeLuminance(hexToRgb(hexB));
  const lighter = Math.max(lumA, lumB);
  const darker = Math.min(lumA, lumB);
  return (lighter + 0.05) / (darker + 0.05);
}

export function meetsAA(foregroundHex: string, backgroundHex: string): boolean {
  return contrastRatio(foregroundHex, backgroundHex) >= AA_CONTRAST_RATIO;
}

/**
 * Whichever of this app's two ink colors reads better against `backgroundHex`
 * — never a computed "invert the lightness" guess, an actual contrast-ratio
 * comparison between the two real candidates. For the vast majority of real
 * colors, the winner comfortably passes AA; a middling-lightness color (the
 * scenario `primaryColor`'s "warn, don't block" rule exists for) may still
 * fail with BOTH candidates — this always returns the better of the two
 * regardless, since the caller must render *something*.
 */
export function deriveForeground(backgroundHex: string): string {
  const withDark = contrastRatio(INK_DARK, backgroundHex);
  const withLight = contrastRatio(INK_LIGHT, backgroundHex);
  return withDark >= withLight ? INK_DARK : INK_LIGHT;
}

/**
 * A lightness nudge for a hover/derived-accent shade — not WCAG-validated
 * (there is no text-legibility requirement on a hover fill itself, only on
 * whatever foreground sits on top of it, which is re-derived separately).
 * Lightens a dark background, darkens a light one, so the hover state is
 * visually distinguishable from the resting background in either direction.
 */
export function deriveHoverBackground(backgroundHex: string): string {
  const { r, g, b } = hexToRgb(backgroundHex);
  const lum = relativeLuminance({ r, g, b });
  const isDark = lum < 0.5;
  const delta = isDark ? 0.12 : -0.08;
  const nudge = (c: number) => clamp01(c / 255 + delta) * 255;
  return rgbToHex({ r: nudge(r), g: nudge(g), b: nudge(b) });
}

/**
 * Doc: "light backgrounds get dark text and a visible border, dark
 * backgrounds get light text and no border." A literal zero-alpha border on
 * dark is indistinguishable from "the sidebar just ends" against most main
 * content areas, so this keeps a hairline in both directions (matching the
 * existing shipped default's own `oklch(1 0 0 / 10%)` on dark) — a light
 * sidebar gets a real, visible border; a dark one gets a barely-there edge
 * rather than a literal none, which is what "no border" reads as in practice
 * on the existing default.
 */
export function deriveBorder(backgroundHex: string): string {
  const lum = relativeLuminance(hexToRgb(backgroundHex));
  return lum < 0.5 ? "rgba(255, 255, 255, 0.1)" : "rgba(0, 0, 0, 0.12)";
}

export interface ResolvedPrimaryTheme {
  background: string;
  foreground: string;
  ratio: number;
  passesAA: boolean;
}

/**
 * `primaryColor` -> the app's ONE brand-color knob (`--brand-gold`/
 * `--brand-gold-foreground`, verified against the actual codebase — see
 * OrganizationBranding's schema doc comment for why `accentColor` doesn't
 * exist). Warn, never block: unlike the sidebar, there is no safe fallback
 * to refuse into — the director must be allowed to save even a middling
 * color the settings UI has already warned them about.
 */
export function resolvePrimaryTheme(primaryColorHex: string): ResolvedPrimaryTheme {
  const foreground = deriveForeground(primaryColorHex);
  const ratio = contrastRatio(foreground, primaryColorHex);
  return { background: primaryColorHex, foreground, ratio, passesAA: ratio >= AA_CONTRAST_RATIO };
}

export interface SidebarOverrides {
  background: string;
  foreground?: string | null;
  activeBackground?: string | null;
  activeForeground?: string | null;
  border?: string | null;
  /**
   * The active-item background to use when `activeBackground` is unset —
   * REQUIRED, never silently `background` itself. Verified directly against
   * the real sidebar component: the active nav item renders via
   * `--sidebar-primary` (branding-scope.tsx), which defaults to
   * `--brand-gold` in the shipped CSS — so an org that hasn't set an
   * explicit sidebar-active color keeps today's exact look (active = brand
   * color), while one that HAS set one gets true independence from
   * `primaryColor`, per the doc's own "chosen independently" requirement.
   * Callers pass the resolved `primaryColor` here.
   */
  activeBackgroundDefault: string;
}

export interface ResolvedSidebarTheme {
  background: string;
  foreground: string;
  activeBackground: string;
  activeForeground: string;
  hoverBackground: string;
  hoverForeground: string;
  border: string;
}

/**
 * Always produces a fully resolved 7-value theme — never partial. A `null`/
 * absent override derives from `background`; a provided override is used
 * as-is (its own legality is `validateSidebarOverrides`'s job, called
 * separately by the save action BEFORE this ever persists one).
 *
 * Hover (`--sidebar-accent`/`--sidebar-accent-foreground` in the real
 * component — verified directly in staff-sidebar.tsx/ui/sidebar.tsx, not
 * assumed) is not one of OrganizationBranding's five stored fields at all:
 * it is always derived from `background`, matching the doc's field list
 * exactly (five stored inputs, seven rendered outputs).
 */
export function resolveSidebarTheme(overrides: SidebarOverrides): ResolvedSidebarTheme {
  const background = overrides.background;
  const foreground = overrides.foreground ?? deriveForeground(background);
  const activeBackground = overrides.activeBackground ?? overrides.activeBackgroundDefault;
  const activeForeground = overrides.activeForeground ?? deriveForeground(activeBackground);
  const hoverBackground = deriveHoverBackground(background);
  const hoverForeground = deriveForeground(hoverBackground);
  const border = overrides.border ?? deriveBorder(background);

  return { background, foreground, activeBackground, activeForeground, hoverBackground, hoverForeground, border };
}

export interface SidebarValidationFailure {
  field: "foreground" | "activeForeground";
  ratio: number;
  suggestion: string;
}

/**
 * The sidebar's "block, don't warn" rule (doc: "enforced here, not merely
 * warned"). A DERIVED foreground can never fail this by construction
 * (`deriveForeground` always picks the better-contrast candidate) — the only
 * way to fail is an explicit override the director typed into the advanced
 * per-token picker, which is exactly the case this checks and the save
 * action must refuse.
 */
export function validateSidebarOverrides(overrides: SidebarOverrides):
  | { ok: true }
  | { ok: false; failures: SidebarValidationFailure[] } {
  const failures: SidebarValidationFailure[] = [];

  if (overrides.foreground) {
    const ratio = contrastRatio(overrides.foreground, overrides.background);
    if (ratio < AA_CONTRAST_RATIO) {
      failures.push({ field: "foreground", ratio, suggestion: deriveForeground(overrides.background) });
    }
  }

  if (overrides.activeForeground) {
    const activeBackground = overrides.activeBackground ?? overrides.activeBackgroundDefault;
    const ratio = contrastRatio(overrides.activeForeground, activeBackground);
    if (ratio < AA_CONTRAST_RATIO) {
      failures.push({ field: "activeForeground", ratio, suggestion: deriveForeground(activeBackground) });
    }
  }

  return failures.length > 0 ? { ok: false, failures } : { ok: true };
}

/** Doc's "organization initials on the primary color" logo fallback. First letter of up to the first two words, uppercase — "Alliance Jiu-Jitsu" -> "AJ", "Demo" -> "D". */
export function deriveInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean).slice(0, 2);
  return words.map((word) => word[0]!.toUpperCase()).join("");
}
