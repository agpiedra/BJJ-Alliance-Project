import "dotenv/config";
import { getTestPrismaClient } from "../helpers/test-db";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { decode } from "next-auth/jwt";
import { hashSecret } from "../../src/lib/crypto";
import { requireEnv } from "../../src/lib/env";

/**
 * MULTI_ACADEMY_AND_KIDS_BELTS.md-adjacent dev-only backdoor for Playwright
 * screenshot verification — see the two open KNOWN_LIMITATIONS entries in
 * scripts/pending-callers.ts this route works around: real login's `signIn`
 * cookie failure, and requireTenantContext() redirecting any session whose
 * `activeOrganizationId` is still null (true of every real login today).
 * This file's job is proving every gate actually gates: each disabling
 * condition must produce the *same* 404 a nonexistent route would, the one
 * enabled case must produce a real, decodable session cookie for exactly
 * the requested user, and org selection must go through a real
 * `OrganizationMembership` row — never an unchecked value.
 */
const { POST } = await import("../../src/app/api/e2e-auth-bypass/route");

const SESSION_COOKIE_NAME = "authjs.session-token";
const REAL_SECRET = "test-only-bypass-secret-value";

const prisma = getTestPrismaClient();
const cleanupUserIds: string[] = [];
const cleanupOrganizationIds: string[] = [];

async function makeUser(role: "ADMIN" | "STUDENT", label: string, active = true) {
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
  const email = `${label}-${suffix}@example.com`;
  const user = await prisma.user.create({
    data: { email, passwordHash: await hashSecret("irrelevant-password-123"), role, active },
  });
  cleanupUserIds.push(user.id);
  return user;
}

async function makeOrganizationMembership(userId: string, role: "ADMIN" | "STUDENT") {
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
  const organization = await prisma.organization.create({
    data: { slug: `bypass-org-${suffix}`, name: `Bypass Test Org ${suffix}` },
  });
  cleanupOrganizationIds.push(organization.id);
  await prisma.organizationMembership.create({
    data: { userId, organizationId: organization.id, role },
  });
  return organization;
}

function request(body: unknown, host = "localhost:3000"): Request {
  return new Request("http://localhost:3000/api/e2e-auth-bypass", {
    method: "POST",
    headers: { host, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const mutableEnv = process.env as Record<string, string | undefined>;

function setEnv(nodeEnv: string | undefined, secret: string | undefined) {
  if (nodeEnv === undefined) delete mutableEnv.NODE_ENV;
  else mutableEnv.NODE_ENV = nodeEnv;
  if (secret === undefined) delete mutableEnv.E2E_AUTH_BYPASS_SECRET;
  else mutableEnv.E2E_AUTH_BYPASS_SECRET = secret;
}

describe("POST /api/e2e-auth-bypass", () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalSecret = process.env.E2E_AUTH_BYPASS_SECRET;

  afterEach(() => {
    setEnv(originalNodeEnv, originalSecret);
  });

  afterAll(async () => {
    if (cleanupOrganizationIds.length > 0) {
      await prisma.organizationMembership.deleteMany({ where: { organizationId: { in: cleanupOrganizationIds } } });
      await prisma.organization.deleteMany({ where: { id: { in: cleanupOrganizationIds } } });
    }
    if (cleanupUserIds.length > 0) {
      await prisma.notification.deleteMany({ where: { userId: { in: cleanupUserIds } } });
      await prisma.user.deleteMany({ where: { id: { in: cleanupUserIds } } });
    }
  });

  it("is inert when NODE_ENV is production, even with the correct secret and a valid user", async () => {
    const user = await makeUser("ADMIN", "bypass-prod");
    setEnv("production", REAL_SECRET);

    const response = await POST(request({ userId: user.id, secret: REAL_SECRET }));

    expect(response.status).toBe(404);
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("is inert when E2E_AUTH_BYPASS_SECRET is unset, even outside production", async () => {
    const user = await makeUser("ADMIN", "bypass-nosecret");
    setEnv("development", undefined);

    const response = await POST(request({ userId: user.id, secret: "anything" }));

    expect(response.status).toBe(404);
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("is inert for a non-local Host header", async () => {
    const user = await makeUser("ADMIN", "bypass-remote-host");
    setEnv("development", REAL_SECRET);

    const response = await POST(request({ userId: user.id, secret: REAL_SECRET }, "attacker.example.com"));

    expect(response.status).toBe(404);
  });

  it("is inert for a wrong secret", async () => {
    const user = await makeUser("ADMIN", "bypass-wrong-secret");
    setEnv("development", REAL_SECRET);

    const response = await POST(request({ userId: user.id, secret: "not-the-secret" }));

    expect(response.status).toBe(404);
  });

  it("is inert for a nonexistent or inactive user id", async () => {
    const inactiveUser = await makeUser("ADMIN", "bypass-inactive", false);
    setEnv("development", REAL_SECRET);

    const nonexistent = await POST(request({ userId: "not-a-real-id", secret: REAL_SECRET }));
    const inactive = await POST(request({ userId: inactiveUser.id, secret: REAL_SECRET }));

    expect(nonexistent.status).toBe(404);
    expect(inactive.status).toBe(404);
  });

  it("mints a working session cookie for an existing active user when every gate passes", async () => {
    const user = await makeUser("STUDENT", "bypass-success");
    setEnv("development", REAL_SECRET);

    const response = await POST(request({ userId: user.id, secret: REAL_SECRET }));
    expect(response.status).toBe(200);

    const setCookie = response.headers.get("set-cookie");
    expect(setCookie).toBeTruthy();
    const cookieValue = setCookie!.split(";")[0].split("=").slice(1).join("=");

    const token = await decode({
      token: cookieValue,
      secret: requireEnv("AUTH_SECRET"),
      salt: SESSION_COOKIE_NAME,
    });

    expect(token?.id).toBe(user.id);
    expect(token?.role).toBe("STUDENT");
  });

  it("auto-selects the user's real organization membership when one exists", async () => {
    const user = await makeUser("ADMIN", "bypass-org-auto");
    const organization = await makeOrganizationMembership(user.id, "ADMIN");
    setEnv("development", REAL_SECRET);

    const response = await POST(request({ userId: user.id, secret: REAL_SECRET }));
    expect(response.status).toBe(200);

    const cookieValue = response.headers.get("set-cookie")!.split(";")[0].split("=").slice(1).join("=");
    const token = await decode({ token: cookieValue, secret: requireEnv("AUTH_SECRET"), salt: SESSION_COOKIE_NAME });

    expect(token?.activeOrganizationId).toBe(organization.id);
  });

  it("rejects a requested organizationId the user has no membership in, writing nothing", async () => {
    const user = await makeUser("ADMIN", "bypass-org-mismatch");
    await makeOrganizationMembership(user.id, "ADMIN");
    const otherOrganization = await prisma.organization.create({
      data: { slug: `bypass-other-org-${Date.now()}`, name: "Other Org" },
    });
    cleanupOrganizationIds.push(otherOrganization.id);
    setEnv("development", REAL_SECRET);

    const response = await POST(
      request({ userId: user.id, secret: REAL_SECRET, organizationId: otherOrganization.id }),
    );

    expect(response.status).toBe(404);
    expect(response.headers.get("set-cookie")).toBeNull();
  });
});
