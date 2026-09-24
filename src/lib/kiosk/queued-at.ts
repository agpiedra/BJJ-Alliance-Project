/**
 * How far in the past a client-supplied `queuedAt` (an offline replay's
 * original attendance instant) may be and still be honored.
 *
 * 12 hours: long enough to cover the realistic worst case this exists for —
 * a tablet that loses connectivity during an evening class and only comes back
 * online the next morning — while still refusing an absurdly stale value from
 * a device whose clock is simply wrong. It is a sanity bound, not the real
 * gate: `performCheckIn` still re-evaluates each class window (start - 30 minutes to
 * end + 30 minutes) against whichever instant is used, so a timestamp that happens to
 * fall inside this bound but matches no class (or several) is retained UNMATCHED for staff review.
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
 * Returns `undefined` — meaning "the instant could not be verified" — when the
 * value is absent, malformed, in the future, or older than `MAX_QUEUED_AGE_MS`.
 * The check-in is still recorded (at the server clock), never rejected: losing
 * the attendance entirely is strictly worse. But an unverified instant is never
 * used to pick a class, so a REPLAY carrying one is saved UNMATCHED for staff
 * review (see `replay.timestampVerified` in perform-check-in.ts).
 */
export function resolveAttendanceInstant(queuedAt: unknown, nowMs: number = Date.now()): Date | undefined {
  if (typeof queuedAt !== "number" || !Number.isFinite(queuedAt)) return undefined;
  if (queuedAt > nowMs) return undefined;
  if (nowMs - queuedAt > MAX_QUEUED_AGE_MS) return undefined;

  return new Date(queuedAt);
}
