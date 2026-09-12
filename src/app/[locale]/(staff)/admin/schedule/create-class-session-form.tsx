"use client";

import { useActionState, useId } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { createClassSession } from "./actions";
import { DayOfWeek, ClassType } from "@/generated/prisma/browser";
import type { ActionState } from "@/lib/action-state";

const INITIAL_STATE: ActionState = {};
const DAY_OPTIONS = Object.values(DayOfWeek);
const TYPE_OPTIONS = Object.values(ClassType);
const FIELD_CLASS =
  "h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm text-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none";

// Rendered only for an ADMIN session (page.tsx gate) — the real enforcement
// is server-side in `createClassSession` itself
// (requireStaffSession(["ADMIN"])), never this UI check alone.
//
// No collapsible wrapper of its own (unlike the old flat-list page) — this
// now always lives inside the "Nueva clase" Sheet in the schedule header,
// which is already the open/close affordance.
export function CreateClassSessionForm({ academyId }: { academyId: string }) {
  const t = useTranslations("adminSchedule.create");
  const tDay = useTranslations("dayOfWeek");
  const tType = useTranslations("classType");
  const [state, formAction, isPending] = useActionState(createClassSession, INITIAL_STATE);
  const idPrefix = useId();

  return (
    <>
      {state.ok && <p className="text-sm text-ok">{t("success")}</p>}

      <form action={formAction} className="flex w-full flex-col gap-3">
        <input type="hidden" name="academyId" value={academyId} />

        <label htmlFor={`${idPrefix}-day`} className="flex flex-col gap-1 text-sm">
          <span>{t("dayOfWeek")}</span>
          <select id={`${idPrefix}-day`} name="dayOfWeek" required defaultValue={DayOfWeek.MONDAY} className={FIELD_CLASS}>
            {DAY_OPTIONS.map((day) => (
              <option key={day} value={day}>
                {tDay(day)}
              </option>
            ))}
          </select>
        </label>
        <label htmlFor={`${idPrefix}-start`} className="flex flex-col gap-1 text-sm">
          <span>{t("startTime")}</span>
          <input id={`${idPrefix}-start`} type="time" name="startTime" required className={FIELD_CLASS} />
        </label>
        <label htmlFor={`${idPrefix}-duration`} className="flex flex-col gap-1 text-sm">
          <span>{t("durationMinutes")}</span>
          <input
            id={`${idPrefix}-duration`}
            type="number"
            name="durationMinutes"
            required
            min={1}
            max={600}
            defaultValue={60}
            className={FIELD_CLASS}
          />
        </label>
        <label htmlFor={`${idPrefix}-name`} className="flex flex-col gap-1 text-sm">
          <span>{t("name")}</span>
          <input id={`${idPrefix}-name`} type="text" name="name" required className={FIELD_CLASS} />
        </label>
        <label htmlFor={`${idPrefix}-type`} className="flex flex-col gap-1 text-sm">
          <span>{t("type")}</span>
          <select id={`${idPrefix}-type`} name="type" required defaultValue={ClassType.GI} className={FIELD_CLASS}>
            {TYPE_OPTIONS.map((type) => (
              <option key={type} value={type}>
                {tType(type)}
              </option>
            ))}
          </select>
        </label>
        <label htmlFor={`${idPrefix}-counts`} className="flex flex-col gap-1 text-sm">
          <span>{t("countsTowardPromotion")}</span>
          <select id={`${idPrefix}-counts`} name="countsTowardPromotion" required defaultValue="true" className={FIELD_CLASS}>
            <option value="true">{t("yes")}</option>
            <option value="false">{t("no")}</option>
          </select>
        </label>
        {state.error && <p className="text-sm text-bad">{t(state.error)}</p>}
        <Button type="submit" variant="primary" disabled={isPending}>
          {t("submit")}
        </Button>
      </form>
    </>
  );
}
