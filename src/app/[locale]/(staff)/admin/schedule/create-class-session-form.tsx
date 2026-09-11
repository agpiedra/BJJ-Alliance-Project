"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { createClassSession } from "./actions";
import { DayOfWeek, ClassType } from "@/generated/prisma/browser";
import type { ActionState } from "@/lib/action-state";

const INITIAL_STATE: ActionState = {};
const DAY_OPTIONS = Object.values(DayOfWeek);
const TYPE_OPTIONS = Object.values(ClassType);

// Rendered only for an ADMIN session (page.tsx gate) — the real enforcement
// is server-side in `createClassSession` itself
// (requireStaffSession(["ADMIN"])), never this UI check alone.
export function CreateClassSessionForm({ academyId }: { academyId: string }) {
  const t = useTranslations("adminSchedule.create");
  const tDay = useTranslations("dayOfWeek");
  const tType = useTranslations("classType");
  const [state, formAction, isPending] = useActionState(createClassSession, INITIAL_STATE);

  return (
    <details className="rounded border p-4">
      <summary className="cursor-pointer font-medium">{t("toggle")}</summary>

      {state.ok && <p className="mt-4 text-sm text-green-700">{t("success")}</p>}

      <form action={formAction} className="mt-4 flex w-full max-w-sm flex-col gap-3">
        <input type="hidden" name="academyId" value={academyId} />

        <label className="flex flex-col gap-1">
          <span>{t("dayOfWeek")}</span>
          <select
            name="dayOfWeek"
            required
            defaultValue={DayOfWeek.MONDAY}
            className="rounded border px-3 py-2"
          >
            {DAY_OPTIONS.map((day) => (
              <option key={day} value={day}>
                {tDay(day)}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span>{t("startTime")}</span>
          <input type="time" name="startTime" required className="rounded border px-3 py-2" />
        </label>
        <label className="flex flex-col gap-1">
          <span>{t("durationMinutes")}</span>
          <input
            type="number"
            name="durationMinutes"
            required
            min={1}
            max={600}
            defaultValue={60}
            className="rounded border px-3 py-2"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span>{t("name")}</span>
          <input type="text" name="name" required className="rounded border px-3 py-2" />
        </label>
        <label className="flex flex-col gap-1">
          <span>{t("type")}</span>
          <select name="type" required defaultValue={ClassType.GI} className="rounded border px-3 py-2">
            {TYPE_OPTIONS.map((type) => (
              <option key={type} value={type}>
                {tType(type)}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span>{t("countsTowardPromotion")}</span>
          <select
            name="countsTowardPromotion"
            required
            defaultValue="true"
            className="rounded border px-3 py-2"
          >
            <option value="true">{t("yes")}</option>
            <option value="false">{t("no")}</option>
          </select>
        </label>
        {state.error && <p className="text-sm text-red-600">{t(state.error)}</p>}
        <Button type="submit" disabled={isPending}>
          {t("submit")}
        </Button>
      </form>
    </details>
  );
}
