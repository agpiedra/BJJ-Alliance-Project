"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { BeltGraphic, type Belt } from "@/components/belt-graphic/belt-graphic";
import { enqueueOfflineCheckIn, flushOfflineQueue } from "@/lib/kiosk/offline-queue";

const CODE_LENGTH = 4;
const SUCCESS_DISPLAY_MS = 6000;
const ERROR_DISPLAY_MS = 4000;
const QUEUED_DISPLAY_MS = 6000;

/** The success (`ok: true`) shape of `POST /api/kiosk/check-in`'s JSON body. */
interface CheckInSuccess {
  ok: true;
  student: { firstName: string; lastName: string; currentBelt: string; currentStripes: number };
  summary: {
    atBeltCount: number;
    remainingToNextStripe: number | null;
    examEligible: boolean;
  };
  earnedStripe: boolean;
  isVisitor: boolean;
  homeAcademyName: string;
}

/** Every failure shape the endpoint can return, per Task 5's contract. */
type CheckInFailureReason =
  | "invalid_request"
  | "invalid_code"
  | "no_active_class"
  | "already_checked_in"
  | "invalid_token"
  | "rate_limited"
  | "locked_out"
  | "network_error"
  // Client-only: the device is offline (or looked offline) AND the attempt
  // could not be durably queued either — either IndexedDB isn't available
  // in this environment, or the enqueue itself threw (e.g. a quota/DB
  // error). Never derived from a server response.
  | "queue_failed";

type Phase =
  | { kind: "entry"; code: string; submitting: boolean }
  | { kind: "success"; result: CheckInSuccess }
  | { kind: "error"; reason: CheckInFailureReason }
  | { kind: "locked"; reason: "rate_limited" | "locked_out"; retryAfterSeconds: number }
  | { kind: "queued" };

export function KioskClient({
  academyName,
  academySlug,
  token,
}: {
  academyId: string;
  academyName: string;
  academySlug: string;
  token: string;
}) {
  const t = useTranslations("kiosk");
  const [phase, setPhase] = useState<Phase>({ kind: "entry", code: "", submitting: false });
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const clearTimers = useCallback(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  }, []);

  // Timers must never outlive the component or leak across a phase change
  // that already replaced them with a different plan.
  useEffect(() => clearTimers, [clearTimers]);

  // Register the service worker (best-effort, feature-detected — see
  // public/sw.js: it exists only to satisfy PWA-installability checks, it
  // does not own any offline logic).
  useEffect(() => {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/sw.js").catch(() => {
      // Installability is a nice-to-have, not required for the kiosk to
      // function — swallow registration failures.
    });
  }, []);

  // Flush any check-ins queued from a previous offline session once on
  // mount, and again every time connectivity returns. This effect owns no
  // component timers of its own, so it doesn't interact with clearTimers.
  useEffect(() => {
    void flushOfflineQueue();
    const handleOnline = () => {
      void flushOfflineQueue();
    };
    window.addEventListener("online", handleOnline);
    return () => window.removeEventListener("online", handleOnline);
  }, []);

  const resetToEntry = useCallback(() => {
    clearTimers();
    setPhase({ kind: "entry", code: "", submitting: false });
  }, [clearTimers]);

  const queueCheckIn = useCallback(
    async (code: string) => {
      // enqueueOfflineCheckIn can fail two ways: it resolves `false` when
      // IndexedDB simply isn't available in this environment, or it can
      // reject (e.g. a QuotaExceededError, or a blocked/corrupted DB).
      // Both leave the check-in unpersisted, so both fall back to the same
      // "could not be saved" error — never the reassuring "queued" message
      // — otherwise the student is told their check-in is safe when it was
      // never recorded anywhere and never will be. Catching here also
      // guarantees `submitting` always gets cleared, so a rejected enqueue
      // can never freeze the kiosk on the next student.
      let persisted: boolean;
      try {
        persisted = await enqueueOfflineCheckIn({ academySlug, token, code });
      } catch {
        persisted = false;
      }

      clearTimers();

      if (!persisted) {
        setPhase({ kind: "error", reason: "queue_failed" });
        timeoutRef.current = setTimeout(resetToEntry, ERROR_DISPLAY_MS);
        return;
      }

      setPhase({ kind: "queued" });
      timeoutRef.current = setTimeout(resetToEntry, QUEUED_DISPLAY_MS);
    },
    [academySlug, token, clearTimers, resetToEntry],
  );

  const submitCode = useCallback(
    async (code: string) => {
      setPhase({ kind: "entry", code, submitting: true });

      // Fast pre-check: if the browser already knows it's offline, don't
      // bother attempting the request at all — go straight to the queue.
      // `navigator.onLine` can still be wrong in the other direction (it
      // can report `true` on a captive portal or a dead connection), which
      // is why the fetch failure below is the real, authoritative signal.
      if (typeof navigator !== "undefined" && navigator.onLine === false) {
        await queueCheckIn(code);
        return;
      }

      let response: Response;
      try {
        response = await fetch("/api/kiosk/check-in", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ academySlug, token, code }),
        });
      } catch {
        // A thrown fetch is a genuine network-level failure — the device is
        // offline (or the server is unreachable). Queue the attempt instead
        // of showing an error: the student showed up and must not lose
        // credit for the class over wifi.
        await queueCheckIn(code);
        return;
      }

      let body: unknown;
      try {
        body = await response.json();
      } catch {
        clearTimers();
        setPhase({ kind: "error", reason: "network_error" });
        timeoutRef.current = setTimeout(resetToEntry, ERROR_DISPLAY_MS);
        return;
      }

      clearTimers();

      if (response.status === 200 && isCheckInSuccess(body)) {
        setPhase({ kind: "success", result: body });
        timeoutRef.current = setTimeout(resetToEntry, SUCCESS_DISPLAY_MS);
        return;
      }

      if (response.status === 429 && isFailureWithReason(body)) {
        const reason = body.error === "locked_out" ? "locked_out" : "rate_limited";
        const retryAfterSeconds =
          typeof body.retryAfterSeconds === "number" && body.retryAfterSeconds > 0
            ? Math.ceil(body.retryAfterSeconds)
            : 1;
        setPhase({ kind: "locked", reason, retryAfterSeconds });
        intervalRef.current = setInterval(() => {
          setPhase((current) => {
            if (current.kind !== "locked") return current;
            const next = current.retryAfterSeconds - 1;
            if (next <= 0) {
              clearTimers();
              return { kind: "entry", code: "", submitting: false };
            }
            return { ...current, retryAfterSeconds: next };
          });
        }, 1000);
        return;
      }

      const reason: CheckInFailureReason = isFailureWithReason(body)
        ? (body.error as CheckInFailureReason)
        : "invalid_request";
      setPhase({ kind: "error", reason });
      timeoutRef.current = setTimeout(resetToEntry, ERROR_DISPLAY_MS);
    },
    [academySlug, token, clearTimers, resetToEntry, queueCheckIn],
  );

  const pressDigit = (digit: string) => {
    if (phase.kind !== "entry" || phase.submitting) return;
    const nextCode = phase.code + digit;
    if (nextCode.length >= CODE_LENGTH) {
      void submitCode(nextCode.slice(0, CODE_LENGTH));
      return;
    }
    setPhase({ kind: "entry", code: nextCode, submitting: false });
  };

  const pressBackspace = () => {
    if (phase.kind !== "entry" || phase.submitting) return;
    setPhase({ kind: "entry", code: phase.code.slice(0, -1), submitting: false });
  };

  const pressClear = () => {
    if (phase.kind !== "entry" || phase.submitting) return;
    setPhase({ kind: "entry", code: "", submitting: false });
  };

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 p-6">
      <h1 className="text-center text-3xl font-bold">{academyName}</h1>

      {phase.kind === "entry" && (
        <EntryView
          code={phase.code}
          submitting={phase.submitting}
          onDigit={pressDigit}
          onBackspace={pressBackspace}
          onClear={pressClear}
        />
      )}

      {phase.kind === "success" && <SuccessView result={phase.result} />}

      {phase.kind === "queued" && (
        <Card className="w-full max-w-sm">
          <CardContent className="flex flex-col items-center gap-2 py-8 text-center">
            <p className="text-lg font-medium">{t("queuedOffline")}</p>
          </CardContent>
        </Card>
      )}

      {phase.kind === "error" && (
        <Card className="w-full max-w-sm">
          <CardContent className="flex flex-col items-center gap-2 py-8 text-center">
            <p className="text-lg font-medium">{t(errorMessageKey(phase.reason))}</p>
          </CardContent>
        </Card>
      )}

      {phase.kind === "locked" && (
        <Card className="w-full max-w-sm">
          <CardContent className="flex flex-col items-center gap-2 py-8 text-center">
            <p className="text-lg font-medium">
              {phase.reason === "locked_out" ? t("lockedOut") : t("rateLimited")}
            </p>
            <p className="text-3xl font-bold tabular-nums">{phase.retryAfterSeconds}s</p>
          </CardContent>
        </Card>
      )}
    </main>
  );
}

function errorMessageKey(reason: CheckInFailureReason): string {
  switch (reason) {
    case "invalid_code":
      return "invalidCode";
    case "already_checked_in":
      return "alreadyCheckedIn";
    case "no_active_class":
      return "noActiveClass";
    case "invalid_token":
      return "invalidToken";
    case "network_error":
      return "networkError";
    case "queue_failed":
      return "queueFailed";
    case "invalid_request":
    default:
      return "genericError";
  }
}

function EntryView({
  code,
  submitting,
  onDigit,
  onBackspace,
  onClear,
}: {
  code: string;
  submitting: boolean;
  onDigit: (digit: string) => void;
  onBackspace: () => void;
  onClear: () => void;
}) {
  const t = useTranslations("kiosk");
  const dots = Array.from({ length: CODE_LENGTH }, (_, index) => index < code.length);

  return (
    <div className="flex flex-col items-center gap-6">
      <p className="text-lg text-muted-foreground">{t("enterCode")}</p>

      <div className="flex gap-3" aria-hidden="true">
        {dots.map((filled, index) => (
          <span
            key={index}
            className={`size-5 rounded-full border-2 border-foreground ${filled ? "bg-foreground" : "bg-transparent"}`}
          />
        ))}
      </div>

      <div className="grid grid-cols-3 gap-3">
        {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((digit) => (
          <Button
            key={digit}
            type="button"
            size="lg"
            variant="outline"
            className="h-16 w-16 text-2xl"
            disabled={submitting}
            onClick={() => onDigit(digit)}
          >
            {digit}
          </Button>
        ))}
        <Button
          type="button"
          size="lg"
          variant="secondary"
          className="h-16 w-16 text-lg"
          disabled={submitting || code.length === 0}
          onClick={onClear}
        >
          {t("clear")}
        </Button>
        <Button
          type="button"
          size="lg"
          variant="outline"
          className="h-16 w-16 text-2xl"
          disabled={submitting}
          onClick={() => onDigit("0")}
        >
          0
        </Button>
        <Button
          type="button"
          size="lg"
          variant="secondary"
          className="h-16 w-16 text-lg"
          disabled={submitting || code.length === 0}
          onClick={onBackspace}
          aria-label={t("backspace")}
        >
          ⌫
        </Button>
      </div>

      {submitting && <p className="text-muted-foreground">{t("submitting")}</p>}
    </div>
  );
}

function SuccessView({ result }: { result: CheckInSuccess }) {
  const t = useTranslations("kiosk");
  const { student, summary, earnedStripe, isVisitor, homeAcademyName } = result;

  return (
    <Card className="w-full max-w-md">
      <CardHeader>
        <CardTitle className="text-center text-2xl">
          {earnedStripe ? t("earnedStripeHeading") : t("successHeading")}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col items-center gap-4 text-center">
        <p className="text-xl font-semibold">
          {student.firstName} {student.lastName}
        </p>

        <BeltGraphic belt={student.currentBelt as Belt} stripes={student.currentStripes} />

        {isVisitor && (
          <span className="rounded-full bg-secondary px-3 py-1 text-sm text-secondary-foreground">
            {t("visitorBadge", { academy: homeAcademyName })}
          </span>
        )}

        <p className="text-muted-foreground">{t("atBeltCount", { count: summary.atBeltCount })}</p>

        {summary.remainingToNextStripe !== null && (
          <p className="text-muted-foreground">
            {t("remainingToNextStripe", { count: summary.remainingToNextStripe })}
          </p>
        )}

        {summary.remainingToNextStripe === null && summary.examEligible && (
          <p className="font-medium">{t("examEligible")}</p>
        )}
      </CardContent>
    </Card>
  );
}

function isFailureWithReason(body: unknown): body is { ok: false; error: string; retryAfterSeconds?: unknown } {
  if (typeof body !== "object" || body === null) return false;
  const record = body as Record<string, unknown>;
  return record.ok === false && typeof record.error === "string";
}

function isCheckInSuccess(body: unknown): body is CheckInSuccess {
  if (typeof body !== "object" || body === null) return false;
  const record = body as Record<string, unknown>;
  return record.ok === true && "student" in record && "summary" in record;
}
