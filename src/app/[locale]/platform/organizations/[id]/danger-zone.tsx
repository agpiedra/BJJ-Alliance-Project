"use client";

import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { suspendOrganizationAction, reactivateOrganizationAction, cancelOrganizationAction } from "../actions";
import type { OrganizationStatus } from "@/generated/prisma/client";

export function DangerZone({ organizationId, status }: { organizationId: string; status: OrganizationStatus }) {
  const t = useTranslations("platform.organizations.detail.dangerZone");
  const [isPending, startTransition] = useTransition();
  const [cancelling, setCancelling] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);

  if (status === "CANCELLED") {
    return <p className="text-sm text-muted-foreground">{t("alreadyCancelled")}</p>;
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex gap-2">
        {status === "ACTIVE" && (
          <Button
            variant="destructive"
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
        )}
        {status === "SUSPENDED" && (
          <Button
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
        )}
        {!cancelling && (
          <Button variant="destructive" size="sm" disabled={isPending} onClick={() => setCancelling(true)}>
            {t("cancel")}
          </Button>
        )}
      </div>

      {cancelling && (
        <div className="flex flex-col gap-2">
          <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder={t("cancelNotePlaceholder")} disabled={isPending} />
          {error && <p className="text-sm text-destructive">{t(error as "confirmCancel")}</p>}
          <div className="flex gap-2">
            <Button
              variant="destructive"
              size="sm"
              disabled={isPending}
              onClick={() => {
                if (!confirm(t("confirmCancel"))) return;
                setError(null);
                startTransition(async () => {
                  const result = await cancelOrganizationAction(organizationId, note);
                  if (result.error) setError(result.error);
                });
              }}
            >
              {t("confirmCancelButton")}
            </Button>
            <Button variant="ghost" size="sm" disabled={isPending} onClick={() => setCancelling(false)}>
              {t("cancelDialogCancel")}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
