import { prisma } from "@/lib/prisma";

const RATE_LIMIT_WINDOW_SECONDS = 60;
const RATE_LIMIT_MAX_FAILURES = 10;
const LOCKOUT_FAILURE_THRESHOLD = 5;
const LOCKOUT_SECONDS = 60;

export type RateLimitRejection = {
  allowed: false;
  reason: "rate_limited" | "locked_out";
  retryAfterSeconds: number;
};

export type ReserveResult = { allowed: true; attemptId: string } | RateLimitRejection;

/**
 * The real outcome of an attempt previously claimed by `reserveKioskAttempt`.
 *
 * Only `invalid_code` is a brute-force signal. `already_checked_in` and `no_active_class`
 * both mean the submitted code was VALID and resolved to a real, active student — the
 * former is a student double-tapping, the latter a student arriving outside any class
 * window (which the narrower ±30-minute window made measurably more common). Neither is a
 * guess, so neither may extend the lockout.
 */
export type KioskAttemptOutcome = "success" | "invalid_code" | "already_checked_in" | "no_active_class";

/** Outcomes that leave the reserved row counting toward the lockout anchor. */
const OUTCOME_COUNTS_AS_FAILURE: Record<KioskAttemptOutcome, boolean> = {
  success: false,
  invalid_code: true,
  already_checked_in: false,
  no_active_class: false,
};

type WindowAttempt = { createdAt: Date };

/**
 * Pure decision function over the caller-supplied, ascending-by-createdAt list of
 * COUNTING failures inside the trailing window (see `countsAsFailure`).
 *
 * Both thresholds count failures ONLY — successful check-ins never count toward either.
 * A single shared kiosk tablet legitimately does 10+ successful check-ins a minute during
 * a class rush (that is the product's own design), and counting those as abuse turned the
 * brute-force control into a self-inflicted denial of service: the 11th real student in a
 * minute got a lockout screen instead of a check-in. An attacker guessing codes produces
 * overwhelmingly failures until they guess right, so failure-only counting preserves the
 * actual protection.
 *
 * "Failure" here is narrower still than `success: false`: it is a genuine wrong-code
 * guess. Valid-code failures (`already_checked_in`, `no_active_class`) and attempts the
 * gate itself refused are logged but excluded, because the anchor is re-derived from
 * whatever currently sits in the window — so counting them let five late arrivals, five
 * double-taps, or a scripted flood of already-rejected requests hold an entire academy's
 * kiosk in a self-renewing lockout.
 *
 * `locked_out` is checked first so that when both the lockout and the total-failures
 * rate-limit conditions are true simultaneously, the more specific "locked_out" reason
 * wins. NOTE: with both thresholds now counting failures over the same 60s window, and
 * LOCKOUT_SECONDS === RATE_LIMIT_WINDOW_SECONDS, any window holding >= 10 failures
 * necessarily also holds >= 5 whose lockout has not yet expired — so in practice the
 * `rate_limited` branch is unreachable and exists as a defensive ceiling should either
 * constant ever be retuned independently.
 */
function evaluateRateLimit(recentFailures: WindowAttempt[]): { allowed: true } | RateLimitRejection {
  if (recentFailures.length >= LOCKOUT_FAILURE_THRESHOLD) {
    const fifthFailure = recentFailures[LOCKOUT_FAILURE_THRESHOLD - 1].createdAt;
    const lockoutEndsAt = fifthFailure.getTime() + LOCKOUT_SECONDS * 1000;
    if (Date.now() < lockoutEndsAt) {
      return {
        allowed: false,
        reason: "locked_out",
        retryAfterSeconds: Math.ceil((lockoutEndsAt - Date.now()) / 1000),
      };
    }
  }

  if (recentFailures.length >= RATE_LIMIT_MAX_FAILURES) {
    const oldestInWindow = recentFailures[0].createdAt;
    const retryAfterSeconds = Math.max(
      1,
      RATE_LIMIT_WINDOW_SECONDS - Math.floor((Date.now() - oldestInWindow.getTime()) / 1000),
    );
    return { allowed: false, reason: "rate_limited", retryAfterSeconds };
  }

  return { allowed: true };
}

/**
 * Step 1 of 2. Atomically decides whether this kiosk may make an attempt at all, and — if
 * so — claims a `KioskAttempt` row for it BEFORE the submitted code is ever evaluated.
 *
 * Why reserve-then-finalize rather than the old check-then-record: the previous design ran
 * the atomic gate AFTER `performCheckIn` had already evaluated the guess, so a flood of
 * concurrent requests all reached the code comparison and a winning guess found that way
 * still came back as a real 200. Claiming the slot first means the gate is genuinely in
 * front of the guess — a blocked caller never reaches `performCheckIn` at all.
 *
 * The key is `(academyId, kioskTokenHash)`. `kioskTokenHash` is the digest of the kiosk
 * token the route has already verified against `Academy.kioskTokenHash`; unlike the old
 * `x-forwarded-for`-derived IP it cannot be forged or rotated per request by the caller.
 * `ipAddress` is still written, but purely as best-effort audit metadata.
 *
 * A rejected attempt is ALSO written (as `success: false`) rather than dropped: spec §4.1
 * requires every failed attempt to be logged, and the attempts made during an active
 * lockout are exactly the ones an operator most needs to see. It is written with
 * `countsAsFailure: false`, though: the gate refused it before any code was evaluated, so
 * it is not evidence of a guess. Counting it made the lockout self-renewing — anyone able
 * to fire five requests a minute could hold an entire academy's kiosk offline
 * indefinitely, including through requests that never reached `performCheckIn` at all.
 *
 * Everything runs inside one transaction serialized by a per-key advisory lock, so
 * concurrent callers for the same key queue up and each sees the fully committed state
 * left by the ones before it.
 */
export async function reserveKioskAttempt(
  academyId: string,
  kioskTokenHash: string,
  ipAddress: string,
): Promise<ReserveResult> {
  return prisma.$transaction(
    async (tx) => {
      // Serialize concurrent callers for this exact (academyId, kioskTokenHash) key. The
      // lock is released automatically when the transaction commits or rolls back.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${academyId} || ':' || ${kioskTokenHash})::bigint)`;

      const windowStart = new Date(Date.now() - RATE_LIMIT_WINDOW_SECONDS * 1000);
      const recentFailures = await tx.kioskAttempt.findMany({
        where: {
          academyId,
          kioskTokenHash,
          success: false,
          countsAsFailure: true,
          createdAt: { gte: windowStart },
        },
        orderBy: { createdAt: "asc" },
        select: { createdAt: true },
      });

      const decision = evaluateRateLimit(recentFailures);

      // Provisional row: `success: false` either way. An ALLOWED attempt is claimed as
      // `countsAsFailure: true` — presumed a guess until `finalizeKioskAttempt` learns
      // otherwise, which is exactly what caps a burst of concurrent reservations at five
      // (none of them has been finalized when the next one reads the window). A REJECTED
      // attempt is logged but never counted: the gate refused it before any code was
      // evaluated, so treating it as evidence of a guess is what made the lockout
      // self-renewing.
      const attempt = await tx.kioskAttempt.create({
        data: {
          academyId,
          kioskTokenHash,
          ipAddress,
          success: false,
          countsAsFailure: decision.allowed,
        },
        select: { id: true },
      });

      if (!decision.allowed) {
        return decision;
      }

      return { allowed: true as const, attemptId: attempt.id };
    },
    // Generous timeout: under heavy concurrent contention for the same key, a waiter may
    // sit in the advisory-lock queue behind several other fast transactions.
    { timeout: 10_000 },
  );
}

/**
 * Step 2 of 2. Records the real outcome of an attempt previously claimed by
 * `reserveKioskAttempt`.
 *
 * An `invalid_code` outcome is a no-op — the reserved row already says exactly that (a
 * failure that counts). Every other outcome clears `countsAsFailure`, and a `success`
 * additionally flips `success`. Either way it is a targeted single-row update by primary
 * key: no lock is needed because only the caller that reserved this row knows its id, and
 * both edits can only ever relax the window, never let an extra attempt through.
 *
 * Guaranteed not to throw. This runs AFTER `performCheckIn` may have committed a real
 * `AttendanceRecord`, and this row is audit/metering metadata — failing the HTTP response
 * over it would tell a student their check-in failed when it genuinely succeeded. An
 * unexpected failure here leaves the row as a counting failure, which is the conservative
 * direction (it can only tighten the limiter, never loosen it).
 */
export async function finalizeKioskAttempt(attemptId: string, outcome: KioskAttemptOutcome): Promise<void> {
  const countsAsFailure = OUTCOME_COUNTS_AS_FAILURE[outcome];
  const success = outcome === "success";
  if (countsAsFailure && !success) return;

  try {
    await prisma.kioskAttempt.update({
      where: { id: attemptId },
      data: { success, countsAsFailure },
    });
  } catch (error) {
    console.error("[kiosk-rate-limit] failed to finalize attempt", { attemptId, outcome, error });
  }
}
