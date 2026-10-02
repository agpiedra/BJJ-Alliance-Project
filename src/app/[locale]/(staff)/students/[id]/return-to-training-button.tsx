"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { returnToTraining } from "./actions";
import type { ActionState } from "@/lib/action-state";

const INITIAL_STATE: ActionState = {};

/**
 * Genuine-return-to-training brief (D22): a separate, explicitly labeled action, visibly distinguished from
 * `RestoreStudentButton` — never presented as a variant of it. Rendered only when `page.tsx` has resolved a
 * trustworthy (`EVENT`-sourced) archive event for this exact student (`resolveTrustworthyArchiveEvent`); its id is
 * embedded as the hidden `archiveEventId` field, re-verified fresh under the student lock before any write
 * (`genuineReturnChargeInTx`'s own doc comment). `page.tsx` renders this at all only while billing is active
 * (today, never in production) — zero new DOM for every organization until that changes.
 */
export function ReturnToTrainingButton({
  organizationId,
  studentId,
  archiveEventId,
}: {
  organizationId: string;
  studentId: string;
  archiveEventId: string;
}) {
  const t = useTranslations("students.detail.returnToTraining");
  const [state, formAction, isPending] = useActionState(returnToTraining.bind(null, organizationId), INITIAL_STATE);

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
      <input type="hidden" name="archiveEventId" value={archiveEventId} />
      {state.ok && <p className="text-sm text-green-700">{t("success")}</p>}
      {state.error && <p className="text-sm text-red-600">{t(state.error as never)}</p>}
      <Button type="submit" variant="default" disabled={isPending}>
        {t("button")}
      </Button>
    </form>
  );
}
