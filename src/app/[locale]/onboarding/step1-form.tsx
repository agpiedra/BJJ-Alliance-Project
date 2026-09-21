"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { saveOnboardingStep1 } from "./actions";
import { INITIAL_ACTION_STATE } from "@/lib/action-state";

export function OnboardingStep1Form({
  organizationId,
  locale,
  organizationName,
  displayName,
  slug,
}: {
  organizationId: string;
  locale: string;
  organizationName: string;
  displayName: string;
  slug: string;
}) {
  const t = useTranslations("onboarding.step1");
  const [state, formAction, isPending] = useActionState(saveOnboardingStep1.bind(null, organizationId, locale), INITIAL_ACTION_STATE);

  return (
    <form action={formAction} className="flex flex-col gap-3">
      <label className="flex flex-col gap-1">
        <span>{t("name")}</span>
        <input type="text" name="name" required defaultValue={organizationName} className="rounded border px-3 py-2" />
      </label>
      <label className="flex flex-col gap-1">
        <span>{t("displayName")}</span>
        <input type="text" name="displayName" defaultValue={displayName} className="rounded border px-3 py-2" />
      </label>
      <p className="text-sm text-muted-foreground">
        {t("slugNote", { slug })}
      </p>
      {state.error && <p className="text-sm text-bad">{t("error")}</p>}
      <Button type="submit" disabled={isPending}>
        {t("next")}
      </Button>
    </form>
  );
}
