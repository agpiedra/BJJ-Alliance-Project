"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Pill } from "@/components/ui/pill";
import { buildProgressView } from "@/lib/promotion/progress-view";
import type { TodaysClass } from "@/lib/portal/todays-classes";
import { selfCheckIn, type SelfCheckInState } from "./self-check-in-action";

const INITIAL_STATE: SelfCheckInState = {};

// The real error codes this card can see. `class_not_open` / `invalid_class` come from the shared core's OPEN_ONLY
// policy (the list on screen is a convenience, the server is the boundary); `already_checked_in` is the duplicate
// refusal; `notActive` is checked upfront in self-check-in-action.ts for a PENDING/ARCHIVED/INACTIVE student
// (the portal, unlike an anonymous kiosk, already shows the student their real status); `invalid_code` is
// realistically unreachable here but still gets a message rather than falling through silently.
const KNOWN_ERRORS = ["class_not_open", "invalid_class", "already_checked_in", "notActive", "invalid_code"] as const;

function errorMessageKey(error: string): string {
  return (KNOWN_ERRORS as readonly string[]).includes(error) ? `error.${error}` : "error.generic";
}

/** A small allowance past the boundary so the refresh always lands on the far side of it. */
const BOUNDARY_MARGIN_MS = 250;

/**
 * Re-reads the server data at the instant the class list next changes, so a page left open moves from "opens at"
 * to an enabled check-in and from open to closed - and rolls over at Costa Rica midnight - without a manual reload.
 *
 * - `nextChangeAt` and `serverNow` come from the server (`listTodaysClasses`). The wait is measured against the
 *   SERVER's clock: the browser's offset from `serverNow` is taken once at render, so a browser clock that is fast
 *   or slow cannot make the refresh early or late (the offset lags the true one by the network latency, i.e. the
 *   refresh errs a little late, never early).
 * - It fires once per set of server data, at the boundary, and again as soon as the tab becomes visible or the
 *   window regains focus if the boundary passed while it was hidden, throttled or asleep (browsers delay timers).
 * - A refresh delivers new props (a new boundary), which restarts this effect. If the server ever returned the same
 *   boundary again nothing loops: the effect only re-runs when the props change.
 * - This only RE-READS server state. The buttons still come from the server's list and every check-in is
 *   re-validated by the server; a stale or mistimed refresh can never make a check-in succeed.
 */
function useRefreshAtBoundary(nextChangeAt: string, serverNow: string, refresh: () => void) {
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  useEffect(() => {
    const target = new Date(nextChangeAt).getTime();
    const offset = new Date(serverNow).getTime() - Date.now(); // server clock minus browser clock, measured now
    if (Number.isNaN(target) || Number.isNaN(offset)) return;
    const serverTime = () => Date.now() + offset;

    let timer: ReturnType<typeof setTimeout> | undefined;
    let fired = false;
    const fire = () => {
      if (fired) return;
      fired = true;
      clearTimeout(timer);
      refreshRef.current();
    };
    const schedule = () => {
      timer = setTimeout(() => (serverTime() >= target ? fire() : schedule()), Math.max(0, target - serverTime() + BOUNDARY_MARGIN_MS));
    };
    const onWake = () => {
      if (document.visibilityState === "visible" && serverTime() >= target) fire();
    };

    schedule();
    document.addEventListener("visibilitychange", onWake);
    window.addEventListener("focus", onWake);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onWake);
      window.removeEventListener("focus", onWake);
    };
  }, [nextChangeAt, serverNow]);
}

/**
 * Today's classes for the student's own academy, each with its honest state (open, already checked in, opens at
 * HH:mm, closed) and a check-in button only where the server would accept it. The student checks in to an
 * EXPLICIT class: the button posts that class's id, and the server re-validates it (academy, active, window), so
 * this list is never the eligibility boundary.
 *
 * After a successful check-in the page's server data is refreshed in place (the action revalidates /portal and
 * `router.refresh()` is the defensive fallback): the row turns into "checked in", and the progress card and the
 * attendance history update without a full browser reload. The card also refreshes itself when time moves the list
 * (see `useRefreshAtBoundary`), so a tab left open never shows a class as "opens at" once it is open, or as open
 * once it has closed.
 */
export function TodaysClassesCard({
  organizationId,
  classes,
  nextChangeAt,
  serverNow,
}: {
  organizationId: string;
  classes: TodaysClass[];
  /** The next instant this list can change (ISO), from the server; the card refreshes itself then. */
  nextChangeAt: string;
  /** The server's clock (ISO) that produced `classes`. */
  serverNow: string;
}) {
  const t = useTranslations("portal.selfCheckIn");
  const tClassType = useTranslations("classType");
  const router = useRouter();
  const [state, formAction, isPending] = useActionState(selfCheckIn.bind(null, organizationId), INITIAL_STATE);
  const [submittedId, setSubmittedId] = useState<string | null>(null);

  // A success changes the row, the progress and the history; a REFUSAL (class_not_open, already_checked_in, ...) means
  // the screen was stale, so it re-reads the truth from the server too. The server is authoritative either way.
  useEffect(() => {
    if (state.ok || state.error) {
      router.refresh();
    }
    // Only re-run when a NEW state comes back from the action (a fresh submission), never on `router` identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  useRefreshAtBoundary(nextChangeAt, serverNow, router.refresh);

  const errorText = state.error ? t(errorMessageKey(state.error)) : null;
  const errorBelongsToARow = state.error !== undefined && submittedId !== null && classes.some((c) => c.id === submittedId);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{state.ok && state.thresholdReached ? t("thresholdReachedHeading") : t("heading")}</CardTitle>
        <CardDescription>{t("description")}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {state.ok && state.student && state.summary && (
          <SelfCheckInResult summary={state.summary} progressOutcome={state.progressOutcome} t={t} />
        )}

        {errorText && !errorBelongsToARow && (
          <p role="alert" className="text-sm text-destructive">
            {errorText}
          </p>
        )}

        {classes.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("noClasses")}</p>
        ) : (
          <ul aria-label={t("classesLabel")} className="flex flex-col divide-y divide-border">
            {classes.map((cls) => (
              // COMPACT ROW: name on the first line; time, class type and (for an open class) the "Open now" pill share the second, and
              // the action or state sits on the right, so a class takes about 70px instead of stacking name / time / type / pill / button
              // (about 190px per open class on a phone) and the progress card below is reachable without scrolling past every class.
              // Touch targets stay comfortable: the Check in button is 44px on any touch device (48px via pointer-coarse:min-h-12).
              <li key={cls.id} data-testid="class-row" className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 py-3 first:pt-0 last:pb-0">
                <div className="flex min-w-0 flex-col gap-1">
                  <span className="font-medium">{cls.name}</span>
                  <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
                    <span className="tabular-nums">
                      {cls.startTime} – {cls.endTime}
                    </span>
                    <Badge variant="outline">{tClassType(cls.type)}</Badge>
                    {cls.state.kind === "open" && <Pill variant="ok">{t("stateOpen")}</Pill>}
                    {!cls.countsTowardPromotion && <span className="text-xs">{t("notCounted")}</span>}
                  </span>
                </div>

                <div className="shrink-0 text-right text-sm">
                  {cls.state.kind === "open" && (
                    <form
                      action={(formData) => {
                        setSubmittedId(cls.id);
                        formAction(formData);
                      }}
                    >
                      <input type="hidden" name="classSessionId" value={cls.id} />
                      <Button
                        type="submit"
                        disabled={isPending}
                        className="px-4 pointer-coarse:min-h-12"
                        aria-label={t("buttonLabel", { name: cls.name, time: cls.startTime })}
                      >
                        {isPending && submittedId === cls.id ? t("submitting") : t("button")}
                      </Button>
                    </form>
                  )}
                  {cls.state.kind === "checked_in" && <Pill variant="ok">{t("stateCheckedIn")}</Pill>}
                  {cls.state.kind === "not_open_yet" && (
                    <Pill variant="plain">{t("stateNotOpenYet", { time: cls.state.opensAt })}</Pill>
                  )}
                  {cls.state.kind === "closed" && <Pill variant="plain">{t("stateClosed")}</Pill>}
                </div>

                {errorText && submittedId === cls.id && (
                  <p role="alert" className="col-span-2 text-sm text-destructive">
                    {errorText}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * What this check-in did for the student progress, said truthfully: an extra class the same day is recorded
 * but is not another progress day, and a class that does not count toward promotion says so. The numbers come
 * from the shared `buildProgressView` - an eligible student sees "eligible for instructor review", never 42 / 30.
 */
function SelfCheckInResult({
  summary,
  progressOutcome,
  t,
}: {
  summary: NonNullable<SelfCheckInState["summary"]>;
  progressOutcome: SelfCheckInState["progressOutcome"];
  t: ReturnType<typeof useTranslations>;
}) {
  const view = buildProgressView({ ...summary, dueDate: null });
  return (
    <div role="status" className="flex flex-col gap-2 text-sm">
      <p className="font-medium text-foreground">{t("successMessage")}</p>

      {progressOutcome === "already_counted_today" && (
        <p className="text-muted-foreground">{t("progressAlreadyCounted")}</p>
      )}
      {progressOutcome === "not_promotion_class" && (
        <p className="text-muted-foreground">{t("progressNotPromotionClass")}</p>
      )}
      {progressOutcome === "before_last_promotion" && (
        <p className="text-muted-foreground">{t("progressBeforeLastPromotion")}</p>
      )}

      {/* Only where attendance is what earns the next promotion (an attendance target exists). For a time-based degree (black belt)
          eligibility is decided by time, so this line would wrongly imply that attendance counts toward it. */}
      {view.current !== null && <p className="text-muted-foreground">{t("atBeltCount", { count: view.actualCount })}</p>}

      {view.state === "in_progress" && (
        <p className="text-muted-foreground">{t("remainingToNextStripe", { count: view.remaining ?? 0 })}</p>
      )}

      {view.state === "eligible" && <p className="font-medium">{t("eligibleForReview")}</p>}
    </div>
  );
}
