"use client";

import { Suspense, useActionState } from "react";
import { useTranslations } from "next-intl";
import { useParams, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { login } from "./actions";
import { INITIAL_ACTION_STATE } from "@/lib/action-state";

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
}

function LoginForm() {
  const t = useTranslations("auth.login");
  const params = useParams<{ locale: string }>();
  const searchParams = useSearchParams();
  const callbackUrl = searchParams.get("callbackUrl") ?? undefined;

  const [state, formAction, isPending] = useActionState(
    login.bind(null, params.locale, callbackUrl),
    INITIAL_ACTION_STATE,
  );

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 p-6">
      <h1 className="text-2xl font-bold">{t("heading")}</h1>
      <form action={formAction} className="flex w-full max-w-sm flex-col gap-3">
        <label className="flex flex-col gap-1">
          <span>{t("email")}</span>
          <input type="email" name="email" required className="rounded border px-3 py-2" />
        </label>
        <label className="flex flex-col gap-1">
          <span>{t("password")}</span>
          <input type="password" name="password" required className="rounded border px-3 py-2" />
        </label>
        {state.error && <p className="text-sm text-red-600">{t(state.error)}</p>}
        <Button type="submit" disabled={isPending}>
          {t("submit")}
        </Button>
        <a href={`/${params.locale}/forgot-password`} className="text-sm underline">
          {t("forgotPassword")}
        </a>
      </form>
    </main>
  );
}
