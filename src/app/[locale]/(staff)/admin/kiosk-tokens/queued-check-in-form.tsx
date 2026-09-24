"use client";

import { useActionState, useId, useState } from "react";
import { DateTime } from "luxon";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { dismissQueuedCheckInAction, resolveQueuedCheckInAction } from "./queued-check-in-actions";
import type { ActionState } from "@/lib/action-state";

const INITIAL_STATE: ActionState = {};
const FIELD_CLASS =
  "h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm text-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none";
const WEEKDAY_OF: Record<string, number> = { MONDAY: 1, TUESDAY: 2, WEDNESDAY: 3, THURSDAY: 4, FRIDAY: 5, SATURDAY: 6, SUNDAY: 7 };

export interface QueuedClassOption {
  id: string;
  name: string;
  startTime: string;
  dayOfWeek: string;
}

/**
 * One evidence row's staff actions. "Record attendance" needs a DAY and a CLASS of that day: the day starts as the day the
 * tablet CLAIMED when that could be read (staff can change it), and is empty when the claim was unreadable, so an
 * unverified date is never silently adopted - a person chooses it. The class list only offers that academy's active classes
 * scheduled on the chosen weekday (the options come from the server; the real validation is server-side in
 * `resolveQueuedCheckIn`). "Set aside" keeps the evidence with a reason.
 */
export function QueuedCheckInForm({
  organizationId,
  queuedCheckInId,
  defaultDate,
  defaultClassId,
  classes,
}: {
  organizationId: string;
  queuedCheckInId: string;
  /** `yyyy-MM-dd` in Costa Rica, or "" when the tablet's time was unreadable. */
  defaultDate: string;
  defaultClassId: string | null;
  classes: QueuedClassOption[];
}) {
  const t = useTranslations("adminKioskTokens.queued");
  const [resolveState, resolveAction, resolving] = useActionState(resolveQueuedCheckInAction.bind(null, organizationId), INITIAL_STATE);
  const [dismissState, dismissAction, dismissing] = useActionState(dismissQueuedCheckInAction.bind(null, organizationId), INITIAL_STATE);
  const [date, setDate] = useState(defaultDate);
  const dateId = useId();
  const classId = useId();
  const reasonId = useId();

  const day = DateTime.fromFormat(date, "yyyy-MM-dd");
  const options = day.isValid ? classes.filter((option) => WEEKDAY_OF[option.dayOfWeek] === day.weekday) : [];
  const preferred = options.find((option) => option.id === defaultClassId)?.id ?? options[0]?.id ?? "";

  return (
    <div className="flex min-w-[15rem] flex-col gap-3">
      <form action={resolveAction} className="flex flex-col items-start gap-2">
        <input type="hidden" name="queuedCheckInId" value={queuedCheckInId} />
        <label htmlFor={dateId} className="text-xs font-medium">
          {t("dateLabel")}
        </label>
        <input id={dateId} name="date" type="date" required value={date} onChange={(event) => setDate(event.target.value)} className={FIELD_CLASS} />
        <label htmlFor={classId} className="text-xs font-medium">
          {t("classLabel")}
        </label>
        {options.length === 0 ? (
          <p className="text-xs text-muted-foreground">{day.isValid ? t("noClassesThatDay") : t("chooseDayFirst")}</p>
        ) : (
          // Re-keyed by the day so the default follows the chosen weekday.
          <select key={`${date}-${preferred}`} id={classId} name="classSessionId" required defaultValue={preferred} className={FIELD_CLASS}>
            {options.map((option) => (
              <option key={option.id} value={option.id}>
                {option.startTime} · {option.name}
              </option>
            ))}
          </select>
        )}
        {resolveState.ok && <p className="text-xs text-ok">{t("recorded")}</p>}
        {resolveState.error && <p role="alert" className="text-xs text-bad">{t(`errors.${resolveState.error}`)}</p>}
        <Button type="submit" variant="primary" size="sm" disabled={resolving || options.length === 0}>
          {t("record")}
        </Button>
      </form>

      <details>
        <summary className="cursor-pointer text-xs font-medium">{t("dismissSummary")}</summary>
        <form action={dismissAction} className="mt-2 flex flex-col items-start gap-2">
          <input type="hidden" name="queuedCheckInId" value={queuedCheckInId} />
          <label htmlFor={reasonId} className="text-xs">
            {t("dismissReasonLabel")}
          </label>
          <input id={reasonId} name="reason" type="text" required minLength={3} maxLength={500} className={FIELD_CLASS} />
          {dismissState.ok && <p className="text-xs text-ok">{t("dismissed")}</p>}
          {dismissState.error && <p role="alert" className="text-xs text-bad">{t(`errors.${dismissState.error}`)}</p>}
          <Button type="submit" variant="outline" size="sm" disabled={dismissing}>
            {t("dismissSubmit")}
          </Button>
        </form>
      </details>
    </div>
  );
}
