import "dotenv/config";
import { getTestPrismaClient } from "../helpers/test-db";
import { afterEach, describe, expect, it } from "vitest";
import { decode } from "next-auth/jwt";
import { hashSecret } from "../../src/lib/crypto";
import { requireEnv } from "../../src/lib/env";
import { signInJwtCallback, type JwtCallbackParams } from "../../src/lib/auth/sign-in-jwt-callback";

/**
 * The trust condition for src/app/api/e2e-auth-bypass/route.ts: every
 * screenshot taken through it is only evidence about production if the
 * session it mints is the SAME session real login would produce for that
 * user. This is not "both work" — it asserts equality of the actual token
 * claims, using `signInJwtCallback` called exactly the way src/auth.ts's
 * real `signIn()` flow calls it as the "real login" side of the
 * comparison, since both the bypass and real login literally call this
 * same function (see its own file for why that sharing is the point).
 */
const { POST } = await import("../../src/app/api/e2e-auth-bypass/route");

const SESSION_COOKIE_NAME = "authjs.session-token";
const REAL_SECRET = "test-only-bypass-secret-value";

const prisma = getTestPrismaClient();
const cleanupUserIds: string[] = [];
const cleanupOrganizationIds: string[] = [];

const mutableEnv = process.env as Record<string, string | undefined>;
function enableBypass() {
  mutableEnv.NODE_ENV = "development";
  mutableEnv.E2E_AUTH_BYPASS_SECRET = REAL_SECRET;
}

afterEach(async () => {
  if (cleanupOrganizationIds.length > 0) {
    await prisma.organizationMembership.deleteMany({ where: { organizationId: { in: cleanupOrganizationIds } } });
    await prisma.organization.deleteMany({ where: { id: { in: cleanupOrganizationIds } } });
  }
  if (cleanupUserIds.length > 0) {
    await prisma.user.deleteMany({ where: { id: { in: cleanupUserIds } } });
  }
  cleanupOrganizationIds.length = 0;
  cleanupUserIds.length = 0;
});

async function makeUserWithMembership(role: "ADMIN" | "STUDENT") {
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
  const user = await prisma.user.create({
    data: { email: `equality-${suffix}@example.com`, passwordHash: await hashSecret("irrelevant"), role },
  });
  cleanupUserIds.push(user.id);
  const organization = await prisma.organization.create({
    data: { slug: `equality-org-${suffix}`, name: `Equality Org ${suffix}`, status: "ACTIVE" },
  });
  cleanupOrganizationIds.push(organization.id);
  await prisma.organizationMembership.create({ data: { userId: user.id, organizationId: organization.id, role } });
  return { user, organization };
}

async function bypassToken(userId: string, organizationId?: string) {
  const response = await POST(
    new Request("http://localhost:3000/api/e2e-auth-bypass", {
      method: "POST",
      headers: { host: "localhost:3000", "content-type": "application/json" },
      body: JSON.stringify({ userId, secret: REAL_SECRET, ...(organizationId ? { organizationId } : {}) }),
    }),
  );
  expect(response.status).toBe(200);
  const setCookie = response.headers.get("set-cookie")!;
  const cookieValue = setCookie.split(";")[0].split("=").slice(1).join("=");
  return decode({ token: cookieValue, secret: requireEnv("AUTH_SECRET"), salt: SESSION_COOKIE_NAME });
}

/** Simulates exactly what src/auth.ts's real signIn() flow does: one call to the shared jwt callback with `user` present. */
async function realLoginToken(user: { id: string; email: string; role: string }) {
  return signInJwtCallback({
    token: { sub: user.id, email: user.email, name: user.email },
    user: { id: user.id, email: user.email, role: user.role, name: user.email },
    trigger: "signIn",
  } as JwtCallbackParams);
}

/** Claims that must be equal — excludes iat/exp/jti, which are legitimately fresh per call. */
function meaningfulClaims(token: Record<string, unknown> | null) {
  return {
    id: token?.id,
    sub: token?.sub,
    email: token?.email,
    name: token?.name,
    role: token?.role,
    activeOrganizationId: token?.activeOrganizationId,
    // The `{ staff, portal }` claim the middleware reads — the bypass must mint the SAME one.
    access: token?.access,
  };
}

describe("e2e-auth-bypass mints a session structurally identical to real login", () => {
  it("for a user with exactly one active membership: same id/role/email/name/activeOrganizationId", async () => {
    const { user, organization } = await makeUserWithMembership("ADMIN");
    enableBypass();

    const real = await realLoginToken(user);
    const bypass = await bypassToken(user.id);

    expect(meaningfulClaims(bypass)).toEqual(meaningfulClaims(real));
    expect(real.activeOrganizationId).toBe(organization.id);
    expect(bypass?.activeOrganizationId).toBe(organization.id);
    expect(real.access).toEqual({ staff: true, portal: false });
    expect(bypass?.access).toEqual({ staff: true, portal: false });
  });

  it("for a user with zero memberships: both resolve activeOrganizationId to null, never to something guessed", async () => {
    const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
    const user = await prisma.user.create({
      data: { email: `equality-orphan-${suffix}@example.com`, passwordHash: await hashSecret("irrelevant"), role: "STUDENT" },
    });
    cleanupUserIds.push(user.id);
    enableBypass();

    const real = await realLoginToken(user);
    const bypass = await bypassToken(user.id);

    expect(meaningfulClaims(bypass)).toEqual(meaningfulClaims(real));
    expect(real.activeOrganizationId).toBeNull();
  });

  it("an explicit organizationId given to the bypass matches what an explicit unstable_update() to that same org would produce via the shared callback", async () => {
    const { user, organization } = await makeUserWithMembership("ADMIN");
    // A second membership so the "no override" resolution alone would be
    // needsSelection (null) — proving the override path is what's under
    // test here, not the single-membership auto-resolve from the test above.
    const secondOrg = await prisma.organization.create({
      data: { slug: `equality-org-b-${Date.now()}`, name: "Equality Org B", status: "ACTIVE" },
    });
    cleanupOrganizationIds.push(secondOrg.id);
    await prisma.organizationMembership.create({ data: { userId: user.id, organizationId: secondOrg.id, role: "ADMIN" } });
    enableBypass();

    const realSignIn = await realLoginToken(user);
    const realAfterSwitch = await signInJwtCallback({
      token: realSignIn,
      trigger: "update",
      session: { activeOrganizationId: organization.id },
    } as JwtCallbackParams);
    const bypass = await bypassToken(user.id, organization.id);

    expect(meaningfulClaims(bypass)).toEqual(meaningfulClaims(realAfterSwitch));
    expect(bypass?.activeOrganizationId).toBe(organization.id);
  });
});
