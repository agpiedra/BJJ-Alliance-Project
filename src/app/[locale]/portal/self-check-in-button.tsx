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
// earnedStripe, visitor badge, remainingToNextStripe / examEligible copy)
// so a student sees the same shape of feedback whether they tapped a kiosk
// or checked in from their phone — just without the kiosk's belt graphic,
// which the page already renders once above this card.
export function SelfCheckInButton() {
  const t = useTranslations("portal.selfCheckIn");
  const router = useRouter();
  const [state, formAction, isPending] = useActionState(selfCheckIn, INITIAL_STATE);

  // The action's own revalidatePath(`/${locale}/portal`) invalidates the
  // page's cached render, but this component is already mounted on the
  // CURRENT render of that page — its sibling progress card (fed by
  // getAtBeltSummary at page-load time) won't pick up fresh data without an
  // explicit re-render of the Server Component tree. router.refresh() does
  // exactly that, without a full page reload or disturbing this button's own
  // just-set success state.
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

            {state.isVisitor && state.homeAcademyName && (
              <span className="w-fit rounded-full bg-secondary px-3 py-1 text-secondary-foreground">
                {t("visitorBadge", { academy: state.homeAcademyName })}
              </span>
            )}

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
