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

async function makeOrgAndAdmin(status: "PENDING" | "ACTIVE" | "SUSPENDED" | "CANCELLED") {
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
    data: { userId: user.id, organizationId: organization.id, role: "ADMIN" },
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

  it("redirects to /login when there is no session at all", async () => {
    currentSession = null;
    expect(await redirectTargetOf(requireTenantContext())).toBe("/en/login");
  });

  it("redirects to /login when the session's active organization has no membership row", async () => {
    const { user } = await makeOrgAndAdmin("ACTIVE");
    currentSession = { user: { id: user.id, role: "ADMIN" }, activeOrganizationId: "no-such-organization-id" };
    expect(await redirectTargetOf(requireTenantContext())).toBe("/en/login");
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
});
