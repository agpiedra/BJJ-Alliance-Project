"use client";

import { useActionState, useId } from "react";
import { useTranslations } from "next-intl";
import { cn } from "cn";
import { Button } from "@/components/ui/button";
import { updateClassSession } from "./actions";
import { DayOfWeek, ClassType } from "@/generated/prisma/browser";
import type { ActionState } from "@/lib/action-state";

const INITIAL_STATE: ActionState = {};
const DAY_OPTIONS = Object.values(DayOfWeek);
const TYPE_OPTIONS = Object.values(ClassType);
const FIELD_CLASS =
  "h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm text-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none";

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
//
// `renderAsDetails` (default true) keeps the Lista table's original
// collapsed-per-row behavior; the week-calendar detail Sheet
// (schedule-calendar-view.tsx) renders the same form directly (`false`) since
// the Sheet itself is already the "opened" affordance — one component, two
// call sites, per REDESIGN_BRIEF.md Phase 5's own suggestion.
export function EditClassSessionForm({
  organizationId,
  session,
  renderAsDetails = true,
}: {
  organizationId: string;
  session: EditableClassSession;
  renderAsDetails?: boolean;
}) {
  const t = useTranslations("adminSchedule.edit");
  const tField = useTranslations("adminSchedule.create");
  const tDay = useTranslations("dayOfWeek");
  const tType = useTranslations("classType");
  const [state, formAction, isPending] = useActionState(
    updateClassSession.bind(null, organizationId),
    INITIAL_STATE,
  );
  const idPrefix = useId();

  const form = (
    <>
      {state.ok && <p className={cn(renderAsDetails ? "mt-3" : "mt-0", "text-sm text-ok")}>{t("success")}</p>}

      <form action={formAction} className="mt-3 flex w-full max-w-sm flex-col gap-3">
        <input type="hidden" name="classSessionId" value={session.id} />

        <label htmlFor={`${idPrefix}-day`} className="flex flex-col gap-1 text-sm">
          <span>{tField("dayOfWeek")}</span>
          <select
            id={`${idPrefix}-day`}
            name="dayOfWeek"
            required
            defaultValue={session.dayOfWeek}
            className={FIELD_CLASS}
          >
            {DAY_OPTIONS.map((day) => (
              <option key={day} value={day}>
                {tDay(day)}
              </option>
            ))}
          </select>
        </label>
        <label htmlFor={`${idPrefix}-start`} className="flex flex-col gap-1 text-sm">
          <span>{tField("startTime")}</span>
          <input
            id={`${idPrefix}-start`}
            type="time"
            name="startTime"
            required
            defaultValue={session.startTime}
            className={FIELD_CLASS}
          />
        </label>
        <label htmlFor={`${idPrefix}-duration`} className="flex flex-col gap-1 text-sm">
          <span>{tField("durationMinutes")}</span>
          <input
            id={`${idPrefix}-duration`}
            type="number"
            name="durationMinutes"
            required
            min={1}
            max={600}
            defaultValue={session.durationMinutes}
            className={FIELD_CLASS}
          />
        </label>
        <label htmlFor={`${idPrefix}-name`} className="flex flex-col gap-1 text-sm">
          <span>{tField("name")}</span>
          <input
            id={`${idPrefix}-name`}
            type="text"
            name="name"
            required
            defaultValue={session.name}
            className={FIELD_CLASS}
          />
        </label>
        <label htmlFor={`${idPrefix}-type`} className="flex flex-col gap-1 text-sm">
          <span>{tField("type")}</span>
          <select id={`${idPrefix}-type`} name="type" required defaultValue={session.type} className={FIELD_CLASS}>
            {TYPE_OPTIONS.map((type) => (
              <option key={type} value={type}>
                {tType(type)}
              </option>
            ))}
          </select>
        </label>
        <label htmlFor={`${idPrefix}-counts`} className="flex flex-col gap-1 text-sm">
          <span>{tField("countsTowardPromotion")}</span>
          <select
            id={`${idPrefix}-counts`}
            name="countsTowardPromotion"
            required
            defaultValue={session.countsTowardPromotion ? "true" : "false"}
            className={FIELD_CLASS}
          >
            <option value="true">{tField("yes")}</option>
            <option value="false">{tField("no")}</option>
          </select>
        </label>
        {state.error && <p className="text-sm text-bad">{t(state.error)}</p>}
        <Button type="submit" variant="primary" size="sm" disabled={isPending}>
          {t("submit")}
        </Button>
      </form>
    </>
  );

  if (!renderAsDetails) {
    return form;
  }

  return (
    <details className="rounded-lg border border-border p-3">
      <summary className="cursor-pointer text-sm font-medium">{t("toggle")}</summary>
      {form}
    </details>
  );
}
