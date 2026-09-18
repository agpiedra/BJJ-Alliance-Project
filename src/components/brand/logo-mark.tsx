import { cn } from "cn";
import { PLATFORM_NAME } from "@/lib/platform";

export interface LogoMarkProps {
  /** Width/height of the plaque in pixels. Defaults to a nav-bar-friendly size. */
  size?: number;
  className?: string;
  /**
   * MULTI_ACADEMY_AND_KIDS_BELTS.md Phase 4 — organization branding, all
   * optional. No props at all means there is no organization to show yet
   * (a genuinely pre-tenant page) — the platform's own wordmark, not any
   * organization's logo.
   */
  logoUrl?: string | null;
  /** Doc's "organization initials on the primary color" fallback — shown
   * when `logoUrl` is null/absent AND `initials` is provided (a branded
   * caller with no logo uploaded yet). Ignored if `logoUrl` is set. */
  initials?: string;
  initialsBackground?: string;
  initialsForeground?: string;
  /**
   * MULTI_ACADEMY_AND_KIDS_BELTS.md Item 2 — the organization's own
   * `displayName`, used as `alt` text on a real `logoUrl` image. Every
   * caller that passes `logoUrl` (staff sidebar, student portal, kiosk,
   * `/o/[orgSlug]/login`) already resolves this from the same branding read
   * that gave it `logoUrl` in the first place — threading it through here
   * is what stopped a real organization's own uploaded logo from being
   * announced to screen readers as "Alliance Jiu-Jitsu Costa Rica." Ignored
   * when `logoUrl` isn't set (the `initials` branch renders its own text
   * content, which is already announced correctly with no `alt` needed; the
   * zero-props fallback always names the platform, never an organization).
   */
  alt?: string;
}

/**
 * The organization's own logo (`logoUrl`), or its initials-on-primary-color
 * fallback (`initials`), or — for the genuinely pre-tenant, zero-props
 * case — a plain text wordmark naming the platform, never any
 * organization's logo asset.
 *
 * A real `logoUrl` uses a plain `<img>`, not `next/image`: Supabase Storage
 * URLs are external and not known at build time (no static `remotePatterns`
 * entry could cover every organization's project), so `next/image`'s
 * optimizer can't serve them — same reasoning `logo-uploader.tsx`'s own
 * upload preview already uses.
 */
export function LogoMark({ size = 40, className, logoUrl, initials, initialsBackground, initialsForeground, alt }: LogoMarkProps) {
  if (logoUrl) {
    return (
      <span
        className={cn("relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-xl p-1", className)}
        style={{ width: size, height: size, backgroundColor: initialsBackground ?? "#ffffff" }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element -- external Supabase URL, see this component's own doc comment */}
        <img src={logoUrl} alt={alt ?? PLATFORM_NAME} className="h-full w-full object-contain" />
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
      className={cn("inline-flex shrink-0 items-center whitespace-nowrap font-bold tracking-tight", className)}
      style={{ height: size, fontSize: size * 0.4 }}
    >
      {PLATFORM_NAME}
    </span>
  );
}
