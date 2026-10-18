"use client";

import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import type { InvitationSettlement } from "@/lib/organizations/approve-organization";
import { approveOrganizationAction } from "../actions";

type Outcome = "error" | "accepted" | "rejected" | "not_configured" | "unknown" | "notIssued" | "legacyUnresolved";
type Result = { outcome: Outcome; settlement?: InvitationSettlement } | null;

const OUTCOME_KEY = {
  error: "resendInvitationError",
  accepted: "resendInvitationAccepted",
  rejected: "resendInvitationRejected",
  not_configured: "resendInvitationNotConfigured",
  unknown: "resendInvitationUnknown",
  notIssued: "resendInvitationNotIssued",
  legacyUnresolved: "resendInvitationLegacyUnresolved",
} as const;

/** The second sentence: what settlement found. "settled" depends on the email outcome; the others never do. */
function settlementKey(outcome: Outcome, settlement: InvitationSettlement) {
  switch (settlement) {
    case "acceptedMeanwhile":
      return "resendInvitationAcceptedMeanwhile";
    case "unavailable":
      return "resendInvitationUnavailable";
    case "failed":
      return "resendInvitationSettleFailed";
    case "settled":
      if (outcome === "accepted") return "resendInvitationSettledAccepted";
      if (outcome === "unknown") return "resendInvitationSettledUnknown";
      return "resendInvitationSettledWithdrawn";
  }
}

/** Results an operator must act on; "accepted", "unknown" and "notIssued" are stated neutrally. */
function isFailure(result: NonNullable<Result>): boolean {
  return ["error", "rejected", "not_configured", "legacyUnresolved"].includes(result.outcome) || result.settlement === "failed";
}

/**
 * MULTI_ACADEMY_AND_KIDS_BELTS.md Phase 8 — a real gap found while writing
 * docs/MULTI_ACADEMY_OPERATIONS.md: resending an invitation for an
 * already-ACTIVE organization had no panel button, only
 * scripts/approve-organization.ts. Calls the exact same
 * `approveOrganizationAction` the pending queue's own "Approve" button
 * calls (which itself calls `approveOrganization()` — one function, both
 * callers) — `approveOrganization()` already accepts PENDING or ACTIVE, so
 * no new server action was needed here. On ACTIVE it creates no new academy
 * or membership. It issues a fresh invitation unless one to this address was
 * genuinely accepted (`acceptedAt`), or a row consumed under the old rules is
 * unresolved; earlier links are retired only once the provider accepts the new
 * email (docs/INVITATION_LIFECYCLE_REPAIR_PLAN.md).
 *
 * The message is the email outcome (PR #133's classification — accepted is never shown as delivered) followed by
 * what settlement found; it never claims an earlier link still works, only what this resend changed.
 */
export function ResendInvitationButton({ organizationId }: { organizationId: string }) {
  const t = useTranslations("platform.organizations.detail.members");
  const [isPending, startTransition] = useTransition();
  const [result, setResult] = useState<Result>(null);

  return (
    <div className="flex items-center gap-2">
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={isPending}
        onClick={() => {
          if (!confirm(t("confirmResendInvitation"))) return;
          setResult(null);
          startTransition(async () => {
            const action = await approveOrganizationAction(organizationId);
            setResult(
              action.error ? { outcome: "error" } : { outcome: action.invitationEmail ?? "unknown", settlement: action.invitationSettlement },
            );
          });
        }}
      >
        {t("resendInvitation")}
      </Button>
      {result && (
        <span className={isFailure(result) ? "text-sm text-destructive" : "text-sm text-muted-foreground"}>
          {t(OUTCOME_KEY[result.outcome])}
          {result.settlement && ` ${t(settlementKey(result.outcome, result.settlement))}`}
        </span>
      )}
    </div>
  );
}
