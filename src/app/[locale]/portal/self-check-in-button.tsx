"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { selfCheckIn, type SelfCheckInState } from "./self-check-in-action";

const INITIAL_STATE: SelfCheckInState = {};

// The three real error codes performCheckIn's studentId path can return
// (see its doc comment on the shared core): `no_active_class` and
// `already_checked_in` are the two a student can genuinely hit here.
// `invalid_code` is realistically unreachable via this path (it would mean
// requireStudentSession resolved a session whose linked Student row is
// gone or non-ACTIVE — see self-check-in-action.ts) but still gets a
// message rather than falling through silently.
const KNOWN_ERRORS = ["no_active_class", "already_checked_in", "invalid_code"] as const;

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
  const [state, formAction, isPending] = useActionState(selfCheckIn, INITIAL_STATE);

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
