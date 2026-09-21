"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { restoreStudent } from "./actions";
import type { ActionState } from "@/lib/action-state";

const INITIAL_STATE: ActionState = {};

// Rendered only for an ARCHIVED student, to ADMIN/DIRECTOR sessions (page.tsx
// gate) — the real enforcement is server-side in `restoreStudent` itself
// (resolveActionContext + a fresh scope check + the ARCHIVED precondition),
// never this UI check alone.
export function RestoreStudentButton({ organizationId, studentId }: { organizationId: string; studentId: string }) {
  const t = useTranslations("students.detail.restore");
  const [state, formAction, isPending] = useActionState(restoreStudent.bind(null, organizationId), INITIAL_STATE);

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
      {state.error && <p className="text-sm text-red-600">{t(state.error as never)}</p>}
      <Button type="submit" variant="outline" disabled={isPending}>
        {t("button")}
      </Button>
    </form>
  );
}
