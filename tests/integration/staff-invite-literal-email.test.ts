import "dotenv/config";
import { getTestPrismaClient } from "../helpers/test-db";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Staff invitations match an address case-insensitively but LITERALLY. Prisma's `mode: "insensitive"` compiles to an
 * unescaped `ILIKE`, where `_`, `%` and `\` in an address are pattern characters — so inviting `wild_card@…` used to
 * bind the invitation to an unrelated existing account `wildXcard@…` (sending the link to THAT address), and an
 * unrelated pending `wildXcard@…` invitation made `wild_card@…` look "already invited".
 * Disposable test-database data only; email is mocked (nothing is sent).
 */
vi.mock("@/lib/email/send-transactional-email", () => ({
  sendTransactionalEmail: vi.fn(async () => ({ success: true, outcome: "accepted" })),
}));

let currentSession: { user: { id: string; role: string } | null; activeOrganizationId?: string } | null = null;
vi.mock("@/auth", () => ({
  auth: () => Promise.resolve(currentSession),
  signIn: (_provider: string, options: { redirectTo: string }) => {
    const error = new Error("NEXT_REDIRECT");
    (error as { digest?: string }).digest = `NEXT_REDIRECT;push;${options.redirectTo};307;`;
    throw error;
  },
}));

const { sendTransactionalEmail } = await import("../../src/lib/email/send-transactional-email");
const { approveOrganization } = await import("../../src/lib/organizations/approve-organization");
const { acceptInvitation } = await import("../../src/app/[locale]/accept-invitation/actions");
const { inviteStaff } = await import("../../src/lib/staff/staff-actions");
const { inviteStaffMember } = await import("../../src/lib/staff/staff-service");
const { requireOrganizationAccess } = await import("../../src/lib/tenant/context");
const { hashSecret } = await import("../../src/lib/crypto");

const prisma = getTestPrismaClient();
const sendMock = vi.mocked(sendTransactionalEmail);
const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
const orgIds: string[] = [];
const userIds: string[] = [];
let counter = 0;
let approverId: string;

function form(fields: Record<string, string | string[]>): FormData {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    if (Array.isArray(value)) for (const v of value) fd.append(key, v);
    else fd.set(key, value);
  }
  return fd;
}

const tokenOf = (link: string) => new URL(link).searchParams.get("token")!;

async function accept(token: string, fields: Record<string, string> = {}) {
  return acceptInvitation("es", {}, form({ token, ...fields })).catch((error: { digest?: string }) => {
    if (!error.digest?.startsWith("NEXT_REDIRECT")) throw error;
    return { redirected: error.digest } as const;
  });
}

/** An organization with its Owner created the real way (approval + accepted invitation). */
async function newOrganization() {
  counter += 1;
  const email = `literal-owner-${counter}-${suffix}@example.com`;
  const organization = await prisma.organization.create({
    data: { slug: `literal-${suffix}-${counter}`, name: `Literal ${counter}`, status: "PENDING", city: "Heredia", contactEmail: email },
  });
  orgIds.push(organization.id);
  const approval = await approveOrganization(organization.slug, approverId);
  await accept(tokenOf(approval.invitationLink!), { password: "owner-password-123" });
  const owner = await prisma.user.findUniqueOrThrow({ where: { email } });
  userIds.push(owner.id);
  const academy = await prisma.academy.findFirstOrThrow({ where: { organizationId: organization.id } });
  currentSession = { user: { id: owner.id, role: "ADMIN" }, activeOrganizationId: organization.id };
  return { organizationId: organization.id, ownerId: owner.id, academyId: academy.id };
}

async function account(email: string) {
  const user = await prisma.user.create({ data: { email, passwordHash: await hashSecret("account-password-123"), role: "INSTRUCTOR" } });
  userIds.push(user.id);
  return user;
}

async function pendingInvitation(organizationId: string, email: string) {
  counter += 1;
  return prisma.invitation.create({
    data: { tokenHash: `literal-${suffix}-${counter}`, email, organizationId, role: "INSTRUCTOR", expiresAt: new Date(Date.now() + 86_400_000) },
  });
}

const sentTo = () => sendMock.mock.calls.map((call) => call[0]);

describe("staff invitations match addresses literally", () => {
  beforeAll(async () => {
    const approver = await prisma.user.create({
      data: { email: `literal-approver-${suffix}@example.com`, passwordHash: await hashSecret("irrelevant-password-123"), role: "ADMIN", isSuperAdmin: true },
    });
    userIds.push(approver.id);
    approverId = approver.id;
  });

  beforeEach(() => {
    currentSession = null;
  });

  afterAll(async () => {
    await prisma.auditLog.deleteMany({ where: { organizationId: { in: orgIds } } });
    await prisma.invitation.deleteMany({ where: { organizationId: { in: orgIds } } });
    await prisma.paymentPlan.deleteMany({ where: { organizationId: { in: orgIds } } });
    await prisma.staffAssignment.deleteMany({ where: { organizationId: { in: orgIds } } });
    await prisma.organizationMembership.deleteMany({ where: { organizationId: { in: orgIds } } });
    await prisma.user.updateMany({ where: { id: { in: userIds } }, data: { lastActiveOrganizationId: null } });
    await prisma.academy.deleteMany({ where: { organizationId: { in: orgIds } } });
    await prisma.organization.deleteMany({ where: { id: { in: orgIds } } });
    const created = await prisma.user.findMany({ where: { email: { contains: suffix } }, select: { id: true } });
    await prisma.user.deleteMany({ where: { id: { in: [...userIds, ...created.map((u) => u.id)] } } });
  });

  it("REQUIRED: an underscore cannot select another account — the invitation keeps the intended recipient, through acceptance", async () => {
    const org = await newOrganization();
    const other = await account(`wildXcard-${suffix}@example.com`); // what `wild_card-…` matches as an ILIKE pattern
    const intended = `wild_card-${suffix}@example.com`;
    sendMock.mockClear();

    const result = await inviteStaff(org.organizationId, {}, form({ email: intended, role: "INSTRUCTOR", academyIds: [org.academyId] }));

    expect(result).toMatchObject({ ok: true });
    const invitation = await prisma.invitation.findUniqueOrThrow({ where: { id: result.invitationId! } });
    expect(invitation.email).toBe(intended);
    expect(sentTo()).toEqual([intended]);
    expect(result.invitationLink).toBeDefined();

    // Accepting creates/uses the INTENDED address's account — the lookalike account gains nothing.
    await accept(tokenOf(result.invitationLink!), { password: "intended-password-1" });
    const created = await prisma.user.findUniqueOrThrow({ where: { email: intended } });
    userIds.push(created.id);
    await expect(requireOrganizationAccess(created.id, org.organizationId)).resolves.toMatchObject({ organizationRole: "INSTRUCTOR" });
    expect(await prisma.organizationMembership.count({ where: { userId: other.id } })).toBe(0);
  });

  it("REQUIRED: % and \\ cannot select another account either (service level; the form's validation rejects these characters)", async () => {
    const org = await newOrganization();
    const context = await requireOrganizationAccess(org.ownerId, org.organizationId);
    for (const [intended, lookalike] of [
      [`pct%card-${suffix}@example.com`, `pctANYTHINGcard-${suffix}@example.com`],
      [`bs\\_card-${suffix}@example.com`, `bs_card-${suffix}@example.com`], // ILIKE: `bs\_card` means literal `bs_card`
    ]) {
      await account(lookalike);
      sendMock.mockClear();
      const result = await inviteStaffMember(context, { email: intended, role: "INSTRUCTOR", academyIds: [org.academyId] });
      expect(result, intended).toMatchObject({ ok: true });
      const invitation = await prisma.invitation.findUniqueOrThrow({ where: { id: (result as { invitationId: string }).invitationId } });
      expect(invitation.email, intended).toBe(intended);
      expect(sentTo(), intended).toEqual([intended]);
    }
  });

  it("REQUIRED: an unrelated pending invitation matching the pattern does not make the address 'already invited'", async () => {
    const org = await newOrganization();
    await pendingInvitation(org.organizationId, `pendX-${suffix}@example.com`);
    const context = await requireOrganizationAccess(org.ownerId, org.organizationId);

    expect(await inviteStaff(org.organizationId, {}, form({ email: `pend_-${suffix}@example.com`, role: "INSTRUCTOR", academyIds: [org.academyId] }))).toMatchObject({ ok: true });
    await pendingInvitation(org.organizationId, `pctZZZpend-${suffix}@example.com`);
    expect(await inviteStaffMember(context, { email: `pct%pend-${suffix}@example.com`, role: "INSTRUCTOR", academyIds: [org.academyId] })).toMatchObject({ ok: true });
  });

  it("REQUIRED: ordinary case-insensitive matching still works — existing account's casing, pending invitation, existing member", async () => {
    const org = await newOrganization();
    // An existing account with mixed case: the invitation carries THAT casing (acceptance looks the account up exactly).
    const mixed = await account(`Mixed.Case-${suffix}@Example.com`);
    const first = await inviteStaff(org.organizationId, {}, form({ email: `mixed.case-${suffix}@example.com`, role: "INSTRUCTOR", academyIds: [org.academyId] }));
    expect(first).toMatchObject({ ok: true });
    expect((await prisma.invitation.findUniqueOrThrow({ where: { id: first.invitationId! } })).email).toBe(mixed.email);
    // The same address again, any case: already invited.
    expect(await inviteStaff(org.organizationId, {}, form({ email: `MIXED.CASE-${suffix}@EXAMPLE.COM`, role: "INSTRUCTOR", academyIds: [org.academyId] }))).toEqual({ error: "alreadyInvited" });
    // A pending invitation stored in another case also counts.
    await pendingInvitation(org.organizationId, `Pending.Case-${suffix}@Example.com`);
    expect(await inviteStaff(org.organizationId, {}, form({ email: `pending.case-${suffix}@example.com`, role: "INSTRUCTOR", academyIds: [org.academyId] }))).toEqual({ error: "alreadyInvited" });
    // An existing member here, addressed in another case: still recognized.
    const member = await account(`Member.Case-${suffix}@Example.com`);
    await prisma.organizationMembership.create({ data: { userId: member.id, organizationId: org.organizationId, role: "INSTRUCTOR" } });
    expect(await inviteStaff(org.organizationId, {}, form({ email: `member.case-${suffix}@example.com`, role: "INSTRUCTOR", academyIds: [org.academyId] }))).toEqual({ error: "alreadyMember" });
  });

  it("REQUIRED: two accounts that differ only by case are refused as ambiguous — never resolved by picking one", async () => {
    const org = await newOrganization();
    const lower = await account(`dup-${suffix}@example.com`);
    const upper = await account(`DUP-${suffix}@example.com`);
    sendMock.mockClear();

    const result = await inviteStaff(org.organizationId, {}, form({ email: `dup-${suffix}@example.com`, role: "INSTRUCTOR", academyIds: [org.academyId] }));

    expect(result).toEqual({ error: "ambiguousAccount" });
    expect(await prisma.invitation.count({ where: { organizationId: org.organizationId, email: { in: [lower.email, upper.email] } } })).toBe(0);
    expect(sendMock).not.toHaveBeenCalled();
  });
});
