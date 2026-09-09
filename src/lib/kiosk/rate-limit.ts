import { prisma } from "@/lib/prisma";

const RATE_LIMIT_WINDOW_SECONDS = 60;
const RATE_LIMIT_MAX_ATTEMPTS = 10;
const LOCKOUT_FAILURE_THRESHOLD = 5;
const LOCKOUT_SECONDS = 60;

export type RateLimitResult =
  | { allowed: true }
  | { allowed: false; reason: "rate_limited" | "locked_out"; retryAfterSeconds: number };

type WindowAttempt = { success: boolean; createdAt: Date };

/**
 * Pure decision function over a (caller-supplied, ascending-by-createdAt) list of attempts
 * within the trailing window. `locked_out` is checked first so that when both the lockout
 * and the total-attempts-rate-limit conditions are true simultaneously, the more specific
 * "locked_out" reason wins.
 */
function evaluateRateLimit(recentAttempts: WindowAttempt[]): RateLimitResult {
  const recentFailures = recentAttempts.filter((a) => !a.success);
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

  if (recentAttempts.length >= RATE_LIMIT_MAX_ATTEMPTS) {
    const oldestInWindow = recentAttempts[0].createdAt;
    const retryAfterSeconds = Math.max(
      1,
      RATE_LIMIT_WINDOW_SECONDS - Math.floor((Date.now() - oldestInWindow.getTime()) / 1000),
    );
    return { allowed: false, reason: "rate_limited", retryAfterSeconds };
  }

  return { allowed: true };
}

/**
 * Read-only status check: reports whether (academyId, ipAddress) is currently rate-limited
 * or locked out, based on attempts already persisted. Does not record anything, so it's safe
 * to call for UI gating before doing any work (e.g. before validating a submitted PIN) — but
 * it is a plain snapshot read and is NOT the enforcement point. `recordKioskAttempt` is the
 * atomic enforcement point; a caller must still treat that call's result as authoritative.
 */
export async function checkKioskRateLimit(academyId: string, ipAddress: string): Promise<RateLimitResult> {
  const windowStart = new Date(Date.now() - RATE_LIMIT_WINDOW_SECONDS * 1000);

  const recentAttempts = await prisma.kioskAttempt.findMany({
    where: { academyId, ipAddress, createdAt: { gte: windowStart } },
    orderBy: { createdAt: "asc" },
    select: { success: true, createdAt: true },
  });

  return evaluateRateLimit(recentAttempts);
}

/**
 * Atomically evaluates the rate limit against attempts already recorded for
 * (academyId, ipAddress) and, only if still allowed, records this attempt — all inside a
 * single Postgres transaction serialized by a per-key advisory lock. This closes a race where
 * concurrent callers each read a stale/pre-lockout window before any of their attempts had
 * committed: with the lock held for the read+decide+write, concurrent calls for the same key
 * queue up and each sees the fully up-to-date state left by the ones before it, so the
 * 10-attempts/60s and 5-failures/60s caps hold even under concurrent load.
 *
 * NOTE: this is the fix for a race-condition finding — `recordKioskAttempt` previously had a
 * `Promise<void>` return type and always inserted unconditionally. It now returns the
 * `RateLimitResult` for this attempt (reflecting whether it was actually allowed and
 * recorded), since that is the only point in this module where the decision is safe under
 * concurrency. Callers (e.g. the kiosk check-in endpoint, not yet built as of this fix) should
 * treat this return value as authoritative and must not infer "allowed" merely from a prior
 * `checkKioskRateLimit` call, since that call is a plain snapshot read with no lock.
 */
export async function recordKioskAttempt(
  academyId: string,
  ipAddress: string,
  success: boolean,
): Promise<RateLimitResult> {
  return prisma.$transaction(
    async (tx) => {
      // Serialize concurrent callers for this exact (academyId, ipAddress) key. The lock is
      // released automatically when the transaction commits or rolls back.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${academyId} || ':' || ${ipAddress})::bigint)`;

      const windowStart = new Date(Date.now() - RATE_LIMIT_WINDOW_SECONDS * 1000);
      const recentAttempts = await tx.kioskAttempt.findMany({
        where: { academyId, ipAddress, createdAt: { gte: windowStart } },
        orderBy: { createdAt: "asc" },
        select: { success: true, createdAt: true },
      });

      const result = evaluateRateLimit(recentAttempts);
      if (!result.allowed) {
        return result;
      }

      await tx.kioskAttempt.create({ data: { academyId, ipAddress, success } });
      return result;
    },
    // Generous timeout: under heavy concurrent contention for the same key, a waiter may sit
    // in the advisory-lock queue behind several other fast (lock+read+insert) transactions.
    { timeout: 10_000 },
  );
}
