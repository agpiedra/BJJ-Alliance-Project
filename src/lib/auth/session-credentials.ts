import { cache } from "react";
import { prisma } from "@/lib/prisma";
import { safeErrorCode } from "@/lib/auth/password-reset-log";

/**
 * docs/PASSWORD_RECOVERY_PLAN.md §2.9 — session revocation on password reset.
 *
 * A session token carries `cv`, the user's `credentialsVersion` captured at sign-in from the same row read that
 * verified the password. A successful reset increments the stored version, so every token issued before it stops
 * matching. `iat` cannot serve: Auth.js re-encodes the token (new `iat`/`exp`/`jti`) on every session refresh.
 */

/** The version a token carries. A token issued before the claim existed has none and counts as 0. */
export function tokenCredentialsVersion(token: { cv?: unknown }): number {
  return typeof token.cv === "number" ? token.cv : 0;
}

/** One primary-key read per user per request (React's per-request `cache`, the same pattern as `getTenantContext`). */
const readCredentialState = cache(async (userId: string) =>
  prisma.user.findUnique({ where: { id: userId }, select: { active: true, credentialsVersion: true } }),
);

/**
 * True only when the token names an existing, ACTIVE user whose current `credentialsVersion` equals the token's. A
 * missing id, a missing or inactive user, a version mismatch and a database failure all return false — no access.
 * The stored version is only ever compared, never copied back into the token.
 */
export async function sessionCredentialsCurrent(token: { id?: unknown; cv?: unknown }): Promise<boolean> {
  if (typeof token.id !== "string" || token.id === "") return false;
  try {
    const state = await readCredentialState(token.id);
    return state !== null && state.active && state.credentialsVersion === tokenCredentialsVersion(token);
  } catch (error) {
    console.warn("[session]", { event: "session.credentials_check_failed", error: safeErrorCode(error) });
    return false;
  }
}
