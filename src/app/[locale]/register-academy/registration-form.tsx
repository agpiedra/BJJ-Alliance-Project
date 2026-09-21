"use client";

import { useActionState, useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { slugify } from "@/lib/organizations/slug";
import { CURRENCIES } from "@/lib/payments/format-money";
import { registerOrganization, checkSlugAvailability, type RegistrationState } from "./actions";

const INITIAL_STATE: RegistrationState = {};

const STUDENT_COUNT_BANDS = ["1-25", "26-75", "76-150", "150+"] as const;

export function RegistrationForm() {
  const t = useTranslations("registerAcademy");
  const [state, formAction, isPending] = useActionState(registerOrganization, INITIAL_STATE);
  const [slug, setSlug] = useState("");
  const [slugEditedByHand, setSlugEditedByHand] = useState(false);
  const [slugAvailable, setSlugAvailable] = useState<boolean | null>(null);
  const [isCheckingSlug, startSlugCheck] = useTransition();

  function checkSlug(candidate: string) {
    startSlugCheck(async () => {
      const result = await checkSlugAvailability(candidate);
      setSlugAvailable(result.available);
    });
  }

  if (state.ok) {
    return (
      <main className="flex min-h-[calc(100vh-4rem)] flex-col items-center justify-center gap-4 p-6 text-center">
        <h1 className="text-2xl font-bold">{t("successHeading")}</h1>
        <p className="max-w-md text-muted-foreground">{t("successBody")}</p>
      </main>
    );
  }

  return (
    <main className="flex min-h-[calc(100vh-4rem)] flex-col items-center justify-center gap-4 p-6">
      <h1 className="text-2xl font-bold">{t("heading")}</h1>
      <form action={formAction} className="flex w-full max-w-sm flex-col gap-3">
        {/* Honeypot — hidden visually, never `type="hidden"` (some bots skip
            those). A real visitor never sees or fills this. */}
        <div className="absolute -left-[9999px]" aria-hidden="true">
          <label>
            Website
            <input type="text" name="website" tabIndex={-1} autoComplete="off" />
          </label>
        </div>

        <label className="flex flex-col gap-1">
          <span>{t("organizationName")}</span>
          <input
            type="text"
            name="organizationName"
            required
            className="rounded border px-3 py-2"
            onChange={(e) => {
              if (slugEditedByHand) return;
              const suggested = slugify(e.target.value);
              setSlug(suggested);
              if (suggested.length >= 2) checkSlug(suggested);
            }}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span>{t("desiredSlug")}</span>
          <input
            type="text"
            name="desiredSlug"
            required
            value={slug}
            className="rounded border px-3 py-2"
            onChange={(e) => {
              setSlugEditedByHand(true);
              const next = slugify(e.target.value);
              setSlug(next);
              setSlugAvailable(null);
              if (next.length >= 2) checkSlug(next);
            }}
          />
          {isCheckingSlug && <span className="text-sm text-muted-foreground">{t("slugChecking")}</span>}
          {!isCheckingSlug && slugAvailable === true && (
            <span className="text-sm text-ok">{t("slugAvailable")}</span>
          )}
          {!isCheckingSlug && slugAvailable === false && (
            <span className="text-sm text-bad">{t("slugTaken")}</span>
          )}
        </label>
        <label className="flex flex-col gap-1">
          <span>{t("country")}</span>
          <input type="text" name="country" required className="rounded border px-3 py-2" />
        </label>
        <label className="flex flex-col gap-1">
          <span>{t("city")}</span>
          <input type="text" name="city" required className="rounded border px-3 py-2" />
        </label>
        <label className="flex flex-col gap-1">
          <span>{t("contactName")}</span>
          <input type="text" name="contactName" required className="rounded border px-3 py-2" />
        </label>
        <label className="flex flex-col gap-1">
          <span>{t("contactEmail")}</span>
          <input type="email" name="contactEmail" required className="rounded border px-3 py-2" />
        </label>
        <label className="flex flex-col gap-1">
          <span>{t("contactPhone")}</span>
          <input type="tel" name="contactPhone" required className="rounded border px-3 py-2" />
        </label>
        <label className="flex flex-col gap-1">
          <span>{t("studentCountBand")}</span>
          <select name="studentCountBand" required defaultValue="" className="rounded border px-3 py-2">
            <option value="" disabled>
              {t("studentCountBandPlaceholder")}
            </option>
            {STUDENT_COUNT_BANDS.map((band) => (
              <option key={band} value={band}>
                {band}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span>{t("referralSource")}</span>
          <input type="text" name="referralSource" className="rounded border px-3 py-2" />
        </label>
        <label className="flex flex-col gap-1">
          <span>{t("preferredLocale")}</span>
          <select name="preferredLocale" required defaultValue="es" className="rounded border px-3 py-2">
            <option value="es">Español</option>
            <option value="en">English</option>
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span>{t("currency")}</span>
          <select name="currency" required defaultValue="CRC" className="rounded border px-3 py-2">
            {CURRENCIES.map((currency) => (
              <option key={currency} value={currency}>
                {t(`currencyOption.${currency}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" name="termsAccepted" required />
          <span className="text-sm">{t("termsAccepted")}</span>
        </label>
        {state.error && <p className="text-sm text-bad">{t(`error.${state.error}` as never)}</p>}
        <Button type="submit" disabled={isPending}>
          {t("submit")}
        </Button>
      </form>
    </main>
  );
}
