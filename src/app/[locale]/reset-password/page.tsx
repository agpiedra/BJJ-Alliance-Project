"use client";

import { Suspense, useActionState } from "react";
import { useTranslations } from "next-intl";
import { useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AuthCard } from "@/components/auth/auth-card";
import { resetPassword } from "./actions";
import { INITIAL_ACTION_STATE } from "@/lib/action-state";

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={null}>
      <ResetPasswordForm />
    </Suspense>
  );
}

function ResetPasswordForm() {
  const t = useTranslations("auth.resetPassword");
  const searchParams = useSearchParams();
  const token = searchParams.get("token") ?? "";
  const [state, formAction, isPending] = useActionState(resetPassword, INITIAL_ACTION_STATE);

  if (state.ok) {
    return (
      <AuthCard title={t("heading")}>
        <p className="text-sm text-muted-foreground">{t("success")}</p>
      </AuthCard>
    );
  }

  return (
    <AuthCard title={t("heading")}>
      <form action={formAction} className="flex flex-col gap-3">
        <input type="hidden" name="token" value={token} />
        <label className="flex flex-col gap-1">
          <span>{t("newPassword")}</span>
          <Input type="password" name="password" required minLength={8} />
        </label>
        {state.error && <p className="text-sm text-destructive">{t(state.error)}</p>}
        <Button type="submit" disabled={isPending}>
          {t("submit")}
        </Button>
      </form>
    </AuthCard>
  );
}
