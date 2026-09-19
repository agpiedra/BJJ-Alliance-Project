"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { INITIAL_ACTION_STATE } from "@/lib/action-state";
import { grantSuperAdmin } from "./actions";

export function GrantAdminForm() {
  const t = useTranslations("platform.admins.grant");
  const [state, formAction, isPending] = useActionState(grantSuperAdmin, INITIAL_ACTION_STATE);

  return (
    <form action={formAction} className="flex flex-wrap items-end gap-2">
      <label className="flex flex-col gap-1">
        <span className="text-sm">{t("emailLabel")}</span>
        <Input name="email" type="email" required />
      </label>
      <Button type="submit" disabled={isPending}>
        {t("submit")}
      </Button>
      {state.error && <p className="text-sm text-destructive">{t(`errors.${state.error}` as "errors.userNotFound")}</p>}
    </form>
  );
}
