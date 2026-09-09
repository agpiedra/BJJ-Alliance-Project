/**
 * How far in the past a client-supplied `queuedAt` (an offline replay's
 * original attendance instant) may be and still be honored.
 *
 * 12 hours: long enough to cover the realistic worst case this exists for —
 * a tablet that loses connectivity during an evening class and only comes back
 * online the next morning — while still refusing an absurdly stale value from
 * a device whose clock is simply wrong. It is a sanity bound, not the real
 * gate: `performCheckIn` still re-evaluates the ±30-minute check-in window
 * against whichever instant is used, so a nonsense timestamp that happens to
 * fall inside this bound is still rejected there as `no_active_class`.
 */
export const MAX_QUEUED_AGE_MS = 12 * 60 * 60 * 1000;

/**
 * Resolve the instant a check-in should be recorded at, from an optional,
 * untrusted, client-supplied `queuedAt` (epoch ms).
 *
 * An offline replay sends the moment the student actually tapped. Without it
 * the ledger records the moment connectivity came back instead — the wrong
 * `occurredAt`, potentially the wrong ledger day, and potentially attributed
 * to a LATER class (or rejected outright) because the original class window
 * has since closed.
 *
 * Returns `undefined` — meaning "fall back to real server time" — when the
 * value is absent, malformed, in the future, or older than
 * `MAX_QUEUED_AGE_MS`. Deliberately a fallback rather than a rejection:
 * losing the check-in entirely is strictly worse than recording it with a
 * slightly-off timestamp.
 */
export function resolveAttendanceInstant(queuedAt: unknown, nowMs: number = Date.now()): Date | undefined {
  if (typeof queuedAt !== "number" || !Number.isFinite(queuedAt)) return undefined;
  if (queuedAt > nowMs) return undefined;
  if (nowMs - queuedAt > MAX_QUEUED_AGE_MS) return undefined;

  return new Date(queuedAt);
}
