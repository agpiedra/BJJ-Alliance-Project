"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { useParams, useRouter } from "next/navigation";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { INITIAL_ACTION_STATE } from "@/lib/action-state";
import { createOrganizationManually, type ManualOrganizationCreationState } from "./actions";

export default function NewOrganizationPage() {
  const t = useTranslations("platform.organizations.new");
  const params = useParams<{ locale: string }>();
  const router = useRouter();
  const [state, formAction, isPending] = useActionState<ManualOrganizationCreationState, FormData>(
    async (prevState, formData) => {
      const result = await createOrganizationManually(prevState, formData);
      if (result.ok) {
        router.push(`/${params.locale}/platform/organizations`);
      }
      return result;
    },
    INITIAL_ACTION_STATE,
  );

  return (
    <>
      <header>
        <h1 className="text-2xl font-bold">{t("heading")}</h1>
      </header>

      <form action={formAction} className="flex max-w-lg flex-col gap-3">
        <label className="flex flex-col gap-1">
          <span>{t("fields.organizationName")}</span>
          <Input name="organizationName" required />
        </label>
        <label className="flex flex-col gap-1">
          <span>{t("fields.desiredSlug")}</span>
          <Input name="desiredSlug" required />
          {state.fieldErrors?.desiredSlug && <span className="text-sm text-destructive">{state.fieldErrors.desiredSlug[0]}</span>}
        </label>
        <label className="flex flex-col gap-1">
          <span>{t("fields.country")}</span>
          <Input name="country" required />
        </label>
        <label className="flex flex-col gap-1">
          <span>{t("fields.city")}</span>
          <Input name="city" required />
        </label>
        <label className="flex flex-col gap-1">
          <span>{t("fields.directorEmail")}</span>
          <Input name="directorEmail" type="email" required />
          {state.fieldErrors?.directorEmail && <span className="text-sm text-destructive">{state.fieldErrors.directorEmail[0]}</span>}
        </label>
        <label className="flex flex-col gap-1">
          <span>{t("fields.contactName")}</span>
          <Input name="contactName" required />
        </label>
        <label className="flex flex-col gap-1">
          <span>{t("fields.contactPhone")}</span>
          <Input name="contactPhone" required />
        </label>
        <label className="flex flex-col gap-1">
          <span>{t("fields.studentCountBand")}</span>
          <Input name="studentCountBand" required />
        </label>
        <label className="flex flex-col gap-1">
          <span>{t("fields.preferredLocale")}</span>
          <select name="preferredLocale" defaultValue="es" className="h-9 rounded-lg border border-input bg-transparent px-3">
            <option value="es">Español</option>
            <option value="en">English</option>
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span>{t("fields.promotionMode")}</span>
          <select name="promotionMode" defaultValue="ATTENDANCE" className="h-9 rounded-lg border border-input bg-transparent px-3">
            <option value="ATTENDANCE">{t("promotionModes.ATTENDANCE")}</option>
            <option value="TIME">{t("promotionModes.TIME")}</option>
            <option value="MANUAL">{t("promotionModes.MANUAL")}</option>
          </select>
        </label>

        {state.error && !state.fieldErrors && <p className="text-sm text-destructive">{t(`errors.${state.error}` as "errors.invalid")}</p>}

        <Button type="submit" disabled={isPending}>
          {t("submit")}
        </Button>
      </form>
    </>
  );
}
