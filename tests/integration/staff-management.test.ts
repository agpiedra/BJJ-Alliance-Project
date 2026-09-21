import "dotenv/config";
import { getTestPrismaClient } from "../helpers/test-db";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/email/send-transactional-email", () => ({
  sendTransactionalEmail: vi.fn(async () => ({ success: true })),
}));

let currentSession: { user: { id: string; role: string } | null; activeOrganizationId?: string } | null = null;
const signInMock = vi.fn((_provider: string, options: { redirectTo: string }) => {
  const error = new Error("NEXT_REDIRECT");
  (error as { digest?: string }).digest = `NEXT_REDIRECT;push;${options.redirectTo};307;`;
  throw error;
});
vi.mock("@/auth", () => ({
  auth: () => Promise.resolve(currentSession),
  signIn: (...args: [string, { redirectTo: string }]) => signInMock(...args),
}));

const { sendTransactionalEmail } = await import("../../src/lib/email/send-transactional-email");
const { approveOrganization } = await import("../../src/lib/organizations/approve-organization");
const { acceptInvitation } = await import("../../src/app/[locale]/accept-invitation/actions");
const { inviteStaff, resendInvitation, revokeInvitation, updateStaffMember, deactivateStaffMember, reactivateStaffMember } = await import(
  "../../src/lib/staff/staff-actions"
);
const { setMembershipActive } = await import("../../src/lib/staff/staff-service");
const { listStaff } = await import("../../src/lib/staff/list-staff");
const { requireOrganizationAccess } = await import("../../src/lib/tenant/context");
const { verifyCredentials } = await import("../../src/lib/auth/verify-credentials");
const { hashSecret, digestLookupSecret } = await import("../../src/lib/crypto");
const { requireEnv } = await import("../../src/lib/env");

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

function actAs(userId: string, organizationId: string, role = "ADMIN") {
  currentSession = { user: { id: userId, role }, activeOrganizationId: organizationId };
}

const tokenOf = (link: string) => new URL(link).searchParams.get("token")!;

async function accept(token: string, fields: Record<string, string> = {}) {
  return acceptInvitation("es", {}, form({ token, ...fields })).catch((error: { digest?: string }) => {
    if (!error.digest?.startsWith("NEXT_REDIRECT")) throw error;
    return { redirected: error.digest } as const;
  });
}

/**
 * An organization whose Owner is created exactly the way a real one is —
 * approval, then the invitation accepted — with a second academy added
 * (nothing in the product creates one yet; that is B3), so a DIRECTOR/
 * INSTRUCTOR can be assigned to one and not the other.
 */
async function newOrganization() {
  counter += 1;
  const email = `staff-owner-${counter}-${suffix}@example.com`;
  const organization = await prisma.organization.create({
    data: { slug: `staff-${suffix}-${counter}`, name: `Staff ${counter}`, status: "PENDING", city: "Heredia", contactEmail: email },
  });
  orgIds.push(organization.id);
  const approval = await approveOrganization(organization.slug, approverId);
  await accept(tokenOf(approval.invitationLink!), { password: "owner-password-123" });
  const owner = await prisma.user.findUniqueOrThrow({ where: { email } });
  userIds.push(owner.id);
  const first = await prisma.academy.findFirstOrThrow({ where: { organizationId: organization.id } });
  const second = await prisma.academy.create({
    data: {
      organizationId: organization.id,
      name: `Second ${counter}`,
      slug: `staff-second-${suffix}-${counter}`,
      kioskTokenHash: digestLookupSecret(`kiosk-${suffix}-${counter}`, requireEnv("CODE_PEPPER")),
    },
  });
  return { organizationId: organization.id, ownerId: owner.id, ownerEmail: email, academyA: first.id, academyB: second.id };
}

/** A staff member created directly (edit/deactivate tests aren't about the invite flow). */
async function addMember(
  org: { organizationId: string },
  role: "ADMIN" | "DIRECTOR" | "INSTRUCTOR",
  academyIds: string[],
  opts: { label?: string; password?: string } = {},
) {
  counter += 1;
  const email = `staff-${opts.label ?? role.toLowerCase()}-${counter}-${suffix}@example.com`;
  const user = await prisma.user.create({
    data: { email, passwordHash: await hashSecret(opts.password ?? "member-password-123"), role },
  });
  userIds.push(user.id);
  const membership = await prisma.organizationMembership.create({ data: { userId: user.id, organizationId: org.organizationId, role } });
  if (role !== "ADMIN") {
    for (const academyId of academyIds) {
      await prisma.staffAssignment.create({ data: { userId: user.id, academyId, organizationId: org.organizationId, role } });
    }
  }
  return { user, membership, email };
}

async function assignmentsOf(userId: string, organizationId: string) {
  return prisma.staffAssignment.findMany({ where: { userId, organizationId }, orderBy: { academyId: "asc" } });
}

async function auditRows(organizationId: string, action: string) {
  return prisma.auditLog.findMany({ where: { organizationId, action }, orderBy: { createdAt: "asc" } });
}

describe("staff management", () => {
  beforeAll(async () => {
    const approver = await prisma.user.create({
      data: { email: `staff-approver-${suffix}@example.com`, passwordHash: await hashSecret("irrelevant-password-123"), role: "ADMIN", isSuperAdmin: true },
    });
    userIds.push(approver.id);
    approverId = approver.id;
  });

  beforeEach(() => {
    currentSession = null;
    signInMock.mockClear();
    sendMock.mockClear();
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

  describe("only the Owner manages staff", () => {
    it("REQUIRED: a location director and an instructor are refused every staff action", async () => {
      const org = await newOrganization();
      const director = await addMember(org, "DIRECTOR", [org.academyA]);
      const instructor = await addMember(org, "INSTRUCTOR", [org.academyA]);
      const target = await addMember(org, "INSTRUCTOR", [org.academyA], { label: "target" });

      for (const actor of [director, instructor]) {
        actAs(actor.user.id, org.organizationId, actor.membership.role);
        await expect(inviteStaff(org.organizationId, {}, form({ email: "x@example.com", role: "INSTRUCTOR", academyIds: [org.academyA] }))).rejects.toThrow("FORBIDDEN");
        await expect(updateStaffMember(org.organizationId, {}, form({ membershipId: target.membership.id, role: "DIRECTOR", academyIds: [org.academyA] }))).rejects.toThrow("FORBIDDEN");
        await expect(deactivateStaffMember(org.organizationId, target.membership.id)).rejects.toThrow("FORBIDDEN");
        await expect(reactivateStaffMember(org.organizationId, target.membership.id)).rejects.toThrow("FORBIDDEN");
        await expect(resendInvitation(org.organizationId, "any")).rejects.toThrow("FORBIDDEN");
        await expect(revokeInvitation(org.organizationId, "any")).rejects.toThrow("FORBIDDEN");
      }
      expect((await prisma.organizationMembership.findUniqueOrThrow({ where: { id: target.membership.id } })).active).toBe(true);
    });

    it("an Owner of another organization is told 'not found' — never a hint that the member exists", async () => {
      const a = await newOrganization();
      const b = await newOrganization();
      const target = await addMember(a, "INSTRUCTOR", [a.academyA]);

      actAs(b.ownerId, a.organizationId); // B's owner naming A's organization
      expect(await deactivateStaffMember(a.organizationId, target.membership.id)).toEqual({ error: "notFound" });

      actAs(b.ownerId, b.organizationId); // ...or naming A's member inside their OWN organization
      expect(await deactivateStaffMember(b.organizationId, target.membership.id)).toEqual({ error: "notFound" });
      expect((await prisma.organizationMembership.findUniqueOrThrow({ where: { id: target.membership.id } })).active).toBe(true);
    });
  });

  describe("inviting", () => {
    it("issues an invitation for an academy-scoped role, audited, with a copyable link and an email", async () => {
      const org = await newOrganization();
      actAs(org.ownerId, org.organizationId);
      sendMock.mockClear(); // creating the organization sent its own approval email

      const result = await inviteStaff(org.organizationId, {}, form({ email: "  Coach.One@Example.com ", role: "INSTRUCTOR", academyIds: [org.academyB] }));

      expect(result).toMatchObject({ ok: true, emailSent: true });
      const link = (result as { invitationLink: string }).invitationLink;
      expect(link).toContain("/accept-invitation?token=");
      const invitation = await prisma.invitation.findFirstOrThrow({ where: { organizationId: org.organizationId, email: "coach.one@example.com" } });
      expect(invitation).toMatchObject({ role: "INSTRUCTOR", academyIds: [org.academyB], invitedById: org.ownerId, usedAt: null, revokedAt: null });
      expect(invitation.tokenHash).toBe(digestLookupSecret(tokenOf(link), requireEnv("CODE_PEPPER")));
      expect(sendMock).toHaveBeenCalledTimes(1);
      const [audit] = await auditRows(org.organizationId, "staff.invite");
      expect(audit).toMatchObject({ actorId: org.ownerId, entityType: "Invitation", entityId: invitation.id });
      expect(audit.after).toMatchObject({ email: "coach.one@example.com", role: "INSTRUCTOR", academyIds: [org.academyB] });
    });

    it("an Owner invitation carries no academies — their scope is all of them", async () => {
      const org = await newOrganization();
      actAs(org.ownerId, org.organizationId);
      await inviteStaff(org.organizationId, {}, form({ email: "second.owner@example.com", role: "ADMIN", academyIds: [org.academyA] }));
      const invitation = await prisma.invitation.findFirstOrThrow({ where: { organizationId: org.organizationId, email: "second.owner@example.com" } });
      expect(invitation).toMatchObject({ role: "ADMIN", academyIds: [] });
    });

    it("REQUIRED: a director or instructor needs at least one academy — and never one from another organization", async () => {
      const org = await newOrganization();
      const other = await newOrganization();
      actAs(org.ownerId, org.organizationId);

      for (const role of ["DIRECTOR", "INSTRUCTOR"]) {
        expect(await inviteStaff(org.organizationId, {}, form({ email: `none-${role}@example.com`, role }))).toMatchObject({ error: "academyRequired" });
      }
      expect(await inviteStaff(org.organizationId, {}, form({ email: "foreign@example.com", role: "INSTRUCTOR", academyIds: [other.academyA] }))).toMatchObject({ error: "invalidAcademy" });
      expect(await inviteStaff(org.organizationId, {}, form({ email: "x@example.com", role: "STUDENT", academyIds: [org.academyA] }))).toMatchObject({ error: "invalid" });
      expect(await prisma.invitation.count({ where: { organizationId: org.organizationId, email: { in: ["none-DIRECTOR@example.com", "none-INSTRUCTOR@example.com", "foreign@example.com", "x@example.com"] } } })).toBe(0);
    });

    it("refuses an address that is already a member (active or deactivated) or already has a pending invitation — and allows one whose invitation expired", async () => {
      const org = await newOrganization();
      const active = await addMember(org, "INSTRUCTOR", [org.academyA], { label: "active" });
      const inactive = await addMember(org, "INSTRUCTOR", [org.academyA], { label: "inactive" });
      await prisma.organizationMembership.update({ where: { id: inactive.membership.id }, data: { active: false } });
      actAs(org.ownerId, org.organizationId);

      expect(await inviteStaff(org.organizationId, {}, form({ email: active.email, role: "INSTRUCTOR", academyIds: [org.academyA] }))).toMatchObject({ error: "alreadyMember" });
      expect(await inviteStaff(org.organizationId, {}, form({ email: inactive.email, role: "INSTRUCTOR", academyIds: [org.academyA] }))).toMatchObject({ error: "alreadyMemberInactive" });

      expect(await inviteStaff(org.organizationId, {}, form({ email: "pending@example.com", role: "INSTRUCTOR", academyIds: [org.academyA] }))).toMatchObject({ ok: true });
      expect(await inviteStaff(org.organizationId, {}, form({ email: "PENDING@example.com", role: "DIRECTOR", academyIds: [org.academyA] }))).toMatchObject({ error: "alreadyInvited" });

      await prisma.invitation.updateMany({ where: { organizationId: org.organizationId, email: "pending@example.com" }, data: { expiresAt: new Date(Date.now() - 1000) } });
      expect(await inviteStaff(org.organizationId, {}, form({ email: "pending@example.com", role: "INSTRUCTOR", academyIds: [org.academyA] }))).toMatchObject({ ok: true });
    });

    it("REQUIRED: an existing student account cannot be invited as staff — the global User.role would lock them out of one side of the app", async () => {
      const org = await newOrganization();
      counter += 1;
      const studentEmail = `staff-student-${counter}-${suffix}@example.com`;
      const student = await prisma.user.create({ data: { email: studentEmail, passwordHash: await hashSecret("student-password-1"), role: "STUDENT" } });
      userIds.push(student.id);
      actAs(org.ownerId, org.organizationId);

      expect(await inviteStaff(org.organizationId, {}, form({ email: studentEmail, role: "INSTRUCTOR", academyIds: [org.academyA] }))).toMatchObject({ error: "studentAccount" });
    });

    it("when the email fails to send, the invitation still exists and the link is still handed back to copy", async () => {
      const org = await newOrganization();
      actAs(org.ownerId, org.organizationId);
      sendMock.mockResolvedValueOnce({ success: false, error: "sandbox" } as never);

      const result = await inviteStaff(org.organizationId, {}, form({ email: "nomail@example.com", role: "INSTRUCTOR", academyIds: [org.academyA] }));

      expect(result).toMatchObject({ ok: true, emailSent: false });
      expect((result as { invitationLink: string }).invitationLink).toContain("token=");
      expect(await prisma.invitation.count({ where: { organizationId: org.organizationId, email: "nomail@example.com" } })).toBe(1);
    });
  });

  describe("accepting an invitation", () => {
    it("REQUIRED: a brand-new person sets a password, is created with the invited role and academies, and lands in the app — not in the owner's onboarding", async () => {
      const org = await newOrganization();
      actAs(org.ownerId, org.organizationId);
      const result = await inviteStaff(org.organizationId, {}, form({ email: "new.director@example.com", role: "DIRECTOR", academyIds: [org.academyB] }));
      const token = tokenOf((result as { invitationLink: string }).invitationLink);
      signInMock.mockClear(); // creating the organization signed its owner in

      await accept(token, { password: "brand-new-password-1" });

      const user = await prisma.user.findUniqueOrThrow({ where: { email: "new.director@example.com" } });
      userIds.push(user.id);
      expect(user).toMatchObject({ active: true, role: "DIRECTOR" });
      expect(await verifyCredentials("new.director@example.com", "brand-new-password-1")).not.toBeNull();
      expect(await prisma.organizationMembership.findUniqueOrThrow({ where: { userId_organizationId: { userId: user.id, organizationId: org.organizationId } } })).toMatchObject({ role: "DIRECTOR", active: true });
      expect((await assignmentsOf(user.id, org.organizationId)).map((a) => [a.academyId, a.role])).toEqual([[org.academyB, "DIRECTOR"]]);
      expect(signInMock).toHaveBeenCalledTimes(1);
      expect(signInMock.mock.calls[0][1].redirectTo).toBe("/es/dashboard");
      // Their scope is exactly what they were invited to.
      const context = await requireOrganizationAccess(user.id, org.organizationId);
      expect(context.academyIds).toEqual([org.academyB]);
      expect(context.organizationRole).toBe("DIRECTOR");
      // (The Owner's own acceptance during setup is audited too — pick this person's row.)
      const audit = (await auditRows(org.organizationId, "staff.accept")).find((row) => row.actorId === user.id);
      expect(audit).toMatchObject({ entityType: "OrganizationMembership" });
      expect(audit?.after).toMatchObject({ role: "DIRECTOR", academyIds: [org.academyB], createdMembership: true });
    });

    it("REQUIRED: someone who already has an account keeps their password, gains the membership and the academies, and is not signed in by the link", async () => {
      const org = await newOrganization();
      const other = await newOrganization();
      const existing = await addMember(other, "INSTRUCTOR", [other.academyA], { label: "existing", password: "already-mine-pass-1" });
      actAs(org.ownerId, org.organizationId);
      const result = await inviteStaff(org.organizationId, {}, form({ email: existing.email, role: "INSTRUCTOR", academyIds: [org.academyA, org.academyB] }));
      signInMock.mockClear(); // both organizations' owners were signed in while being created

      await accept(tokenOf((result as { invitationLink: string }).invitationLink), { password: "an-attempt-to-reset-9" });

      expect(await verifyCredentials(existing.email, "already-mine-pass-1")).not.toBeNull();
      expect(await verifyCredentials(existing.email, "an-attempt-to-reset-9")).toBeNull();
      expect(signInMock).not.toHaveBeenCalled();
      expect((await assignmentsOf(existing.user.id, org.organizationId)).map((a) => a.academyId).sort()).toEqual([org.academyA, org.academyB].sort());
      // The other organization is exactly as it was.
      expect((await assignmentsOf(existing.user.id, other.organizationId)).map((a) => a.academyId)).toEqual([other.academyA]);
      await expect(requireOrganizationAccess(existing.user.id, other.organizationId)).resolves.toMatchObject({ organizationRole: "INSTRUCTOR" });
    });

    it("a used, revoked or expired link is dead", async () => {
      const org = await newOrganization();
      actAs(org.ownerId, org.organizationId);
      const tokens: string[] = [];
      for (const email of ["used@example.com", "revoked@example.com", "expired@example.com"]) {
        const result = await inviteStaff(org.organizationId, {}, form({ email, role: "INSTRUCTOR", academyIds: [org.academyA] }));
        tokens.push(tokenOf((result as { invitationLink: string }).invitationLink));
      }
      await accept(tokens[0], { password: "used-password-123" });
      userIds.push((await prisma.user.findUniqueOrThrow({ where: { email: "used@example.com" } })).id);
      const revoked = await prisma.invitation.findFirstOrThrow({ where: { organizationId: org.organizationId, email: "revoked@example.com" } });
      await revokeInvitation(org.organizationId, revoked.id);
      await prisma.invitation.updateMany({ where: { organizationId: org.organizationId, email: "expired@example.com" }, data: { expiresAt: new Date(Date.now() - 1000) } });

      for (const token of tokens) {
        expect(await accept(token, { password: "second-try-password-1" })).toMatchObject({ error: "invalidToken" });
      }
    });
  });

  describe("resending and revoking", () => {
    it("REQUIRED: resending kills the old link, issues a new working one, and is audited", async () => {
      const org = await newOrganization();
      actAs(org.ownerId, org.organizationId);
      const first = await inviteStaff(org.organizationId, {}, form({ email: "resend@example.com", role: "INSTRUCTOR", academyIds: [org.academyA] }));
      const invitation = await prisma.invitation.findFirstOrThrow({ where: { organizationId: org.organizationId, email: "resend@example.com" } });

      const resent = await resendInvitation(org.organizationId, invitation.id);

      expect(resent).toMatchObject({ ok: true, emailSent: true });
      const oldToken = tokenOf((first as { invitationLink: string }).invitationLink);
      const newToken = tokenOf((resent as { invitationLink: string }).invitationLink);
      expect(newToken).not.toBe(oldToken);
      expect(await accept(oldToken, { password: "old-link-password-1" })).toMatchObject({ error: "invalidToken" });
      // The replacement keeps the role and academies of the original.
      const replacement = await prisma.invitation.findFirstOrThrow({ where: { organizationId: org.organizationId, email: "resend@example.com", usedAt: null, revokedAt: null } });
      expect(replacement).toMatchObject({ role: "INSTRUCTOR", academyIds: [org.academyA] });
      await accept(newToken, { password: "new-link-password-1" });
      userIds.push((await prisma.user.findUniqueOrThrow({ where: { email: "resend@example.com" } })).id);
      expect(await verifyCredentials("resend@example.com", "new-link-password-1")).not.toBeNull();
      expect(await auditRows(org.organizationId, "staff.invitationResend")).toHaveLength(1);
    });

    it("an expired invitation can be resent; a used or revoked one cannot", async () => {
      const org = await newOrganization();
      actAs(org.ownerId, org.organizationId);
      await inviteStaff(org.organizationId, {}, form({ email: "exp@example.com", role: "INSTRUCTOR", academyIds: [org.academyA] }));
      await inviteStaff(org.organizationId, {}, form({ email: "rev@example.com", role: "INSTRUCTOR", academyIds: [org.academyA] }));
      const expired = await prisma.invitation.findFirstOrThrow({ where: { organizationId: org.organizationId, email: "exp@example.com" } });
      const revoked = await prisma.invitation.findFirstOrThrow({ where: { organizationId: org.organizationId, email: "rev@example.com" } });
      await prisma.invitation.update({ where: { id: expired.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
      await revokeInvitation(org.organizationId, revoked.id);

      expect(await resendInvitation(org.organizationId, expired.id)).toMatchObject({ ok: true });
      expect(await resendInvitation(org.organizationId, revoked.id)).toMatchObject({ error: "notPending" });
    });

    it("revoking withdraws the link and is audited; revoking twice, or another organization's invitation, does nothing", async () => {
      const org = await newOrganization();
      const other = await newOrganization();
      actAs(org.ownerId, org.organizationId);
      const result = await inviteStaff(org.organizationId, {}, form({ email: "withdraw@example.com", role: "INSTRUCTOR", academyIds: [org.academyA] }));
      const invitation = await prisma.invitation.findFirstOrThrow({ where: { organizationId: org.organizationId, email: "withdraw@example.com" } });

      expect(await revokeInvitation(org.organizationId, invitation.id)).toEqual({ ok: true });

      expect((await prisma.invitation.findUniqueOrThrow({ where: { id: invitation.id } })).revokedAt).not.toBeNull();
      expect(await accept(tokenOf((result as { invitationLink: string }).invitationLink), { password: "revoked-password-1" })).toMatchObject({ error: "invalidToken" });
      expect(await revokeInvitation(org.organizationId, invitation.id)).toMatchObject({ error: "notPending" });
      expect(await auditRows(org.organizationId, "staff.invitationRevoke")).toHaveLength(1);

      actAs(other.ownerId, other.organizationId);
      const theirs = await prisma.invitation.create({
        data: { tokenHash: digestLookupSecret(`t-${suffix}-${counter}`, requireEnv("CODE_PEPPER")), email: "theirs@example.com", organizationId: org.organizationId, role: "INSTRUCTOR", expiresAt: new Date(Date.now() + 86_400_000) },
      });
      expect(await revokeInvitation(other.organizationId, theirs.id)).toEqual({ error: "notFound" });
      expect((await prisma.invitation.findUniqueOrThrow({ where: { id: theirs.id } })).revokedAt).toBeNull();
    });
  });

  describe("editing a member", () => {
    it("REQUIRED: changing the role keeps the assignment role in sync with the membership role, and re-scopes the academies", async () => {
      const org = await newOrganization();
      const member = await addMember(org, "INSTRUCTOR", [org.academyA]);
      actAs(org.ownerId, org.organizationId);

      expect(await updateStaffMember(org.organizationId, {}, form({ membershipId: member.membership.id, role: "DIRECTOR", academyIds: [org.academyB] }))).toEqual({ ok: true });

      expect((await prisma.organizationMembership.findUniqueOrThrow({ where: { id: member.membership.id } })).role).toBe("DIRECTOR");
      expect((await assignmentsOf(member.user.id, org.organizationId)).map((a) => [a.academyId, a.role])).toEqual([[org.academyB, "DIRECTOR"]]);
      const [audit] = await auditRows(org.organizationId, "staff.update");
      expect(audit.before).toMatchObject({ role: "INSTRUCTOR", academyIds: [org.academyA] });
      expect(audit.after).toMatchObject({ role: "DIRECTOR", academyIds: [org.academyB] });
    });

    it("REQUIRED: however a member is edited, every one of their assignments has exactly their membership's role", async () => {
      const org = await newOrganization();
      const member = await addMember(org, "INSTRUCTOR", [org.academyA]);
      actAs(org.ownerId, org.organizationId);
      const steps: Array<[string, string[]]> = [
        ["DIRECTOR", [org.academyA, org.academyB]],
        ["INSTRUCTOR", [org.academyB]],
        ["DIRECTOR", [org.academyA]],
        ["ADMIN", []],
        ["INSTRUCTOR", [org.academyA, org.academyB]],
      ];
      for (const [role, academyIds] of steps) {
        expect(await updateStaffMember(org.organizationId, {}, form({ membershipId: member.membership.id, role, academyIds }))).toEqual({ ok: true });
        const membership = await prisma.organizationMembership.findUniqueOrThrow({ where: { id: member.membership.id } });
        const assignments = await assignmentsOf(member.user.id, org.organizationId);
        expect(membership.role).toBe(role);
        expect(assignments.every((a) => a.role === membership.role), `after ${role}: ${JSON.stringify(assignments.map((a) => a.role))}`).toBe(true);
        expect(assignments.map((a) => a.academyId).sort()).toEqual([...academyIds].sort());
      }
    });

    it("promoting to Owner drops the assignments — the scope is now every academy", async () => {
      const org = await newOrganization();
      const member = await addMember(org, "DIRECTOR", [org.academyA]);
      actAs(org.ownerId, org.organizationId);

      await updateStaffMember(org.organizationId, {}, form({ membershipId: member.membership.id, role: "ADMIN" }));

      expect(await assignmentsOf(member.user.id, org.organizationId)).toEqual([]);
      expect((await requireOrganizationAccess(member.user.id, org.organizationId)).academyIds).toBe("ALL");
    });

    it("REQUIRED: a director or instructor always keeps at least one academy — an edit that would leave none changes nothing", async () => {
      const org = await newOrganization();
      const member = await addMember(org, "INSTRUCTOR", [org.academyA]);
      actAs(org.ownerId, org.organizationId);

      expect(await updateStaffMember(org.organizationId, {}, form({ membershipId: member.membership.id, role: "INSTRUCTOR" }))).toMatchObject({ error: "academyRequired" });
      expect(await updateStaffMember(org.organizationId, {}, form({ membershipId: member.membership.id, role: "DIRECTOR" }))).toMatchObject({ error: "academyRequired" });
      expect(await updateStaffMember(org.organizationId, {}, form({ membershipId: member.membership.id, role: "INSTRUCTOR", academyIds: ["nope"] }))).toMatchObject({ error: "invalidAcademy" });

      expect((await prisma.organizationMembership.findUniqueOrThrow({ where: { id: member.membership.id } })).role).toBe("INSTRUCTOR");
      expect((await assignmentsOf(member.user.id, org.organizationId)).map((a) => a.academyId)).toEqual([org.academyA]);
    });

    it("demoting another Owner needs academies too", async () => {
      const org = await newOrganization();
      const second = await addMember(org, "ADMIN", []);
      actAs(org.ownerId, org.organizationId);

      expect(await updateStaffMember(org.organizationId, {}, form({ membershipId: second.membership.id, role: "INSTRUCTOR" }))).toMatchObject({ error: "academyRequired" });
      expect(await updateStaffMember(org.organizationId, {}, form({ membershipId: second.membership.id, role: "INSTRUCTOR", academyIds: [org.academyA] }))).toEqual({ ok: true });
    });
  });

  describe("deactivating and reactivating", () => {
    it("REQUIRED: deactivating is audited and takes effect on the very next request; the assignments survive for a reactivation", async () => {
      const org = await newOrganization();
      const member = await addMember(org, "INSTRUCTOR", [org.academyA, org.academyB]);
      actAs(org.ownerId, org.organizationId);

      expect(await deactivateStaffMember(org.organizationId, member.membership.id)).toEqual({ ok: true });

      await expect(requireOrganizationAccess(member.user.id, org.organizationId)).rejects.toMatchObject({ result: { status: "NO_MEMBERSHIP" } });
      expect(await assignmentsOf(member.user.id, org.organizationId)).toHaveLength(2);
      const [audit] = await auditRows(org.organizationId, "staff.deactivate");
      expect(audit).toMatchObject({ actorId: org.ownerId, entityType: "OrganizationMembership", entityId: member.membership.id });
      expect(audit.before).toMatchObject({ active: true });
      expect(audit.after).toMatchObject({ active: false });

      expect(await reactivateStaffMember(org.organizationId, member.membership.id)).toEqual({ ok: true });
      expect((await requireOrganizationAccess(member.user.id, org.organizationId)).academyIds).toHaveLength(2);
      expect(await auditRows(org.organizationId, "staff.reactivate")).toHaveLength(1);
    });

    it("REQUIRED: nobody deactivates or demotes themselves — even with another Owner standing by", async () => {
      const org = await newOrganization();
      await addMember(org, "ADMIN", [], { label: "spare-owner" }); // so 'last owner' is NOT what stops this
      const ownerMembership = await prisma.organizationMembership.findFirstOrThrow({ where: { userId: org.ownerId, organizationId: org.organizationId } });
      actAs(org.ownerId, org.organizationId);

      expect(await deactivateStaffMember(org.organizationId, ownerMembership.id)).toMatchObject({ error: "selfChange" });
      expect(await updateStaffMember(org.organizationId, {}, form({ membershipId: ownerMembership.id, role: "DIRECTOR", academyIds: [org.academyA] }))).toMatchObject({ error: "selfChange" });
      expect((await prisma.organizationMembership.findUniqueOrThrow({ where: { id: ownerMembership.id } })).active).toBe(true);
    });

    it("REQUIRED: the organization is never left without an active Owner — a deactivated Owner does not count", async () => {
      const org = await newOrganization();
      const second = await addMember(org, "ADMIN", [], { label: "second-owner" });
      const ownerMembership = await prisma.organizationMembership.findFirstOrThrow({ where: { userId: org.ownerId, organizationId: org.organizationId } });
      const ownerContext = await requireOrganizationAccess(org.ownerId, org.organizationId);
      // A context for the second Owner, captured while they are still active:
      // the service does not re-authenticate, so it can be replayed after they
      // have been removed — which is exactly the state that must be refused.
      const secondContext = await requireOrganizationAccess(second.user.id, org.organizationId);

      // With two active Owners, one may remove the other...
      expect(await setMembershipActive(ownerContext, second.membership.id, false)).toEqual({ ok: true });
      // ...and the one left is now the last: removing them is refused.
      expect(await setMembershipActive(secondContext, ownerMembership.id, false)).toEqual({ error: "lastOwner" });
      expect((await prisma.organizationMembership.findUniqueOrThrow({ where: { id: ownerMembership.id } })).active).toBe(true);
    });

    it("REQUIRED: two Owners removing each other at the same moment cannot leave the organization ownerless", async () => {
      const org = await newOrganization();
      const second = await addMember(org, "ADMIN", [], { label: "racer" });
      const ownerMembership = await prisma.organizationMembership.findFirstOrThrow({ where: { userId: org.ownerId, organizationId: org.organizationId } });
      const ownerContext = await requireOrganizationAccess(org.ownerId, org.organizationId);
      const secondContext = await requireOrganizationAccess(second.user.id, org.organizationId);

      const results = await Promise.all([
        setMembershipActive(ownerContext, second.membership.id, false),
        setMembershipActive(secondContext, ownerMembership.id, false),
      ]);

      expect(results.filter((r) => "ok" in r)).toHaveLength(1);
      expect(results.filter((r) => "error" in r).map((r) => (r as { error: string }).error)).toEqual(["lastOwner"]);
      expect(await prisma.organizationMembership.count({ where: { organizationId: org.organizationId, role: "ADMIN", active: true } })).toBe(1);
    });

    it("the staff page's own targets are staff only — a student's membership cannot be managed here", async () => {
      const org = await newOrganization();
      counter += 1;
      const user = await prisma.user.create({ data: { email: `staff-stu-${counter}-${suffix}@example.com`, passwordHash: await hashSecret("student-pass-1"), role: "STUDENT" } });
      userIds.push(user.id);
      const membership = await prisma.organizationMembership.create({ data: { userId: user.id, organizationId: org.organizationId, role: "STUDENT" } });
      actAs(org.ownerId, org.organizationId);

      expect(await deactivateStaffMember(org.organizationId, membership.id)).toEqual({ error: "notFound" });
      expect((await prisma.organizationMembership.findUniqueOrThrow({ where: { id: membership.id } })).active).toBe(true);
    });
  });

  describe("the staff list", () => {
    it("lists this organization's staff with academies and status, and its pending invitations — never students, never another organization", async () => {
      const org = await newOrganization();
      const other = await newOrganization();
      const director = await addMember(org, "DIRECTOR", [org.academyA], { label: "lister" });
      const coach = await addMember(org, "INSTRUCTOR", [org.academyA, org.academyB], { label: "coach" });
      await prisma.organizationMembership.update({ where: { id: coach.membership.id }, data: { active: false } });
      counter += 1;
      const student = await prisma.user.create({ data: { email: `staff-list-stu-${counter}-${suffix}@example.com`, passwordHash: await hashSecret("student-pass-1"), role: "STUDENT" } });
      userIds.push(student.id);
      await prisma.organizationMembership.create({ data: { userId: student.id, organizationId: org.organizationId, role: "STUDENT" } });
      await addMember(other, "INSTRUCTOR", [other.academyA], { label: "elsewhere" });
      actAs(org.ownerId, org.organizationId);
      await inviteStaff(org.organizationId, {}, form({ email: "listed-pending@example.com", role: "INSTRUCTOR", academyIds: [org.academyB] }));
      await inviteStaff(org.organizationId, {}, form({ email: "listed-expired@example.com", role: "INSTRUCTOR", academyIds: [org.academyB] }));
      await prisma.invitation.updateMany({ where: { organizationId: org.organizationId, email: "listed-expired@example.com" }, data: { expiresAt: new Date(Date.now() - 1000) } });
      await inviteStaff(org.organizationId, {}, form({ email: "listed-revoked@example.com", role: "INSTRUCTOR", academyIds: [org.academyB] }));
      await revokeInvitation(org.organizationId, (await prisma.invitation.findFirstOrThrow({ where: { organizationId: org.organizationId, email: "listed-revoked@example.com" } })).id);

      const { members, invitations } = await listStaff(org.organizationId);

      expect(members.map((m) => m.email).sort()).toEqual([org.ownerEmail, director.email, coach.email].sort());
      expect(members.find((m) => m.email === coach.email)).toMatchObject({ role: "INSTRUCTOR", active: false, academies: expect.arrayContaining([expect.objectContaining({ id: org.academyA }), expect.objectContaining({ id: org.academyB })]) });
      expect(members.find((m) => m.email === org.ownerEmail)).toMatchObject({ role: "ADMIN", active: true, academies: [] });
      expect(invitations.map((i) => [i.email, i.expired]).sort()).toEqual([["listed-expired@example.com", true], ["listed-pending@example.com", false]]);
    });
  });
});
