"use client";

import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { approveOrganizationAction, rejectOrganizationAction } from "../actions";

export function PendingRowActions({ organizationId }: { organizationId: string }) {
  const t = useTranslations("platform.organizations.pending.rowActions");
  const [isPending, startTransition] = useTransition();
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);

  function handleApprove() {
    setError(null);
    startTransition(async () => {
      const result = await approveOrganizationAction(organizationId);
      if (result.error) setError(result.error);
    });
  }

  function handleReject() {
    setError(null);
    startTransition(async () => {
      const result = await rejectOrganizationAction(organizationId, note);
      if (result.error) setError(result.error);
    });
  }

  if (rejecting) {
    return (
      <div className="flex flex-col gap-2 pt-2">
        <Input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder={t("rejectNotePlaceholder")}
          disabled={isPending}
        />
        {error && <p className="text-sm text-destructive">{t(error as "noteRequired")}</p>}
        <div className="flex gap-2">
          <Button variant="destructive" size="sm" disabled={isPending} onClick={handleReject}>
            {t("confirmReject")}
          </Button>
          <Button variant="ghost" size="sm" disabled={isPending} onClick={() => setRejecting(false)}>
            {t("cancel")}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex gap-2 pt-2">
      <Button size="sm" disabled={isPending} onClick={handleApprove}>
        {t("approve")}
      </Button>
      <Button variant="ghost" size="sm" disabled={isPending} onClick={() => setRejecting(true)}>
        {t("reject")}
      </Button>
      {error && <p className="text-sm text-destructive self-center">{error}</p>}
    </div>
  );
}
