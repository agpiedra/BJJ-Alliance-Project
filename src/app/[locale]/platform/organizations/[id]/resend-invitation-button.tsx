"use client";

import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { approveOrganizationAction } from "../actions";

type Result = "idle" | "error" | "accepted" | "rejected" | "not_configured" | "unknown" | "notIssued";

/** Messages that report a failure; "accepted", "unknown" and "notIssued" are stated neutrally. */
const FAILED: ReadonlySet<Result> = new Set<Result>(["error", "rejected", "not_configured"]);

const MESSAGE_KEY = {
  error: "resendInvitationError",
  accepted: "resendInvitationAccepted",
  rejected: "resendInvitationRejected",
  not_configured: "resendInvitationNotConfigured",
  unknown: "resendInvitationUnknown",
  notIssued: "resendInvitationNotIssued",
} as const;

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
 *
 * The message reports the email outcome the action hands back (PR #133's classification): accepted is never shown as
 * delivered, and a rejected, unconfigured or unconfirmed send is never shown as sent.
 */
export function ResendInvitationButton({ organizationId }: { organizationId: string }) {
  const t = useTranslations("platform.organizations.detail.members");
  const [isPending, startTransition] = useTransition();
  const [result, setResult] = useState<Result>("idle");

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
            setResult(action.error ? "error" : (action.invitationEmail ?? "unknown"));
          });
        }}
      >
        {t("resendInvitation")}
      </Button>
      {result !== "idle" && (
        <span className={FAILED.has(result) ? "text-sm text-destructive" : "text-sm text-muted-foreground"}>{t(MESSAGE_KEY[result])}</span>
      )}
    </div>
  );
}
