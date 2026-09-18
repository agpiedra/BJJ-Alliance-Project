import type { ReactNode } from "react";
import type { ResolvedBranding } from "@/lib/branding/get-branding";

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
 * `--brand-gold` is deliberately identical in both `:root` and `.dark`
 * scopes here, continuing this codebase's OWN existing rule for that token
 * ("Gold does not invert between themes" — globals.css) — a director's
 * color gets the same treatment the shipped default already gets, not a
 * new light/dark-aware behavior invented for this feature. `--sidebar-*`
 * is likewise already theme-invariant in the shipped defaults (identical
 * values in `:root` and `.dark` today), so this continues that too: one
 * set of sidebar values, injected once, regardless of theme.
 *
 * Scoped to a `data-branding` wrapper (not a raw `:root`/`.dark` override)
 * so this never leaks into unauthenticated/unbranded pages rendered
 * outside this wrapper in the same browser tab (there are none today, but
 * nothing here should rely on being the only such wrapper ever mounted).
 */
export function BrandingScope({ branding, children }: { branding: ResolvedBranding; children: ReactNode }) {
  const scopeAttr = `org-${branding.organizationId}`;
  return (
    <div data-branding={scopeAttr} className="contents">
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
        }
      `}</style>
      {children}
    </div>
  );
}
