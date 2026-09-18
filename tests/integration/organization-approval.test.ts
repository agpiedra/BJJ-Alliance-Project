import "dotenv/config";
import { getTestPrismaClient } from "../helpers/test-db";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { hashSecret } from "../../src/lib/crypto";

const sendTransactionalEmailMock = vi.fn(async (_to: string, _subject: string, _bodyLines: string[]) => ({ success: true }));
vi.mock("@/lib/email/send-transactional-email", () => ({
  sendTransactionalEmail: (...args: [string, string, string[]]) => sendTransactionalEmailMock(...args),
}));

// Same NEXT_REDIRECT-throwing mock login-actions.test.ts uses — signIn()
// must carry out its own redirect (never `redirect: false`), so a real test
// simulates that by throwing the same digest Next's real redirect() throws.
vi.mock("@/auth", () => ({
  signIn: vi.fn((_provider: string, options: { redirectTo: string }) => {
    const error = new Error("NEXT_REDIRECT");
    (error as { digest?: string }).digest = `NEXT_REDIRECT;push;${options.redirectTo};307;`;
    throw error;
  }),
}));

const { approveOrganization, OrganizationNotApprovableError } = await import(
  "../../src/lib/organizations/approve-organization"
);
const { acceptInvitation } = await import("../../src/app/[locale]/accept-invitation/actions");

const prisma = getTestPrismaClient();

const cleanupOrgIds: string[] = [];
const cleanupUserIds: string[] = [];

async function cleanup() {
  if (cleanupOrgIds.length > 0) {
    await prisma.invitation.deleteMany({ where: { organizationId: { in: cleanupOrgIds } } });
    await prisma.organizationMembership.deleteMany({ where: { organizationId: { in: cleanupOrgIds } } });
    await prisma.academy.deleteMany({ where: { organizationId: { in: cleanupOrgIds } } });
    await prisma.organization.deleteMany({ where: { id: { in: cleanupOrgIds } } });
  }
  if (cleanupUserIds.length > 0) {
    await prisma.user.deleteMany({ where: { id: { in: cleanupUserIds } } });
  }
}

function uniqueSuffix(): string {
  return `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
}

async function makePendingOrganization(overrides: Partial<{ contactEmail: string; city: string; status: "PENDING" | "ACTIVE" | "SUSPENDED" | "CANCELLED" }> = {}) {
  const suffix = uniqueSuffix();
  const org = await prisma.organization.create({
    data: {
      slug: `approval-test-${suffix}`,
      name: `Approval Test ${suffix}`,
      status: overrides.status ?? "PENDING",
      city: overrides.city ?? "Test City",
      contactEmail: overrides.contactEmail ?? `director-${suffix}@example.com`,
    },
  });
  cleanupOrgIds.push(org.id);
  return org;
}

async function makeSuperAdmin() {
  const suffix = uniqueSuffix();
  const user = await prisma.user.create({
    data: {
      email: `super-${suffix}@example.com`,
      passwordHash: await hashSecret("irrelevant-password-123"),
      role: "ADMIN",
      isSuperAdmin: true,
    },
  });
  cleanupUserIds.push(user.id);
  return user;
}

/** Extracts the redirect target from the NEXT_REDIRECT error acceptInvitation() throws on success. */
async function redirectTargetOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    const digest = (error as { digest?: string }).digest;
    if (typeof digest === "string" && digest.startsWith("NEXT_REDIRECT")) {
      return digest.split(";")[2]!;
    }
    throw error;
  }
  throw new Error("expected acceptInvitation() to redirect, but it resolved instead");
}

describe("approveOrganization", () => {
  afterAll(cleanup);
  afterEach(() => sendTransactionalEmailMock.mockClear());

  it("approves a PENDING org: status -> ACTIVE, default academy named after the city, new director (placeholder password, inactive), membership, invitation", async () => {
    const org = await makePendingOrganization({ city: "Cartago" });
    const approver = await makeSuperAdmin();

    const result = await approveOrganization(org.slug, approver.id);

    const updated = await prisma.organization.findUniqueOrThrow({ where: { id: org.id } });
    expect(updated.status).toBe("ACTIVE");
    expect(updated.approvedById).toBe(approver.id);
    expect(updated.approvedAt).not.toBeNull();

    const academy = await prisma.academy.findFirstOrThrow({ where: { organizationId: org.id } });
    expect(academy.name).toBe("Cartago");
    expect(academy.slug).toBe(org.slug);
    expect(result.kioskToken).not.toBeNull();

    const director = await prisma.user.findUniqueOrThrow({ where: { email: org.contactEmail! } });
    cleanupUserIds.push(director.id);
    expect(director.active).toBe(false);
    expect(director.role).toBe("DIRECTOR");

    const membership = await prisma.organizationMembership.findUniqueOrThrow({
      where: { userId_organizationId: { userId: director.id, organizationId: org.id } },
    });
    expect(membership.role).toBe("DIRECTOR");

    expect(result.invitationLink).toContain("/accept-invitation?token=");
    const invitationCount = await prisma.invitation.count({ where: { organizationId: org.id, usedAt: null } });
    expect(invitationCount).toBe(1);

    expect(sendTransactionalEmailMock).toHaveBeenCalledTimes(1);
  });

  it("is idempotent: approving twice produces exactly one branch, one membership, and one VALID invitation", async () => {
    const org = await makePendingOrganization();
    const approver = await makeSuperAdmin();

    const first = await approveOrganization(org.slug, approver.id);
    const second = await approveOrganization(org.slug, approver.id);

    const director = await prisma.user.findUniqueOrThrow({ where: { email: org.contactEmail! } });
    cleanupUserIds.push(director.id);

    const academyCount = await prisma.academy.count({ where: { organizationId: org.id } });
    expect(academyCount).toBe(1);
    expect(second.kioskToken).toBeNull(); // no new token minted on the retry

    const membershipCount = await prisma.organizationMembership.count({ where: { organizationId: org.id } });
    expect(membershipCount).toBe(1);

    const validInvitations = await prisma.invitation.count({ where: { organizationId: org.id, usedAt: null } });
    expect(validInvitations).toBe(1); // the first invitation's token was invalidated on resend

    expect(first.invitationLink).not.toBe(second.invitationLink);
  });

  it("reuses an existing User's identity without overwriting its password or active state (Phase 1 multi-organization case)", async () => {
    const suffix = uniqueSuffix();
    const existingEmail = `existing-${suffix}@example.com`;
    const existing = await prisma.user.create({
      data: { email: existingEmail, passwordHash: await hashSecret("their-real-password-123"), role: "INSTRUCTOR", active: true },
    });
    cleanupUserIds.push(existing.id);

    const org = await makePendingOrganization({ contactEmail: existingEmail });
    const approver = await makeSuperAdmin();
    await approveOrganization(org.slug, approver.id);

    const unchanged = await prisma.user.findUniqueOrThrow({ where: { id: existing.id } });
    expect(unchanged.passwordHash).toBe(existing.passwordHash);
    expect(unchanged.active).toBe(true);
    expect(unchanged.role).toBe("INSTRUCTOR"); // User.role column untouched — membership is the real grant

    const membership = await prisma.organizationMembership.findUniqueOrThrow({
      where: { userId_organizationId: { userId: existing.id, organizationId: org.id } },
    });
    expect(membership.role).toBe("DIRECTOR");
  });

  it("refuses to approve a SUSPENDED or CANCELLED organization", async () => {
    const org = await makePendingOrganization({ status: "SUSPENDED" });
    const approver = await makeSuperAdmin();

    await expect(approveOrganization(org.slug, approver.id)).rejects.toThrow(OrganizationNotApprovableError);
  });
});

describe("acceptInvitation", () => {
  afterAll(cleanup);

  it("valid token: sets the real password, activates the account, marks the invitation used, and signs in", async () => {
    const org = await makePendingOrganization();
    const approver = await makeSuperAdmin();
    const { invitationLink } = await approveOrganization(org.slug, approver.id);
    const director = await prisma.user.findUniqueOrThrow({ where: { email: org.contactEmail! } });
    cleanupUserIds.push(director.id);

    const token = new URL(invitationLink!).searchParams.get("token")!;
    const fd = new FormData();
    fd.set("token", token);
    fd.set("password", "MyRealPassword123!");

    const redirectTarget = await redirectTargetOf(acceptInvitation("en", {}, fd));
    expect(redirectTarget).toBe("/en/onboarding");

    const updated = await prisma.user.findUniqueOrThrow({ where: { id: director.id } });
    expect(updated.active).toBe(true);
    expect(updated.passwordHash).not.toBe(director.passwordHash);

    const invitation = await prisma.invitation.findFirstOrThrow({ where: { organizationId: org.id } });
    expect(invitation.usedAt).not.toBeNull();
  });

  it("invalid token is refused, never a 500", async () => {
    const fd = new FormData();
    fd.set("token", "this-token-does-not-exist");
    fd.set("password", "MyRealPassword123!");

    const result = await acceptInvitation("en", {}, fd);
    expect(result.error).toBe("invalidToken");
  });

  it("an already-used token cannot be replayed", async () => {
    const org = await makePendingOrganization();
    const approver = await makeSuperAdmin();
    const { invitationLink } = await approveOrganization(org.slug, approver.id);
    const director = await prisma.user.findUniqueOrThrow({ where: { email: org.contactEmail! } });
    cleanupUserIds.push(director.id);

    const token = new URL(invitationLink!).searchParams.get("token")!;
    const fd = () => {
      const f = new FormData();
      f.set("token", token);
      f.set("password", "MyRealPassword123!");
      return f;
    };

    await redirectTargetOf(acceptInvitation("en", {}, fd()));
    const replay = await acceptInvitation("en", {}, fd());
    expect(replay.error).toBe("invalidToken");
  });
});
