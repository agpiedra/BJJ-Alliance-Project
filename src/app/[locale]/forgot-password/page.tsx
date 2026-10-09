"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { useParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AuthCard } from "@/components/auth/auth-card";
import { BrandBanner } from "@/components/brand/brand-banner";
import { requestPasswordReset } from "./actions";
import { INITIAL_ACTION_STATE } from "@/lib/action-state";

export default function ForgotPasswordPage() {
  const t = useTranslations("auth.forgotPassword");
  const params = useParams<{ locale: string }>();
  const [state, formAction, isPending] = useActionState(
    requestPasswordReset.bind(null, params.locale),
    INITIAL_ACTION_STATE,
  );

  if (state.ok) {
    return (
      <>
        <BrandBanner />
        <AuthCard title={t("heading")}>
          <p className="text-sm text-muted-foreground">{t("genericConfirmation")}</p>
        </AuthCard>
      </>
    );
  }

  return (
    <>
      <BrandBanner />
      <AuthCard title={t("heading")}>
        <form action={formAction} className="flex flex-col gap-3">
          <label className="flex flex-col gap-1">
            <span>{t("email")}</span>
            <Input type="email" name="email" required />
          </label>
          <Button type="submit" disabled={isPending}>
            {t("submit")}
          </Button>
        </form>
      </AuthCard>
    </>
  );
}
