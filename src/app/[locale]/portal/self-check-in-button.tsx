"use client";

import { useActionState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { selfCheckIn, type SelfCheckInState } from "./self-check-in-action";

const INITIAL_STATE: SelfCheckInState = {};

// The real error codes this button can see. `no_active_class` and
// `already_checked_in` come from performCheckIn's studentId path (see its
// doc comment on the shared core). `notActive` is checked upfront in
// self-check-in-action.ts, before performCheckIn is ever called, for a
// PENDING/ARCHIVED/INACTIVE student — deliberately distinct from
// performCheckIn's own generic `invalid_code`, since the portal (unlike an
// anonymous kiosk) already shows this student their real account status.
// `invalid_code` itself is realistically unreachable via this path now (it
// would mean requireStudentSession resolved a session whose linked Student
// row is somehow gone — see self-check-in-action.ts) but still gets a
// message rather than falling through silently.
const KNOWN_ERRORS = ["no_active_class", "already_checked_in", "invalid_code", "notActive"] as const;

function errorMessageKey(error: string): string {
  return (KNOWN_ERRORS as readonly string[]).includes(error) ? `error.${error}` : "error.generic";
}

// Matches the kiosk's own SuccessView conventions (heading swap on
// earnedStripe, remainingToNextStripe / examEligible copy) so a student sees
// the same shape of feedback whether they tapped a kiosk or checked in from
// their phone — just without the kiosk's belt graphic, which the page
// already renders once above this card. Unlike the kiosk, this component has
// no visitor badge: selfCheckIn always calls performCheckIn with the
// student's OWN homeAcademyId as the academyId, so performCheckIn's
// isVisitor (homeAcademyId !== input.academyId) can never be true on this
// path — there is no cross-academy self-check-in to indicate.
export function SelfCheckInButton() {
  const t = useTranslations("portal.selfCheckIn");
  const router = useRouter();
  const [state, formAction, isPending] = useActionState(selfCheckIn, INITIAL_STATE);

  // The action's own revalidatePath(`/${locale}/portal`) is the load-bearing
  // half of this refresh: calling it during the Server Action is what makes
  // THAT action's response carry a freshly-rendered payload for this page —
  // including the sibling progress card (fed by getAtBeltSummary at
  // page-load time) — for the current view, not just some future
  // navigation. router.refresh() below is redundant on that happy path (the
  // fresh data is already arriving via the action's own response); it's kept
  // only as a defensive fallback in case revalidatePath ever fails silently
  // (its call in self-check-in-action.ts is wrapped in a try/catch that logs
  // but doesn't throw), not as the primitive that "unlocks" the other one.
  useEffect(() => {
    if (state.ok) {
      router.refresh();
    }
    // Only re-run when a NEW state comes back from the action (a fresh
    // submission), never on `router` identity changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{state.ok && state.earnedStripe ? t("earnedStripeHeading") : t("heading")}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {state.ok && state.student && state.summary && (
          <div className="flex flex-col gap-2 text-sm">
            <p className="font-medium text-foreground">{t("successMessage")}</p>

            <p className="text-muted-foreground">
              {t("atBeltCount", { count: state.summary.atBeltCount })}
            </p>

            {state.summary.remainingToNextStripe !== null && (
              <p className="text-muted-foreground">
                {t("remainingToNextStripe", { count: state.summary.remainingToNextStripe })}
              </p>
            )}

            {state.summary.remainingToNextStripe === null && state.summary.examEligible && (
              <p className="font-medium">{t("examEligible")}</p>
            )}
          </div>
        )}

        {state.error && <p className="text-sm text-destructive">{t(errorMessageKey(state.error))}</p>}

        <form action={formAction}>
          <Button type="submit" disabled={isPending} className="w-full">
            {isPending ? t("submitting") : t("button")}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
