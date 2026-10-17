import "dotenv/config";
import { Pool, type PoolClient } from "pg";
import { NextRequest } from "next/server";
import { encode, decode, type JWT } from "next-auth/jwt";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getTestPrismaClient } from "../helpers/test-db";
import { resolveGuardedTestDatabaseUrl } from "../../scripts/lib/test-database-guard";
import { digestLookupSecret } from "../../src/lib/crypto";
import { requireEnv } from "../../src/lib/env";

/**
 * docs/PASSWORD_RECOVERY_PLAN.md §2.9 — a successful password reset ends every earlier session.
 *
 * Driven through the app's real entry points, against the isolated test database:
 *  - "Node session read" = the real `/api/auth/[...nextauth]` GET handler from src/auth.ts — the same Auth.js session
 *    action and the same Node `jwt` callback every server-side `auth()` call runs;
 *  - "middleware refresh" = the real src/middleware.ts default export, which re-encodes the cookie through the Edge
 *    `NextAuth(authConfig)` instance and returns it in `Set-Cookie`;
 *  - sign-in = `verifyCredentials` (what `authorize` calls) followed by the shared `signInJwtCallback` and `encode`,
 *    exactly as Auth.js and the e2e bypass do.
 * Only the database lookup used by the "database failure" case is fault-injected (a test-only Proxy).
 */
let failCredentialRead = false;
vi.mock("@/lib/prisma", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/prisma")>();
  const real = actual.prisma as unknown as Record<string | symbol, unknown>;
  const prisma = new Proxy(real, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (prop === "user") {
        return new Proxy(value as object, {
          get(userTarget, userProp) {
            if (userProp === "findUnique" && failCredentialRead) {
              return () => Promise.reject(Object.assign(new Error("SYNTH-DB-SECRET-n4 down"), { code: "P1001", name: "PrismaClientKnownRequestError" }));
            }
            const v = Reflect.get(userTarget, userProp, userTarget);
            return typeof v === "function" ? v.bind(userTarget) : v;
          },
        });
      }
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
  return { ...actual, prisma };
});

vi.mock("@/lib/after-response", () => ({ scheduleAfterResponse: () => true }));

// Several bcrypt (cost 12) hashes per test, plus a lock-gated reset in (5).
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

// Locale routing only: next-intl's middleware cannot load under vitest (it imports `next/server` from inside an external
// dependency). The session refresh under test is done by the `auth(...)` wrapper around it — the real Edge
// `NextAuth(authConfig)` instance — which appends the re-encoded cookie to whatever response the inner handler returns.
vi.mock("next-intl/middleware", async () => {
  const { NextResponse } = await import("next/server");
  return { default: () => () => NextResponse.next() };
});

const { handlers } = await import("../../src/auth");
const { default: middleware } = await import("../../src/middleware");
const authConfig = (await import("../../src/auth.config")).default;
const { signInJwtCallback } = await import("../../src/lib/auth/sign-in-jwt-callback");
const { verifyCredentials } = await import("../../src/lib/auth/verify-credentials");
const { redeemPasswordResetToken } = await import("../../src/lib/auth/password-reset");
const { hashSecret } = await import("../../src/lib/crypto");

const SESSION_COOKIE = "authjs.session-token";
const ORIGINAL = "Original-Passw0rd";
const prisma = getTestPrismaClient();
const pool = new Pool({ connectionString: resolveGuardedTestDatabaseUrl(), max: 4 });
const PEPPER = process.env.CODE_PEPPER as string;
const userIds: string[] = [];
const orgIds: string[] = [];

function uniq() {
  return `${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}

async function makeStaffUser() {
  const suffix = uniq();
  const user = await prisma.user.create({
    data: { email: `revocation-${suffix}@example.test`, passwordHash: await hashSecret(ORIGINAL), role: "ADMIN" },
  });
  userIds.push(user.id);
  const organization = await prisma.organization.create({ data: { slug: `revocation-org-${suffix}`, name: `Revocation ${suffix}`, status: "ACTIVE" } });
  orgIds.push(organization.id);
  await prisma.organizationMembership.create({ data: { userId: user.id, organizationId: organization.id, role: "ADMIN" } });
  return { user, organization };
}

async function encodeToken(token: JWT): Promise<string> {
  return encode({ token, secret: requireEnv("AUTH_SECRET"), salt: SESSION_COOKIE });
}

async function decodeCookie(value: string): Promise<JWT | null> {
  return decode({ token: value, secret: requireEnv("AUTH_SECRET"), salt: SESSION_COOKIE });
}

/** A real sign-in: credentials verified exactly as `authorize` does, then the shared callback, then encoding. */
async function signInToken(email: string, password: string): Promise<JWT | null> {
  const verified = await verifyCredentials(email, password);
  if (!verified) return null;
  return signInJwtCallback({ token: { sub: verified.id, email: verified.email, name: verified.email }, user: verified, trigger: "signIn" } as never);
}

async function signIn(email: string, password: string): Promise<string | null> {
  const token = await signInToken(email, password);
  return token ? encodeToken(token) : null;
}

/**
 * Headers a real request to the local dev server carries. Without `x-forwarded-proto`, and with no AUTH_URL set,
 * Auth.js assumes https and looks for the `__Secure-` cookie name instead.
 */
function requestHeaders(cookie: string): Record<string, string> {
  return { cookie: `${SESSION_COOKIE}=${cookie}`, host: "localhost:3000", "x-forwarded-proto": "http" };
}

/** The real Node session read (the /api/auth/session handler). Returns the session body and any session cookie set. */
async function nodeSession(cookie: string): Promise<{ session: { user?: { id?: string } } | null; setCookie: string | null }> {
  const response = await handlers.GET(new NextRequest("http://localhost:3000/api/auth/session", { headers: requestHeaders(cookie) }));
  const body = (await response.json()) as { user?: { id?: string } } | null;
  const sessionCookie = response.headers.getSetCookie().find((c) => c.startsWith(`${SESSION_COOKIE}=`)) ?? null;
  return { session: body && body.user ? body : null, setCookie: sessionCookie };
}

/** The real middleware: returns the refreshed session cookie value it sets, and the response. */
async function middlewareRequest(cookie: string, path = "/en/dashboard") {
  const response = (await middleware(new NextRequest(`http://localhost:3000${path}`, { headers: requestHeaders(cookie) }), undefined as never)) as Response;
  const set = response.headers.getSetCookie().find((c) => c.startsWith(`${SESSION_COOKIE}=`));
  const refreshed = set ? set.split(";")[0].slice(SESSION_COOKIE.length + 1) : null;
  return { response, refreshed };
}

async function resetPassword(userId: string, newPassword: string) {
  const raw = `raw-${uniq()}`;
  await prisma.passwordResetToken.create({
    data: { userId, tokenHash: digestLookupSecret(raw, PEPPER), expiresAt: new Date(Date.now() + 60 * 60 * 1000) },
  });
  return redeemPasswordResetToken({ rawToken: raw, newPassword });
}

let consoleCalls: unknown[][] = [];
beforeEach(() => {
  failCredentialRead = false;
  consoleCalls = [];
  for (const method of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      consoleCalls.push(args);
    });
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await prisma.passwordResetToken.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.organizationMembership.deleteMany({ where: { organizationId: { in: orgIds } } });
  await prisma.organization.deleteMany({ where: { id: { in: orgIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await pool.end();
});

describe("session revocation on password reset", () => {
  it("REQUIRED (1): an existing session works before a reset and stops working after it; the cookie is cleared", async () => {
    const { user } = await makeStaffUser();
    const cookie = (await signIn(user.email, ORIGINAL))!;
    expect((await decodeCookie(cookie))?.cv).toBe(0);
    expect((await nodeSession(cookie)).session?.user?.id).toBe(user.id);

    expect(await resetPassword(user.id, "Brand-New-Passw0rd")).toEqual({ ok: true });
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).credentialsVersion).toBe(1);

    const after = await nodeSession(cookie);
    expect(after.session).toBeNull();
    expect(after.setCookie).toMatch(new RegExp(`^${SESSION_COOKIE}=;`)); // Auth.js clears the revoked cookie
  });

  it("REQUIRED (2): a middleware refresh re-encodes the cookie (new iat/exp) but cannot revive a revoked session", async () => {
    const { user } = await makeStaffUser();
    const cookie = (await signIn(user.email, ORIGINAL))!;
    await resetPassword(user.id, "Brand-New-Passw0rd");

    const { refreshed } = await middlewareRequest(cookie);
    expect(refreshed).toBeTruthy();
    const before = (await decodeCookie(cookie))!;
    const after = (await decodeCookie(refreshed!))!;
    expect(after.iat).toBeGreaterThanOrEqual(before.iat as number);
    expect(after.jti).not.toBe(before.jti);
    expect(after.cv).toBe(0); // the stale claim survives the refresh unchanged — it is never refreshed from the database

    expect((await nodeSession(refreshed!)).session).toBeNull();
  });

  it("REQUIRED (3): an organization/session update cannot revive a revoked session, and cannot change the claim", async () => {
    const { user, organization } = await makeStaffUser();
    const staleToken = (await signInToken(user.email, ORIGINAL))!;
    await resetPassword(user.id, "Brand-New-Passw0rd");

    const updated = await signInJwtCallback({
      token: staleToken,
      trigger: "update",
      session: { activeOrganizationId: organization.id, cv: 1, credentialsVersion: 1 },
    } as never);
    expect(updated).toBeNull();

    // A current session's update keeps its captured claim even when the update payload names another version.
    const fresh = (await signInToken(user.email, "Brand-New-Passw0rd"))!;
    const freshUpdated = await signInJwtCallback({ token: fresh, trigger: "update", session: { activeOrganizationId: organization.id, cv: 99 } } as never);
    expect(freshUpdated?.cv).toBe(1);
    const edgeUpdated = await authConfig.callbacks!.jwt!({ token: { ...fresh }, trigger: "update", session: { activeOrganizationId: organization.id, cv: 99 } } as never);
    expect((edgeUpdated as JWT).cv).toBe(1);
  });

  it("REQUIRED (4): a fresh login with the new password works; the old password fails", async () => {
    const { user } = await makeStaffUser();
    await resetPassword(user.id, "Brand-New-Passw0rd");

    expect(await signIn(user.email, ORIGINAL)).toBeNull();
    const cookie = (await signIn(user.email, "Brand-New-Passw0rd"))!;
    expect((await decodeCookie(cookie))?.cv).toBe(1);
    expect((await nodeSession(cookie)).session?.user?.id).toBe(user.id);
    const { refreshed } = await middlewareRequest(cookie);
    expect((await nodeSession(refreshed!)).session?.user?.id).toBe(user.id);
  });

  it("REQUIRED (5): a reset that commits between password verification and token issuance cannot authorize the old-password login", async () => {
    const { user } = await makeStaffUser();

    // The token is created BEFORE the gate: inserting a row that references the user takes FOR KEY SHARE on it, which
    // would wait behind the gate's FOR UPDATE.
    const raw = `raw-${uniq()}`;
    await prisma.passwordResetToken.create({ data: { userId: user.id, tokenHash: digestLookupSecret(raw, PEPPER), expiresAt: new Date(Date.now() + 3_600_000) } });

    // Hold the user row lock so the reset is pending while the old password is verified.
    const gate: PoolClient = await pool.connect();
    let released = false;
    const releaseGate = async () => {
      if (released) return;
      released = true;
      await gate.query("COMMIT");
      gate.release();
    };
    let verified: Awaited<ReturnType<typeof verifyCredentials>>;
    let reset: ReturnType<typeof redeemPasswordResetToken>;
    try {
      await gate.query("BEGIN");
      await gate.query(`SELECT 1 FROM "User" WHERE "id" = $1 FOR UPDATE`, [user.id]);
      reset = redeemPasswordResetToken({ rawToken: raw, newPassword: "Brand-New-Passw0rd" });
      let waiting = false;
      for (let i = 0; i < 500 && !waiting; i++) {
        const { rows } = await pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`);
        waiting = Number(rows[0].n) >= 1;
        if (!waiting) await new Promise((r) => setTimeout(r, 20));
      }
      expect(waiting, "the reset is blocked on the user lock").toBe(true);

      verified = await verifyCredentials(user.email, ORIGINAL); // reads the committed (old) row: old hash, version 0
      expect(verified?.credentialsVersion).toBe(0);
    } finally {
      await releaseGate();
    }
    expect(await reset!).toEqual({ ok: true }); // version is now 1

    // Token issuance happens AFTER the reset committed — it still carries the version read with the old password.
    const token = (await signInJwtCallback({ token: { sub: user.id, email: user.email, name: user.email }, user: verified!, trigger: "signIn" } as never))!;
    expect(token.cv).toBe(0);
    expect((await nodeSession(await encodeToken(token))).session).toBeNull();

    // And once the reset has committed, the old password cannot sign in at all.
    expect(await verifyCredentials(user.email, ORIGINAL)).toBeNull();
  });

  it("REQUIRED (6): failed and rolled-back resets do not revoke sessions", async () => {
    const { user } = await makeStaffUser();
    const cookie = (await signIn(user.email, ORIGINAL))!;

    expect(await redeemPasswordResetToken({ rawToken: `unknown-${uniq()}`, newPassword: "Never-Applied-0" })).toEqual({ ok: false, reason: "invalidToken" });

    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION revocation_test_block() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'synthetic rollback'; END; $$ LANGUAGE plpgsql`);
    await prisma.$executeRawUnsafe(
      `CREATE TRIGGER revocation_test_block BEFORE UPDATE OF "passwordHash" ON "User" FOR EACH ROW WHEN (NEW."id" = '${user.id}') EXECUTE FUNCTION revocation_test_block()`,
    );
    try {
      expect(await resetPassword(user.id, "Never-Applied-1")).toEqual({ ok: false, reason: "failed" });
    } finally {
      await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS revocation_test_block ON "User"`);
      await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS revocation_test_block()`);
    }

    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).credentialsVersion).toBe(0);
    expect((await nodeSession(cookie)).session?.user?.id).toBe(user.id);
  });

  it("REQUIRED (7): a legacy token without the claim counts as version 0 — valid until that user's first reset", async () => {
    const { user } = await makeStaffUser();
    const token = (await signInToken(user.email, ORIGINAL))!;
    delete token.cv;
    const legacy = await encodeToken(token);
    expect((await decodeCookie(legacy))?.cv).toBeUndefined();

    expect((await nodeSession(legacy)).session?.user?.id).toBe(user.id);
    const { refreshed } = await middlewareRequest(legacy);
    expect((await nodeSession(refreshed!)).session?.user?.id).toBe(user.id);

    await resetPassword(user.id, "Brand-New-Passw0rd");
    expect((await nodeSession(legacy)).session).toBeNull();
  });
});

describe("session checks never grant access on missing data or failures", () => {
  it("an inactive user's session is refused", async () => {
    const { user } = await makeStaffUser();
    const cookie = (await signIn(user.email, ORIGINAL))!;
    await prisma.user.update({ where: { id: user.id }, data: { active: false } });
    expect((await nodeSession(cookie)).session).toBeNull();
  });

  it("a session for a user that no longer exists is refused", async () => {
    const { user } = await makeStaffUser();
    const token = (await signInToken(user.email, ORIGINAL))!;
    expect((await nodeSession(await encodeToken({ ...token, id: "missing-user-id" }))).session).toBeNull();
  });

  it("a database failure during the check is refused and logged with a fixed event and sanitized code only", async () => {
    const { user } = await makeStaffUser();
    const cookie = (await signIn(user.email, ORIGINAL))!;
    failCredentialRead = true;
    const result = await nodeSession(cookie);
    failCredentialRead = false;
    expect(result.session).toBeNull();
    expect(consoleCalls).toContainEqual(["[session]", { event: "session.credentials_check_failed", error: "P1001" }]);
    expect(JSON.stringify(consoleCalls)).not.toContain("SYNTH-DB-SECRET");
  });

  it("a sign-in without a captured version is refused rather than guessed", async () => {
    const { user } = await makeStaffUser();
    const token = await signInJwtCallback({ token: { sub: user.id }, user: { id: user.id, email: user.email, name: user.email }, trigger: "signIn" } as never);
    expect(token).toBeNull();
  });

  it("login stays reachable with a revoked cookie: middleware lets /en/login through, no redirect", async () => {
    const { user } = await makeStaffUser();
    const cookie = (await signIn(user.email, ORIGINAL))!;
    await resetPassword(user.id, "Brand-New-Passw0rd");
    const { response } = await middlewareRequest(cookie, "/en/login");
    expect(response.headers.get("location") ?? "").not.toContain("/login");
    expect(response.status).toBeLessThan(300);
  });
});
