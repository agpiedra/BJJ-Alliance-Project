"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { signup, type SignupState } from "./actions";
import { Belt } from "@/generated/prisma/browser";

const BELT_OPTIONS = Object.values(Belt);
const STRIPE_OPTIONS = [0, 1, 2, 3, 4];

const INITIAL_STATE: SignupState = {};

type Academy = { slug: string; name: string };

export function SignupForm({ academies }: { academies: Academy[] }) {
  const t = useTranslations("signup");
  const tBelt = useTranslations("belt");
  const [state, formAction, isPending] = useActionState(signup, INITIAL_STATE);

  if (state.ok) {
    return (
      <main className="flex min-h-[calc(100vh-4rem)] flex-col items-center justify-center gap-4 p-6 text-center">
        <h1 className="text-2xl font-bold">{t("successHeading")}</h1>
        <p>{t("successCodeWarning")}</p>
        <p className="text-4xl font-mono font-bold tracking-widest">{state.code}</p>
        <p className="text-sm text-muted-foreground">{t("successNote")}</p>
      </main>
    );
  }

  const guardianNameErrors = state.fieldErrors?.guardianName;

  return (
    <main className="flex min-h-[calc(100vh-4rem)] flex-col items-center justify-center gap-4 p-6">
      <h1 className="text-2xl font-bold">{t("heading")}</h1>
      <form action={formAction} className="flex w-full max-w-sm flex-col gap-3">
        <label className="flex flex-col gap-1">
          <span>{t("firstName")}</span>
          <input type="text" name="firstName" required className="rounded border px-3 py-2" />
        </label>
        <label className="flex flex-col gap-1">
          <span>{t("lastName")}</span>
          <input type="text" name="lastName" required className="rounded border px-3 py-2" />
        </label>
        <label className="flex flex-col gap-1">
          <span>{t("phone")}</span>
          <input type="tel" name="phone" required className="rounded border px-3 py-2" />
        </label>
        <label className="flex flex-col gap-1">
          <span>{t("email")}</span>
          <input type="email" name="email" required className="rounded border px-3 py-2" />
        </label>
        <label className="flex flex-col gap-1">
          <span>{t("homeAcademy")}</span>
          <select name="homeAcademySlug" required className="rounded border px-3 py-2">
            {academies.map((academy) => (
              <option key={academy.slug} value={academy.slug}>
                {academy.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span>{t("currentBelt")}</span>
          <select name="currentBelt" required defaultValue={Belt.WHITE} className="rounded border px-3 py-2">
            {BELT_OPTIONS.map((belt) => (
              <option key={belt} value={belt}>
                {tBelt(belt)}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span>{t("currentStripes")}</span>
          <select name="currentStripes" required defaultValue={0} className="rounded border px-3 py-2">
            {STRIPE_OPTIONS.map((count) => (
              <option key={count} value={count}>
                {count}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span>{t("password")}</span>
          <input type="password" name="password" required minLength={8} className="rounded border px-3 py-2" />
        </label>
        <label className="flex flex-col gap-1">
          <span>{t("dateOfBirth")}</span>
          <input type="date" name="dateOfBirth" className="rounded border px-3 py-2" />
        </label>
        <label className="flex flex-col gap-1">
          <span>{t("guardianName")}</span>
          <input type="text" name="guardianName" className="rounded border px-3 py-2" />
        </label>
        {guardianNameErrors && guardianNameErrors.length > 0 && (
          <p className="text-sm text-red-600">{t("guardianRequiredForMinor")}</p>
        )}
        <label className="flex flex-col gap-1">
          <span>{t("guardianPhone")}</span>
          <input type="tel" name="guardianPhone" className="rounded border px-3 py-2" />
        </label>
        <label className="flex flex-col gap-1">
          <span>{t("emergencyContact")}</span>
          <input type="text" name="emergencyContact" className="rounded border px-3 py-2" />
        </label>
        {state.error && <p className="text-sm text-red-600">{t(state.error)}</p>}
        <Button type="submit" disabled={isPending}>
          {t("submit")}
        </Button>
      </form>
    </main>
  );
}
