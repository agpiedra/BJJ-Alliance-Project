import "dotenv/config";
import { getTestPrismaClient } from "../helpers/test-db";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * "Remove from academy" (staff-service.ts `removeStaffMembership`). Disposable test-database data only; email is mocked
 * (nothing is sent).
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
const { inviteStaff, deactivateStaffMember, reactivateStaffMember, removeStaffMember, resendInvitation } = await import("../../src/lib/staff/staff-actions");
const { removeStaffMembership, setMembershipActive } = await import("../../src/lib/staff/staff-service");
const { requireOrganizationAccess } = await import("../../src/lib/tenant/context");
const { verifyCredentials } = await import("../../src/lib/auth/verify-credentials");
const { hashSecret, digestLookupSecret, generateRandomToken } = await import("../../src/lib/crypto");
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

/** An organization with its Owner created the real way (approval + accepted invitation) and a second academy. */
async function newOrganization() {
  counter += 1;
  const email = `remove-owner-${counter}-${suffix}@example.com`;
  const organization = await prisma.organization.create({
    data: { slug: `remove-${suffix}-${counter}`, name: `Remove ${counter}`, status: "PENDING", city: "Heredia", contactEmail: email },
  });
  orgIds.push(organization.id);
  const approval = await approveOrganization(organization.slug, approverId);
  await accept(tokenOf(approval.invitationLink!), { password: "owner-password-123" });
  const owner = await prisma.user.findUniqueOrThrow({ where: { email } });
  userIds.push(owner.id);
  const ownerMembership = await prisma.organizationMembership.findFirstOrThrow({ where: { userId: owner.id, organizationId: organization.id } });
  const first = await prisma.academy.findFirstOrThrow({ where: { organizationId: organization.id } });
  const second = await prisma.academy.create({
    data: {
      organizationId: organization.id,
      name: `Second ${counter}`,
      slug: `remove-second-${suffix}-${counter}`,
      kioskTokenHash: digestLookupSecret(`kiosk-remove-${suffix}-${counter}`, requireEnv("CODE_PEPPER")),
    },
  });
  return { organizationId: organization.id, ownerId: owner.id, ownerMembershipId: ownerMembership.id, academyA: first.id, academyB: second.id };
}

type Org = Awaited<ReturnType<typeof newOrganization>>;

async function newUser(label: string, role: "ADMIN" | "DIRECTOR" | "INSTRUCTOR" | "STUDENT") {
  counter += 1;
  const user = await prisma.user.create({
    data: { email: `remove-${label}-${counter}-${suffix}@example.com`, passwordHash: await hashSecret("member-password-123"), role },
  });
  userIds.push(user.id);
  return user;
}

/** A staff member created directly, optionally already deactivated, optionally for an existing account. */
async function addMember(org: { organizationId: string }, role: "ADMIN" | "DIRECTOR" | "INSTRUCTOR", academyIds: string[], opts: { active?: boolean; userId?: string } = {}) {
  const user = opts.userId ? await prisma.user.findUniqueOrThrow({ where: { id: opts.userId } }) : await newUser(role.toLowerCase(), role);
  const membership = await prisma.organizationMembership.create({
    data: { userId: user.id, organizationId: org.organizationId, role, active: opts.active ?? true },
  });
  if (role !== "ADMIN") {
    for (const academyId of academyIds) {
      await prisma.staffAssignment.create({ data: { userId: user.id, academyId, organizationId: org.organizationId, role } });
    }
  }
  return { user, membership, email: user.email };
}

async function linkStudent(org: Org, userId: string, status: "PENDING" | "ACTIVE" | "INACTIVE" | "ARCHIVED") {
  counter += 1;
  const rank =
    (await prisma.beltRank.findFirst({ where: { organizationId: org.organizationId, track: "ADULT", code: "WHITE" } })) ??
    (await prisma.beltRank.create({
      data: {
        organizationId: org.organizationId,
        track: "ADULT",
        code: "WHITE",
        labelEs: "Blanco",
        labelEn: "White",
        primaryColor: "#F0EBE0",
        barColor: "#111116",
        order: 0,
        maxStripes: 4,
        attendancesPerStripe: 30,
        attendancesForExam: 120,
        stripeColors: ["#000000", "#000000", "#000000", "#000000"],
        visibleStripeSlots: 4,
      },
    }));
  return prisma.student.create({
    data: {
      userId,
      organizationId: org.organizationId,
      homeAcademyId: org.academyA,
      firstName: "Linked",
      lastName: `Student ${counter}`,
      phone: "0000-0000",
      email: `remove-linked-${counter}-${suffix}@example.com`,
      currentRankId: rank.id,
      codeHash: digestLookupSecret(`remove-code-${suffix}-${counter}`, requireEnv("CODE_PEPPER")),
      status,
    },
  });
}

/** A pending invitation row written directly (as an earlier/stale link would be), with its raw token. */
async function pendingInvitation(org: Org, email: string, opts: { expired?: boolean } = {}) {
  const rawToken = generateRandomToken();
  const invitation = await prisma.invitation.create({
    data: {
      tokenHash: digestLookupSecret(rawToken, requireEnv("CODE_PEPPER")),
      email,
      organizationId: org.organizationId,
      role: "INSTRUCTOR",
      invitedById: org.ownerId,
      academyIds: [org.academyA],
      expiresAt: new Date(Date.now() + (opts.expired ? -60_000 : 7 * 24 * 60 * 60 * 1000)),
    },
  });
  return { invitation, rawToken };
}

const ctxOf = (userId: string, organizationId: string) => requireOrganizationAccess(userId, organizationId);
const assignmentsOf = (userId: string, organizationId: string) => prisma.staffAssignment.findMany({ where: { userId, organizationId } });
const auditRows = (organizationId: string, action: string) => prisma.auditLog.findMany({ where: { organizationId, action }, orderBy: { createdAt: "asc" } });
const membershipById = (id: string) => prisma.organizationMembership.findUnique({ where: { id } });

/** Everything a refusal must leave exactly as it was. */
async function snapshot(userId: string, organizationId: string, membershipId: string) {
  return {
    membership: await membershipById(membershipId),
    assignments: (await assignmentsOf(userId, organizationId)).map((row) => row.id).sort(),
    invitations: await prisma.invitation.findMany({ where: { organizationId }, orderBy: { id: "asc" }, select: { id: true, usedAt: true, revokedAt: true } }),
    user: await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { lastActiveOrganizationId: true, active: true, passwordHash: true, credentialsVersion: true } }),
    removeAudits: (await auditRows(organizationId, "staff.remove")).length,
  };
}

describe("remove from academy", () => {
  beforeAll(async () => {
    const approver = await prisma.user.create({
      data: { email: `remove-approver-${suffix}@example.com`, passwordHash: await hashSecret("irrelevant-password-123"), role: "ADMIN", isSuperAdmin: true },
    });
    userIds.push(approver.id);
    approverId = approver.id;
  });

  beforeEach(() => {
    currentSession = null;
    sendMock.mockClear();
  });

  afterAll(async () => {
    await prisma.attendanceRecord.deleteMany({ where: { organizationId: { in: orgIds } } });
    await prisma.student.deleteMany({ where: { organizationId: { in: orgIds } } });
    await prisma.auditLog.deleteMany({ where: { organizationId: { in: orgIds } } });
    await prisma.invitation.deleteMany({ where: { organizationId: { in: orgIds } } });
    await prisma.paymentPlan.deleteMany({ where: { organizationId: { in: orgIds } } });
    await prisma.staffAssignment.deleteMany({ where: { organizationId: { in: orgIds } } });
    await prisma.organizationMembership.deleteMany({ where: { organizationId: { in: orgIds } } });
    await prisma.user.updateMany({ where: { id: { in: userIds } }, data: { lastActiveOrganizationId: null } });
    await prisma.beltRank.deleteMany({ where: { organizationId: { in: orgIds } } });
    await prisma.academy.deleteMany({ where: { organizationId: { in: orgIds } } });
    await prisma.organization.deleteMany({ where: { id: { in: orgIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  });

  describe("an Owner removes a deactivated member", () => {
    it("REQUIRED: membership and this academy's assignments go, pending links here are revoked, the preference is cleared, one audit row — and nothing else changes", async () => {
      const org = await newOrganization();
      const other = await newOrganization();
      const member = await addMember(org, "INSTRUCTOR", [org.academyA, org.academyB]);
      const elsewhere = await addMember(other, "DIRECTOR", [other.academyA], { userId: member.user.id });
      await prisma.user.update({ where: { id: member.user.id }, data: { lastActiveOrganizationId: org.organizationId } });

      // Links to this address here: one live and one expired (both must die), one accepted and one revoked (history kept).
      const live = await pendingInvitation(org, member.email);
      const expired = await pendingInvitation(org, member.email, { expired: true });
      const accepted = await pendingInvitation(org, member.email);
      await prisma.invitation.update({ where: { id: accepted.invitation.id }, data: { usedAt: new Date("2026-01-01"), acceptedAt: new Date("2026-01-01") } });
      const revoked = await pendingInvitation(org, member.email);
      const revokedAt = new Date("2026-01-02");
      await prisma.invitation.update({ where: { id: revoked.invitation.id }, data: { revokedAt } });
      // Not this person's, and not this organization's: untouched.
      const someoneElse = await pendingInvitation(org, `someone-else-${suffix}@example.com`);
      const otherOrgLink = await pendingInvitation(other, member.email);

      // History referencing the account: attendance they recorded for another student, and an earlier audit row.
      const student = await linkStudent(org, (await newUser("trainee", "STUDENT")).id, "ACTIVE");
      const attendance = await prisma.attendanceRecord.create({
        data: {
          studentId: student.id,
          academyId: org.academyA,
          organizationId: org.organizationId,
          occurredAt: new Date("2026-03-01T12:00:00Z"),
          date: new Date("2026-03-01T00:00:00Z"),
          type: "CHECKIN",
          source: "STAFF",
          createdById: member.user.id,
        },
      });
      const priorAudit = await prisma.auditLog.create({ data: { actorId: member.user.id, organizationId: org.organizationId, action: "test.history", entityType: "Student", entityId: student.id } });

      actAs(org.ownerId, org.organizationId);
      expect(await deactivateStaffMember(org.organizationId, member.membership.id)).toEqual({ ok: true });
      sendMock.mockClear(); // setup (organization approval) sent its own mocked emails
      const userBefore = await prisma.user.findUniqueOrThrow({ where: { id: member.user.id } });

      expect(await removeStaffMember(org.organizationId, member.membership.id)).toEqual({ ok: true });

      expect(await membershipById(member.membership.id)).toBeNull();
      expect(await assignmentsOf(member.user.id, org.organizationId)).toHaveLength(0);
      const invitation = (id: string) => prisma.invitation.findUniqueOrThrow({ where: { id } });
      expect((await invitation(live.invitation.id)).revokedAt).not.toBeNull();
      expect((await invitation(expired.invitation.id)).revokedAt).not.toBeNull();
      expect(await invitation(accepted.invitation.id)).toMatchObject({ revokedAt: null, acceptedAt: new Date("2026-01-01") });
      expect((await invitation(revoked.invitation.id)).revokedAt).toEqual(revokedAt);
      expect((await invitation(someoneElse.invitation.id)).revokedAt).toBeNull();
      expect((await invitation(otherOrgLink.invitation.id)).revokedAt).toBeNull();

      // The account: only the preference changed — email, password, active, credentialsVersion as they were.
      const userAfter = await prisma.user.findUniqueOrThrow({ where: { id: member.user.id } });
      expect(userAfter.lastActiveOrganizationId).toBeNull();
      expect({ ...userAfter, lastActiveOrganizationId: userBefore.lastActiveOrganizationId, updatedAt: userBefore.updatedAt }).toEqual(userBefore);

      // The other organization: membership and assignments intact, still usable.
      expect(await membershipById(elsewhere.membership.id)).toMatchObject({ active: true, role: "DIRECTOR" });
      expect(await assignmentsOf(member.user.id, other.organizationId)).toHaveLength(1);
      await expect(ctxOf(member.user.id, other.organizationId)).resolves.toMatchObject({ organizationRole: "DIRECTOR" });
      // This organization: denied on the next request (same per-request check an old session goes through); login still works.
      await expect(ctxOf(member.user.id, org.organizationId)).rejects.toMatchObject({ result: { status: "NO_MEMBERSHIP" } });
      expect(await verifyCredentials(member.email, "member-password-123")).not.toBeNull();
      // History kept.
      expect(await prisma.attendanceRecord.findUniqueOrThrow({ where: { id: attendance.id } })).toEqual(attendance);
      expect(await prisma.auditLog.findUniqueOrThrow({ where: { id: priorAudit.id } })).toEqual(priorAudit);

      const audits = await auditRows(org.organizationId, "staff.remove");
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({ actorId: org.ownerId, entityType: "OrganizationMembership", entityId: member.membership.id });
      expect(audits[0].before).toEqual({ userId: member.user.id, email: member.email, role: "INSTRUCTOR", active: false, academyIds: [org.academyA, org.academyB].sort() });
      expect((audits[0].after as { revokedInvitationIds: string[] }).revokedInvitationIds.sort()).toEqual([live.invitation.id, expired.invitation.id].sort());
      expect(sendMock).not.toHaveBeenCalled();
    });

    it("REQUIRED: a case-variant invitation for the same mailbox is revoked too — otherwise accepting it would create a second account with access here", async () => {
      // Addresses are NOT normalized everywhere (signup, academy registration and login use the typed casing; User.email
      // is unique case-sensitively; acceptance looks the account up by the invitation's exact address). So an invitation
      // to `Remove-…@Example.com` reaches the same mailbox as the removed `remove-…@example.com` account, and accepting it
      // would CREATE a separate account with that casing and a fresh membership here.
      const org = await newOrganization();
      const member = await addMember(org, "INSTRUCTOR", [org.academyA], { active: false });
      const variant = member.email.replace(/^remove/, "Remove").replace("@example.com", "@Example.com");
      expect(variant).not.toBe(member.email);
      const live = await pendingInvitation(org, variant);
      const expired = await pendingInvitation(org, variant, { expired: true });
      // The case-insensitive match must stay inside THIS academy and must not touch history:
      const other = await newOrganization();
      const otherAcademy = await pendingInvitation(other, variant); // same mailbox, another academy: stays live
      const consumed = await pendingInvitation(org, variant); // accepted earlier: stays as it was
      const usedAt = new Date("2026-02-01T00:00:00Z");
      await prisma.invitation.update({ where: { id: consumed.invitation.id }, data: { usedAt, acceptedAt: usedAt } });
      const legacyUsed = await pendingInvitation(org, variant); // consumed before acceptedAt existed: stays as it was
      await prisma.invitation.update({ where: { id: legacyUsed.invitation.id }, data: { usedAt } });
      const revokedBefore = await pendingInvitation(org, variant); // already revoked: keeps its original time
      const revokedAt = new Date("2026-02-02T00:00:00Z");
      await prisma.invitation.update({ where: { id: revokedBefore.invitation.id }, data: { revokedAt } });
      actAs(org.ownerId, org.organizationId);

      expect(await removeStaffMember(org.organizationId, member.membership.id)).toEqual({ ok: true });

      const row = (id: string) => prisma.invitation.findUniqueOrThrow({ where: { id }, select: { usedAt: true, acceptedAt: true, revokedAt: true } });
      expect(await row(otherAcademy.invitation.id)).toEqual({ usedAt: null, acceptedAt: null, revokedAt: null });
      expect(await row(consumed.invitation.id)).toEqual({ usedAt, acceptedAt: usedAt, revokedAt: null });
      expect(await row(legacyUsed.invitation.id)).toEqual({ usedAt, acceptedAt: null, revokedAt: null });
      expect(await row(revokedBefore.invitation.id)).toEqual({ usedAt: null, acceptedAt: null, revokedAt });

      expect((await prisma.invitation.findUniqueOrThrow({ where: { id: live.invitation.id } })).revokedAt).not.toBeNull();
      expect((await prisma.invitation.findUniqueOrThrow({ where: { id: expired.invitation.id } })).revokedAt).not.toBeNull();
      expect(await accept(live.rawToken, { password: "a-new-password-1" })).toEqual({ error: "invalidToken" });
      expect(await resendInvitation(org.organizationId, expired.invitation.id)).toEqual({ error: "notPending" });
      expect(await prisma.user.count({ where: { email: variant } })).toBe(0);
      expect(await prisma.organizationMembership.count({ where: { organizationId: org.organizationId, user: { email: { equals: member.email, mode: "insensitive" } } } })).toBe(0);
      const [audit] = await auditRows(org.organizationId, "staff.remove");
      expect((audit.after as { revokedInvitationIds: string[] }).revokedInvitationIds.sort()).toEqual([live.invitation.id, expired.invitation.id].sort());
    });

    it("leaves a preference that points at ANOTHER academy alone", async () => {
      const org = await newOrganization();
      const other = await newOrganization();
      const member = await addMember(org, "INSTRUCTOR", [org.academyA], { active: false });
      await addMember(other, "INSTRUCTOR", [other.academyA], { userId: member.user.id });
      await prisma.user.update({ where: { id: member.user.id }, data: { lastActiveOrganizationId: other.organizationId } });
      actAs(org.ownerId, org.organizationId);

      expect(await removeStaffMember(org.organizationId, member.membership.id)).toEqual({ ok: true });
      expect((await prisma.user.findUniqueOrThrow({ where: { id: member.user.id } })).lastActiveOrganizationId).toBe(other.organizationId);
    });

    // NOT a test of the last-Owner refusal. `removeStaffMembership` keeps that check, but its refusing branch cannot be
    // reached: the actor is re-checked as an active Owner with an active account under the same lock, and only an
    // inactive target can be removed, so another active Owner always remains. No test here exercises it.
    it("a deactivated Owner can be removed while an active Owner remains", async () => {
      const org = await newOrganization();
      const formerOwner = await addMember(org, "ADMIN", [], { active: false });
      actAs(org.ownerId, org.organizationId);
      expect(await removeStaffMember(org.organizationId, formerOwner.membership.id)).toEqual({ ok: true });
      expect(await membershipById(formerOwner.membership.id)).toBeNull();
      expect(await membershipById(org.ownerMembershipId)).toMatchObject({ active: true, role: "ADMIN" });
    });

    it("REQUIRED: the address can be invited again; accepting reuses the same account and creates a NEW membership", async () => {
      const org = await newOrganization();
      const member = await addMember(org, "INSTRUCTOR", [org.academyA], { active: false });
      actAs(org.ownerId, org.organizationId);
      sendMock.mockClear(); // setup (organization approval) sent its own mocked emails
      expect(await removeStaffMember(org.organizationId, member.membership.id)).toEqual({ ok: true });
      expect(sendMock).not.toHaveBeenCalled(); // removal sends nothing

      const invited = await inviteStaff(org.organizationId, {}, form({ email: member.email, role: "DIRECTOR", academyIds: [org.academyB] }));
      expect(invited).toMatchObject({ ok: true, emailOutcome: "accepted" });
      expect(sendMock).toHaveBeenCalledTimes(1); // the mock — nothing real is sent

      expect(await accept(tokenOf(invited.invitationLink!))).toEqual({ ok: true }); // existing account: no password asked, no sign-in
      const fresh = await prisma.organizationMembership.findUniqueOrThrow({ where: { userId_organizationId: { userId: member.user.id, organizationId: org.organizationId } } });
      expect(fresh.id).not.toBe(member.membership.id);
      expect(fresh).toMatchObject({ role: "DIRECTOR", active: true });
      expect((await assignmentsOf(member.user.id, org.organizationId)).map((row) => row.academyId)).toEqual([org.academyB]);
      expect(await prisma.user.count({ where: { email: member.email } })).toBe(1);
      expect(await verifyCredentials(member.email, "member-password-123")).not.toBeNull();

      // A late duplicate of the ORIGINAL removal can never touch the replacement membership.
      expect(await removeStaffMember(org.organizationId, member.membership.id)).toEqual({ error: "notFound" });
      expect(await membershipById(fresh.id)).not.toBeNull();
      expect(await auditRows(org.organizationId, "staff.remove")).toHaveLength(1);
    });
  });

  describe("refusals change nothing", () => {
    it("REQUIRED: a director and an instructor are refused — through the action and calling the service directly", async () => {
      const org = await newOrganization();
      const director = await addMember(org, "DIRECTOR", [org.academyA]);
      const instructor = await addMember(org, "INSTRUCTOR", [org.academyA]);
      const target = await addMember(org, "INSTRUCTOR", [org.academyA], { active: false });
      const before = await snapshot(target.user.id, org.organizationId, target.membership.id);

      for (const actor of [director, instructor]) {
        actAs(actor.user.id, org.organizationId, actor.membership.role);
        await expect(removeStaffMember(org.organizationId, target.membership.id)).rejects.toThrow("FORBIDDEN");
        await expect(removeStaffMembership(await ctxOf(actor.user.id, org.organizationId), target.membership.id)).rejects.toThrow("FORBIDDEN");
      }
      expect(await snapshot(target.user.id, org.organizationId, target.membership.id)).toEqual(before);
    });

    it("REQUIRED: a stale Owner context — deactivated, demoted, or account disabled since it was resolved — is refused under the lock", async () => {
      const org = await newOrganization();
      const second = await addMember(org, "ADMIN", []);
      const target = await addMember(org, "INSTRUCTOR", [org.academyA], { active: false });
      const before = await snapshot(target.user.id, org.organizationId, target.membership.id);

      const stale = await ctxOf(second.user.id, org.organizationId);
      expect(await setMembershipActive(await ctxOf(org.ownerId, org.organizationId), second.membership.id, false)).toEqual({ ok: true });
      expect(await removeStaffMembership(stale, target.membership.id)).toEqual({ error: "notFound" });

      await prisma.organizationMembership.update({ where: { id: second.membership.id }, data: { active: true, role: "DIRECTOR" } });
      expect(await removeStaffMembership(stale, target.membership.id)).toEqual({ error: "notFound" });

      await prisma.organizationMembership.update({ where: { id: second.membership.id }, data: { role: "ADMIN" } });
      await prisma.user.update({ where: { id: second.user.id }, data: { active: false } });
      expect(await removeStaffMembership(stale, target.membership.id)).toEqual({ error: "notFound" });

      expect(await snapshot(target.user.id, org.organizationId, target.membership.id)).toEqual(before);
    });

    it("REQUIRED: self, an active member, a missing or empty id, another organization's member and a student membership", async () => {
      const org = await newOrganization();
      const other = await newOrganization();
      const active = await addMember(org, "INSTRUCTOR", [org.academyA]);
      const foreign = await addMember(other, "INSTRUCTOR", [other.academyA], { active: false });
      const studentUser = await newUser("student", "STUDENT");
      const studentMembership = await prisma.organizationMembership.create({ data: { userId: studentUser.id, organizationId: org.organizationId, role: "STUDENT", active: false } });

      actAs(org.ownerId, org.organizationId);
      const activeBefore = await snapshot(active.user.id, org.organizationId, active.membership.id);
      const foreignBefore = await snapshot(foreign.user.id, other.organizationId, foreign.membership.id);

      expect(await removeStaffMember(org.organizationId, org.ownerMembershipId)).toEqual({ error: "selfChange" });
      expect(await removeStaffMember(org.organizationId, active.membership.id)).toEqual({ error: "removeActive" });
      expect(await removeStaffMember(org.organizationId, "no-such-membership")).toEqual({ error: "notFound" });
      expect(await removeStaffMember(org.organizationId, "")).toEqual({ error: "invalid" });
      expect(await removeStaffMember(org.organizationId, foreign.membership.id)).toEqual({ error: "notFound" });
      expect(await removeStaffMember(other.organizationId, foreign.membership.id)).toEqual({ error: "notFound" }); // not a member there
      expect(await removeStaffMember(org.organizationId, studentMembership.id)).toEqual({ error: "notFound" });

      expect(await membershipById(org.ownerMembershipId)).toMatchObject({ active: true });
      expect(await membershipById(studentMembership.id)).not.toBeNull();
      expect(await snapshot(active.user.id, org.organizationId, active.membership.id)).toEqual(activeBefore);
      expect(await snapshot(foreign.user.id, other.organizationId, foreign.membership.id)).toEqual(foreignBefore);
      expect(await auditRows(org.organizationId, "staff.remove")).toHaveLength(0);
    });

    it("REQUIRED: a linked student record in ANY status blocks removal and keeps membership and student data", async () => {
      const org = await newOrganization();
      actAs(org.ownerId, org.organizationId);
      for (const [status, error] of [["ACTIVE", "linkedStudent"], ["PENDING", "linkedStudentInactive"], ["INACTIVE", "linkedStudentInactive"], ["ARCHIVED", "linkedStudentInactive"]] as const) {
        const coach = await addMember(org, "INSTRUCTOR", [org.academyA], { active: false });
        const student = await linkStudent(org, coach.user.id, status);
        const before = await snapshot(coach.user.id, org.organizationId, coach.membership.id);

        expect(await removeStaffMember(org.organizationId, coach.membership.id)).toEqual({ error });

        expect(await snapshot(coach.user.id, org.organizationId, coach.membership.id)).toEqual(before);
        expect(await prisma.student.findUniqueOrThrow({ where: { id: student.id } })).toEqual(student);
      }
    });
  });

  it("REQUIRED: atomic — if the audit row cannot be written, nothing is removed, revoked or cleared", async () => {
    const org = await newOrganization();
    const member = await addMember(org, "INSTRUCTOR", [org.academyA], { active: false });
    await pendingInvitation(org, member.email);
    // A case-variant link too: the case-insensitive revocation must roll back with everything else.
    await pendingInvitation(org, member.email.replace(/^remove/, "REMOVE"));
    await prisma.user.update({ where: { id: member.user.id }, data: { lastActiveOrganizationId: org.organizationId } });
    const before = await snapshot(member.user.id, org.organizationId, member.membership.id);

    // A test-database-only trigger, scoped to THIS membership id, that makes the staff.remove audit insert fail.
    const fn = `test_fail_remove_${suffix.replace(/\W/g, "_")}`;
    await prisma.$executeRawUnsafe(
      `CREATE FUNCTION ${fn}() RETURNS trigger AS $$ BEGIN IF NEW.action = 'staff.remove' AND NEW."entityId" = '${member.membership.id}' THEN RAISE EXCEPTION 'forced audit failure'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql`,
    );
    await prisma.$executeRawUnsafe(`CREATE TRIGGER ${fn} BEFORE INSERT ON "AuditLog" FOR EACH ROW EXECUTE FUNCTION ${fn}()`);
    try {
      actAs(org.ownerId, org.organizationId);
      await expect(removeStaffMember(org.organizationId, member.membership.id)).rejects.toThrow(/forced audit failure/);
    } finally {
      await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${fn} ON "AuditLog"`);
      await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${fn}()`);
    }
    expect(await snapshot(member.user.id, org.organizationId, member.membership.id)).toEqual(before);
  });

  /**
   * Races in BOTH orders, explicitly. Every operation here takes the organization staff lock first; this holds that lock,
   * starts `first`, waits until the database shows it queued on the lock, then starts `second` and waits until it is
   * queued too, then releases. PostgreSQL grants a contended lock to its waiters in queue order, so `first` runs to its
   * commit before `second` reads anything. Each test then asserts the outcome of THAT order, not "either".
   */
  async function inLockOrder<A, B>(organizationId: string, first: () => Promise<A>, second: () => Promise<B>): Promise<[A, B]> {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let held!: () => void;
    const holding = new Promise<void>((resolve) => (held = resolve));
    const holder = prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${organizationId}))::text AS locked`;
        held();
        await gate;
      },
      { timeout: 30_000 },
    );
    await holding;
    const one = first();
    await lockWaiters(organizationId, 1);
    const two = second();
    await lockWaiters(organizationId, 2);
    release();
    await holder;
    return Promise.all([one, two]);
  }

  /** Waits until `n` sessions are queued (not granted) on this organization's staff lock. */
  async function lockWaiters(organizationId: string, n: number): Promise<void> {
    for (let i = 0; i < 400; i += 1) {
      const [row] = await prisma.$queryRaw<{ waiting: bigint }[]>`
        SELECT count(*) AS waiting FROM pg_locks
        WHERE locktype = 'advisory' AND NOT granted AND objsubid = 1
          AND objid::bigint = (hashtext(${organizationId})::bigint & 4294967295)`;
      if (Number(row.waiting) >= n) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`the staff lock never had ${n} waiter(s)`);
  }

  describe("races, each in both orders (serialized on the organization staff lock)", () => {
    it("REQUIRED: a duplicate submission removes once, audits once; the second is a benign notFound", async () => {
      const org = await newOrganization();
      const member = await addMember(org, "INSTRUCTOR", [org.academyA], { active: false });
      const ctx = await ctxOf(org.ownerId, org.organizationId);

      const results = await inLockOrder(org.organizationId, () => removeStaffMembership(ctx, member.membership.id), () => removeStaffMembership(ctx, member.membership.id));

      expect(results).toEqual([{ ok: true }, { error: "notFound" }]);
      expect(await auditRows(org.organizationId, "staff.remove")).toHaveLength(1);
    });

    it("REQUIRED: remove first, then reactivate — removed; the reactivation finds nothing", async () => {
      const org = await newOrganization();
      const member = await addMember(org, "INSTRUCTOR", [org.academyA], { active: false });
      const ctx = await ctxOf(org.ownerId, org.organizationId);

      const [removed, reactivated] = await inLockOrder(org.organizationId, () => removeStaffMembership(ctx, member.membership.id), () => setMembershipActive(ctx, member.membership.id, true));

      expect(removed).toEqual({ ok: true });
      expect(reactivated).toEqual({ error: "notFound" });
      expect(await membershipById(member.membership.id)).toBeNull();
      expect(await assignmentsOf(member.user.id, org.organizationId)).toHaveLength(0);
      expect(await auditRows(org.organizationId, "staff.reactivate")).toHaveLength(0);
    });

    it("REQUIRED: reactivate first, then remove — reactivated and kept; the removal is refused as active", async () => {
      const org = await newOrganization();
      const member = await addMember(org, "INSTRUCTOR", [org.academyA], { active: false });
      const ctx = await ctxOf(org.ownerId, org.organizationId);

      const [reactivated, removed] = await inLockOrder(org.organizationId, () => setMembershipActive(ctx, member.membership.id, true), () => removeStaffMembership(ctx, member.membership.id));

      expect(reactivated).toEqual({ ok: true });
      expect(removed).toEqual({ error: "removeActive" });
      expect(await membershipById(member.membership.id)).toMatchObject({ active: true });
      expect(await assignmentsOf(member.user.id, org.organizationId)).toHaveLength(1);
      expect(await auditRows(org.organizationId, "staff.remove")).toHaveLength(0);
    });

    it("REQUIRED: remove first, then a stale link is accepted — the link was revoked; no access", async () => {
      const org = await newOrganization();
      const member = await addMember(org, "INSTRUCTOR", [org.academyA], { active: false });
      const { invitation, rawToken } = await pendingInvitation(org, member.email);
      const ctx = await ctxOf(org.ownerId, org.organizationId);

      const [removed, accepted] = await inLockOrder(org.organizationId, () => removeStaffMembership(ctx, member.membership.id), () => accept(rawToken));

      expect(removed).toEqual({ ok: true });
      expect(accepted).toEqual({ error: "invalidToken" });
      expect(await prisma.invitation.findUniqueOrThrow({ where: { id: invitation.id } })).toMatchObject({ acceptedAt: null, usedAt: null });
      expect(await prisma.organizationMembership.count({ where: { userId: member.user.id, organizationId: org.organizationId } })).toBe(0);
      await expect(ctxOf(member.user.id, org.organizationId)).rejects.toMatchObject({ result: { status: "NO_MEMBERSHIP" } });
    });

    it("REQUIRED: a stale link is accepted first, then remove — acceptance leaves the deactivated membership as it is; removal then deletes it", async () => {
      const org = await newOrganization();
      const member = await addMember(org, "INSTRUCTOR", [org.academyA], { active: false });
      const { invitation, rawToken } = await pendingInvitation(org, member.email);
      const ctx = await ctxOf(org.ownerId, org.organizationId);

      const [accepted, removed] = await inLockOrder(org.organizationId, () => accept(rawToken), () => removeStaffMembership(ctx, member.membership.id));

      expect(accepted).toEqual({ ok: true }); // existing account: consumed, membership left deactivated, nobody signed in
      expect(removed).toEqual({ ok: true }); // still deactivated when removal read it
      expect((await prisma.invitation.findUniqueOrThrow({ where: { id: invitation.id } })).acceptedAt).not.toBeNull();
      expect(await auditRows(org.organizationId, "staff.accept")).toHaveLength(2); // the Owner's own acceptance + this one
      expect(await prisma.organizationMembership.count({ where: { userId: member.user.id, organizationId: org.organizationId } })).toBe(0);
      await expect(ctxOf(member.user.id, org.organizationId)).rejects.toMatchObject({ result: { status: "NO_MEMBERSHIP" } });
    });

    it("REQUIRED: a resend before removal is revoked with the rest; a resend after removal is refused", async () => {
      const org = await newOrganization();
      const member = await addMember(org, "INSTRUCTOR", [org.academyA], { active: false });
      const first = await pendingInvitation(org, member.email);
      actAs(org.ownerId, org.organizationId);

      const resent = await resendInvitation(org.organizationId, first.invitation.id);
      expect(resent).toMatchObject({ ok: true });
      expect(await removeStaffMember(org.organizationId, member.membership.id)).toEqual({ ok: true });

      expect(await prisma.invitation.count({ where: { organizationId: org.organizationId, email: member.email, usedAt: null, revokedAt: null } })).toBe(0);
      expect(await accept(tokenOf(resent.invitationLink!))).toEqual({ error: "invalidToken" });
      expect(await resendInvitation(org.organizationId, first.invitation.id)).toEqual({ error: "notPending" });
    });

    it("REQUIRED: the removing Owner is deactivated FIRST by another Owner — their removal is then refused (stale actor)", async () => {
      const org = await newOrganization();
      const second = await addMember(org, "ADMIN", []);
      const target = await addMember(org, "INSTRUCTOR", [org.academyA], { active: false });
      const secondCtx = await ctxOf(second.user.id, org.organizationId);
      const ownerCtx = await ctxOf(org.ownerId, org.organizationId);

      const [deactivated, removed] = await inLockOrder(org.organizationId, () => setMembershipActive(ownerCtx, second.membership.id, false), () => removeStaffMembership(secondCtx, target.membership.id));

      expect(deactivated).toEqual({ ok: true });
      expect(removed).toEqual({ error: "notFound" });
      expect(await membershipById(target.membership.id)).toMatchObject({ active: false });
      expect(await assignmentsOf(target.user.id, org.organizationId)).toHaveLength(1);
      expect(await auditRows(org.organizationId, "staff.remove")).toHaveLength(0);
    });

    it("REQUIRED: the removing Owner removes FIRST, then is deactivated — the removal stands; the deactivation still applies", async () => {
      const org = await newOrganization();
      const second = await addMember(org, "ADMIN", []);
      const target = await addMember(org, "INSTRUCTOR", [org.academyA], { active: false });
      const secondCtx = await ctxOf(second.user.id, org.organizationId);
      const ownerCtx = await ctxOf(org.ownerId, org.organizationId);

      const [removed, deactivated] = await inLockOrder(org.organizationId, () => removeStaffMembership(secondCtx, target.membership.id), () => setMembershipActive(ownerCtx, second.membership.id, false));

      expect(removed).toEqual({ ok: true });
      expect(deactivated).toEqual({ ok: true });
      expect(await membershipById(target.membership.id)).toBeNull();
      expect(await membershipById(second.membership.id)).toMatchObject({ active: false });
      expect(await auditRows(org.organizationId, "staff.remove")).toHaveLength(1);
    });
  });

  it("reactivating after removal is notFound — Reactivate cannot bring back a removed member", async () => {
    const org = await newOrganization();
    const member = await addMember(org, "INSTRUCTOR", [org.academyA], { active: false });
    actAs(org.ownerId, org.organizationId);
    expect(await removeStaffMember(org.organizationId, member.membership.id)).toEqual({ ok: true });
    expect(await reactivateStaffMember(org.organizationId, member.membership.id)).toEqual({ error: "notFound" });
  });
});
