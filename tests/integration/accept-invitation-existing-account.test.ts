import "dotenv/config";
import { getTestPrismaClient } from "../helpers/test-db";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/email/send-transactional-email", () => ({
  sendTransactionalEmail: vi.fn(async () => ({ success: true })),
}));

// signIn() carries out its own redirect, so a real accept ends in a NEXT_REDIRECT
// throw. Counting its calls is how these tests tell "a session was minted" from
// "no session was minted" — an existing account must NOT get one from a link.
const signInMock = vi.fn((_provider: string, options: { redirectTo: string }) => {
  const error = new Error("NEXT_REDIRECT");
  (error as { digest?: string }).digest = `NEXT_REDIRECT;push;${options.redirectTo};307;`;
  throw error;
});
vi.mock("@/auth", () => ({
  auth: () => Promise.resolve(null),
  signIn: (...args: [string, { redirectTo: string }]) => signInMock(...args),
}));

const { approveOrganization } = await import("../../src/lib/organizations/approve-organization");
const { acceptInvitation } = await import("../../src/app/[locale]/accept-invitation/actions");
const { verifyCredentials } = await import("../../src/lib/auth/verify-credentials");
const { hashSecret } = await import("../../src/lib/crypto");

const prisma = getTestPrismaClient();

/**
 * `acceptInvitation` used to overwrite the password of whichever account owned
 * the invited address, unconditionally — its own comment says it exists only to
 * "turn a placeholder, unguessable password into a real one". That is right for
 * a brand-new account and destructive for anyone who already has one: invited
 * into a second organization, they silently lost their password. It was
 * reachable today at bootstrap (the runbook's step 9 mails a redundant
 * invitation to the platform admin's OWN address, and the runbook had to warn
 * "do not open it"). The rule under test: an existing account keeps its
 * password and gains the membership; only a brand-new account sets one.
 */
const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
const orgIds: string[] = [];
const userIds: string[] = [];
let counter = 0;

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) fd.set(key, value);
  return fd;
}

async function makeUser(label: string, opts: { password?: string; active?: boolean } = {}) {
  const email = `accept-existing-${label}-${suffix}@example.com`;
  const user = await prisma.user.create({
    data: {
      email,
      passwordHash: await hashSecret(opts.password ?? "irrelevant-password-1"),
      role: "ADMIN",
      active: opts.active ?? true,
      isSuperAdmin: label.startsWith("approver"),
    },
  });
  userIds.push(user.id);
  return { ...user, email };
}

/** A PENDING organization whose contact address is `contactEmail`, approved for real. */
async function approveFor(contactEmail: string, approverId: string) {
  counter += 1;
  const organization = await prisma.organization.create({
    data: {
      slug: `accept-existing-${suffix}-${counter}`,
      name: `Accept Existing ${counter}`,
      status: "PENDING",
      city: "Heredia",
      contactEmail,
    },
  });
  orgIds.push(organization.id);
  const approval = await approveOrganization(organization.slug, approverId);
  const token = new URL(approval.invitationLink!).searchParams.get("token")!;
  return { organizationId: organization.id, token };
}

/** Runs the action the way a request does: a session-minting sign-in ends in a NEXT_REDIRECT. */
async function accept(token: string, fields: Record<string, string> = {}) {
  return acceptInvitation("es", {}, form({ token, ...fields })).catch((error: { digest?: string }) => {
    if (!error.digest?.startsWith("NEXT_REDIRECT")) throw error;
    return { redirected: error.digest } as const;
  });
}

describe("acceptInvitation never touches an existing account's password", () => {
  beforeEach(() => {
    signInMock.mockClear();
  });

  afterAll(async () => {
    await prisma.auditLog.deleteMany({ where: { organizationId: { in: orgIds } } });
    await prisma.invitation.deleteMany({ where: { organizationId: { in: orgIds } } });
    await prisma.paymentPlan.deleteMany({ where: { organizationId: { in: orgIds } } });
    await prisma.staffAssignment.deleteMany({ where: { organizationId: { in: orgIds } } });
    await prisma.organizationMembership.deleteMany({ where: { organizationId: { in: orgIds } } });
    await prisma.academy.deleteMany({ where: { organizationId: { in: orgIds } } });
    await prisma.organization.deleteMany({ where: { id: { in: orgIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  });

  it("REQUIRED: the bootstrap hazard — a platform admin invited to their OWN organization keeps the password they already had", async () => {
    const approver = await makeUser("approver");
    // The runbook's bootstrap: an existing, active account with a real password
    // registers an organization under its own address, and approval mails it a
    // (redundant) invitation.
    const admin = await makeUser("bootstrap", { password: "the-original-password-1" });
    const { organizationId, token } = await approveFor(admin.email, approver.id);

    await accept(token, { password: "someone-elses-new-pass-9" });

    expect(await verifyCredentials(admin.email, "the-original-password-1")).not.toBeNull();
    expect(await verifyCredentials(admin.email, "someone-elses-new-pass-9")).toBeNull();
    // ...and the link still did its one job: the membership exists, the invitation is spent.
    expect(await prisma.organizationMembership.count({ where: { userId: admin.id, organizationId } })).toBe(1);
    expect((await prisma.invitation.findFirstOrThrow({ where: { organizationId, email: admin.email } })).usedAt).not.toBeNull();
  });

  it("REQUIRED: an existing account is not signed in by a link — possession of the link is not possession of the account", async () => {
    const approver = await makeUser("approver-signin");
    const existing = await makeUser("nosession", { password: "existing-password-1" });
    const { token } = await approveFor(existing.email, approver.id);

    await accept(token, { password: "whatever-password-9" });

    expect(signInMock).not.toHaveBeenCalled();
  });

  it("an existing account can accept without supplying any password at all", async () => {
    const approver = await makeUser("approver-nopw");
    const existing = await makeUser("nopw", { password: "existing-password-2" });
    const { organizationId, token } = await approveFor(existing.email, approver.id);

    const result = await accept(token); // no password field

    expect(result).not.toMatchObject({ error: expect.anything() });
    expect((await prisma.invitation.findFirstOrThrow({ where: { organizationId, email: existing.email } })).usedAt).not.toBeNull();
    expect(await verifyCredentials(existing.email, "existing-password-2")).not.toBeNull();
  });

  it("a brand-new account still sets its password, is activated and is signed in", async () => {
    const approver = await makeUser("approver-new");
    const email = `accept-existing-brandnew-${suffix}@example.com`;
    const { token } = await approveFor(email, approver.id);
    const created = await prisma.user.findUniqueOrThrow({ where: { email } });
    userIds.push(created.id);
    expect(created.active).toBe(false); // the unaccepted placeholder

    await accept(token, { password: "a-real-password-1" });

    expect(await verifyCredentials(email, "a-real-password-1")).not.toBeNull();
    expect((await prisma.user.findUniqueOrThrow({ where: { email } })).active).toBe(true);
    expect(signInMock).toHaveBeenCalledTimes(1);
  });

  it("a brand-new account must still supply a real password", async () => {
    const approver = await makeUser("approver-short");
    const email = `accept-existing-short-${suffix}@example.com`;
    const { token } = await approveFor(email, approver.id);
    userIds.push((await prisma.user.findUniqueOrThrow({ where: { email } })).id);

    const result = await accept(token, { password: "short" });

    expect(result).toMatchObject({ error: expect.anything() });
    expect((await prisma.user.findUniqueOrThrow({ where: { email } })).active).toBe(false);
    expect(signInMock).not.toHaveBeenCalled();
  });
});
