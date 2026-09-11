"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { addAttendanceAdjustment } from "./adjustment-actions";
import type { ActionState } from "@/lib/action-state";

const INITIAL_STATE: ActionState = {};

// Visible to ANY staff role (spec §3 grants attendance marking/correction to
// INSTRUCTOR too, unlike edit/archive) — no page.tsx role gate, matching
// `RegenerateCodeButton`. The server-side `addAttendanceAdjustment`
// (requireStaffSession(["ADMIN", "DIRECTOR", "INSTRUCTOR"]) + a fresh
// isAcademyInScope check) is the real enforcement.
export function AddAdjustmentForm({ studentId }: { studentId: string }) {
  const t = useTranslations("students.detail.adjustment");
  const [state, formAction, isPending] = useActionState(addAttendanceAdjustment, INITIAL_STATE);
  const reasonErrors = state.fieldErrors?.reason;
  const deltaErrors = state.fieldErrors?.delta;

  return (
    <details className="rounded border p-4">
      <summary className="cursor-pointer font-medium">{t("toggle")}</summary>

      {state.ok && <p className="mt-4 text-sm text-green-700">{t("success")}</p>}

      <form action={formAction} className="mt-4 flex w-full max-w-sm flex-col gap-3">
        <input type="hidden" name="studentId" value={studentId} />

        <label className="flex flex-col gap-1">
          <span>{t("delta")}</span>
          <input
            type="number"
            name="delta"
            step="1"
            required
            className="rounded border px-3 py-2"
          />
          <span className="text-sm text-muted-foreground">{t("deltaHint")}</span>
        </label>
        {deltaErrors && deltaErrors.length > 0 && (
          <p className="text-sm text-red-600">{t("deltaInvalid")}</p>
        )}

        <label className="flex flex-col gap-1">
          <span>{t("reason")}</span>
          <textarea name="reason" required className="rounded border px-3 py-2" />
        </label>
        {reasonErrors && reasonErrors.length > 0 && (
          <p className="text-sm text-red-600">{t("reasonRequired")}</p>
        )}

        {state.error && <p className="text-sm text-red-600">{t(state.error)}</p>}
        <Button type="submit" disabled={isPending}>
          {t("submit")}
        </Button>
      </form>
    </details>
  );
}
