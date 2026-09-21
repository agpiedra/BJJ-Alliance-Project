import "dotenv/config";
import { getTestPrismaClient } from "../helpers/test-db";
import { afterAll, describe, expect, it, vi } from "vitest";
import { hashSecret } from "../../src/lib/crypto";

// Same `auth()` / `next-intl/server` mocks as student-session.test.ts /
// self-check-in-action.test.ts — `requireTenantContext`'s redirect branches
// call `getLocale()` (request-scoped machinery that doesn't exist in a plain
// integration test) and `auth()` (the real NextAuth session).
let currentSession: { user: { id: string; role: string } | null; activeOrganizationId?: string } | null = null;

vi.mock("@/auth", () => ({
  auth: () => Promise.resolve(currentSession),
}));

vi.mock("next-intl/server", () => ({
  getLocale: () => Promise.resolve("en"),
}));

const { requireTenantContext } = await import("../../src/lib/tenant/context");

const prisma = getTestPrismaClient();

const cleanupUserIds: string[] = [];
const cleanupOrganizationIds: string[] = [];

async function cleanup() {
  if (cleanupUserIds.length > 0) {
    await prisma.organizationMembership.deleteMany({ where: { userId: { in: cleanupUserIds } } });
    await prisma.user.deleteMany({ where: { id: { in: cleanupUserIds } } });
  }
  if (cleanupOrganizationIds.length > 0) {
    await prisma.organization.deleteMany({ where: { id: { in: cleanupOrganizationIds } } });
  }
}

function suffix() {
  return `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
}

async function makeOrgAndAdmin(
  status: "PENDING" | "ACTIVE" | "SUSPENDED" | "CANCELLED",
  membershipRole: "ADMIN" | "INSTRUCTOR" = "ADMIN",
) {
  const s = suffix();
  const organization = await prisma.organization.create({
    data: { slug: `require-ctx-org-${s}`, name: `Require Ctx Org ${s}`, status },
  });
  cleanupOrganizationIds.push(organization.id);

  const user = await prisma.user.create({
    data: {
      email: `require-ctx-${s}@example.com`,
      passwordHash: await hashSecret("irrelevant-password-123"),
      role: "ADMIN",
      active: true,
    },
  });
  cleanupUserIds.push(user.id);

  await prisma.organizationMembership.create({
    data: { userId: user.id, organizationId: organization.id, role: membershipRole },
  });

  return { organization, user };
}

/** Extracts the redirect target from the `NEXT_REDIRECT` error `redirect()` throws. */
async function redirectTargetOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    const digest = (error as { digest?: string }).digest;
    if (typeof digest === "string" && digest.startsWith("NEXT_REDIRECT")) {
      // digest shape: "NEXT_REDIRECT;<type>;<url>;<statusCode>;"
      return digest.split(";")[2];
    }
    throw error;
  }
  throw new Error("expected requireTenantContext() to redirect, but it resolved instead");
}

describe("requireTenantContext", () => {
  afterAll(cleanup);

  it("redirects to /login when there is no session at all (the genuinely UNAUTHENTICATED case)", async () => {
    currentSession = null;
    expect(await redirectTargetOf(requireTenantContext())).toBe("/en/login");
  });

  it("redirects to /select-organization when a signed-in user has 2+ active memberships and no resolved selector", async () => {
    const { user } = await makeOrgAndAdmin("ACTIVE");
    const s = suffix();
    const orgB = await prisma.organization.create({
      data: { slug: `require-ctx-org-b-${s}`, name: `Require Ctx Org B ${s}`, status: "ACTIVE" },
    });
    cleanupOrganizationIds.push(orgB.id);
    await prisma.organizationMembership.create({ data: { userId: user.id, organizationId: orgB.id, role: "ADMIN" } });

    currentSession = { user: { id: user.id, role: "ADMIN" }, activeOrganizationId: undefined };
    expect(await redirectTargetOf(requireTenantContext())).toBe("/en/select-organization");
  });

  it("redirects to /no-organization-access (NOT /login) when the session's active organization has no membership row — the user IS authenticated, this is a different failure", async () => {
    const { user } = await makeOrgAndAdmin("ACTIVE");
    currentSession = { user: { id: user.id, role: "ADMIN" }, activeOrganizationId: "no-such-organization-id" };
    expect(await redirectTargetOf(requireTenantContext())).toBe("/en/no-organization-access");
  });

  // 1e: the exact fix — ORG_NOT_ACTIVE must NOT fall into the same /login
  // redirect as NO_MEMBERSHIP (spec: "a clear localized message, not a
  // generic auth error"), for all three non-ACTIVE statuses.
  it("redirects to /organization-unavailable — NOT /login — for PENDING, SUSPENDED, and CANCELLED organizations", async () => {
    for (const status of ["PENDING", "SUSPENDED", "CANCELLED"] as const) {
      const { organization, user } = await makeOrgAndAdmin(status);
      currentSession = { user: { id: user.id, role: "ADMIN" }, activeOrganizationId: organization.id };
      expect(await redirectTargetOf(requireTenantContext())).toBe("/en/organization-unavailable");
    }
  });

  it("does not redirect and returns the real tenant context when the organization is ACTIVE", async () => {
    const { organization, user } = await makeOrgAndAdmin("ACTIVE");
    currentSession = { user: { id: user.id, role: "ADMIN" }, activeOrganizationId: organization.id };

    const context = await requireTenantContext();

    expect(context.organizationId).toBe(organization.id);
    expect(context.organizationRole).toBe("ADMIN");
  });

  // The wrong-role case used to throw a bare Error("FORBIDDEN") — an unhandled
  // raw 500 on every Owner-only page. A member without the role is refused the
  // same way a non-member is refused on /platform: a real notFound() (HTTP 404),
  // so the route does not announce that it exists.
  describe("a genuine member without the required role", () => {
    async function digestOf(promise: Promise<unknown>): Promise<string | undefined> {
      try {
        await promise;
      } catch (error) {
        return (error as { digest?: string }).digest;
      }
      throw new Error("expected requireTenantContext() to refuse, but it resolved");
    }

    it("gets a real notFound() (404), not a thrown FORBIDDEN error", async () => {
      const { organization, user } = await makeOrgAndAdmin("ACTIVE", "INSTRUCTOR");
      currentSession = { user: { id: user.id, role: "INSTRUCTOR" }, activeOrganizationId: organization.id };

      const digest = await digestOf(requireTenantContext(["ADMIN"]));

      expect(digest).toContain("404");
    });

    it("is still let through when their role IS allowed (control: the refusal is about the role, not the user)", async () => {
      const { organization, user } = await makeOrgAndAdmin("ACTIVE", "INSTRUCTOR");
      currentSession = { user: { id: user.id, role: "INSTRUCTOR" }, activeOrganizationId: organization.id };

      const context = await requireTenantContext(["ADMIN", "INSTRUCTOR"]);

      expect(context.organizationRole).toBe("INSTRUCTOR");
    });

    it("does not turn the other refusals into 404s: an unauthenticated visitor still goes to /login, whatever roles the page asks for", async () => {
      currentSession = null;
      expect(await redirectTargetOf(requireTenantContext(["ADMIN"]))).toBe("/en/login");
    });
  });
});
