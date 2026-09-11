"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { regenerateStudentCode, type RegenerateCodeState } from "./actions";

const INITIAL_STATE: RegenerateCodeState = {};

// Available to any staff role (spec §4.1) — no page.tsx gate, unlike edit/
// archive. Server-side `regenerateStudentCode` is the real (non-)gate too.
export function RegenerateCodeButton({ studentId }: { studentId: string }) {
  const t = useTranslations("students.detail.regenerateCode");
  const [state, formAction, isPending] = useActionState(regenerateStudentCode, INITIAL_STATE);

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
      {state.ok && state.code && (
        <div className="flex flex-col gap-2 rounded border border-green-600 bg-green-50 p-3">
          <p>{t("successCodeWarning")}</p>
          <p className="text-3xl font-mono font-bold tracking-widest">{state.code}</p>
        </div>
      )}
      {state.error && <p className="text-sm text-red-600">{t(state.error)}</p>}
      <Button type="submit" variant="outline" disabled={isPending}>
        {t("button")}
      </Button>
    </form>
  );
}
