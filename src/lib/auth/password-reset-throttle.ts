import { prisma } from "@/lib/prisma";
import { digestLookupSecret } from "@/lib/crypto";
import { requireEnv } from "@/lib/env";
import { logPasswordResetEvent, safeErrorCode } from "@/lib/auth/password-reset-log";

/**
 * docs/PASSWORD_RECOVERY_PLAN.md §2.4 — password-reset request throttling. Independent of the kiosk PIN limiter and of
 * RegistrationAttempt; neither is touched.
 */
export const RESET_ACCOUNT_LIMIT = 3;
export const RESET_IP_LIMIT = 20;
export const RESET_WINDOW_MS = 60 * 60 * 1000;
/** Rows older than this are swept. Larger than the window, so a sweep can never remove a row a window still counts. */
export const RESET_RETENTION_HOURS = 24;
export const RESET_SWEEP_BATCH = 100;

export interface ResetThrottleKeys {
  account: string;
  /** Null when no client IP is available; the IP limit is then skipped (fail open on that axis only). */
  ip: string | null;
}

/**
 * Keyed digests, never the raw values. The account key is derived from the SUBMITTED address for every request,
 * whether or not an account exists, so throttling behaves identically either way. Normalizing here changes only the
 * throttle key, not which account is looked up.
 */
export function resetThrottleKeys(email: string, ip: string | null): ResetThrottleKeys {
  const pepper = requireEnv("CODE_PEPPER");
  return {
    account: digestLookupSecret(`pwreset-email:${email.trim().toLowerCase()}`, pepper),
    ip: ip ? digestLookupSecret(`pwreset-ip:${ip}`, pepper) : null,
  };
}

export type ResetClaimResult = { allowed: true } | { allowed: false; keyKind: "email" | "ip" };

/**
 * Decides and records one request. Serialized per key with transaction-scoped advisory locks — account key first, then
 * IP key, always in that order — so concurrent requests for a key queue up and each counts the rows committed by the
 * ones before it. Only an ALLOWED request inserts rows, so refused attempts cannot extend their own window.
 */
export async function claimResetRequest(keys: ResetThrottleKeys, now: Date = new Date()): Promise<ResetClaimResult> {
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`pwreset:email:${keys.account}`}, 0))`;
      if (keys.ip) {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`pwreset:ip:${keys.ip}`}, 0))`;
      }

      const windowStart = new Date(now.getTime() - RESET_WINDOW_MS);
      const accountCount = await tx.passwordResetRequest.count({
        where: { keyKind: "email", keyDigest: keys.account, createdAt: { gte: windowStart } },
      });
      if (accountCount >= RESET_ACCOUNT_LIMIT) return { allowed: false, keyKind: "email" };

      if (keys.ip) {
        const ipCount = await tx.passwordResetRequest.count({
          where: { keyKind: "ip", keyDigest: keys.ip, createdAt: { gte: windowStart } },
        });
        if (ipCount >= RESET_IP_LIMIT) return { allowed: false, keyKind: "ip" };
      }

      await tx.passwordResetRequest.createMany({
        data: [
          { keyKind: "email", keyDigest: keys.account, createdAt: now },
          ...(keys.ip ? [{ keyKind: "ip", keyDigest: keys.ip, createdAt: now }] : []),
        ],
      });
      return { allowed: true };
    },
    // A waiter may queue behind several other short transactions for the same key.
    { timeout: 10_000 },
  );
}

/**
 * Bounded cleanup: deletes at most RESET_SWEEP_BATCH rows older than the retention period, oldest first, through the
 * `createdAt` index. `SKIP LOCKED` keeps concurrent sweeps from blocking each other. Runs after the decision
 * transaction, never inside it; a failure is logged with an allow-listed code and never affects the response.
 *
 * What it bounds: expired rows drain while requests keep arriving (each request adds at most 2 rows and removes up to
 * 100). What it does NOT bound: rows inside the retention period (no fixed ceiling), or expired rows when requests
 * stop entirely. `createdAt` holds UTC wall-clock values (timestamp without time zone), hence the UTC cutoff.
 */
export async function sweepExpiredResetRequests(): Promise<number> {
  try {
    return await prisma.$executeRaw`
      DELETE FROM "PasswordResetRequest"
      WHERE "id" IN (
        SELECT "id" FROM "PasswordResetRequest"
        WHERE "createdAt" < (now() AT TIME ZONE 'UTC') - make_interval(hours => ${RESET_RETENTION_HOURS}::int)
        ORDER BY "createdAt"
        LIMIT ${RESET_SWEEP_BATCH}::int
        FOR UPDATE SKIP LOCKED
      )`;
  } catch (error) {
    logPasswordResetEvent({ event: "password_reset.throttle_cleanup_failed", error: safeErrorCode(error) });
    return 0;
  }
}
