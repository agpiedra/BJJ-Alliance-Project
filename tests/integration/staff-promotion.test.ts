import "dotenv/config";
import { getTestPrismaClient } from "../helpers/test-db";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/email/send-transactional-email", () => ({
  sendTransactionalEmail: vi.fn(async () => ({ success: true })),
}));

let currentSession: { user: { id: string }; activeOrganizationId: string; access?: unknown } | null = null;
vi.mock("@/auth", () => ({
  auth: () => Promise.resolve(currentSession),
  signIn: vi.fn((_provider: string, options: { redirectTo: string }) => {
    const error = new Error("NEXT_REDIRECT");
    (error as { digest?: string }).digest = `NEXT_REDIRECT;push;${options.redirectTo};307;`;
    throw error;
  }),
}));
vi.mock("@/lib/notifications/fire-and-forget", () => ({ fireAndForget: vi.fn() }));

const { approveOrganization } = await import("../../src/lib/organizations/approve-organization");
const { acceptInvitation } = await import("../../src/app/[locale]/accept-invitation/actions");
const { registerOrganization } = await import("../../src/app/[locale]/register-academy/actions");
const { signup } = await import("../../src/app/[locale]/o/[orgSlug]/signup/actions");
const { approveStudent, archiveStudent } = await import("../../src/app/[locale]/(staff)/students/[id]/actions");
const { inviteStaff, updateStaffMember } = await import("../../src/lib/staff/staff-actions");
const { listStaff } = await import("../../src/lib/staff/list-staff");
const { deriveAccess } = await import("../../src/lib/auth/derive-access");
const { verifyCredentials } = await import("../../src/lib/auth/verify-credentials");
const { hashSecret } = await import("../../src/lib/crypto");

const prisma = getTestPrismaClient();

/**
 * "In a jiu-jitsu academy every instructor is a student." Until now an Owner who
 * invited an address that already belonged to a student's login was refused
 * (`studentAccount`) — the global `User.role` gated whole route trees, so one account
 * could not be both — and the only workaround was a second email address: one person,
 * two identities, teaching under one and training under the other.
 *
 * Access is membership now, so the refusal is gone. Inviting an existing student
 * account PROMOTES their membership in place when they accept: the same membership row,
 * the same login and password, the same student record, its history and belt — the
 * role changes and the academies are assigned, and it is audited with the before and
 * after role. The reverse — "Student only" — takes staff access away and leaves the
 * training. Built the real way throughout (registration form, approval, invitation
 * accepted, public student signup, the real approve / archive actions).
 */
const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
const orgIds: string[] = [];
const userIds: string[] = [];
const registrationEmails: string[] = [];
let counter = 0;
let approverId: string;
const STUDENT_PASSWORD = "student-password-123";

const NONE = { staff: false, portal: false };
const STAFF_ONLY = { staff: true, portal: false };
const PORTAL_ONLY = { staff: false, portal: true };
const BOTH = { staff: true, portal: true };

function form(fields: Record<string, string | string[]>): FormData {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    for (const item of Array.isArray(value) ? value : [value]) fd.append(key, item);
  }
  return fd;
}

function actAs(userId: string, organizationId: string) {
  currentSession = { user: { id: userId }, activeOrganizationId: organizationId };
}

async function newOrganization() {
  counter += 1;
  const email = `promo-owner-${counter}-${suffix}@example.com`;
  const slug = `promo-${suffix}-${counter}`;
  registrationEmails.push(email);
  const registration = await registerOrganization(
    {},
    form({
      organizationName: `Promo ${counter}`,
      desiredSlug: slug,
      country: "Costa Rica",
      city: "Heredia",
      contactName: "Owner",
      contactEmail: email,
      contactPhone: "88880000",
      studentCountBand: "1-25",
      preferredLocale: "es",
      termsAccepted: "on",
    }),
  );
  expect(registration, JSON.stringify(registration)).toMatchObject({ ok: true });
  const organization = await prisma.organization.findUniqueOrThrow({ where: { slug } });
  orgIds.push(organization.id);
  const approval = await approveOrganization(organization.slug, approverId);
  const fd = new FormData();
  fd.set("token", new URL(approval.invitationLink!).searchParams.get("token")!);
  fd.set("password", "owner-password-123");
  await acceptInvitation("es", {}, fd).catch((error: { digest?: string }) => {
    if (!error.digest?.startsWith("NEXT_REDIRECT")) throw error;
  });
  const owner = await prisma.user.findUniqueOrThrow({ where: { email } });
  userIds.push(owner.id);
  const academy = await prisma.academy.findFirstOrThrow({ where: { organizationId: organization.id } });
  return { organizationId: organization.id, slug, academySlug: academy.slug, academyId: academy.id, ownerId: owner.id };
}

type Org = Awaited<ReturnType<typeof newOrganization>>;

async function approvedStudent(org: Org, label: string) {
  counter += 1;
  const email = `promo-student-${label}-${counter}-${suffix}@example.com`;
  const result = await signup(
    org.slug,
    {},
    form({
      firstName: "Real",
      lastName: `Student${counter}`,
      phone: "88880000",
      email,
      homeAcademySlug: org.academySlug,
      currentBelt: "BLUE",
      currentStripes: "2",
      password: STUDENT_PASSWORD,
    }),
  );
  expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
  const user = await prisma.user.findUniqueOrThrow({ where: { email } });
  userIds.push(user.id);
  const student = await prisma.student.findFirstOrThrow({ where: { userId: user.id } });
  actAs(org.ownerId, org.organizationId);
  expect(await approveStudent(org.organizationId, {}, form({ studentId: student.id }))).toEqual({ ok: true });
  return { user, student, email };
}

/** The Owner invites, the person accepts the link — the whole real path. Returns the invitation link's token. */
async function invite(org: Org, email: string, role: string, academyIds: string[]) {
  actAs(org.ownerId, org.organizationId);
  const result = await inviteStaff(org.organizationId, {}, form({ email, role, academyIds }));
  return result as { ok?: true; error?: string; invitationLink?: string };
}
const tokenOf = (link: string) => new URL(link).searchParams.get("token")!;
async function accept(token: string) {
  currentSession = null; // an existing account is not signed in by a link, and needs no session to accept
  return acceptInvitation("es", {}, form({ token }));
}

const membershipOf = (userId: string, organizationId: string) =>
  prisma.organizationMembership.findUnique({ where: { userId_organizationId: { userId, organizationId } } });
const assignmentsOf = (userId: string, organizationId: string) =>
  prisma.staffAssignment.findMany({ where: { userId, organizationId }, orderBy: { academyId: "asc" } });

describe("promoting a student to staff, and back", () => {
  beforeAll(async () => {
    const approver = await prisma.user.create({
      data: { email: `promo-approver-${suffix}@example.com`, passwordHash: await hashSecret("irrelevant-password-123"), role: "ADMIN", isSuperAdmin: true },
    });
    userIds.push(approver.id);
    approverId = approver.id;
  });

  afterEach(() => {
    currentSession = null;
  });

  afterAll(async () => {
    await prisma.auditLog.deleteMany({ where: { organizationId: { in: orgIds } } });
    await prisma.notification.deleteMany({ where: { organizationId: { in: orgIds } } });
    await prisma.student.deleteMany({ where: { organizationId: { in: orgIds } } });
    await prisma.invitation.deleteMany({ where: { organizationId: { in: orgIds } } });
    await prisma.paymentPlan.deleteMany({ where: { organizationId: { in: orgIds } } });
    await prisma.staffAssignment.deleteMany({ where: { organizationId: { in: orgIds } } });
    await prisma.organizationMembership.deleteMany({ where: { organizationId: { in: orgIds } } });
    await prisma.academy.deleteMany({ where: { organizationId: { in: orgIds } } });
    await prisma.promotionConfig.deleteMany({ where: { organizationId: { in: orgIds } } });
    await prisma.beltRank.deleteMany({ where: { organizationId: { in: orgIds } } });
    await prisma.organizationBranding.deleteMany({ where: { organizationId: { in: orgIds } } });
    await prisma.organization.deleteMany({ where: { id: { in: orgIds } } });
    await prisma.registrationAttempt.deleteMany({ where: { email: { in: registrationEmails } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  });

  describe("inviting an existing student account", () => {
    it("REQUIRED: is no longer refused, and on acceptance PROMOTES their membership in place — same membership, login, password and student record; both sides of the app", async () => {
      const org = await newOrganization();
      const { user, student, email } = await approvedStudent(org, "promoted");
      const before = await membershipOf(user.id, org.organizationId);
      const passwordBefore = (await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).passwordHash;
      expect(before).toMatchObject({ role: "STUDENT", active: true });
      expect(await deriveAccess(user.id, org.organizationId)).toEqual(PORTAL_ONLY);

      const invited = await invite(org, email, "INSTRUCTOR", [org.academyId]);
      expect(invited, JSON.stringify(invited)).toMatchObject({ ok: true });
      // Nothing changes until they accept: a pending invitation grants nothing.
      expect((await membershipOf(user.id, org.organizationId))?.role).toBe("STUDENT");

      expect(await accept(tokenOf(invited.invitationLink!))).toEqual({ ok: true });

      const after = await membershipOf(user.id, org.organizationId);
      expect(after).toMatchObject({ id: before!.id, role: "INSTRUCTOR", active: true }); // the SAME row, promoted
      expect((await assignmentsOf(user.id, org.organizationId)).map((a) => [a.academyId, a.role])).toEqual([[org.academyId, "INSTRUCTOR"]]);

      // Their login, their password and their training are untouched.
      const account = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
      expect(account.passwordHash).toBe(passwordBefore);
      expect(await verifyCredentials(email, STUDENT_PASSWORD)).toMatchObject({ id: user.id });
      expect(await prisma.student.findUniqueOrThrow({ where: { id: student.id } })).toMatchObject({ status: "ACTIVE", userId: user.id, currentStripes: 2 });
      expect(await prisma.organizationMembership.count({ where: { userId: user.id } })).toBe(1);

      // Both sides of the app, from one account — and the global role is not what decided it.
      expect(await deriveAccess(user.id, org.organizationId)).toEqual(BOTH);
      expect(account.role).toBe("STUDENT");
      expect((await listStaff(org.organizationId)).members.find((m) => m.userId === user.id)).toMatchObject({ role: "INSTRUCTOR" });
    });

    it("REQUIRED: the promotion is audited with the before and after role", async () => {
      const org = await newOrganization();
      const { user, email } = await approvedStudent(org, "audited");
      const invited = await invite(org, email, "DIRECTOR", [org.academyId]);
      await accept(tokenOf(invited.invitationLink!));

      const audit = await prisma.auditLog.findFirstOrThrow({ where: { organizationId: org.organizationId, action: "staff.promote", actorId: user.id } });
      expect(audit).toMatchObject({ entityType: "OrganizationMembership" });
      expect(audit.before).toMatchObject({ role: "STUDENT", academyIds: [] });
      expect(audit.after).toMatchObject({ role: "DIRECTOR", academyIds: [org.academyId] });
    });

    it("promoting to Owner assigns no academies (an Owner has every one)", async () => {
      const org = await newOrganization();
      const { user, email } = await approvedStudent(org, "owner");
      const invited = await invite(org, email, "ADMIN", []);
      await accept(tokenOf(invited.invitationLink!));

      expect(await membershipOf(user.id, org.organizationId)).toMatchObject({ role: "ADMIN" });
      expect(await assignmentsOf(user.id, org.organizationId)).toEqual([]);
      expect(await deriveAccess(user.id, org.organizationId)).toEqual(BOTH);
    });

    it("a director still needs at least one location, promotion or not", async () => {
      const org = await newOrganization();
      const { email } = await approvedStudent(org, "needs-academy");
      expect(await invite(org, email, "DIRECTOR", [])).toMatchObject({ error: "academyRequired" });
    });

    it("REQUIRED: an old link changes nothing once the membership has been deactivated — it can neither promote nor reactivate", async () => {
      const org = await newOrganization();
      const { user, student, email } = await approvedStudent(org, "stale-link");
      const invited = await invite(org, email, "INSTRUCTOR", [org.academyId]);

      actAs(org.ownerId, org.organizationId);
      expect(await archiveStudent(org.organizationId, {}, form({ studentId: student.id }))).toEqual({ ok: true }); // switches the membership off
      expect(await accept(tokenOf(invited.invitationLink!))).toEqual({ ok: true });

      expect(await membershipOf(user.id, org.organizationId)).toMatchObject({ role: "STUDENT", active: false });
      expect(await assignmentsOf(user.id, org.organizationId)).toEqual([]);
      expect(await prisma.auditLog.count({ where: { organizationId: org.organizationId, action: "staff.promote" } })).toBe(0);
      expect(await deriveAccess(user.id, org.organizationId)).toEqual(NONE);
    });

    it("a link works once: the second acceptance is refused and nothing changes twice", async () => {
      const org = await newOrganization();
      const { email } = await approvedStudent(org, "once");
      const invited = await invite(org, email, "INSTRUCTOR", [org.academyId]);
      const token = tokenOf(invited.invitationLink!);

      expect(await accept(token)).toEqual({ ok: true });
      expect(await accept(token)).toEqual({ error: "invalidToken" });
      expect(await prisma.auditLog.count({ where: { organizationId: org.organizationId, action: "staff.promote" } })).toBe(1);
    });

    it("the other refusals stand: someone already staff is alreadyMember, a deactivated membership is alreadyMemberInactive", async () => {
      const org = await newOrganization();
      const coach = await approvedStudent(org, "already-staff");
      const invited = await invite(org, coach.email, "INSTRUCTOR", [org.academyId]);
      await accept(tokenOf(invited.invitationLink!));
      expect(await invite(org, coach.email, "DIRECTOR", [org.academyId])).toMatchObject({ error: "alreadyMember" });

      const archived = await approvedStudent(org, "archived");
      actAs(org.ownerId, org.organizationId);
      await archiveStudent(org.organizationId, {}, form({ studentId: archived.student.id }));
      expect(await invite(org, archived.email, "INSTRUCTOR", [org.academyId])).toMatchObject({ error: "alreadyMemberInactive" });
    });
  });

  describe("Student only (the demotion)", () => {
    async function makeCoach(org: Org, label: string) {
      const person = await approvedStudent(org, label);
      const invited = await invite(org, person.email, "INSTRUCTOR", [org.academyId]);
      await accept(tokenOf(invited.invitationLink!));
      const membership = (await membershipOf(person.user.id, org.organizationId))!;
      return { ...person, membership };
    }

    it("REQUIRED: takes staff access away and keeps the training — same membership, no assignments, student record untouched, audited", async () => {
      const org = await newOrganization();
      const coach = await makeCoach(org, "demoted");
      expect(await deriveAccess(coach.user.id, org.organizationId)).toEqual(BOTH);

      actAs(org.ownerId, org.organizationId);
      const result = await updateStaffMember(org.organizationId, {}, form({ membershipId: coach.membership.id, role: "STUDENT", academyIds: [] }));
      expect(result).toEqual({ ok: true });

      expect(await membershipOf(coach.user.id, org.organizationId)).toMatchObject({ id: coach.membership.id, role: "STUDENT", active: true });
      expect(await assignmentsOf(coach.user.id, org.organizationId)).toEqual([]);
      expect(await prisma.student.findUniqueOrThrow({ where: { id: coach.student.id } })).toMatchObject({ status: "ACTIVE" });
      expect(await deriveAccess(coach.user.id, org.organizationId)).toEqual(PORTAL_ONLY);

      const audit = await prisma.auditLog.findFirstOrThrow({ where: { organizationId: org.organizationId, action: "staff.update", entityId: coach.membership.id } });
      expect(audit.before).toMatchObject({ role: "INSTRUCTOR", academyIds: [org.academyId] });
      expect(audit.after).toMatchObject({ role: "STUDENT", academyIds: [] });
      // They are no longer on the staff page's roster (students are not managed there).
      expect((await listStaff(org.organizationId)).members.some((m) => m.userId === coach.user.id)).toBe(false);
    });

    it("REQUIRED: someone with no student record has nothing to keep — refused (noStudentRecord), unchanged; deactivate is the tool for removing them", async () => {
      const org = await newOrganization();
      actAs(org.ownerId, org.organizationId);
      counter += 1;
      const email = `promo-staff-only-${counter}-${suffix}@example.com`;
      const invited = (await inviteStaff(org.organizationId, {}, form({ email, role: "INSTRUCTOR", academyIds: [org.academyId] }))) as { invitationLink: string };
      const fd = form({ token: tokenOf(invited.invitationLink), password: "brand-new-password-1" });
      await acceptInvitation("es", {}, fd).catch((error: { digest?: string }) => {
        if (!error.digest?.startsWith("NEXT_REDIRECT")) throw error;
      });
      const user = await prisma.user.findUniqueOrThrow({ where: { email } });
      userIds.push(user.id);
      const membership = (await membershipOf(user.id, org.organizationId))!;

      actAs(org.ownerId, org.organizationId);
      const result = await updateStaffMember(org.organizationId, {}, form({ membershipId: membership.id, role: "STUDENT", academyIds: [] }));

      expect(result).toMatchObject({ error: "noStudentRecord" });
      expect(await membershipOf(user.id, org.organizationId)).toMatchObject({ role: "INSTRUCTOR" });
      expect((await assignmentsOf(user.id, org.organizationId)).length).toBe(1);
    });

    it("nobody demotes themselves — even to Student only", async () => {
      const org = await newOrganization();
      const owner = await approvedStudent(org, "owner-self");
      const invited = await invite(org, owner.email, "ADMIN", []);
      await accept(tokenOf(invited.invitationLink!));
      const membership = (await membershipOf(owner.user.id, org.organizationId))!;

      actAs(owner.user.id, org.organizationId);
      expect(await updateStaffMember(org.organizationId, {}, form({ membershipId: membership.id, role: "STUDENT", academyIds: [] }))).toMatchObject({ error: "selfChange" });
      expect(await membershipOf(owner.user.id, org.organizationId)).toMatchObject({ role: "ADMIN" });
    });

    it("an Owner who trains can be moved to Student only by another Owner — and the original Owner stays", async () => {
      const org = await newOrganization();
      const second = await approvedStudent(org, "second-owner");
      const invited = await invite(org, second.email, "ADMIN", []);
      await accept(tokenOf(invited.invitationLink!));
      const membership = (await membershipOf(second.user.id, org.organizationId))!;

      actAs(org.ownerId, org.organizationId);
      expect(await updateStaffMember(org.organizationId, {}, form({ membershipId: membership.id, role: "STUDENT", academyIds: [] }))).toEqual({ ok: true });
      expect(await deriveAccess(second.user.id, org.organizationId)).toEqual(PORTAL_ONLY);
      expect(await deriveAccess(org.ownerId, org.organizationId)).toEqual(STAFF_ONLY);
    });

    it("a location director or instructor may not demote anyone (Owner-only, like every staff action)", async () => {
      const org = await newOrganization();
      const coach = await makeCoach(org, "forbidden-actor");
      const target = await makeCoach(org, "forbidden-target");

      actAs(coach.user.id, org.organizationId);
      await expect(updateStaffMember(org.organizationId, {}, form({ membershipId: target.membership.id, role: "STUDENT", academyIds: [] }))).rejects.toThrow("FORBIDDEN");
      expect(await membershipOf(target.user.id, org.organizationId)).toMatchObject({ role: "INSTRUCTOR" });
    });
  });
});
