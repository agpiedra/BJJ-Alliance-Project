"use client";

import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { useLocale, useTranslations } from "next-intl";
import { DateTime } from "luxon";
import { CheckCircle2, ChevronRight, CircleAlert, Clock, Info, Loader2, Lock, ShieldAlert, TriangleAlert, WifiOff, type LucideIcon } from "lucide-react";
import { cn } from "cn";
import { Button } from "@/components/ui/button";
import { BeltGraphic, type BeltVisualData } from "@/components/belt-graphic/belt-graphic";
import { enqueueOfflineCheckIn, flushOfflineQueue } from "@/lib/kiosk/offline-queue";
import { ZONE } from "@/lib/scheduling/zone";
import type { AtBeltSummary } from "@/lib/students/attendance-summary";
import { buildProgressView } from "@/lib/promotion/progress-view";
import type { ProgressOutcome } from "@/lib/kiosk/perform-check-in";

const CODE_LENGTH = 4;
const SUCCESS_DISPLAY_MS = 6000;
const ERROR_DISPLAY_MS = 4000;
const QUEUED_DISPLAY_MS = 6000;
/**
 * How long the class picker stays up before returning to the PIN pad.
 *
 * Much longer than the other cards (reading several class names and choosing
 * is a real decision, not an acknowledgement) but NOT unbounded: this is a
 * shared, wall-mounted tablet, and a student who taps, gets the picker, then
 * walks away would otherwise leave their session resident forever — the next
 * person at the tablet could tap a class and file attendance under the first
 * student's account.
 */
const PICKER_DISPLAY_MS = 30000;
/** The "check-in is unavailable, ask a coach" card carries an instruction, so it stays up longer than a plain error. */
const UNAVAILABLE_DISPLAY_MS = 9000;

/**
 * One class that is OPEN right now, as offered by the server: name, the scheduled time range and the real class type.
 * (Only classes whose check-in window contains the moment are ever offered; see performCheckIn.)
 */
interface OpenClass {
  id: string;
  name: string;
  startTime: string;
  endTime: string;
  type: string;
}

/** The class an attendance was attributed to, for the confirmation panel. */
interface MatchedClass {
  id: string;
  name: string;
  dayOfWeek: string;
  startTime: string;
}

/** The success (`ok: true`) shape of `POST /api/kiosk/check-in`'s JSON body. */
interface CheckInSuccess {
  ok: true;
  student: {
    firstName: string;
    lastName: string;
    currentBelt: string;
    currentBeltVisual: BeltVisualData;
    currentBeltLabelEs: string;
    currentBeltLabelEn: string;
    currentStripes: number;
  };
  /**
   * The server's own `AtBeltSummary`, narrowed to what this screen reads — NOT a
   * hand-written copy. This used to declare `remainingToNextStripe` /
   * `examEligible`, names the API never returned, so every real check-in
   * rendered "NaN"; deriving the type makes a rename a compile error.
   */
  summary: Pick<
    AtBeltSummary,
    | "atBeltCount"
    | "remainingAttendance"
    | "isEligible"
    | "nextTarget"
    | "mode"
    | "target"
    | "percent"
    | "timeAnchorMissing"
    | "notConfigured"
    | "reachedOn"
  >;
  /** This check-in reached the threshold: eligible for instructor review (a check-in never awards anything). */
  thresholdReached: boolean;
  /** What this check-in did for promotion progress - an extra same-day class is recorded but adds nothing. */
  progressOutcome: ProgressOutcome;
  isVisitor: boolean;
  homeAcademyName: string;
  attendanceRecordId: string;
  /** Another class was open at the same instant, so "not this class" has something to offer. */
  canCorrect?: boolean;
  /** null for an UNMATCHED save — there is no class to name, so the
   * "Asistencia guardada en" panel is omitted entirely. */
  matchedClass: MatchedClass | null;
}

/** Every failure shape the endpoint can return, per Task 5's contract. */
type CheckInFailureReason =
  | "invalid_request"
  | "invalid_code"
  // No class is open: check-in is unavailable and a coach can record the attendance. Nothing was written.
  | "no_open_class"
  | "class_selection_required"
  | "class_not_open"
  | "invalid_class"
  | "already_checked_in"
  | "invalid_token"
  | "org_unavailable"
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
  // SEVERAL classes are open: the student says which one they attended BEFORE anything is written (owner-approved
  // rule). Cancelling, or walking away until `PICKER_DISPLAY_MS` runs out, writes nothing. `closedNotice` is set when the
  // class they chose closed while the picker was up: the choices shown are the fresh ones. Gets its own, much longer
  // timer rather than the few seconds the success/error cards get — reading several class names and choosing is a real
  // decision.
  | { kind: "picking"; code: string; picklist: OpenClass[]; closedNotice: boolean }
  // The confirmation screen's "¿No es esta clase?" link, opened over the
  // success view: the same choose-a-class UI, but reassigning the record that
  // was already written rather than submitting a new check-in.
  | { kind: "correcting"; result: CheckInSuccess; picklist: OpenClass[]; submitting: boolean; failed: boolean }
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
  // Count of queued check-ins permanently lost on replay. Deliberately NOT a
  // `phase` — it must survive every phase transition and stay on screen until
  // a human dismisses it (or the page reloads), unlike the auto-expiring
  // success/error/queued cards. Session-only state is enough: it exists to
  // catch a staff member's eye now, and the entries themselves are already
  // gone from IndexedDB by the time it renders.
  const [droppedCount, setDroppedCount] = useState(0);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // The visible timeout indicator. It is driven by the SAME number that arms the reset (armReset below), so it can never disagree
  // with the real timeout: it exists only while a reset is pending, restarts every time one is armed (a new epoch remounts it) and
  // is removed the moment the timer is cleared (a correction being saved has no pending reset, so it shows no bar).
  const epochRef = useRef(0);
  const [pendingReset, setPendingReset] = useState<{ ms: number; epoch: number } | null>(null);

  const clearTimers = useCallback(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    setPendingReset(null);
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
    const flush = async () => {
      const { dropped } = await flushOfflineQueue();
      if (dropped > 0) setDroppedCount((current) => current + dropped);
    };
    void flush();
    const handleOnline = () => {
      void flush();
    };
    window.addEventListener("online", handleOnline);
    return () => window.removeEventListener("online", handleOnline);
  }, []);

  const resetToEntry = useCallback(() => {
    clearTimers();
    setPhase({ kind: "entry", code: "", submitting: false });
  }, [clearTimers]);

  /** Return to the keypad after `ms`, and show a bar that drains over exactly `ms`. Every "go back to the keypad by itself" goes through here. */
  const armReset = useCallback(
    (ms: number) => {
      timeoutRef.current = setTimeout(resetToEntry, ms);
      epochRef.current += 1;
      setPendingReset({ ms, epoch: epochRef.current });
    },
    [resetToEntry],
  );

  const queueCheckIn = useCallback(
    async (code: string, pickedClassSessionId?: string) => {
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
        persisted = await enqueueOfflineCheckIn({ academySlug, token, code, pickedClassSessionId });
      } catch {
        persisted = false;
      }

      clearTimers();

      if (!persisted) {
        setPhase({ kind: "error", reason: "queue_failed" });
        armReset(ERROR_DISPLAY_MS);
        return;
      }

      setPhase({ kind: "queued" });
      armReset(QUEUED_DISPLAY_MS);
    },
    [academySlug, token, clearTimers, armReset],
  );

  const submitCode = useCallback(
    async (code: string, pickedClassSessionId?: string) => {
      setPhase({ kind: "entry", code, submitting: true });

      // Offline, the attempt is queued instead of lost. A recorded selection (the student had already chosen a class
      // from the picker when the connection dropped) travels with the queued entry; an ordinary offline tap has none.
      // The server judges a queued attempt at its ORIGINAL instant and never refuses it for its class: it is attributed
      // when unambiguous and otherwise kept UNMATCHED for staff review (see offline-queue.ts).
      //
      // Fast pre-check: if the browser already knows it is offline, don't
      // bother attempting the request at all — go straight to the queue.
      // `navigator.onLine` can still be wrong in the other direction (it
      // can report `true` on a captive portal or a dead connection), which
      // is why the fetch failure below is the real, authoritative signal.
      if (typeof navigator !== "undefined" && navigator.onLine === false) {
        await queueCheckIn(code, pickedClassSessionId);
        return;
      }

      let response: Response;
      try {
        response = await fetch("/api/kiosk/check-in", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ academySlug, token, code, pickedClassSessionId }),
        });
      } catch {
        // A thrown fetch is a genuine network-level failure — the device is
        // offline (or the server is unreachable). Queue the attempt instead
        // of showing an error: the student showed up and must not lose
        // credit for the class over wifi.
        await queueCheckIn(code, pickedClassSessionId);
        return;
      }

      let body: unknown;
      try {
        body = await response.json();
      } catch {
        clearTimers();
        setPhase({ kind: "error", reason: "network_error" });
        armReset(ERROR_DISPLAY_MS);
        return;
      }

      clearTimers();

      if (response.status === 200 && isCheckInSuccess(body)) {
        setPhase({ kind: "success", result: body });
        armReset(SUCCESS_DISPLAY_MS);
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

      // Several classes are open (or the class the student chose just closed): show the CURRENT open classes to
      // choose from. The picker is only ever shown with a NON-EMPTY list; if the chosen class closed and nothing is
      // open any more, the student is told check-in is unavailable. Nothing has been written at this point.
      const openClasses = readPicklist(body, "openClasses");
      if ((reason === "class_selection_required" || reason === "class_not_open") && openClasses.length > 0) {
        setPhase({ kind: "picking", code, picklist: openClasses, closedNotice: reason === "class_not_open" });
        armReset(PICKER_DISPLAY_MS);
        return;
      }

      const shown: CheckInFailureReason = reason === "class_not_open" || reason === "class_selection_required" ? "no_open_class" : reason;
      setPhase({ kind: "error", reason: shown });
      armReset(shown === "no_open_class" ? UNAVAILABLE_DISPLAY_MS : ERROR_DISPLAY_MS);
    },
    [academySlug, token, clearTimers, queueCheckIn, armReset],
  );

  /** Confirmation screen -> "¿No es esta clase?": fetch that day's classes. */
  const openCorrection = useCallback(
    async (result: CheckInSuccess) => {
      clearTimers();
      setPhase({ kind: "correcting", result, picklist: [], submitting: true, failed: false });

      let picklist: OpenClass[] = [];
      try {
        const response = await fetch("/api/kiosk/reassign", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ academySlug, token, attendanceRecordId: result.attendanceRecordId }),
        });
        picklist = readPicklist(await response.json());
      } catch {
        picklist = [];
      }

      // Nothing to offer (offline, or the schedule changed under us): fall
      // back to the confirmation screen unchanged — the attendance itself is
      // already safely recorded, so this is a cosmetic failure, not a lost tap.
      if (picklist.length === 0) {
        setPhase({ kind: "success", result });
        armReset(SUCCESS_DISPLAY_MS);
        return;
      }

      // Timer starts only once the picker is actually interactive — a slow
      // fetch must not eat the student's reading time.
      setPhase({ kind: "correcting", result, picklist, submitting: false, failed: false });
      armReset(PICKER_DISPLAY_MS);
    },
    [academySlug, token, clearTimers, armReset],
  );

  /** Correction chosen: reassign the record already written, then return to
   * the confirmation screen showing the NEW class name in the same panel. */
  const applyCorrection = useCallback(
    async (result: CheckInSuccess, picklist: OpenClass[], classSessionId: string) => {
      clearTimers();
      setPhase({ kind: "correcting", result, picklist, submitting: true, failed: false });

      let matchedClass: MatchedClass | null = null;
      try {
        const response = await fetch("/api/kiosk/reassign", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            academySlug,
            token,
            attendanceRecordId: result.attendanceRecordId,
            classSessionId,
          }),
        });
        const body: unknown = await response.json();
        if (response.status === 200 && isReassignSuccess(body)) {
          matchedClass = body.matchedClass;
        }
      } catch {
        matchedClass = null;
      }

      if (!matchedClass) {
        setPhase({ kind: "correcting", result, picklist, submitting: false, failed: true });
        armReset(PICKER_DISPLAY_MS);
        return;
      }

      setPhase({ kind: "success", result: { ...result, matchedClass } });
      armReset(SUCCESS_DISPLAY_MS);
    },
    [academySlug, token, clearTimers, armReset],
  );

  /** Correction cancelled: back to the confirmation, which still shows the class the attendance is saved in. */
  const cancelCorrection = useCallback(
    (result: CheckInSuccess) => {
      clearTimers();
      setPhase({ kind: "success", result });
      armReset(SUCCESS_DISPLAY_MS);
    },
    [clearTimers, armReset],
  );

  // Restyle only: the brief's PIN pad spec ("3x4 numpad" with `Borrar` /
  // `Entrar` as two of the twelve positions, not `Borrar`/`0`/backspace) asks
  // for an explicit submit step instead of auto-submitting on the 4th digit.
  // `pressDigit` now only appends (capped at CODE_LENGTH); `submitCode` is
  // invoked exclusively from `pressEnter` below. `submitCode`/`queueCheckIn`
  // themselves are untouched — only when they're called has changed.
  const pressDigit = (digit: string) => {
    if (phase.kind !== "entry" || phase.submitting || phase.code.length >= CODE_LENGTH) return;
    setPhase({ kind: "entry", code: phase.code + digit, submitting: false });
  };

  const pressClear = () => {
    if (phase.kind !== "entry" || phase.submitting) return;
    setPhase({ kind: "entry", code: "", submitting: false });
  };

  const pressEnter = () => {
    if (phase.kind !== "entry" || phase.submitting || phase.code.length !== CODE_LENGTH) return;
    void submitCode(phase.code);
  };

  const hasOwnHeading = phase.kind === "entry" || phase.kind === "picking" || phase.kind === "correcting" || phase.kind === "success";

  return (
    <main className="relative flex min-h-[calc(100dvh-3rem)] flex-col">
      {/* Persistent, staff-facing. Deliberately outside the `phase` state machine so it never auto-dismisses: a lost check-in has to be
          reported to a person, and nobody watches a kiosk tablet's console. It sits IN the page flow, directly under the banner (it used to
          be fixed over the banner and covered the academy name), so the keypad simply moves down while it is shown. */}
      {droppedCount > 0 && (
        <div role="status" className="flex flex-wrap items-center justify-center gap-x-4 gap-y-2 border-b-2 border-bad-line bg-bad-soft px-4 py-3 text-lg font-medium text-bad">
          <CircleAlert aria-hidden="true" className="size-6 shrink-0" />
          <span>{t("syncDropped", { count: droppedCount })}</span>
          <Button type="button" size="lg" variant="outline" className="border-bad text-bad" onClick={() => setDroppedCount(0)}>
            {t("syncDroppedDismiss")}
          </Button>
        </div>
      )}

      <div className="flex flex-1 flex-col items-center justify-center gap-6 px-6 py-6 pb-10 min-[900px]:landscape:px-14">
        {/* Screens that have no heading of their own (a refusal, the lockout, the offline confirmation) still get one H1, the academy,
            for assistive technology; the banner already shows the name to everyone else. */}
        {!hasOwnHeading && <h1 className="sr-only">{academyName}</h1>}

        {phase.kind === "entry" && (
          <EntryView code={phase.code} submitting={phase.submitting} onDigit={pressDigit} onClear={pressClear} onEnter={pressEnter} />
        )}

        {phase.kind === "success" && <SuccessView result={phase.result} onCorrect={() => void openCorrection(phase.result)} />}

        {phase.kind === "picking" && (
          <ClassPicker
            heading={t("pickClassHeading")}
            description={t("pickClassDescription")}
            notice={phase.closedNotice ? t("pickClassClosedNotice") : undefined}
            picklist={phase.picklist}
            submitting={false}
            cancelLabel={t("pickClassCancel")}
            onCancel={resetToEntry}
            onPick={(classSessionId) => void submitCode(phase.code, classSessionId)}
          />
        )}

        {phase.kind === "correcting" && (
          <ClassPicker
            heading={t("correctClassHeading")}
            description={t("correctClassDescription")}
            picklist={phase.picklist}
            submitting={phase.submitting}
            error={phase.failed ? t("correctClassFailed") : undefined}
            cancelLabel={t("pickClassCancel")}
            onCancel={() => cancelCorrection(phase.result)}
            onPick={(classSessionId) => void applyCorrection(phase.result, phase.picklist, classSessionId)}
          />
        )}

        {phase.kind === "queued" && <NoticeCard tone="ok" icon={WifiOff} role="status" message={t("queuedOffline")} />}

        {phase.kind === "error" && <NoticeCard {...errorPresentation(phase.reason)} message={t(errorMessageKey(phase.reason))} />}

        {phase.kind === "locked" && (
          <NoticeCard
            tone={phase.reason === "locked_out" ? "bad" : "warn"}
            icon={Lock}
            message={phase.reason === "locked_out" ? t("lockedOut") : t("rateLimited")}
            count={`${phase.retryAfterSeconds}s`}
          />
        )}
      </div>

      {/* How long until the keypad comes back by itself. The same number arms the reset (armReset), and a new arm remounts the bar so it
          restarts. Decorative (the text on screen is the message), and hidden entirely for people who ask for reduced motion. */}
      {pendingReset && phase.kind !== "entry" && (
        <div aria-hidden="true" data-testid="kiosk-timeout" data-timeout-ms={pendingReset.ms} className="absolute inset-x-0 bottom-0 h-2 border-t border-input bg-data-track motion-reduce:hidden">
          <div key={pendingReset.epoch} className="kiosk-timeout-fill h-full bg-data" style={{ "--kiosk-timeout-ms": `${pendingReset.ms}ms` } as CSSProperties} />
        </div>
      )}
    </main>
  );
}

type NoticeTone = "ok" | "warn" | "bad" | "info";

const NOTICE_TONE_CLASS: Record<NoticeTone, string> = {
  ok: "border-ok-line bg-ok-soft text-ok",
  warn: "border-warn-line bg-warn-soft text-warn",
  bad: "border-bad-line bg-bad-soft text-bad",
  info: "border-input bg-card text-foreground",
};

/** Refusals, the lockout and the offline confirmation: an icon, the words and a tone, never colour alone. Wording is the app's own. */
function NoticeCard({
  tone,
  icon: Icon,
  message,
  count,
  role = "alert",
}: {
  tone: NoticeTone;
  icon: LucideIcon;
  message: string;
  count?: string;
  role?: "alert" | "status";
}) {
  return (
    <div role={role} className={cn("flex w-full max-w-xl flex-col items-center gap-4 rounded-lg border-2 px-7 py-8 text-center", NOTICE_TONE_CLASS[tone])}>
      <Icon aria-hidden="true" className="size-14" />
      <p className="text-2xl font-semibold text-balance sm:text-3xl">{message}</p>
      {count && <p className="font-mono text-6xl font-medium tabular-nums text-foreground">{count}</p>}
    </div>
  );
}

/** Tone and icon per refusal: red for what the student cannot fix, amber for waiting or asking someone, neutral for "already in". */
function errorPresentation(reason: CheckInFailureReason): { tone: NoticeTone; icon: LucideIcon } {
  switch (reason) {
    case "invalid_code":
    case "invalid_request":
      return { tone: "bad", icon: CircleAlert };
    case "already_checked_in":
      return { tone: "info", icon: Info };
    case "no_open_class":
    case "class_not_open":
    case "class_selection_required":
      return { tone: "warn", icon: Clock };
    case "invalid_token":
      return { tone: "bad", icon: ShieldAlert };
    case "org_unavailable":
      return { tone: "warn", icon: TriangleAlert };
    case "network_error":
      return { tone: "warn", icon: WifiOff };
    case "queue_failed":
    default:
      return { tone: "bad", icon: CircleAlert };
  }
}

function errorMessageKey(reason: CheckInFailureReason): string {
  switch (reason) {
    case "invalid_code":
      return "invalidCode";
    case "already_checked_in":
      return "alreadyCheckedIn";
    case "no_open_class":
    case "class_not_open":
    case "class_selection_required":
      return "noOpenClass";
    case "invalid_token":
      return "invalidToken";
    case "org_unavailable":
      return "orgUnavailable";
    case "network_error":
      return "networkError";
    case "queue_failed":
      return "queueFailed";
    case "invalid_request":
    default:
      return "genericError";
  }
}

// Wall-mounted, read at 1-2 metres: 56px numerals and huge keys with a 2px boundary. Sizes are EXPLICIT and asserted in a real browser
// (tests/browser/touch-targets.test.ts) under a mouse and a coarse pointer: 80 x 80 on a phone (this screen is never really loaded on
// one, but must not overflow it), 156 x 124 in portrait from `sm`, and 132 x 108 on a tablet in landscape (>= 900px wide), where the
// keypad sits beside the prompt and the whole screen fits 1024 x 768 without scrolling. Update the tests together with these numbers.
const KEY_SIZE_CLASS = "h-20 w-20 sm:h-[124px] sm:w-[156px] min-[900px]:landscape:h-[108px] min-[900px]:landscape:w-[132px]";
const DIGIT_BUTTON_CLASS = `${KEY_SIZE_CLASS} border-2 text-4xl font-medium sm:text-[56px]`;
const ACTION_BUTTON_CLASS = `${KEY_SIZE_CLASS} border-2 text-lg sm:text-2xl`;

function EntryView({
  code,
  submitting,
  onDigit,
  onClear,
  onEnter,
}: {
  code: string;
  submitting: boolean;
  onDigit: (digit: string) => void;
  onClear: () => void;
  onEnter: () => void;
}) {
  const t = useTranslations("kiosk");
  const locale = useLocale();
  const dots = Array.from({ length: CODE_LENGTH }, (_, index) => index < code.length);
  const codeComplete = code.length === CODE_LENGTH;

  // Display-only clock, in the academy's zone rather than the tablet's own
  // (possibly misconfigured) OS clock — see src/lib/scheduling/zone.ts. Null
  // until mount so server and client render the same (empty) markup first;
  // ticks every 30s after that, which is fresh enough for a wall clock
  // without repainting every second.
  const [now, setNow] = useState<DateTime | null>(null);
  useEffect(() => {
    setNow(DateTime.now().setZone(ZONE));
    const id = setInterval(() => setNow(DateTime.now().setZone(ZONE)), 30_000);
    return () => clearInterval(id);
  }, []);

  return (
    // Portrait / phone: one centred column (prompt, dots, keypad, clock). Landscape tablet: two columns, the prompt, dots and clock on the
    // left and the keypad on the right, so the whole screen fits 1024 x 768 without scrolling.
    <div className="grid w-full justify-items-center gap-8 min-[900px]:landscape:max-w-5xl min-[900px]:landscape:grid-cols-[minmax(0,1fr)_auto] min-[900px]:landscape:grid-rows-[1fr_auto] min-[900px]:landscape:justify-items-start min-[900px]:landscape:gap-x-16 min-[900px]:landscape:gap-y-6">
      <div className="flex flex-col items-center gap-6 min-[900px]:landscape:col-start-1 min-[900px]:landscape:row-start-1 min-[900px]:landscape:items-start min-[900px]:landscape:self-center">
        <h1 className="text-center text-3xl font-semibold text-balance min-[900px]:landscape:text-left sm:text-[40px] sm:leading-tight">{t("enterCode")}</h1>

        <div className="flex gap-4 sm:gap-5" aria-hidden="true">
          {dots.map((filled, index) => (
            <span key={index} className={`size-6 rounded-full border-[3px] border-foreground sm:size-[30px] ${filled ? "bg-foreground" : "bg-transparent"}`} />
          ))}
        </div>

        {/* The dots are decorative for assistive technology, so how many digits are in is said here (polite, read as it changes). */}
        <p role="status" aria-live="polite" className="sr-only">
          {t("codeStatus", { count: code.length, total: CODE_LENGTH })}
        </p>

        {submitting && (
          <p className="flex items-center gap-2 text-xl text-muted-foreground">
            <Loader2 aria-hidden="true" className="size-6 animate-spin" />
            {t("submitting")}
          </p>
        )}
      </div>

      <div className="grid grid-cols-3 gap-3 sm:gap-4 min-[900px]:landscape:col-start-2 min-[900px]:landscape:row-span-2 min-[900px]:landscape:row-start-1 min-[900px]:landscape:gap-3.5 min-[900px]:landscape:self-center">
        {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((digit) => (
          <Button key={digit} type="button" variant="outline" className={DIGIT_BUTTON_CLASS} disabled={submitting || codeComplete} onClick={() => onDigit(digit)}>
            {digit}
          </Button>
        ))}
        {/* Bottom row: Clear / 0 / Enter, the brief's 3x4 layout. Clear is a secondary key (it discards); Enter is the one primary action and
            stays disabled until all four digits are in. */}
        <Button type="button" variant="secondary" className={ACTION_BUTTON_CLASS} disabled={submitting || code.length === 0} onClick={onClear}>
          {t("clear")}
        </Button>
        <Button type="button" variant="outline" className={DIGIT_BUTTON_CLASS} disabled={submitting || codeComplete} onClick={() => onDigit("0")}>
          0
        </Button>
        <Button type="button" variant="primary" className={ACTION_BUTTON_CLASS} disabled={submitting || !codeComplete} onClick={onEnter}>
          {t("enter")}
        </Button>
      </div>

      {now && (
        <p className="font-mono text-base text-muted-foreground min-[900px]:landscape:col-start-1 min-[900px]:landscape:row-start-2 min-[900px]:landscape:self-end sm:text-xl">
          <span className="whitespace-nowrap">{now.setLocale(locale).toLocaleString(DateTime.DATE_FULL)}</span>
          <span className="min-[900px]:landscape:hidden">{" · "}</span>
          <span className="whitespace-nowrap min-[900px]:landscape:block">{now.setLocale(locale).toLocaleString(DateTime.TIME_SIMPLE)}</span>
        </p>
      )}
    </div>
  );
}

/**
 * The shared "which class did you attend?" screen, used by both the `picking` phase (several classes are open, nothing
 * written yet) and the confirmation screen's `correcting` overlay. Every row shows the class name, its scheduled time
 * range and its real class type. Tap targets are sized to the PIN pad's scale for the same reason (wall-mounted, read
 * and tapped at 1-2 metres), just laid out as full-width rows since class names are long. Cancel always leaves without
 * writing anything.
 */
function ClassPicker({
  heading,
  description,
  notice,
  picklist,
  submitting,
  error,
  cancelLabel,
  onCancel,
  onPick,
}: {
  heading: string;
  description: string;
  notice?: string;
  picklist: OpenClass[];
  submitting: boolean;
  error?: string;
  cancelLabel: string;
  onCancel: () => void;
  onPick: (classSessionId: string) => void;
}) {
  const tType = useTranslations("classType");
  return (
    <div className="flex w-full max-w-2xl flex-col items-center gap-6">
      <h1 className="text-center text-3xl font-semibold text-balance sm:text-4xl">{heading}</h1>
      <p className="text-center text-lg text-muted-foreground sm:text-xl">{description}</p>
      {notice && (
        <p role="status" className="text-center text-lg font-medium sm:text-xl">
          {notice}
        </p>
      )}

      <div className="flex w-full flex-col gap-3">
        {picklist.map((entry) => (
          <Button
            key={entry.id}
            type="button"
            variant="outline"
            disabled={submitting}
            className="h-auto min-h-[104px] pointer-coarse:min-h-[104px] w-full justify-between gap-4 border-2 px-5 py-5 text-left text-xl whitespace-normal sm:px-6 sm:text-2xl"
            onClick={() => onPick(entry.id)}
          >
            <span className="flex min-w-0 flex-col gap-1">
              <span className="text-2xl font-semibold sm:text-[28px] sm:leading-tight">{entry.name}</span>
              <span className="text-base font-normal text-muted-foreground sm:text-lg">{tType.has(entry.type) ? tType(entry.type) : entry.type}</span>
            </span>
            {/* The time range never wraps inside itself, however long the class name is. */}
            <span className="flex shrink-0 items-center gap-3">
              <span className="font-mono text-xl font-medium whitespace-nowrap tabular-nums sm:text-2xl">
                {entry.startTime} – {entry.endTime}
              </span>
              <ChevronRight aria-hidden="true" className="size-7 text-muted-foreground" />
            </span>
          </Button>
        ))}
      </div>

      {error && (
        <p role="alert" className="text-center text-lg font-medium text-bad sm:text-xl">
          {error}
        </p>
      )}

      <Button type="button" variant="ghost" disabled={submitting} className="h-auto min-h-[60px] pointer-coarse:min-h-[60px] px-8 py-4 text-lg underline underline-offset-4 sm:text-xl" onClick={onCancel}>
        {cancelLabel}
      </Button>
    </div>
  );
}

export function SuccessView({ result, onCorrect }: { result: CheckInSuccess; onCorrect: () => void }) {
  const t = useTranslations("kiosk");
  const tDay = useTranslations("dayOfWeek");
  const locale = useLocale();
  const { student, summary, thresholdReached, progressOutcome, isVisitor, homeAcademyName, matchedClass } = result;
  const name = `${student.firstName} ${student.lastName}`;
  // The shared display shaping (buildProgressView) - the same one every other surface reads. An eligible
  // student sees the capped "30 / 30" and "eligible for instructor review", never an overflowing 42 / 30.
  // (The kiosk shows no due date, so none is passed.)
  const view = buildProgressView({ ...summary, dueDate: null });

  const tProgress = useTranslations("portal.progress");
  const percent = view.current !== null && view.target !== null && view.target > 0 ? Math.round((view.current / view.target) * 100) : null;

  return (
    // Portrait: one centred column. Landscape tablet: two columns, who and which belt on the left, progress and the class it was saved in on
    // the right. The name is the screen's H1 (the academy is already in the banner).
    <div className="grid w-full max-w-5xl items-center justify-items-center gap-8 text-center min-[900px]:landscape:grid-cols-2 min-[900px]:landscape:gap-12 min-[900px]:landscape:justify-items-stretch">
      <div className="flex flex-col items-center justify-center gap-5">
        <CheckCircle2 className="size-20 text-ok sm:size-24" aria-hidden="true" />

        <h1 className="text-4xl font-semibold text-balance sm:text-[52px] sm:leading-[1.1]">
          {thresholdReached ? t("thresholdReachedHeading", { name }) : t("successHeading", { name })}
        </h1>

        <BeltGraphic belt={student.currentBeltVisual} label={locale === "es" ? student.currentBeltLabelEs : student.currentBeltLabelEn} stripes={student.currentStripes} />

        {isVisitor && <span className="rounded-full border border-input bg-secondary px-4 py-1.5 text-lg text-secondary-foreground">{t("visitorBadge", { academy: homeAcademyName })}</span>}
      </div>

      <div className="flex w-full max-w-lg flex-col items-center gap-6 min-[900px]:landscape:max-w-none min-[900px]:landscape:items-stretch min-[900px]:landscape:text-left">
        <div className="flex flex-col items-center gap-3 min-[900px]:landscape:items-stretch">
          {/* Shown as the engine gives it: "20 / 30" where there is an attendance target; for a rank with none (time-based) the bare count
              is kept exactly as it was (its wording is unchanged by this redesign). */}
          <p className="font-mono text-5xl font-medium tabular-nums sm:text-[56px] sm:leading-none">
            {view.current !== null && view.target !== null ? `${view.current} / ${view.target}` : view.actualCount}
          </p>

          {percent !== null && (
            <div
              role="progressbar"
              aria-label={tProgress("heading")}
              aria-valuemin={0}
              aria-valuemax={view.target ?? 0}
              aria-valuenow={view.current ?? 0}
              className="h-4 w-full overflow-hidden rounded-full border-2 border-input bg-data-track"
            >
              <div className={cn("h-full rounded-full", percent >= 90 ? "bg-brand-data" : "bg-data")} style={{ width: `${percent}%` }} />
            </div>
          )}

          {view.state === "in_progress" && <p className="text-xl text-muted-foreground sm:text-2xl">{t("remainingToNextStripe", { count: view.remaining ?? 0 })}</p>}

          {view.state === "eligible" && <p className="text-xl font-medium sm:text-2xl">{t("eligibleForReview")}</p>}

          {/* Truthful about what this tap did for progress: recorded either way, but only the first
              qualifying class of the day is a progress day. */}
          {progressOutcome === "already_counted_today" && <p className="text-lg text-muted-foreground sm:text-xl">{t("progressAlreadyCounted")}</p>}
          {progressOutcome === "not_promotion_class" && <p className="text-lg text-muted-foreground sm:text-xl">{t("progressNotPromotionClass")}</p>}
          {progressOutcome === "before_last_promotion" && <p className="text-lg text-muted-foreground sm:text-xl">{t("progressBeforeLastPromotion")}</p>}
        </div>

        {/* The safety net that makes automatic matching acceptable (Phase 9): the kiosk NAMES the class it chose and offers to change it on the
            spot. Omitted entirely for an UNMATCHED save: there is no class to name, and the tap is already queued for staff review on the
            Kiosco page's "Marcajes de hoy" table. */}
        {matchedClass && (
          <div className="flex w-full flex-col items-center gap-2 rounded-lg border border-border bg-card px-5 py-5 text-center min-[900px]:landscape:items-start min-[900px]:landscape:text-left">
            <p className="text-sm tracking-wide text-muted-foreground uppercase">{t("savedIn")}</p>
            <p className="text-2xl font-semibold">{matchedClass.name}</p>
            <p className="text-lg text-muted-foreground">
              {tDay(matchedClass.dayOfWeek)} {matchedClass.startTime}
            </p>
            {result.canCorrect !== false && (
              <Button type="button" variant="outline" className="mt-2 h-auto min-h-[60px] pointer-coarse:min-h-[60px] border-2 px-5 py-3 text-lg sm:text-xl" onClick={onCorrect}>
                {t("notThisClass")}
              </Button>
            )}
          </div>
        )}
      </div>
    </div>
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

/** The class list under `key` (`openClasses` on a check-in response, `picklist` on a correction response), or `[]`. */
function readPicklist(body: unknown, key: "picklist" | "openClasses" = "picklist"): OpenClass[] {
  if (typeof body !== "object" || body === null) return [];
  const list = (body as Record<string, unknown>)[key];
  if (!Array.isArray(list)) return [];
  return list.filter(
    (entry): entry is OpenClass =>
      typeof entry === "object" &&
      entry !== null &&
      typeof (entry as OpenClass).id === "string" &&
      typeof (entry as OpenClass).name === "string" &&
      typeof (entry as OpenClass).startTime === "string" &&
      typeof (entry as OpenClass).endTime === "string",
  );
}

function isReassignSuccess(body: unknown): body is { ok: true; matchedClass: MatchedClass } {
  if (typeof body !== "object" || body === null) return false;
  const record = body as Record<string, unknown>;
  if (record.ok !== true) return false;
  const matched = record.matchedClass;
  return typeof matched === "object" && matched !== null && typeof (matched as MatchedClass).name === "string";
}
