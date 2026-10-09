import type { ReactNode } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * MATROOM Phase 1 (auth & access-state) — the centered card shell already
 * used, identically, by no-access/no-organization-access/
 * organization-unavailable/select-organization/login-form before this
 * extraction. `footer` renders as a sibling of the card inside the same
 * centered `<main>` (login-form's "register academy" link needs this).
 */
export function AuthCard({ title, footer, children }: { title?: ReactNode; footer?: ReactNode; children: ReactNode }) {
  return (
    <main className="flex min-h-[calc(100vh-4rem)] flex-col items-center justify-center bg-background p-6">
      <Card className="w-full max-w-sm">
        {title ? (
          <CardHeader>
            {/* CardTitle renders a plain div (no implicit heading semantics) — every caller here uses it as the
                page's own h1, so it needs an explicit heading role or screen readers lose the page structure
                entirely (caught by accept-invitation-form.test.tsx, which asserted the pre-existing real <h1>). */}
            <CardTitle role="heading" aria-level={1} className="text-2xl">
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
