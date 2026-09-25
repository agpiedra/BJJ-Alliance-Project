import type { ReactNode } from "react";
import { cn } from "cn";
import { LogoMark } from "./logo-mark";

export interface BrandBannerProps {
  /** Page-specific slot content: a title, a locale switcher, a nav trigger, etc. */
  children?: ReactNode;
  /** Single-line kiosk-appropriate variant — visibly shorter than the default bar. */
  compact?: boolean;
  /** MULTI_ACADEMY_AND_KIDS_BELTS.md Phase 4 — passed straight through to
   * LogoMark; see that component's own doc comment. All optional, every
   * existing zero-props caller unchanged. */
  logoUrl?: string | null;
  initials?: string;
  initialsBackground?: string;
  initialsForeground?: string;
  /** MULTI_ACADEMY_AND_KIDS_BELTS.md Item 2 — passed straight through to
   * LogoMark's own `alt`; see that component's own doc comment. */
  alt?: string;
}

/**
 * Horizontal near-black banner bar used at the top of the app shell (Task 2)
 * and on kiosk pages. Reuses `bg-sidebar`/`text-sidebar-foreground` rather
 * than a dedicated banner token, since it is visually and semantically the
 * same near-black brand surface as the sidebar shell — not a separate
 * design language.
 *
 * `border-b-2 border-brand-gold` is one of this redesign's three sanctioned
 * gold accents (plan §Global Constraints) — a hairline edge, not a fill, so
 * it reads as a brand accent without the contrast/legibility risk of gold
 * covering a large surface.
 */
export function BrandBanner({ children, compact = false, logoUrl, initials, initialsBackground, initialsForeground, alt }: BrandBannerProps) {
  return (
    <div
      // Marks the banner as a sidebar-coloured surface so the global focus ring takes the sidebar's own foreground here
      // (globals.css `[data-sidebar] :focus-visible`), not the theme ring, which a tenant's banner colour could hide.
      data-sidebar="banner"
      className={cn(
        "flex items-center gap-3 border-b-2 border-brand-gold bg-sidebar px-4 text-sidebar-foreground",
        compact ? "h-12" : "h-16"
      )}
    >
      <LogoMark
        size={compact ? 32 : 44}
        logoUrl={logoUrl}
        initials={initials}
        initialsBackground={initialsBackground}
        initialsForeground={initialsForeground}
        alt={alt}
      />
      {children ? (
        <div className="flex min-w-0 flex-1 items-center gap-3">{children}</div>
      ) : null}
    </div>
  );
}
