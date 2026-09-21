import "dotenv/config";
import { decode, encode } from "next-auth/jwt";

/**
 * Shared by every suite under tests/smoke — real HTTP against a real running server.
 *
 * Requires SMOKE_BASE_URL, explicitly — never inferred, and refused unless it points
 * at localhost, same "explicit target, no silent fallback" reasoning as
 * TEST_DATABASE_URL (scripts/lib/test-database-guard.ts). These suites are never meant
 * to run against a real deployed environment, so the guard lives HERE, once, and not
 * copied into each suite where the copies could drift.
 */
export function resolveGuardedSmokeBaseUrl(): string {
  const raw = process.env.SMOKE_BASE_URL;
  if (!raw) {
    throw new Error(
      "SMOKE_BASE_URL is required to run the smoke suites (e.g. http://localhost:3000). " +
        "Start the app first (`pnpm build && pnpm start`, or `pnpm dev`) and set this to point at it.",
    );
  }
  const url = new URL(raw);
  if (url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
    throw new Error(
      `SMOKE_BASE_URL must point at localhost/127.0.0.1, got "${url.hostname}". ` +
        "These suites make real, unauthenticated-by-default HTTP requests and must never target a real deployment.",
    );
  }
  return raw.replace(/\/$/, "");
}

export const SMOKE_BASE_URL = resolveGuardedSmokeBaseUrl();

const E2E_SECRET = process.env.E2E_AUTH_BYPASS_SECRET;
if (!E2E_SECRET) {
  throw new Error("E2E_AUTH_BYPASS_SECRET is required to mint authenticated sessions for the smoke suites.");
}

export const SESSION_COOKIE_NAME = "authjs.session-token";

/** Mints a real session cookie via the same dev-only bypass Playwright/manual screenshot
 * verification uses (src/app/api/e2e-auth-bypass/route.ts) — it runs the app's own real
 * sign-in jwt callback, not a second hand-rolled session shape, so a session this suite
 * mints is structurally identical to one real login produces (see
 * tests/integration/e2e-auth-bypass-equals-real-login.test.ts). Returns `name=value`. */
export async function mintSessionCookie(userId: string): Promise<string> {
  const response = await fetch(`${SMOKE_BASE_URL}/api/e2e-auth-bypass`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userId, secret: E2E_SECRET }),
  });
  if (!response.ok) {
    throw new Error(`Failed to mint a smoke-test session for user ${userId}: ${response.status}`);
  }
  const setCookie = response.headers.get("set-cookie");
  if (!setCookie) {
    throw new Error(`e2e-auth-bypass did not return a session cookie for user ${userId}`);
  }
  return setCookie.split(";")[0]!;
}

function authSecret(): string {
  const secret = process.env.AUTH_SECRET;
  if (!secret) throw new Error("AUTH_SECRET is required to read and re-sign session cookies in the smoke suites.");
  return secret;
}

/** The claims inside a `name=value` session cookie. */
export async function readSessionCookie(cookie: string): Promise<Record<string, unknown>> {
  const value = cookie.slice(cookie.indexOf("=") + 1);
  const token = await decode({ token: value, secret: authSecret(), salt: SESSION_COOKIE_NAME });
  if (!token) throw new Error("could not decode the session cookie");
  return token as Record<string, unknown>;
}

/**
 * A REAL session cookie for a REAL user whose `access` claim has been overwritten —
 * the token a person is left holding after being promoted or demoted mid-session (a
 * stale claim), or one a client edited (a forged claim; that needs the signing secret,
 * which is why this can only be done here, in a test that has it). `access: undefined`
 * drops the claim entirely, like a token issued before the claim existed.
 */
export async function withAccessClaim(cookie: string, access: { staff: boolean; portal: boolean } | undefined): Promise<string> {
  const token = await readSessionCookie(cookie);
  if (access === undefined) delete token.access;
  else token.access = access;
  const value = await encode({ token, secret: authSecret(), salt: SESSION_COOKIE_NAME });
  return `${SESSION_COOKIE_NAME}=${value}`;
}
