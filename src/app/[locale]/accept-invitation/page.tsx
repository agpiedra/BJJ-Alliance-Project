"use client";

import { Suspense, useActionState } from "react";
import { useTranslations } from "next-intl";
import { useParams, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { BrandBanner } from "@/components/brand/brand-banner";
import { acceptInvitation } from "./actions";
import { INITIAL_ACTION_STATE } from "@/lib/action-state";

export default function AcceptInvitationPage() {
  return (
    <>
      <BrandBanner />
      <Suspense fallback={null}>
        <AcceptInvitationForm />
      </Suspense>
    </>
  );
}

function AcceptInvitationForm() {
  const t = useTranslations("auth.acceptInvitation");
  const params = useParams<{ locale: string }>();
  const searchParams = useSearchParams();
  const token = searchParams.get("token") ?? "";
  const [state, formAction, isPending] = useActionState(
    acceptInvitation.bind(null, params.locale),
    INITIAL_ACTION_STATE,
  );

  return (
    <main className="flex min-h-[calc(100vh-4rem)] flex-col items-center justify-center gap-4 p-6">
      <h1 className="text-2xl font-bold">{t("heading")}</h1>
      <form action={formAction} className="flex w-full max-w-sm flex-col gap-3">
        <input type="hidden" name="token" value={token} />
        <label className="flex flex-col gap-1">
          <span>{t("newPassword")}</span>
          <input type="password" name="password" required minLength={8} className="rounded border px-3 py-2" />
        </label>
        {state.error && <p className="text-sm text-destructive">{t(state.error)}</p>}
        <Button type="submit" variant="primary" disabled={isPending}>
          {t("submit")}
        </Button>
      </form>
    </main>
  );
}
