"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import type { ActionState } from "@/lib/action-state";
import type { RecentAttendanceEntry } from "@/lib/students/recent-attendance-entries";
import { voidAttendanceEntry } from "./attendance-void-actions";

const INITIAL_STATE: ActionState = {};

/**
 * The staff correction view of the latest attendance entries. ADMIN/DIRECTOR get a "Void" control per valid
 * entry (the server action is the real enforcement); everyone else only sees the list. Voiding keeps the
 * entry, recomputes the day and never changes a promotion - the copy says so.
 */
export function AttendanceEntriesCard({
  organizationId,
  entries,
  canVoid,
}: {
  organizationId: string;
  entries: RecentAttendanceEntry[];
  canVoid: boolean;
}) {
  const t = useTranslations("students.detail.attendanceEntries");

  if (entries.length === 0) return <p className="text-muted-foreground">{t("empty")}</p>;

  return (
    <div className="flex flex-col gap-3">
      {canVoid && <p className="text-sm text-muted-foreground">{t("voidExplainer")}</p>}
      <ul className="flex flex-col gap-2">
        {entries.map((entry) => (
          <li key={entry.id} className="rounded border p-3 text-sm">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <span className={entry.voidedAt ? "font-medium line-through" : "font-medium"}>{entry.day}</span>
              <span className={entry.voidedAt ? "text-muted-foreground line-through" : "text-muted-foreground"}>
                {entry.className ?? entry.reason ?? t(`type.${entry.type}`)} · {t(`source.${entry.source}`)}
              </span>
              {entry.voidedAt && <span className="font-medium text-destructive">{t("voided")}</span>}
            </div>
            {entry.voidedAt && entry.voidReason && (
              <p className="mt-1 text-muted-foreground">{t("voidedReason", { reason: entry.voidReason })}</p>
            )}
            {canVoid && !entry.voidedAt && <VoidControl organizationId={organizationId} recordId={entry.id} />}
          </li>
        ))}
      </ul>
    </div>
  );
}

function VoidControl({ organizationId, recordId }: { organizationId: string; recordId: string }) {
  const t = useTranslations("students.detail.attendanceEntries");
  const [state, formAction, isPending] = useActionState(voidAttendanceEntry.bind(null, organizationId), INITIAL_STATE);
  const reasonErrors = state.fieldErrors?.reason;

  return (
    <details className="mt-2">
      <summary className="cursor-pointer text-sm font-medium">{t("void")}</summary>
      <form action={formAction} className="mt-2 flex max-w-sm flex-col gap-2">
        <input type="hidden" name="recordId" value={recordId} />
        <label className="flex flex-col gap-1">
          <span>{t("reason")}</span>
          <textarea name="reason" required maxLength={500} className="rounded border px-3 py-2" />
        </label>
        {reasonErrors && reasonErrors.length > 0 && <p className="text-sm text-red-600">{t("reasonRequired")}</p>}
        {state.error && !reasonErrors && <p className="text-sm text-red-600">{t(`error.${state.error}`)}</p>}
        {state.ok && <p className="text-sm text-green-700">{t("success")}</p>}
        <Button type="submit" disabled={isPending}>
          {t("submit")}
        </Button>
      </form>
    </details>
  );
}
