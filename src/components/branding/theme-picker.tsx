"use client";

import { useActionState, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { resolvePrimaryTheme, resolveSidebarTheme, validateSidebarOverrides } from "@/lib/theme";
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

  const primary = useMemo(() => resolvePrimaryTheme(primaryColor), [primaryColor]);
  const sidebarInput = useMemo(
    () => ({
      background: sidebarBackground,
      foreground: customizeSidebar && sidebarForeground ? sidebarForeground : null,
      activeBackground: customizeSidebar && sidebarActiveBackground ? sidebarActiveBackground : null,
      activeForeground: customizeSidebar && sidebarActiveForeground ? sidebarActiveForeground : null,
      activeBackgroundDefault: primary.background,
      border: customizeSidebar && sidebarBorder ? sidebarBorder : null,
    }),
    [sidebarBackground, customizeSidebar, sidebarForeground, sidebarActiveBackground, sidebarActiveForeground, sidebarBorder, primary.background],
  );
  const sidebar = useMemo(() => resolveSidebarTheme(sidebarInput), [sidebarInput]);

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
                value={sidebarForeground || sidebar.foreground}
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
                value={sidebarActiveBackground || sidebar.activeBackground}
                onChange={(e) => setSidebarActiveBackground(e.target.value)}
                className="h-9 w-14 rounded border"
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              {t("sidebarActiveForeground")}
              <input
                type="color"
                name="sidebarActiveForeground"
                value={sidebarActiveForeground || sidebar.activeForeground}
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
                value={sidebarBorder || "#000000"}
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
          states, per doc, not a bare color swatch. */}
      <div
        className="flex w-64 shrink-0 flex-col gap-1 rounded-lg p-3"
        style={{ backgroundColor: sidebar.background, color: sidebar.foreground, border: `1px solid ${sidebar.border}` }}
      >
        <p className="px-2 py-1 text-xs font-semibold tracking-wide uppercase opacity-70">{t("previewLabel")}</p>
        <div className="rounded px-3 py-2 text-sm" style={{ backgroundColor: sidebar.activeBackground, color: sidebar.activeForeground }}>
          {t("previewNavActive")}
        </div>
        <div className="rounded px-3 py-2 text-sm" style={{ backgroundColor: sidebar.hoverBackground, color: sidebar.hoverForeground }}>
          {t("previewNavHover")}
        </div>
        <div className="rounded px-3 py-2 text-sm">{t("previewNavDefault")}</div>
        <div className="mt-3 rounded px-3 py-2 text-center text-sm font-medium" style={{ backgroundColor: primary.background, color: primary.foreground }}>
          {t("previewButton")}
        </div>
      </div>
    </form>
  );
}
