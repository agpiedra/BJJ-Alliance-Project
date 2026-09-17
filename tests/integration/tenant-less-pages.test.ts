import "dotenv/config";
import { getTestPrismaClient } from "../helpers/test-db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hashSecret } from "../../src/lib/crypto";

/**
 * MULTI_ACADEMY_AND_KIDS_BELTS.md: /select-organization and
 * /no-organization-access are authenticated but deliberately have no
 * tenant, which can go wrong in two opposite directions — this file rules
 * out both by test, not by reading the code:
 *
 * 1. NOT publicly reachable: middleware's matcher does not exclude these
 *    paths (only /api, /trpc, /_next, /_vercel, and files are), so an
 *    unauthenticated visitor reaching either page must be redirected to
 *    /login by the page's OWN check, same as every other real page.
 * 2. NOT behind requireTenantContext: a signed-in user with no resolved
 *    org must not be bounced BACK to /select-organization from
 *    /select-organization itself — that's an infinite redirect loop with
 *    no way out. Both pages call `auth()` directly for exactly this
 *    reason; this proves it, rather than trusting the comment saying so.
 *
 * Also: `selectOrganization()` must never trust a submitted organizationId
 * without re-validating it's a real, ACTIVE membership for the signed-in
 * user — the same discipline the e2e bypass and every mutating action in
 * this app already apply.
 */
let currentSession: { user: { id: string; role: string } | null } | null = null;

vi.mock("@/auth", () => ({
  auth: () => Promise.resolve(currentSession),
  unstable_update: vi.fn(),
}));
vi.mock("next-intl/server", () => ({
  getTranslations: async () => (key: string) => key,
}));

const { default: NoOrganizationAccessPage } = await import(
  "../../src/app/[locale]/no-organization-access/page"
);
const { default: SelectOrganizationPage } = await import("../../src/app/[locale]/select-organization/page");
const { selectOrganization } = await import("../../src/app/[locale]/select-organization/actions");
const { unstable_update } = await import("@/auth");

const prisma = getTestPrismaClient();
const cleanupUserIds: string[] = [];
const cleanupOrganizationIds: string[] = [];

afterEach(async () => {
  currentSession = null;
  vi.clearAllMocks();
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

function suffix() {
  return `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
}

async function makeUserWithMemberships(count: 0 | 2) {
  const user = await prisma.user.create({
    data: { email: `tenantless-${suffix()}@example.com`, passwordHash: await hashSecret("irrelevant"), role: "ADMIN" },
  });
  cleanupUserIds.push(user.id);
  const orgs = [];
  for (let i = 0; i < count; i++) {
    const org = await prisma.organization.create({
      data: { slug: `tenantless-org-${suffix()}`, name: `Tenantless Org ${suffix()}`, status: "ACTIVE" },
    });
    cleanupOrganizationIds.push(org.id);
    await prisma.organizationMembership.create({ data: { userId: user.id, organizationId: org.id, role: "ADMIN" } });
    orgs.push(org);
  }
  return { user, orgs };
}

/** Extracts the redirect target from the `NEXT_REDIRECT` error `redirect()` throws, or returns null if the call didn't redirect at all. */
async function redirectTargetOf(promise: Promise<unknown>): Promise<string | null> {
  try {
    await promise;
    return null;
  } catch (error) {
    const digest = (error as { digest?: string }).digest;
    if (typeof digest === "string" && digest.startsWith("NEXT_REDIRECT")) {
      return digest.split(";")[2];
    }
    throw error;
  }
}

describe("/no-organization-access is not publicly reachable and does not loop", () => {
  it("redirects an unauthenticated visitor to /login", async () => {
    currentSession = null;
    const target = await redirectTargetOf(
      NoOrganizationAccessPage({ params: Promise.resolve({ locale: "en" }) }),
    );
    expect(target).toBe("/en/login");
  });

  it("does not redirect a signed-in user (renders in place — no loop back through requireTenantContext)", async () => {
    const { user } = await makeUserWithMemberships(0);
    currentSession = { user: { id: user.id, role: "ADMIN" } };
    const target = await redirectTargetOf(
      NoOrganizationAccessPage({ params: Promise.resolve({ locale: "en" }) }),
    );
    expect(target).toBeNull();
  });
});

describe("/select-organization is not publicly reachable and does not loop", () => {
  it("redirects an unauthenticated visitor to /login", async () => {
    currentSession = null;
    const target = await redirectTargetOf(
      SelectOrganizationPage({
        params: Promise.resolve({ locale: "en" }),
        searchParams: Promise.resolve({}),
      }),
    );
    expect(target).toBe("/en/login");
  });

  it("does not redirect a signed-in user with 2+ memberships (renders the picker — no loop back through requireTenantContext)", async () => {
    const { user } = await makeUserWithMemberships(2);
    currentSession = { user: { id: user.id, role: "ADMIN" } };
    const target = await redirectTargetOf(
      SelectOrganizationPage({
        params: Promise.resolve({ locale: "en" }),
        searchParams: Promise.resolve({}),
      }),
    );
    expect(target).toBeNull();
  });
});

describe("selectOrganization() never trusts a submitted organizationId without re-validating membership", () => {
  function formData(organizationId: string): FormData {
    const fd = new FormData();
    fd.set("organizationId", organizationId);
    return fd;
  }

  it("rejects an organizationId the user has no active membership in — does not call unstable_update, redirects back to the picker", async () => {
    const { user } = await makeUserWithMemberships(2);
    const otherOrg = await prisma.organization.create({
      data: { slug: `tenantless-notmine-${suffix()}`, name: "Not Mine", status: "ACTIVE" },
    });
    cleanupOrganizationIds.push(otherOrg.id);
    currentSession = { user: { id: user.id, role: "ADMIN" } };

    const target = await redirectTargetOf(selectOrganization("en", undefined, formData(otherOrg.id)));

    expect(target).toBe("/en/select-organization");
    expect(unstable_update).not.toHaveBeenCalled();
  });

  it("accepts an organizationId the user IS an active member of — calls unstable_update and redirects onward", async () => {
    const { user, orgs } = await makeUserWithMemberships(2);
    currentSession = { user: { id: user.id, role: "ADMIN" } };

    const target = await redirectTargetOf(selectOrganization("en", undefined, formData(orgs[0].id)));

    expect(unstable_update).toHaveBeenCalledWith({ activeOrganizationId: orgs[0].id });
    expect(target).toBe("/en/dashboard");
  });
});
