"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import type { ActionState } from "@/lib/action-state";
import { classifyResponse, rejectionRefreshes, type RejectionCode, type Settled } from "./outcome-messages";

/**
 * Stage 8d-2 (docs/dues/STAGE-8D2-IMPLEMENTATION-PLAN.md §4): every write on the readiness screen goes through `useScopedSubmit`.
 *
 * A SCOPE is what one outcome locks: one per student (their card and their assignment row share it, because any write to a
 * student changes what that student's review attests) and one for the organization-wide baseline.
 *
 * Only the RESPONSE classifies an outcome (`outcome-messages.ts`). Refreshed data is shown as the server's current data and never
 * reinterpreted as this request's result:
 * - saved / a rejection meaning "out of date": `router.refresh()`; the scope stays locked until a new snapshot (`asOf`) arrives;
 * - a field rejection: shown under the field, nothing refreshed, the typed values kept;
 * - outcome unknown (the call threw): the scope locks, the typed values stay untouched, and nothing is refreshed or resubmitted
 *   automatically. The owner reloads the data and must press "I have checked the current data" before the scope unlocks.
 *
 * A ref-based in-flight guard plus the disabled button reduce duplicate submissions within this mounted UI. They cannot give
 * exactly-once behaviour after a lost response, a reload or a second tab (plan §4.5, D3).
 */

export type Place = "card" | "assignment" | "baseline";

type ScopeState =
  | { phase: "idle" }
  | { phase: "pending"; place: Place }
  | { phase: "refreshing"; place: Place; result: "saved" | RejectionCode; count?: number; failed: boolean }
  | { phase: "done"; place: Place; result: "saved" | RejectionCode; count?: number }
  | { phase: "unknown"; place: Place; reloadRequested: boolean; refreshed: boolean; failed: boolean; targetId: string | null };

type Root = {
  asOf: string;
  get: (scope: string) => ScopeState;
  set: (scope: string, next: ScopeState | ((prev: ScopeState) => ScopeState)) => void;
};

const IDLE: ScopeState = { phase: "idle" };
const RootContext = createContext<Root | null>(null);
/** How long to wait for a refreshed snapshot before saying it could not be loaded. */
export const REFRESH_TIMEOUT_MS = 15_000;

/** Wraps the screen. `asOf` is the snapshot time the server rendered; a new value means a refresh arrived. */
export function ReadinessClientRoot({ asOf, children }: { asOf: string; children: React.ReactNode }) {
  const [scopes, setScopes] = useState<Record<string, ScopeState>>({});
  const asOfRef = useRef(asOf);

  const set = useCallback((scope: string, next: ScopeState | ((prev: ScopeState) => ScopeState)) => {
    setScopes((all) => ({ ...all, [scope]: typeof next === "function" ? next(all[scope] ?? IDLE) : next }));
  }, []);

  // A new snapshot arrived: a refresh after a save or an out-of-date rejection completes; an unknown outcome whose reload was
  // requested now shows the CURRENT data (still unknown). Nothing is inferred about the request from what the data contains.
  useEffect(() => {
    if (asOfRef.current === asOf) return;
    asOfRef.current = asOf;
    setScopes((all) => {
      const next: Record<string, ScopeState> = {};
      for (const [key, s] of Object.entries(all)) {
        if (s.phase === "refreshing") next[key] = { phase: "done", place: s.place, result: s.result, count: s.count };
        else if (s.phase === "unknown" && s.reloadRequested) next[key] = { ...s, reloadRequested: false, refreshed: true, failed: false };
        else next[key] = s;
      }
      return next;
    });
  }, [asOf]);

  // A refresh that never arrives (offline): say so, and offer only a full reload.
  const waitingKey = Object.entries(scopes)
    .filter(([, s]) => (s.phase === "refreshing" || (s.phase === "unknown" && s.reloadRequested)) && !s.failed)
    .map(([key]) => key)
    .join("|");
  useEffect(() => {
    if (!waitingKey) return;
    const started = asOfRef.current;
    const timer = setTimeout(() => {
      if (asOfRef.current !== started) return;
      for (const key of waitingKey.split("|")) set(key, (s) => (s.phase === "refreshing" || s.phase === "unknown" ? { ...s, failed: true } : s));
    }, REFRESH_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [waitingKey, set]);

  const get = useCallback((scope: string) => scopes[scope] ?? IDLE, [scopes]);
  return <RootContext.Provider value={{ asOf, get, set }}>{children}</RootContext.Provider>;
}

function useRoot(): Root {
  const root = useContext(RootContext);
  if (!root) throw new Error("ReadinessClientRoot is missing");
  return root;
}

export function useScopeLocked(scope: string): boolean {
  const phase = useRoot().get(scope).phase;
  return phase === "pending" || phase === "refreshing" || phase === "unknown";
}

/**
 * Submit `formData` through `action` for `scope`. Returns the field errors of a field-level rejection (for the caller's fields),
 * and calls `onSaved` (e.g. reset the form) only on an explicit `{ ok: true }`.
 */
export function useScopedSubmit(scope: string, place: Place) {
  const root = useRoot();
  const router = useRouter();
  const inFlight = useRef(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const locked = useScopeLocked(scope);

  const submit = useCallback(
    async (
      action: (formData: FormData) => Promise<ActionState & { count?: number }>,
      formData: FormData,
      opts: { targetId?: string | null; onSaved?: () => void } = {},
    ): Promise<Record<string, string[]>> => {
      if (inFlight.current || locked) return {};
      inFlight.current = true;
      setFieldErrors({});
      root.set(scope, { phase: "pending", place });
      let settled: Settled;
      try {
        settled = { status: "fulfilled", value: await action(formData) };
      } catch {
        settled = { status: "rejected" };
      } finally {
        inFlight.current = false;
      }
      const outcome = classifyResponse(settled);
      if (outcome.kind === "unknown") {
        root.set(scope, { phase: "unknown", place, reloadRequested: false, refreshed: false, failed: false, targetId: opts.targetId ?? null });
        return {};
      }
      if (outcome.kind === "saved") {
        opts.onSaved?.();
        root.set(scope, { phase: "refreshing", place, result: "saved", count: outcome.count, failed: false });
        router.refresh();
        return {};
      }
      if (rejectionRefreshes(outcome.code)) {
        root.set(scope, { phase: "refreshing", place, result: outcome.code, failed: false });
        router.refresh();
        return {};
      }
      setFieldErrors(outcome.fieldErrors);
      root.set(scope, { phase: "done", place, result: outcome.code });
      return outcome.fieldErrors;
    },
    [locked, place, root, router, scope],
  );

  return { submit, pending: root.get(scope).phase === "pending", locked, fieldErrors };
}

/**
 * The scope's outcome region, rendered where the submission happened (`place`). Focus moves here on every outcome so it is
 * announced; it lives outside any form, so it survives a form that closes because its draft is no longer active.
 */
export function ScopeStatus({ scope, place, activeTargets }: { scope: string; place: Place; activeTargets?: readonly string[] }) {
  const t = useTranslations("payments.readiness.forms.outcome");
  const locale = useLocale();
  const root = useRoot();
  const router = useRouter();
  const state = root.get(scope);
  const ref = useRef<HTMLDivElement>(null);
  const shown = state.phase !== "idle" && state.phase !== "pending" && state.place === place;
  // A field-level rejection keeps focus on the refused field (`focusFirstInvalid`); this region is still announced (role="alert").
  const fieldLevel = state.phase === "done" && state.result !== "saved" && !rejectionRefreshes(state.result);
  const signature = shown && !fieldLevel ? `${state.phase}:${"refreshed" in state ? state.refreshed : ""}:${"failed" in state ? state.failed : ""}` : "";

  useEffect(() => {
    if (signature) ref.current?.focus();
  }, [signature]);

  if (!shown) return null;

  if (state.phase === "unknown") {
    const targetClosed = state.refreshed && state.targetId !== null && activeTargets !== undefined && !activeTargets.includes(state.targetId);
    const time = new Intl.DateTimeFormat(locale === "es" ? "es-CR" : "en-US", { timeZone: "America/Costa_Rica", dateStyle: "medium", timeStyle: "medium" }).format(new Date(root.asOf));
    return (
      <div ref={ref} tabIndex={-1} role="alert" className="flex flex-col gap-2 rounded-lg border border-warn-line bg-warn-soft p-3 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
        <p className="font-semibold">{state.refreshed ? t("stillUnknownTitle") : t("unknownTitle")}</p>
        <p>{state.refreshed ? t("stillUnknownBody", { time }) : t("unknownBody")}</p>
        {targetClosed && <p>{t("targetClosed")}</p>}
        {state.failed ? (
          <>
            <p>{t("refreshFailed")}</p>
            <div>
              <Button type="button" variant="outline" size="sm" onClick={() => window.location.reload()}>
                {t("reloadPage")}
              </Button>
            </div>
          </>
        ) : (
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={state.reloadRequested}
              onClick={() => {
                root.set(scope, (s) => (s.phase === "unknown" ? { ...s, reloadRequested: true, failed: false } : s));
                router.refresh();
              }}
            >
              {state.refreshed ? t("reloadAgain") : t("reload")}
            </Button>
            {state.refreshed && (
              <Button type="button" size="sm" disabled={state.reloadRequested} onClick={() => root.set(scope, IDLE)}>
                {t("checked")}
              </Button>
            )}
          </div>
        )}
      </div>
    );
  }

  const saved = state.result === "saved";
  const refreshing = state.phase === "refreshing";
  return (
    <div
      ref={ref}
      tabIndex={-1}
      role={saved ? "status" : "alert"}
      className={`flex flex-col gap-2 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50 ${saved ? "text-ok" : "text-bad"}`}
    >
      <p>
        {!saved
          ? t(`rejected.${state.result}`)
          : state.count === undefined
            ? t("saved")
            : state.count === 0
              ? t("savedBaselineNone")
              : t("savedBaseline", { count: state.count })}
      </p>
      {refreshing && !state.failed && <p className="text-muted-foreground">{t("updating")}</p>}
      {refreshing && state.failed && (
        <div className="flex flex-col gap-2 text-foreground">
          <p>{t("refreshFailed")}</p>
          <div>
            <Button type="button" variant="outline" size="sm" onClick={() => window.location.reload()}>
              {t("reloadPage")}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
