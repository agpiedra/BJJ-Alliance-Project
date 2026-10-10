import type { ReactNode } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { LogoMark, type LogoMarkProps } from "@/components/brand/logo-mark";
import { cn } from "cn";

/**
 * MATROOM Phase 1 (auth & access-state) — the centered card shell demonstrated by
 * design/matroom/preview/auth-access-phase-prototype.html: the brand mark lives
 * INSIDE the card (not a separate top banner bar — the prototype's own closing
 * assessment calls the wordmark part of "the outer card shell"), a consistent
 * ~19-20px heading, and a widenable card for content that needs it (the
 * organization-selection list, per the prototype's own documented reasoning).
 *
 * `brand` is threaded straight through to `LogoMark` — same props, same real
 * tenant-branding resolution (logoUrl/initials/colors) the removed `BrandBanner`
 * usage carried; only WHERE it renders changed, not what it renders.
 */
export function AuthCard({
  title,
  footer,
  children,
  brand,
  widthClassName = "max-w-sm",
}: {
  title?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
  brand?: LogoMarkProps;
  widthClassName?: string;
}) {
  return (
    <main className="flex min-h-[calc(100vh-4rem)] flex-col items-center justify-center bg-background p-6">
      <Card className={cn("w-full [--card-spacing:--spacing(5)] sm:[--card-spacing:--spacing(8)]", widthClassName)}>
        <div className="px-(--card-spacing)">
          <LogoMark size={28} {...brand} />
        </div>
        {title ? (
          <CardHeader>
            {/* CardTitle renders a plain div (no implicit heading semantics) — every caller here uses it as the
                page's own h1, so it needs an explicit heading role or screen readers lose the page structure
                entirely (caught by accept-invitation-form.test.tsx, which asserted the pre-existing real <h1>). */}
            <CardTitle role="heading" aria-level={1} className="text-xl">
              {title}
            </CardTitle>
          </CardHeader>
        ) : null}
        <CardContent className="flex flex-col gap-4">{children}</CardContent>
      </Card>
      {footer}
    </main>
  );
}
