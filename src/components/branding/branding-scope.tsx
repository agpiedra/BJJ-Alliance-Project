"use client";

import { useRef, type ReactNode } from "react";
import type { ResolvedBranding } from "@/lib/branding/get-branding";
import { resolveTenantPresentation } from "@/lib/theme";
import { BrandingPortalContext } from "@/components/branding/branding-portal-context";

/**
 * MULTI_ACADEMY_AND_KIDS_BELTS.md Phase 4 — the one place a resolved
 * organization theme becomes real CSS. Overrides exactly two token
 * families, verified directly against this codebase's actual usage (not
 * the original Phase 4 draft's `--primary`/`--accent` list, which globals.css
 * has its own explicit "never themed" ruling for):
 *
 * - `--brand-gold`/`--brand-gold-foreground` — the app's one real brand-
 *   color knob (buttons, banners, stat tiles; NOT the sidebar's active nav
 *   item since staff-sidebar.tsx's own fix this same phase — see below).
 * - `--sidebar`/`--sidebar-foreground`/`--sidebar-primary`/
 *   `--sidebar-primary-foreground`/`--sidebar-accent`/
 *   `--sidebar-accent-foreground`/`--sidebar-border` — the sidebar's own
 *   rendered tokens. `--sidebar-primary` is the ACTIVE nav item (verified
 *   directly in staff-sidebar.tsx, which this phase rewired from a
 *   hardcoded `bg-brand-gold` to this token specifically so the sidebar's
 *   active color can differ from `primaryColor`); `--sidebar-accent` is
 *   HOVER (`ui/sidebar.tsx`'s own class, untouched) — the resolved theme's
 *   derived `hoverBackground`/`hoverForeground` land there, never on
 *   `activeBackground`/`activeForeground`, which land on `--sidebar-primary`
 *   instead. Getting this pairing backwards would make a director's chosen
 *   "active" color only ever show up on hover.
 *
 * `--brand-gold`/`--sidebar-*` are deliberately identical in both `:root`
 * and `.dark` scopes for a CUSTOMIZED organization (`branding.isDefaultMode
 * === false`), continuing this codebase's own existing rule for that token
 * ("Gold does not invert between themes" — globals.css) — a director's own
 * chosen color gets the same treatment the shipped default already got, not
 * a new light/dark-aware behavior invented for this feature.
 *
 * An organization that has never explicitly saved branding
 * (`branding.isDefaultMode === true`) is the one deliberate exception: it is
 * meant to look exactly like the platform's own unbranded pages, which DO
 * invert between themes (design/matroom/tokens.css's `:root`/`.dark`
 * blocks) — so this is the one case where a SECOND, dark-specific value set
 * is additionally emitted under `.dark`, using `branding.dark` (only present
 * when `isDefaultMode`, see ResolvedBranding's own doc comment).
 *
 * Scoped to a `data-branding` wrapper (not a raw `:root`/`.dark` override)
 * so this never leaks into unauthenticated/unbranded pages rendered
 * outside this wrapper in the same browser tab (there are none today, but
 * nothing here should rely on being the only such wrapper ever mounted).
 */
export function BrandingScope({ branding, children }: { branding: ResolvedBranding; children: ReactNode }) {
  const scopeAttr = `org-${branding.organizationId}`;
  // DESIGN.md §7.10 — a ref to this wrapper so `Sheet` (src/components/ui/sheet.tsx)
  // can portal into it instead of `document.body`, keeping a portaled popup (e.g. the
  // mobile sidebar sheet) a real DOM descendant of the branded `[data-branding]`
  // selector below.
  const containerRef = useRef<HTMLDivElement>(null);
  // MATROOM Phase 1 (design/matroom/DESIGN.md "Tenant branding"): three PRESENTATION tokens on top of the stored colours,
  // derived here at render time and never persisted. The stored colours below are emitted exactly as stored.
  //  - --action-edge: a 1px boundary on the tenant's buttons in the theme where their fill is under 3:1 against the surface.
  //  - --brand-data: the tenant colour where it colours data (progress near completion), lightness-adjusted to 3:1 per theme.
  //  - --sidebar-muted: re-declared here because a custom property using var() resolves where it is DECLARED; the shared
  //    definition would otherwise keep mixing the default sidebar's colours instead of this tenant's.
  const presentation = resolveTenantPresentation(branding.primary.background);
  return (
    <div data-branding={scopeAttr} className="contents" ref={containerRef}>
      <style>{`
        [data-branding="${scopeAttr}"] {
          --brand-gold: ${branding.primary.background};
          --brand-gold-foreground: ${branding.primary.foreground};
          --sidebar: ${branding.sidebar.background};
          --sidebar-foreground: ${branding.sidebar.foreground};
          --sidebar-primary: ${branding.sidebar.activeBackground};
          --sidebar-primary-foreground: ${branding.sidebar.activeForeground};
          --sidebar-accent: ${branding.sidebar.hoverBackground};
          --sidebar-accent-foreground: ${branding.sidebar.hoverForeground};
          --sidebar-border: ${branding.sidebar.border};
          --sidebar-muted: color-mix(in srgb, ${branding.sidebar.foreground} 74%, ${branding.sidebar.background});
          --action-edge: ${presentation.light.actionEdge};
          --brand-data: ${presentation.light.brandData};
        }
        .dark [data-branding="${scopeAttr}"] {
          --action-edge: ${presentation.dark.actionEdge};
          --brand-data: ${presentation.dark.brandData};
          ${
            branding.isDefaultMode && branding.dark
              ? `--brand-gold: ${branding.dark.primary.background};
          --brand-gold-foreground: ${branding.dark.primary.foreground};
          --sidebar: ${branding.dark.sidebar.background};
          --sidebar-foreground: ${branding.dark.sidebar.foreground};
          --sidebar-primary: ${branding.dark.sidebar.activeBackground};
          --sidebar-primary-foreground: ${branding.dark.sidebar.activeForeground};
          --sidebar-accent: ${branding.dark.sidebar.hoverBackground};
          --sidebar-accent-foreground: ${branding.dark.sidebar.hoverForeground};
          --sidebar-border: ${branding.dark.sidebar.border};
          --sidebar-muted: color-mix(in srgb, ${branding.dark.sidebar.foreground} 74%, ${branding.dark.sidebar.background});`
              : ""
          }
        }
      `}</style>
      <BrandingPortalContext.Provider value={containerRef}>{children}</BrandingPortalContext.Provider>
    </div>
  );
}
