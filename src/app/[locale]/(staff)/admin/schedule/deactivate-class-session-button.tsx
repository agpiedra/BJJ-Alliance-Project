"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { deactivateClassSession } from "./actions";
import type { ActionState } from "@/lib/action-state";

const INITIAL_STATE: ActionState = {};

// Rendered only for an ADMIN session (page.tsx gate) — the real enforcement
// is server-side in `deactivateClassSession` itself
// (requireStaffSession(["ADMIN"])), never this UI check alone.
export function DeactivateClassSessionButton({ classSessionId }: { classSessionId: string }) {
  const t = useTranslations("adminSchedule.deactivate");
  const [state, formAction, isPending] = useActionState(deactivateClassSession, INITIAL_STATE);

  return (
    <form
      action={formAction}
      onSubmit={(event) => {
        if (!window.confirm(t("confirm"))) {
          event.preventDefault();
        }
      }}
      className="flex flex-col items-start gap-1"
    >
      <input type="hidden" name="classSessionId" value={classSessionId} />
      {state.ok && <p className="text-sm text-green-700">{t("success")}</p>}
      {state.error && <p className="text-sm text-red-600">{t(state.error)}</p>}
      <Button type="submit" variant="destructive" size="sm" disabled={isPending}>
        {t("button")}
      </Button>
    </form>
  );
}
