"use client";

import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { revokeSuperAdmin } from "./actions";

export function RevokeAdminButton({ userId }: { userId: string }) {
  const t = useTranslations("platform.admins.list");
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="flex items-center gap-2">
      {error && <span className="text-xs text-destructive">{t(`errors.${error}` as "errors.cannotRevokeLastAdmin")}</span>}
      <Button
        variant="ghost"
        size="sm"
        disabled={isPending}
        onClick={() => {
          if (!confirm(t("confirmRevoke"))) return;
          setError(null);
          startTransition(async () => {
            const result = await revokeSuperAdmin(userId);
            if (result.error) setError(result.error);
          });
        }}
      >
        {t("revoke")}
      </Button>
    </div>
  );
}
