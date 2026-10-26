"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { deleteClassSession } from "./actions";
import type { ActionState } from "@/lib/action-state";

const INITIAL_STATE: ActionState = {};

// Rendered only for an inactive class the page found unused. `deleteClassSession` re-checks the role, the tenant, that
// the class is inactive and that nothing refers to it, under a row lock - never this UI check alone.
export function DeleteClassSessionButton({
  organizationId,
  classSessionId,
}: {
  organizationId: string;
  classSessionId: string;
}) {
  const t = useTranslations("adminSchedule.delete");
  const [state, formAction, isPending] = useActionState(
    deleteClassSession.bind(null, organizationId),
    INITIAL_STATE,
  );

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
      {state.error && <p className="text-sm text-bad">{t(state.error)}</p>}
      <Button type="submit" variant="destructive" size="sm" disabled={isPending}>
        {t("button")}
      </Button>
    </form>
  );
}
