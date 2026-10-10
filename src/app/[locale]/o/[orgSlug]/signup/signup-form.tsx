"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Input, FIELD_CLASS } from "@/components/ui/input";
import { AuthCard } from "@/components/auth/auth-card";
import type { LogoMarkProps } from "@/components/brand/logo-mark";
import { signup, type SignupState } from "./actions";

// MULTI_ACADEMY_AND_KIDS_BELTS.md Phase 2: the old `Belt` enum is gone
// (replaced by BeltRank, which is data now) — every existing student still
// starts on one of these 5 adult ranks, so this stays a plain local literal
// list, same as STRIPE_OPTIONS below, rather than a DB round trip for a
// fixed 5-option dropdown.
const BELT_OPTIONS = ["WHITE", "BLUE", "PURPLE", "BROWN", "BLACK"] as const;
const STRIPE_OPTIONS = [0, 1, 2, 3, 4];

const INITIAL_STATE: SignupState = {};

type Academy = { slug: string; name: string };

export function SignupForm({
  orgSlug,
  academies,
  brand,
}: {
  orgSlug: string;
  academies: Academy[];
  brand?: LogoMarkProps;
}) {
  const t = useTranslations("signup");
  const tBelt = useTranslations("belt");
  const [state, formAction, isPending] = useActionState(signup.bind(null, orgSlug), INITIAL_STATE);

  if (state.ok) {
    return (
      <AuthCard title={t("successHeading")} brand={brand}>
        <p>{t("successCodeWarning")}</p>
        <p className="text-4xl font-mono font-bold tracking-widest">{state.code}</p>
        <p className="text-sm text-muted-foreground">{t("successNote")}</p>
      </AuthCard>
    );
  }

  const guardianNameErrors = state.fieldErrors?.guardianName;

  return (
    <AuthCard title={t("heading")} brand={brand}>
      <form action={formAction} className="flex flex-col gap-3">
        <label className="flex flex-col gap-1">
          <span>{t("firstName")}</span>
          <Input type="text" name="firstName" required />
        </label>
        <label className="flex flex-col gap-1">
          <span>{t("lastName")}</span>
          <Input type="text" name="lastName" required />
        </label>
        <label className="flex flex-col gap-1">
          <span>{t("phone")}</span>
          <Input type="tel" name="phone" required />
        </label>
        <label className="flex flex-col gap-1">
          <span>{t("email")}</span>
          <Input type="email" name="email" required />
        </label>
        <label className="flex flex-col gap-1">
          <span>{t("homeAcademy")}</span>
          <select name="homeAcademySlug" required className={FIELD_CLASS}>
            {academies.map((academy) => (
              <option key={academy.slug} value={academy.slug}>
                {academy.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span>{t("currentBelt")}</span>
          <select name="currentBelt" required defaultValue="WHITE" className={FIELD_CLASS}>
            {BELT_OPTIONS.map((belt) => (
              <option key={belt} value={belt}>
                {tBelt(belt)}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span>{t("currentStripes")}</span>
          <select name="currentStripes" required defaultValue={0} className={FIELD_CLASS}>
            {STRIPE_OPTIONS.map((count) => (
              <option key={count} value={count}>
                {count}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span>{t("password")}</span>
          <Input type="password" name="password" required minLength={8} />
        </label>
        <label className="flex flex-col gap-1">
          <span>{t("dateOfBirth")}</span>
          <Input type="date" name="dateOfBirth" />
        </label>
        <label className="flex flex-col gap-1">
          <span>{t("guardianName")}</span>
          <Input type="text" name="guardianName" />
        </label>
        {guardianNameErrors && guardianNameErrors.length > 0 && (
          <p className="text-sm text-destructive">{t("guardianRequiredForMinor")}</p>
        )}
        <label className="flex flex-col gap-1">
          <span>{t("guardianPhone")}</span>
          <Input type="tel" name="guardianPhone" />
        </label>
        <label className="flex flex-col gap-1">
          <span>{t("emergencyContact")}</span>
          <Input type="text" name="emergencyContact" />
        </label>
        {state.error && <p className="text-sm text-destructive">{t(state.error)}</p>}
        <Button type="submit" disabled={isPending}>
          {t("submit")}
        </Button>
      </form>
    </AuthCard>
  );
}
