"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { createStudent, type CreateStudentState } from "./create-student-action";
import { Belt } from "@/generated/prisma/browser";

const BELT_OPTIONS = Object.values(Belt);
const STRIPE_OPTIONS = [0, 1, 2, 3, 4];

const INITIAL_STATE: CreateStudentState = {};

type Academy = { id: string; name: string };

// Rendered only for ADMIN/DIRECTOR sessions (page.tsx gate) — but the real
// enforcement is server-side in `createStudent` itself (requireStaffSession
// + isAcademyInScope), never this UI check alone.
export function CreateStudentForm({ academies }: { academies: Academy[] }) {
  const t = useTranslations("students.create");
  const tBelt = useTranslations("belt");
  const [state, formAction, isPending] = useActionState(createStudent, INITIAL_STATE);

  const guardianNameErrors = state.fieldErrors?.guardianName;

  return (
    <details className="rounded border p-4">
      <summary className="cursor-pointer font-medium">{t("toggle")}</summary>

      {state.ok && state.code && (
        <div className="mt-4 flex flex-col gap-2 rounded border border-green-600 bg-green-50 p-3">
          <p>{t("successCodeWarning")}</p>
          <p className="text-3xl font-mono font-bold tracking-widest">{state.code}</p>
        </div>
      )}

      <form action={formAction} className="mt-4 flex w-full max-w-sm flex-col gap-3">
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

        {academies.length === 1 ? (
          <input type="hidden" name="homeAcademyId" value={academies[0].id} />
        ) : (
          <label className="flex flex-col gap-1">
            <span>{t("homeAcademy")}</span>
            <select name="homeAcademyId" required className="rounded border px-3 py-2">
              {academies.map((academy) => (
                <option key={academy.id} value={academy.id}>
                  {academy.name}
                </option>
              ))}
            </select>
          </label>
        )}

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
    </details>
  );
}
