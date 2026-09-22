import "dotenv/config";
import { getTestPrismaClient } from "../helpers/test-db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/email/send-transactional-email", () => ({
  sendTransactionalEmail: vi.fn(async () => ({ success: true })),
}));
let currentSession: { user: { email: string } } | null = null;
vi.mock("@/auth", () => ({ auth: () => Promise.resolve(currentSession), signIn: vi.fn() }));

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

  // After joining, the page used to say "Sign in with the password you already have" — nonsense
  // for someone who is ALREADY signed in as the invitee (the usual case: a student promoted to
  // instructor, holding the link in the session they are using). The server, which has the
  // invitation's email, says whether the visitor's own session is the invitee's — without ever
  // putting the email on the wire.
  describe("whether the visitor is already signed in as the person invited", () => {
    it("REQUIRED: true only when the session's email IS the invited email (case-insensitively)", async () => {
      const email = `describe-signed-in-${suffix}@example.com`;
      const user = await prisma.user.create({ data: { email, passwordHash: await hashSecret("already-mine-pass-1"), role: "INSTRUCTOR", active: true } });
      userIds.push(user.id);
      const token = await issue(email);

      expect(await describeInvitation(token, email)).toMatchObject({ valid: true, alreadySignedIn: true });
      expect(await describeInvitation(token, email.toUpperCase())).toMatchObject({ alreadySignedIn: true });
    });

    it("REQUIRED: false for a different signed-in account, and for nobody signed in (they still need to sign in as the invitee)", async () => {
      const email = `describe-not-them-${suffix}@example.com`;
      const user = await prisma.user.create({ data: { email, passwordHash: await hashSecret("already-mine-pass-1"), role: "INSTRUCTOR", active: true } });
      userIds.push(user.id);
      const token = await issue(email);

      expect(await describeInvitation(token, `someone-else-${suffix}@example.com`)).toMatchObject({ valid: true, alreadySignedIn: false });
      expect(await describeInvitation(token, null)).toMatchObject({ alreadySignedIn: false });
      expect(await describeInvitation(token)).toMatchObject({ alreadySignedIn: false });
    });

    // The wiring, not just the function: the page reads the visitor's session and hands its email
    // to describeInvitation. Without this a correct function could sit unused (a page that never
    // passes the session says "sign in" to everyone, exactly as before).
    it("REQUIRED: the accept PAGE passes the visitor's session to it", async () => {
      const { default: AcceptInvitationPage } = await import("../../src/app/[locale]/accept-invitation/page");
      const email = `describe-page-${suffix}@example.com`;
      const user = await prisma.user.create({ data: { email, passwordHash: await hashSecret("already-mine-pass-1"), role: "INSTRUCTOR", active: true } });
      userIds.push(user.id);
      const token = await issue(email);
      const render = async () => {
        const tree = (await AcceptInvitationPage({
          params: Promise.resolve({ locale: "en" }),
          searchParams: Promise.resolve({ token }),
        })) as { props: { children: Array<{ props: { summary: { alreadySignedIn?: boolean } } }> } };
        return tree.props.children[1].props.summary.alreadySignedIn;
      };

      currentSession = { user: { email } };
      expect(await render()).toBe(true);
      currentSession = { user: { email: `someone-else-${suffix}@example.com` } };
      expect(await render()).toBe(false);
      currentSession = null;
      expect(await render()).toBe(false);
    });

    it("never reveals the invited email, and an invalid link still says nothing", async () => {
      const email = `describe-private-${suffix}@example.com`;
      const summary = await describeInvitation(await issue(email), email);
      expect(JSON.stringify(summary)).not.toContain(email);
      expect(await describeInvitation("not-a-real-token", email)).toEqual({ valid: false });
    });
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
