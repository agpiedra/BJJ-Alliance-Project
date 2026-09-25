"use client";

import { useActionState, useId } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { FIELD_CLASS } from "@/components/ui/input";
import { reassignAttendanceRecord } from "./reassign-attendance-action";
import type { ActionState } from "@/lib/action-state";

const INITIAL_STATE: ActionState = {};

/**
 * One row's `Cambiar` action: a collapsed <details> holding a select of that
 * academy's active classes for the SAME weekday as the record's ledger day
 * (the options are computed server-side in page.tsx — this component never
 * decides what is reassignable). Same small-mutation-form shape as
 * `admin/schedule/edit-class-session-form.tsx`.
 *
 * Rendered for every staff role that reaches this page; the real enforcement
 * is server-side in `reassignAttendanceRecord`, never this UI.
 */
export function ChangeAttendanceClassForm({
  organizationId,
  attendanceRecordId,
  options,
}: {
  organizationId: string;
  attendanceRecordId: string;
  options: Array<{ id: string; name: string; startTime: string }>;
}) {
  const t = useTranslations("adminKioskTokens.checkIns");
  const [state, formAction, isPending] = useActionState(
    reassignAttendanceRecord.bind(null, organizationId),
    INITIAL_STATE,
  );
  const selectId = useId();

  // Nothing to move it to (a day whose classes were all deactivated since):
  // say so rather than rendering an empty select that can only fail.
  if (options.length === 0) {
    return <span className="text-muted-foreground">{t("noReassignOptions")}</span>;
  }

  return (
    <details className="min-w-[10rem]">
      <summary className="cursor-pointer text-xs font-medium">{t("change")}</summary>
      <form action={formAction} className="mt-2 flex flex-col items-start gap-2">
        <input type="hidden" name="attendanceRecordId" value={attendanceRecordId} />
        <label htmlFor={selectId} className="sr-only">
          {t("changeLabel")}
        </label>
        <select id={selectId} name="classSessionId" required className={FIELD_CLASS}>
          {options.map((option) => (
            <option key={option.id} value={option.id}>
              {option.startTime} · {option.name}
            </option>
          ))}
        </select>
        {state.ok && <p className="text-xs text-ok">{t("changeSuccess")}</p>}
        {state.error && <p className="text-xs text-bad">{t(state.error)}</p>}
        <Button type="submit" variant="primary" size="sm" disabled={isPending}>
          {t("changeSubmit")}
        </Button>
      </form>
    </details>
  );
}
