"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { approveStudent } from "./actions";
import type { ActionState } from "@/lib/action-state";

const INITIAL_STATE: ActionState = {};

// Rendered only for an ADMIN/DIRECTOR session looking at a PENDING student
// (page.tsx gate) — the real enforcement is server-side in `approveStudent`
// itself (requireStaffSession(["ADMIN", "DIRECTOR"]) + isAcademyInScope
// re-checked against a fresh read + a PENDING precondition asserted in the
// UPDATE's own WHERE clause), never this UI check alone.
export function ApproveStudentButton({ studentId }: { studentId: string }) {
  const t = useTranslations("students.detail.approve");
  const [state, formAction, isPending] = useActionState(approveStudent, INITIAL_STATE);

  return (
    <form action={formAction} className="flex flex-col items-start gap-2">
      <input type="hidden" name="studentId" value={studentId} />
      {state.ok && <p className="text-sm text-green-700">{t("success")}</p>}
      {state.error && <p className="text-sm text-red-600">{t(state.error)}</p>}
      <Button type="submit" disabled={isPending}>
        {t("button")}
      </Button>
    </form>
  );
}
