import "dotenv/config";
import { getTestPrismaClient } from "../helpers/test-db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/email/send-transactional-email", () => ({
  sendTransactionalEmail: vi.fn(async () => ({ success: true })),
}));
vi.mock("@/auth", () => ({ auth: () => Promise.resolve(null), signIn: vi.fn() }));

const { approveOrganization } = await import("../../src/lib/organizations/approve-organization");
const { describeInvitation } = await import("../../src/lib/staff/describe-invitation");
const { hashSecret, digestLookupSecret, generateRandomToken } = await import("../../src/lib/crypto");
const { requireEnv } = await import("../../src/lib/env");

const prisma = getTestPrismaClient();

/**
 * The accept page shows a password field only when `describeInvitation` says a
 * password is needed, and `acceptInvitation` independently decides the same
 * thing (`!user || !user.active`). If the two ever disagreed, someone would be
 * asked for a password the action then ignores — or, worse, never asked for one
 * the action requires. This pins the page's half of that agreement.
 */
const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
const orgIds: string[] = [];
const userIds: string[] = [];
let organizationId: string;

async function issue(email: string, over: { usedAt?: Date; revokedAt?: Date; expiresAt?: Date } = {}) {
  const token = generateRandomToken();
  await prisma.invitation.create({
    data: {
      tokenHash: digestLookupSecret(token, requireEnv("CODE_PEPPER")),
      email,
      organizationId,
      role: "INSTRUCTOR",
      academyIds: [],
      expiresAt: over.expiresAt ?? new Date(Date.now() + 86_400_000),
      usedAt: over.usedAt,
      revokedAt: over.revokedAt,
    },
  });
  return token;
}

describe("describeInvitation tells the accept page whether a password is needed", () => {
  beforeAll(async () => {
    const approver = await prisma.user.create({
      data: { email: `describe-approver-${suffix}@example.com`, passwordHash: await hashSecret("irrelevant-password-123"), role: "ADMIN", isSuperAdmin: true },
    });
    userIds.push(approver.id);
    const organization = await prisma.organization.create({
      data: { slug: `describe-${suffix}`, name: `Describe ${suffix}`, status: "PENDING", city: "Heredia", contactEmail: `describe-owner-${suffix}@example.com` },
    });
    orgIds.push(organization.id);
    organizationId = organization.id;
    await approveOrganization(organization.slug, approver.id);
    userIds.push((await prisma.user.findUniqueOrThrow({ where: { email: `describe-owner-${suffix}@example.com` } })).id);
  });

  afterAll(async () => {
    await prisma.auditLog.deleteMany({ where: { organizationId: { in: orgIds } } });
    await prisma.invitation.deleteMany({ where: { organizationId: { in: orgIds } } });
    await prisma.paymentPlan.deleteMany({ where: { organizationId: { in: orgIds } } });
    await prisma.organizationMembership.deleteMany({ where: { organizationId: { in: orgIds } } });
    await prisma.academy.deleteMany({ where: { organizationId: { in: orgIds } } });
    await prisma.organization.deleteMany({ where: { id: { in: orgIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  });

  it("REQUIRED: a person with no account, and an unaccepted placeholder, are asked to set a password", async () => {
    const brandNew = await describeInvitation(await issue(`describe-new-${suffix}@example.com`));
    expect(brandNew).toMatchObject({ valid: true, mode: "setPassword", role: "INSTRUCTOR" });

    // The unaccepted Owner placeholder approval created (active: false).
    const placeholder = await prisma.user.findUniqueOrThrow({ where: { email: `describe-owner-${suffix}@example.com` } });
    expect(placeholder.active).toBe(false);
    expect(await describeInvitation(await issue(placeholder.email))).toMatchObject({ valid: true, mode: "setPassword" });
  });

  it("REQUIRED: someone who already has an active account is only offered to join — never asked for a password", async () => {
    const email = `describe-existing-${suffix}@example.com`;
    const user = await prisma.user.create({ data: { email, passwordHash: await hashSecret("already-mine-pass-1"), role: "INSTRUCTOR", active: true } });
    userIds.push(user.id);

    const summary = await describeInvitation(await issue(email));

    expect(summary).toMatchObject({ valid: true, mode: "join" });
    expect((summary as { organizationName: string }).organizationName).toContain("Describe");
  });

  it("a used, revoked, expired or unknown link is just invalid — with no hint which", async () => {
    const email = `describe-dead-${suffix}@example.com`;
    for (const over of [{ usedAt: new Date() }, { revokedAt: new Date() }, { expiresAt: new Date(Date.now() - 1000) }]) {
      expect(await describeInvitation(await issue(email, over))).toEqual({ valid: false });
    }
    expect(await describeInvitation("not-a-real-token")).toEqual({ valid: false });
    expect(await describeInvitation("")).toEqual({ valid: false });
  });
});
