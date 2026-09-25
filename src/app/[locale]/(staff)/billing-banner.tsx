import { getTranslations } from "next-intl/server";
import { cn } from "cn";

/**
 * MULTI_ACADEMY_AND_KIDS_BELTS.md Phase 6 billing — "non-blocking banner...
 * names the due date and the deadline, fully localized, and never exposes
 * graceDays as a number the director can act on." Never renders anything
 * that blocks interaction (no modal, no overlay, nothing disabled) — a
 * plain bar, same as every other non-blocking notice in this app. The
 * props here are exactly `DirectorBillingBanner`'s own three fields
 * (billing/banner.ts) — this component structurally cannot render a grace
 * number it was never given.
 */
export async function BillingBanner({
  state,
  dueOn,
  deadline,
}: {
  state: "DUE" | "GRACE_EXPIRED";
  dueOn: string;
  deadline: string;
}) {
  const t = await getTranslations("billing.banner");

  return (
    <div
      className={cn(
        "px-4 py-2 text-sm",
        state === "GRACE_EXPIRED" ? "bg-bad-soft text-destructive" : "bg-warn-soft text-warn",
      )}
    >
      {t(state === "GRACE_EXPIRED" ? "graceExpired" : "due", { dueOn, deadline })}
    </div>
  );
}
