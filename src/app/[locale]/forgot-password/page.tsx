"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { useParams } from "next/navigation";
import { Button } from "@/components/ui/button";
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
      <main className="flex min-h-screen flex-col items-center justify-center p-6 text-center">
        <p>{t("genericConfirmation")}</p>
      </main>
    );
  }

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 p-6">
      <h1 className="text-2xl font-bold">{t("heading")}</h1>
      <form action={formAction} className="flex w-full max-w-sm flex-col gap-3">
        <label className="flex flex-col gap-1">
          <span>{t("email")}</span>
          <input type="email" name="email" required className="rounded border px-3 py-2" />
        </label>
        <Button type="submit" disabled={isPending}>
          {t("submit")}
        </Button>
      </form>
    </main>
  );
}
