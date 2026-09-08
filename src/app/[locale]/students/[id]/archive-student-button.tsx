"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { archiveStudent } from "./actions";
import type { ActionState } from "@/lib/action-state";

const INITIAL_STATE: ActionState = {};

// Rendered only for ADMIN/DIRECTOR sessions (page.tsx gate) — the real
// enforcement is server-side in `archiveStudent` itself
// (requireStaffSession + isAcademyInScope re-checked against a fresh read),
// never this UI check alone.
export function ArchiveStudentButton({ studentId, disabled }: { studentId: string; disabled?: boolean }) {
  const t = useTranslations("students.detail.archive");
  const [state, formAction, isPending] = useActionState(archiveStudent, INITIAL_STATE);

  return (
    <form
      action={formAction}
      onSubmit={(event) => {
        if (!window.confirm(t("confirm"))) {
          event.preventDefault();
        }
      }}
      className="flex flex-col items-start gap-2"
    >
      <input type="hidden" name="studentId" value={studentId} />
      {state.ok && <p className="text-sm text-green-700">{t("success")}</p>}
      {state.error && <p className="text-sm text-red-600">{t(state.error)}</p>}
      <Button type="submit" variant="destructive" disabled={isPending || disabled}>
        {t("button")}
      </Button>
    </form>
  );
}
