"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { updateClassSession } from "./actions";
import { DayOfWeek, ClassType } from "@/generated/prisma/browser";
import type { ActionState } from "@/lib/action-state";

const INITIAL_STATE: ActionState = {};
const DAY_OPTIONS = Object.values(DayOfWeek);
const TYPE_OPTIONS = Object.values(ClassType);

type EditableClassSession = {
  id: string;
  dayOfWeek: DayOfWeek;
  startTime: string;
  durationMinutes: number;
  name: string;
  type: ClassType;
  countsTowardPromotion: boolean;
};

// Rendered only for an ADMIN session (page.tsx gate) — the real enforcement
// is server-side in `updateClassSession` itself
// (requireStaffSession(["ADMIN"])), never this UI check alone.
export function EditClassSessionForm({ session }: { session: EditableClassSession }) {
  const t = useTranslations("adminSchedule.edit");
  const tField = useTranslations("adminSchedule.create");
  const tDay = useTranslations("dayOfWeek");
  const tType = useTranslations("classType");
  const [state, formAction, isPending] = useActionState(updateClassSession, INITIAL_STATE);

  return (
    <details className="rounded border p-3">
      <summary className="cursor-pointer text-sm font-medium">{t("toggle")}</summary>

      {state.ok && <p className="mt-3 text-sm text-green-700">{t("success")}</p>}

      <form action={formAction} className="mt-3 flex w-full max-w-sm flex-col gap-3">
        <input type="hidden" name="classSessionId" value={session.id} />

        <label className="flex flex-col gap-1">
          <span>{tField("dayOfWeek")}</span>
          <select
            name="dayOfWeek"
            required
            defaultValue={session.dayOfWeek}
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
          <span>{tField("startTime")}</span>
          <input
            type="time"
            name="startTime"
            required
            defaultValue={session.startTime}
            className="rounded border px-3 py-2"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span>{tField("durationMinutes")}</span>
          <input
            type="number"
            name="durationMinutes"
            required
            min={1}
            max={600}
            defaultValue={session.durationMinutes}
            className="rounded border px-3 py-2"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span>{tField("name")}</span>
          <input
            type="text"
            name="name"
            required
            defaultValue={session.name}
            className="rounded border px-3 py-2"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span>{tField("type")}</span>
          <select name="type" required defaultValue={session.type} className="rounded border px-3 py-2">
            {TYPE_OPTIONS.map((type) => (
              <option key={type} value={type}>
                {tType(type)}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span>{tField("countsTowardPromotion")}</span>
          <select
            name="countsTowardPromotion"
            required
            defaultValue={session.countsTowardPromotion ? "true" : "false"}
            className="rounded border px-3 py-2"
          >
            <option value="true">{tField("yes")}</option>
            <option value="false">{tField("no")}</option>
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
