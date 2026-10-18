import { prisma } from "@/lib/prisma";
import { digestLookupSecret } from "@/lib/crypto";
import { requireEnv } from "@/lib/env";
import { safeErrorCode, type SafeErrorCode } from "@/lib/auth/password-reset-log";
import { verifyCredentials, type VerifiedUser } from "@/lib/auth/verify-credentials";

/**
 * docs/LOGIN_THROTTLING_PLAN.md (rev 2). A plain module, NOT a "use server" file. The ONE enforcement point is
 * `authorizeCredentials`, the Credentials provider's `authorize` (src/auth.ts): every password check — the login
 * action, the academy login (same action), invitation sign-in and a direct POST to /api/auth/callback/credentials —
 * passes through it. Independent of the password-reset, registration and kiosk limiters; none is touched.
 *
 * Provisional initial settings, not production-validated capacity figures.
 */
export const LOGIN_PAIR_LIMIT = 5;
export const LOGIN_ACCOUNT_LIMIT = 20;
export const LOGIN_IP_LIMIT = 50;
export const LOGIN_WINDOW_MS = 15 * 60 * 1000;
/** Rows older than this are swept. Larger than the window, so a sweep never removes a row a window still counts. */
export const LOGIN_RETENTION_HOURS = 24;
export const LOGIN_SWEEP_BATCH = 100;

export type LoginKeyKind = "pair" | "account" | "ip";

/** The ONLY way login throttling writes to the console: fixed enums and allow-listed error codes, nothing else. */
export type LoginLogEntry =
  | { event: "login.throttled"; keyKind: LoginKeyKind }
  /** The reservation could not be made: the attempt is refused (fail closed). */
  | { event: "login.throttle_failed"; error: SafeErrorCode }
  | { event: "login.verify_failed"; error: SafeErrorCode }
  | { event: "login.reservation_release_failed"; error: SafeErrorCode }
  | { event: "login.throttle_cleanup_failed"; error: SafeErrorCode }
  /** src/app/[locale]/login/actions.ts: the landing lookup before sign-in failed; no password was checked. */
  | { event: "login.preauth_lookup_failed"; error: SafeErrorCode };

export function logLoginEvent(entry: LoginLogEntry): void {
  console.warn("[login]", entry);
}

export interface LoginThrottleKeys {
  account: string;
  /** Null when no client IP is available: the pair and IP limits are then skipped; the account limit still applies. */
  ip: string | null;
}

/** Keyed digests, never raw values; derived from the SUBMITTED address whether or not an account exists. */
export function loginThrottleKeys(email: string, ip: string | null): LoginThrottleKeys {
  const pepper = requireEnv("CODE_PEPPER");
  return {
    account: digestLookupSecret(`login-account:${email.trim().toLowerCase()}`, pepper),
    ip: ip ? digestLookupSecret(`login-ip:${ip}`, pepper) : null,
  };
}

/**
 * The first `x-forwarded-for` value. Read from the request Auth.js hands `authorize`, which carries the original
 * headers on every path, including the direct endpoint. Whether the hosting platform replaces a client-supplied value
 * is NOT verified, so the pair and IP limits are best effort until it is.
 */
export function clientIpFromHeaders(headers: Headers): string | null {
  return headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null;
}

export type LoginReservation = { allowed: true; reservationId: string } | { allowed: false; keyKind: LoginKeyKind };

/**
 * Decides and records one attempt BEFORE its password is checked. Serialized per key with transaction-scoped advisory
 * locks — account key first, then IP key, always in that order — so concurrent attempts each count every row
 * committed before them, including attempts still verifying. A refused attempt inserts nothing.
 */
export async function reserveLoginAttempt(keys: LoginThrottleKeys, now: Date = new Date()): Promise<LoginReservation> {
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`login:account:${keys.account}`}, 0))`;
      if (keys.ip) {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`login:ip:${keys.ip}`}, 0))`;
      }

      const createdAt = { gte: new Date(now.getTime() - LOGIN_WINDOW_MS) };
      if (keys.ip) {
        const pair = await tx.loginAttempt.count({ where: { accountDigest: keys.account, ipDigest: keys.ip, createdAt } });
        if (pair >= LOGIN_PAIR_LIMIT) return { allowed: false, keyKind: "pair" };
      }
      const account = await tx.loginAttempt.count({ where: { accountDigest: keys.account, createdAt } });
      if (account >= LOGIN_ACCOUNT_LIMIT) return { allowed: false, keyKind: "account" };
      if (keys.ip) {
        const ip = await tx.loginAttempt.count({ where: { ipDigest: keys.ip, createdAt } });
        if (ip >= LOGIN_IP_LIMIT) return { allowed: false, keyKind: "ip" };
      }

      const row = await tx.loginAttempt.create({
        data: { accountDigest: keys.account, ipDigest: keys.ip, createdAt: now },
        select: { id: true },
      });
      return { allowed: true, reservationId: row.id };
    },
    // A waiter may queue behind several other short transactions for the same key.
    { timeout: 10_000 },
  );
}

/**
 * A successful verification removes ONLY its own reservation. Other in-flight attempts and earlier counted rows stay
 * until they expire — a success never resets a counter. Never throws: on failure the row stays counted until expiry.
 */
export async function releaseLoginReservation(reservationId: string): Promise<void> {
  try {
    await prisma.loginAttempt.deleteMany({ where: { id: reservationId } });
  } catch (error) {
    logLoginEvent({ event: "login.reservation_release_failed", error: safeErrorCode(error) });
  }
}

/**
 * Bounded cleanup, the same shape as the password-reset sweep: at most LOGIN_SWEEP_BATCH rows older than the retention
 * period, oldest first; `SKIP LOCKED` keeps concurrent sweeps from blocking each other. Never throws. `createdAt` holds
 * UTC wall-clock values (timestamp without time zone), hence the UTC cutoff.
 */
export async function sweepExpiredLoginAttempts(): Promise<number> {
  try {
    return await prisma.$executeRaw`
      DELETE FROM "LoginAttempt"
      WHERE "id" IN (
        SELECT "id" FROM "LoginAttempt"
        WHERE "createdAt" < (now() AT TIME ZONE 'UTC') - make_interval(hours => ${LOGIN_RETENTION_HOURS}::int)
        ORDER BY "createdAt"
        LIMIT ${LOGIN_SWEEP_BATCH}::int
        FOR UPDATE SKIP LOCKED
      )`;
  } catch (error) {
    logLoginEvent({ event: "login.throttle_cleanup_failed", error: safeErrorCode(error) });
    return 0;
  }
}

/**
 * The Credentials `authorize`. Never throws: Auth.js turns a thrown error into a distinguishable `Configuration`
 * error and logs its cause, which for a database error can include the submitted address. Every refusal — unknown,
 * inactive, wrong password, throttled, or any failure — is the same `null`. A throttle refusal skips bcrypt.
 */
export async function authorizeCredentials(
  credentials: Partial<Record<string, unknown>> | undefined,
  request: Request,
): Promise<VerifiedUser | null> {
  const email = credentials?.email;
  const password = credentials?.password;
  if (typeof email !== "string" || typeof password !== "string") return null;

  let reservation: LoginReservation;
  try {
    reservation = await reserveLoginAttempt(loginThrottleKeys(email, clientIpFromHeaders(request.headers)));
  } catch (error) {
    logLoginEvent({ event: "login.throttle_failed", error: safeErrorCode(error) });
    return null;
  }
  await sweepExpiredLoginAttempts();
  if (!reservation.allowed) {
    logLoginEvent({ event: "login.throttled", keyKind: reservation.keyKind });
    return null;
  }

  let user: VerifiedUser | null;
  try {
    user = await verifyCredentials(email, password);
  } catch (error) {
    // The reservation stays counted.
    logLoginEvent({ event: "login.verify_failed", error: safeErrorCode(error) });
    return null;
  }
  if (user) await releaseLoginReservation(reservation.reservationId);
  return user;
}
