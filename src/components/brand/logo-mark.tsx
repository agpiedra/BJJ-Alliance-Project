import Image from "next/image";
import { useTranslations } from "next-intl";
import { cn } from "cn";

export interface LogoMarkProps {
  /** Width/height of the plaque in pixels. Defaults to a nav-bar-friendly size. */
  size?: number;
  className?: string;
  /**
   * MULTI_ACADEMY_AND_KIDS_BELTS.md Phase 4 — organization branding, all
   * optional. Every existing zero-props caller (login, signup, forgot/
   * reset-password, select-organization, the two org-unavailable pages, the
   * public home page — none of them in this phase's scope, see the doc's
   * own decision on why) is byte-for-byte unchanged: no props means the
   * original hardcoded Alliance lockup, exactly as before.
   */
  logoUrl?: string | null;
  /** Doc's "organization initials on the primary color" fallback — shown
   * when `logoUrl` is null/absent AND `initials` is provided (a branded
   * caller with no logo uploaded yet). Ignored if `logoUrl` is set. */
  initials?: string;
  initialsBackground?: string;
  initialsForeground?: string;
}

/**
 * The Alliance Jiu-Jitsu lockup (default), or — for a branded surface that
 * passed `logoUrl`/`initials` — the organization's own logo or its
 * initials-on-primary-color fallback, rendered inside the same light
 * plaque.
 *
 * A real `logoUrl` uses a plain `<img>`, not `next/image`: Supabase Storage
 * URLs are external and not known at build time (no static `remotePatterns`
 * entry could cover every organization's project), so `next/image`'s
 * optimizer can't serve them — same reasoning `logo-uploader.tsx`'s own
 * upload preview already uses.
 *
 * `public/branding/logo.png` has an opaque WHITE background (not
 * transparent — confirmed via sharp alpha-channel inspection: min/max alpha
 * both 255 across the whole image), so the DEFAULT case always wraps it in
 * an explicitly light (`bg-white`) backdrop rather than a theme token — the
 * plaque must stay light even if `.dark` is ever activated, since the
 * logo's own background can't be made to blend into a dark surface. A real
 * organization logo/initials render against `initialsBackground` instead
 * (typically the sidebar color it sits on) per the doc's own "preview
 * against the chosen sidebar color, not white" ruling.
 */
export function LogoMark({ size = 40, className, logoUrl, initials, initialsBackground, initialsForeground }: LogoMarkProps) {
  const t = useTranslations("app");

  if (logoUrl) {
    return (
      <span
        className={cn("relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-xl p-1", className)}
        style={{ width: size, height: size, backgroundColor: initialsBackground ?? "#ffffff" }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element -- external Supabase URL, see this component's own doc comment */}
        <img src={logoUrl} alt={t("title")} className="h-full w-full object-contain" />
      </span>
    );
  }

  if (initials) {
    return (
      <span
        className={cn("inline-flex shrink-0 items-center justify-center overflow-hidden rounded-xl font-bold", className)}
        style={{
          width: size,
          height: size,
          backgroundColor: initialsBackground ?? "#111827",
          color: initialsForeground ?? "#ffffff",
          fontSize: size * 0.4,
        }}
      >
        {initials}
      </span>
    );
  }

  return (
    <span
      className={cn(
        "relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-xl bg-white p-1 shadow-sm",
        className
      )}
      style={{ width: size, height: size }}
    >
      <span className="relative h-full w-full">
        <Image
          src="/branding/logo.png"
          alt={t("title")}
          fill
          sizes={`${size}px`}
          className="object-contain"
        />
      </span>
    </span>
  );
}
