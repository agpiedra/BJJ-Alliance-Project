"use client";

import { useTransition } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { suspendOrganizationAction, reactivateOrganizationAction } from "./actions";
import type { OrganizationStatus } from "@/generated/prisma/client";

/** Approve/reject live on the pending queue page, not here (doc: "Approve
 * queue... reachable from a badge counter"), so this list's own row actions
 * are only the two status flips that apply to an already-decided
 * organization. "open as" (impersonation) is deliberately not offered —
 * see MULTI_ACADEMY_AND_KIDS_BELTS.md's Phase 6 open question. */
export function RowActions({ organizationId, status }: { organizationId: string; status: OrganizationStatus }) {
  const t = useTranslations("platform.organizations.rowActions");
  const [isPending, startTransition] = useTransition();

  if (status === "ACTIVE") {
    return (
      <Button
        variant="ghost"
        size="sm"
        disabled={isPending}
        onClick={() => {
          if (!confirm(t("confirmSuspend"))) return;
          startTransition(async () => {
            await suspendOrganizationAction(organizationId);
          });
        }}
      >
        {t("suspend")}
      </Button>
    );
  }

  if (status === "SUSPENDED") {
    return (
      <Button
        variant="ghost"
        size="sm"
        disabled={isPending}
        onClick={() => {
          startTransition(async () => {
            await reactivateOrganizationAction(organizationId);
          });
        }}
      >
        {t("reactivate")}
      </Button>
    );
  }

  return null;
}
