"use client";

import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { approveOrganizationAction } from "../actions";

/**
 * MULTI_ACADEMY_AND_KIDS_BELTS.md Phase 8 — a real gap found while writing
 * docs/MULTI_ACADEMY_OPERATIONS.md: resending an invitation for an
 * already-ACTIVE organization had no panel button, only
 * scripts/approve-organization.ts. Calls the exact same
 * `approveOrganizationAction` the pending queue's own "Approve" button
 * calls (which itself calls `approveOrganization()` — one function, both
 * callers) — `approveOrganization()` already accepts PENDING or ACTIVE and
 * is idempotent on ACTIVE (issues a fresh invitation, invalidates the old
 * one, creates nothing new), so no new server action was needed here.
 */
export function ResendInvitationButton({ organizationId }: { organizationId: string }) {
  const t = useTranslations("platform.organizations.detail.members");
  const [isPending, startTransition] = useTransition();
  const [result, setResult] = useState<"idle" | "sent" | "error">("idle");

  return (
    <div className="flex items-center gap-2">
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={isPending}
        onClick={() => {
          if (!confirm(t("confirmResendInvitation"))) return;
          setResult("idle");
          startTransition(async () => {
            const action = await approveOrganizationAction(organizationId);
            setResult(action.error ? "error" : "sent");
          });
        }}
      >
        {t("resendInvitation")}
      </Button>
      {result === "sent" && <span className="text-sm text-muted-foreground">{t("resendInvitationSent")}</span>}
      {result === "error" && <span className="text-sm text-destructive">{t("resendInvitationError")}</span>}
    </div>
  );
}
