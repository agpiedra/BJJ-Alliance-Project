"use client";

import { useActionState, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { deriveForeground, resolvePrimaryTheme, resolveSidebarTheme, validateSidebarOverrides } from "@/lib/theme";
import { MATROOM_DEFAULT_BRANDING } from "@/lib/branding/default-palette";
import type { ActionState } from "@/lib/action-state";

const INITIAL_STATE: ActionState = {};

export interface ThemePickerInitialValues {
  displayName: string;
  primaryColor: string;
  sidebarBackground: string;
  sidebarForeground: string | null;
  sidebarActiveBackground: string | null;
  sidebarActiveForeground: string | null;
  sidebarBorder: string | null;
  /** Whether this organization currently has `brandingIsDefault: true` (or no row at all) — used
   * ONLY to decide which constant the LIVE PREVIEW falls back to while the draft still matches the
   * default; never used to initialize "Customize sidebar" (that stays keyed off the four raw
   * override fields above, independent of this flag — enabling/disabling overrides is a separate
   * concern from overall default/stored mode). */
  isDefaultMode: boolean;
}

export interface ThemePickerProps {
  organizationId: string;
  initial: ThemePickerInitialValues;
  action: (organizationId: string, prevState: ActionState, formData: FormData) => Promise<ActionState>;
}

/**
 * MULTI_ACADEMY_AND_KIDS_BELTS.md Phase 4 item 4 — a director picking
 * colors sees the resulting sidebar (real nav items in default/hover/active
 * states, not a color swatch) and the WCAG verdict update live, using the
 * SAME `resolveSidebarTheme`/`validateSidebarOverrides`-shaped math the
 * server action re-validates with — so the sidebar's "block, don't warn"
 * rule is visible before save, never only as a rejection after.
 *
 * Standalone and reusable (doc: "Build the logo uploader and the theme
 * picker as standalone reusable components... Phase 5's onboarding wizard
 * renders the same two controls") — this component owns no data fetching
 * and takes its save action as a prop, so the wizard can hand it a
 * different action without duplicating the picker itself.
 */
export function ThemePicker({ organizationId, initial, action }: ThemePickerProps) {
  const t = useTranslations("branding.theme");
  const [state, formAction, isPending] = useActionState(action.bind(null, organizationId), INITIAL_STATE);

  const [primaryColor, setPrimaryColor] = useState(initial.primaryColor);
  const [sidebarBackground, setSidebarBackground] = useState(initial.sidebarBackground);
  const [customizeSidebar, setCustomizeSidebar] = useState(
    Boolean(initial.sidebarForeground || initial.sidebarActiveBackground || initial.sidebarActiveForeground || initial.sidebarBorder),
  );
  const [sidebarForeground, setSidebarForeground] = useState(initial.sidebarForeground ?? "");
  const [sidebarActiveBackground, setSidebarActiveBackground] = useState(initial.sidebarActiveBackground ?? "");
  const [sidebarActiveForeground, setSidebarActiveForeground] = useState(initial.sidebarActiveForeground ?? "");
  const [sidebarBorder, setSidebarBorder] = useState(initial.sidebarBorder ?? "");

  // Recomputed from the live draft on every keystroke, using the identical rule the server's save
  // guard applies — never a value frozen at mount. Editing primaryColor/sidebarBackground away from
  // the default, or checking "Customize sidebar" at all (even before touching a swatch — enabling
  // overrides is itself a meaningful action), immediately falls through to the normal derivation
  // below, so the preview never promises an appearance Save wouldn't actually produce.
  const draftMatchesDefault =
    primaryColor === MATROOM_DEFAULT_BRANDING.light.primaryColor &&
    sidebarBackground === MATROOM_DEFAULT_BRANDING.light.sidebarBackground &&
    !customizeSidebar;
  // `initial.isDefaultMode` gates the top level: a row that did NOT start in default mode never
  // previews as default-mode again merely because its draft happens to match the constant's values
  // (the save guard's `wasDefault` makes the same one-way distinction server-side).
  const previewIsDefaultMode = initial.isDefaultMode && draftMatchesDefault;

  const primary = useMemo(() => resolvePrimaryTheme(primaryColor), [primaryColor]);

  // Effective override values — computed ONCE and reused everywhere: the swatch's own rendered
  // `value=`, the FormData Save actually submits (the same controlled value), the live preview, and
  // sidebarCheck's client-side validation. Previously the swatch displayed one of these (the exact
  // MATROOM literal, or a generic "sidebar.X" derivation) while the preview/validation recomputed a
  // DIFFERENT value from the still-empty raw override state passed as `null` — an untouched swatch
  // could preview one color and submit another (confirmed: an untouched sidebarActiveBackground
  // submitted the approved #e6ebdd literal while the preview derived its active-item color from
  // primaryColor instead). A swatch still showing its fallback is untouched; that fallback is exactly
  // what gets submitted the moment customizeSidebar is checked at all (checking the box with nothing
  // picked is itself a meaningful edit — see saveBrandingTheme's own doc comment), so it must be the
  // single source every consumer below reads from.
  const sidebarForegroundFallback = initial.isDefaultMode
    ? MATROOM_DEFAULT_BRANDING.light.sidebarForeground
    : deriveForeground(sidebarBackground);
  const sidebarActiveBackgroundFallback = initial.isDefaultMode
    ? MATROOM_DEFAULT_BRANDING.light.sidebarActiveBackground
    : primary.background;
  const sidebarActiveBackgroundEffective = sidebarActiveBackground || sidebarActiveBackgroundFallback;
  // activeForeground's natural pairing is with activeBackground (resolveSidebarTheme derives it FROM
  // activeBackground, never independently) — its own fallback must chain off the EFFECTIVE
  // activeBackground, not a value frozen at mount. The approved MATROOM literal is only right while
  // activeBackground is ALSO still exactly the approved default; the moment activeBackground is
  // edited, the approved literal no longer pairs with it and the same contrast-safe derivation
  // resolveSidebarTheme itself would use is correct instead.
  const sidebarActiveForegroundFallback =
    initial.isDefaultMode && sidebarActiveBackgroundEffective === MATROOM_DEFAULT_BRANDING.light.sidebarActiveBackground
      ? MATROOM_DEFAULT_BRANDING.light.sidebarActiveForeground
      : deriveForeground(sidebarActiveBackgroundEffective);
  // deriveBorder() returns an rgba() string, which a native <input type="color"> can neither render
  // nor submit — "#000000" is the existing stored-mode placeholder, unchanged; only default mode has
  // a real hex literal to fall back to.
  const sidebarBorderFallback = initial.isDefaultMode ? MATROOM_DEFAULT_BRANDING.light.sidebarBorder : "#000000";

  const sidebarForegroundEffective = sidebarForeground || sidebarForegroundFallback;
  const sidebarActiveForegroundEffective = sidebarActiveForeground || sidebarActiveForegroundFallback;
  const sidebarBorderEffective = sidebarBorder || sidebarBorderFallback;

  const sidebarInput = useMemo(
    () => ({
      background: sidebarBackground,
      foreground: customizeSidebar ? sidebarForegroundEffective : null,
      activeBackground: customizeSidebar ? sidebarActiveBackgroundEffective : null,
      activeForeground: customizeSidebar ? sidebarActiveForegroundEffective : null,
      activeBackgroundDefault: primary.background,
      border: customizeSidebar ? sidebarBorderEffective : null,
    }),
    [
      sidebarBackground,
      customizeSidebar,
      sidebarForegroundEffective,
      sidebarActiveBackgroundEffective,
      sidebarActiveForegroundEffective,
      sidebarBorderEffective,
      primary.background,
    ],
  );
  const sidebar = useMemo(() => resolveSidebarTheme(sidebarInput), [sidebarInput]);

  // While the draft still matches the default exactly, the preview box below renders via the SAME
  // CSS custom properties the real app renders (`var(--sidebar)` etc.) instead of a hardcoded hex
  // string — those variables already flip between the approved light and dark MATROOM values
  // purely through the CSS cascade (globals.css's plain :root/.dark, or this org's own BrandingScope
  // override, which resolves to the identical values since this org IS in default mode server-side),
  // so the preview follows a live theme toggle with no JS reactivity of its own to maintain. The
  // moment the draft is a genuine edit, this falls back to the flat, theme-invariant hex values
  // `resolvePrimaryTheme`/`resolveSidebarTheme` compute above — correct for stored-mode, which never
  // inverts between themes (see BrandingScope's own doc comment).
  const previewPrimaryBg = previewIsDefaultMode ? "var(--brand-gold)" : primary.background;
  const previewPrimaryFg = previewIsDefaultMode ? "var(--brand-gold-foreground)" : primary.foreground;
  const previewSidebarBg = previewIsDefaultMode ? "var(--sidebar)" : sidebar.background;
  const previewSidebarFg = previewIsDefaultMode ? "var(--sidebar-foreground)" : sidebar.foreground;
  const previewSidebarActiveBg = previewIsDefaultMode ? "var(--sidebar-primary)" : sidebar.activeBackground;
  const previewSidebarActiveFg = previewIsDefaultMode ? "var(--sidebar-primary-foreground)" : sidebar.activeForeground;
  const previewSidebarHoverBg = previewIsDefaultMode ? "var(--sidebar-accent)" : sidebar.hoverBackground;
  const previewSidebarHoverFg = previewIsDefaultMode ? "var(--sidebar-accent-foreground)" : sidebar.hoverForeground;
  const previewSidebarBorder = previewIsDefaultMode ? "var(--sidebar-border)" : sidebar.border;

  // The SAME validation the server action re-runs — never a client-only
  // guess, so the live verdict and the server's eventual block always
  // agree. `resolveSidebarTheme` itself never rejects a bad explicit
  // override (it renders whatever it's given); this is what actually
  // detects a failure.
  const sidebarCheck = useMemo(() => validateSidebarOverrides(sidebarInput), [sidebarInput]);
  const overrideForegroundOk = sidebarCheck.ok || !sidebarCheck.failures.some((f) => f.field === "foreground");

  return (
    <form action={formAction} className="flex flex-col gap-6 lg:flex-row">
      <div className="flex w-full max-w-sm flex-col gap-4">
        <label className="flex flex-col gap-1">
          <span>{t("displayName")}</span>
          <input
            type="text"
            name="displayName"
            defaultValue={initial.displayName}
            className="rounded border px-3 py-2"
          />
        </label>

        <label className="flex flex-col gap-1">
          <span>{t("primaryColor")}</span>
          <div className="flex items-center gap-2">
            <input
              type="color"
              name="primaryColor"
              value={primaryColor}
              onChange={(e) => setPrimaryColor(e.target.value)}
              className="h-10 w-14 rounded border"
            />
            <span className="font-mono text-sm">{primaryColor}</span>
          </div>
          <p className={`text-sm ${primary.passesAA ? "text-ok" : "text-warn"}`}>
            {primary.passesAA
              ? t("contrastPass", { ratio: primary.ratio.toFixed(2) })
              : t("contrastWarn", { ratio: primary.ratio.toFixed(2) })}
          </p>
        </label>

        <label className="flex flex-col gap-1">
          <span>{t("sidebarBackground")}</span>
          <div className="flex items-center gap-2">
            <input
              type="color"
              name="sidebarBackground"
              value={sidebarBackground}
              onChange={(e) => setSidebarBackground(e.target.value)}
              className="h-10 w-14 rounded border"
            />
            <span className="font-mono text-sm">{sidebarBackground}</span>
          </div>
        </label>

        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={customizeSidebar}
            onChange={(e) => setCustomizeSidebar(e.target.checked)}
          />
          {t("customizeSidebarToggle")}
        </label>

        {customizeSidebar && (
          <div className="flex flex-col gap-3 rounded border p-3">
            <label className="flex flex-col gap-1 text-sm">
              {t("sidebarForeground")}
              <input
                type="color"
                name="sidebarForeground"
                value={sidebarForegroundEffective}
                onChange={(e) => setSidebarForeground(e.target.value)}
                className="h-9 w-14 rounded border"
              />
              {!overrideForegroundOk && (
                <span className="text-sm text-bad">{t("sidebarContrastBlocked")}</span>
              )}
            </label>
            <label className="flex flex-col gap-1 text-sm">
              {t("sidebarActiveBackground")}
              <input
                type="color"
                name="sidebarActiveBackground"
                value={sidebarActiveBackgroundEffective}
                onChange={(e) => setSidebarActiveBackground(e.target.value)}
                className="h-9 w-14 rounded border"
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              {t("sidebarActiveForeground")}
              <input
                type="color"
                name="sidebarActiveForeground"
                value={sidebarActiveForegroundEffective}
                onChange={(e) => setSidebarActiveForeground(e.target.value)}
                className="h-9 w-14 rounded border"
              />
              {!sidebarCheck.ok && sidebarCheck.failures.some((f) => f.field === "activeForeground") && (
                <span className="text-sm text-bad">{t("sidebarContrastBlocked")}</span>
              )}
            </label>
            <label className="flex flex-col gap-1 text-sm">
              {t("sidebarBorder")}
              <input
                type="color"
                name="sidebarBorder"
                value={sidebarBorderEffective}
                onChange={(e) => setSidebarBorder(e.target.value)}
                className="h-9 w-14 rounded border"
              />
            </label>
          </div>
        )}

        {state.error === "sidebarContrast" && (
          <p className="text-sm text-bad">{t("sidebarContrastBlocked")}</p>
        )}
        {state.error && state.error !== "sidebarContrast" && (
          <p className="text-sm text-bad">{t.has(`error.${state.error}`) ? t(`error.${state.error}` as never) : t("error.generic")}</p>
        )}
        {state.ok && <p className="text-sm text-ok">{t("saved")}</p>}

        <Button type="submit" disabled={isPending || !sidebarCheck.ok}>
          {t("save")}
        </Button>
      </div>

      {/* Live sidebar preview — real nav items in default/hover/active
          states, per doc, not a bare color swatch. While the draft still
          matches the default (previewIsDefaultMode), this renders via
          var(--sidebar)/var(--brand-gold) etc. — the SAME tokens the real
          app renders, which already flip with the page's actual light/dark
          theme through the CSS cascade alone, so this preview follows a
          live theme toggle with no extra reactivity of its own. */}
      <div
        className="flex w-64 shrink-0 flex-col gap-1 rounded-lg p-3"
        style={{ backgroundColor: previewSidebarBg, color: previewSidebarFg, border: `1px solid ${previewSidebarBorder}` }}
      >
        <p className="px-2 py-1 text-xs font-semibold tracking-wide uppercase opacity-70">{t("previewLabel")}</p>
        <div className="rounded px-3 py-2 text-sm" style={{ backgroundColor: previewSidebarActiveBg, color: previewSidebarActiveFg }}>
          {t("previewNavActive")}
        </div>
        <div className="rounded px-3 py-2 text-sm" style={{ backgroundColor: previewSidebarHoverBg, color: previewSidebarHoverFg }}>
          {t("previewNavHover")}
        </div>
        <div className="rounded px-3 py-2 text-sm">{t("previewNavDefault")}</div>
        <div className="mt-3 rounded px-3 py-2 text-center text-sm font-medium" style={{ backgroundColor: previewPrimaryBg, color: previewPrimaryFg }}>
          {t("previewButton")}
        </div>
      </div>
    </form>
  );
}
