"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { confirmPromotion } from "./promotion-actions";
import type { ActionState } from "@/lib/action-state";

const INITIAL_STATE: ActionState = {};

// confirmPromotion (./promotion-actions.ts) returns one of FOUR distinct
// error codes on top of `{ok:true}` (plus a Zod `"invalid"` that's only
// reachable if the hidden studentId field is ever missing/malformed, which
// this form never does):
//   - "notFound": the student is out of this session's scope, or vanished.
//   - "notActive": the student is PENDING or ARCHIVED (not ACTIVE) at write
//     time — either the queue somehow surfaced a non-ACTIVE student, or
//     (the race this guards against) another staff member archived this
//     exact student between this list loading and this click.
//   - "notEligible": the fresh eligibility recheck at write time found the
//     student no longer eligible — the race guard this whole action exists
//     to enforce (see the action's own doc comment). Most commonly hit when
//     the queue row shown here is already stale by the time staff click.
//   - "conflict": a concurrent confirm for the SAME student won the race
//     first (the action's finding I-2 guard), OR the student's status
//     changed strictly between the action's own upfront read and its write
//     (finding N-1's second half) — either way, this click wrote nothing.
// Each gets its own message; a "generic" fallback covers anything else so an
// unrecognized code never renders silently blank.
const KNOWN_ERRORS = ["notFound", "notActive", "notEligible", "conflict"] as const;

function errorMessageKey(error: string): string {
  return (KNOWN_ERRORS as readonly string[]).includes(error) ? `error.${error}` : "error.generic";
}

// Rendered only for ADMIN/DIRECTOR sessions (page.tsx gate, mirroring
// ArchiveStudentButton's convention from the student detail page) — the real
// enforcement is server-side in confirmPromotion itself
// (requireStaffSession(["ADMIN","DIRECTOR"]) + a fresh eligibility recheck),
// never this UI check alone.
//
// A plain window.confirm is used for consistency with this codebase's other
// destructive-ish action buttons (archive, regenerate-code) — a promotion
// isn't actually destructive and has full audit history (spec doesn't
// require a confirm dialog here), but the extra guard against a stray click
// costs nothing and keeps every dashboard action button behaving the same
// way.
export function ConfirmPromotionButton({ studentId }: { studentId: string }) {
  const t = useTranslations("dashboard.promotionQueue");
  const [state, formAction, isPending] = useActionState(confirmPromotion, INITIAL_STATE);

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
      {state.error && <p className="text-sm text-red-600">{t(errorMessageKey(state.error))}</p>}
      <Button type="submit" size="sm" disabled={isPending}>
        {t("confirmButton")}
      </Button>
    </form>
  );
}
