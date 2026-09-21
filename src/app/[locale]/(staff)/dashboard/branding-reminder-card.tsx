"use client";

import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { Card, CardContent } from "@/components/ui/card";
import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "cn";
import { dismissBrandingReminder } from "./branding-reminder-actions";

/**
 * MULTI_ACADEMY_AND_KIDS_BELTS.md Item 2 — the wizard's own acceptance
 * criteria named this card as NOT YET BUILT ("Skipping/finishing the wizard
 * works correctly, but no card was built to remind a director who skipped
 * branding that it's still available"). Shown to ADMIN/DIRECTOR only (see
 * dashboard/page.tsx's own gate) whenever `dashboard/page.tsx` determines
 * the organization has no logo yet and hasn't dismissed this before.
 *
 * Hides itself immediately on dismiss (local state) rather than waiting on
 * the server round-trip — the write is fire-and-forget from the UI's own
 * perspective; `branding-reminder-actions.ts`'s own revalidatePath call is
 * what keeps a later real page load from showing it again, not this
 * component re-rendering.
 */
export function BrandingReminderCard({ locale, organizationId }: { locale: string; organizationId: string }) {
  const t = useTranslations("dashboard.brandingReminder");
  const [dismissed, setDismissed] = useState(false);
  const [isPending, startTransition] = useTransition();

  if (dismissed) return null;

  function handleDismiss() {
    setDismissed(true);
    startTransition(async () => {
      await dismissBrandingReminder(organizationId);
    });
  }

  return (
    <Card>
      <CardContent className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col gap-1">
          <p className="font-medium">{t("title")}</p>
          <p className="text-sm text-muted-foreground">{t("body")}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <a href={`/${locale}/admin/branding`} className={cn(buttonVariants({ variant: "default", size: "sm" }))}>
            {t("cta")}
          </a>
          <Button variant="ghost" size="sm" onClick={handleDismiss} disabled={isPending}>
            {t("dismiss")}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
