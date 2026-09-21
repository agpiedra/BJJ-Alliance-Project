import "dotenv/config";
import { getTestPrismaClient } from "../helpers/test-db";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/email/send-transactional-email", () => ({
  sendTransactionalEmail: vi.fn(async () => ({ success: true })),
}));

let currentSession: { user: { id: string } | null; activeOrganizationId?: string } | null = null;
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
const { approveStudent, archiveStudent, restoreStudent } = await import("../../src/app/[locale]/(staff)/students/[id]/actions");
const { deriveAccess } = await import("../../src/lib/auth/derive-access");
const { signInJwtCallback } = await import("../../src/lib/auth/sign-in-jwt-callback");
const authConfig = (await import("../../src/auth.config")).default;
const { hashSecret } = await import("../../src/lib/crypto");

const prisma = getTestPrismaClient();

/**
 * The `access` claim — `{ staff, portal }` — that the Edge middleware reads.
 * Derived from the DATABASE by one function, from the same membership and
 * linked-student facts every per-request check uses:
 *
 * - `staff`: an ACTIVE membership whose role is ADMIN, DIRECTOR or INSTRUCTOR;
 * - `portal`: an ACTIVE membership AND a linked `Student` whose status is ACTIVE.
 *   (Pure students have both by construction — approval creates the membership —
 *   and archiving takes both away. A coach who also trains has their own student
 *   record: archive THAT and they lose the portal and keep the staff app, the same
 *   as any archived student.)
 *
 * Built the real way throughout: the public registration form, approval, the
 * invitation accepted, the public student signup, the real approve / archive /
 * restore actions — a test that builds its world by hand tests a world that does
 * not exist.
 */
const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
const orgIds: string[] = [];
const userIds: string[] = [];
const registrationEmails: string[] = [];
let counter = 0;
let approverId: string;

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) fd.set(key, value);
  return fd;
}

function actAs(userId: string, organizationId: string) {
  currentSession = { user: { id: userId }, activeOrganizationId: organizationId };
}

async function newOrganization() {
  counter += 1;
  const email = `access-owner-${counter}-${suffix}@example.com`;
  const slug = `access-${suffix}-${counter}`;
  registrationEmails.push(email);
  const registration = await registerOrganization(
    {},
    form({
      organizationName: `Access ${counter}`,
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

async function signUpStudent(org: { slug: string; academySlug: string }, label: string) {
  counter += 1;
  const email = `access-student-${label}-${counter}-${suffix}@example.com`;
  const result = await signup(
    org.slug,
    {},
    form({
      firstName: "Real",
      lastName: `Student${counter}`,
      phone: "88880000",
      email,
      homeAcademySlug: org.academySlug,
      currentBelt: "WHITE",
      currentStripes: "0",
      password: "student-password-123",
    }),
  );
  expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
  const user = await prisma.user.findUniqueOrThrow({ where: { email } });
  userIds.push(user.id);
  const student = await prisma.student.findFirstOrThrow({ where: { userId: user.id } });
  return { user, student };
}

const idForm = (studentId: string) => form({ studentId });
const approve = (org: { organizationId: string; ownerId: string }, studentId: string) => (actAs(org.ownerId, org.organizationId), approveStudent(org.organizationId, {}, idForm(studentId)));
const archive = (org: { organizationId: string; ownerId: string }, studentId: string) => (actAs(org.ownerId, org.organizationId), archiveStudent(org.organizationId, {}, idForm(studentId)));
const restore = (org: { organizationId: string; ownerId: string }, studentId: string) => (actAs(org.ownerId, org.organizationId), restoreStudent(org.organizationId, {}, idForm(studentId)));

const NONE = { staff: false, portal: false };
const STAFF_ONLY = { staff: true, portal: false };
const PORTAL_ONLY = { staff: false, portal: true };
const BOTH = { staff: true, portal: true };

describe("deriveAccess and the access claim", () => {
  beforeAll(async () => {
    const approver = await prisma.user.create({
      data: { email: `access-approver-${suffix}@example.com`, passwordHash: await hashSecret("irrelevant-password-123"), role: "ADMIN", isSuperAdmin: true },
    });
    userIds.push(approver.id);
    approverId = approver.id;
  });

  beforeEach(() => {
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

  describe("deriveAccess", () => {
    it("REQUIRED: an Owner is staff-only; a real student is portal-only once approved and not before", async () => {
      const org = await newOrganization();
      const { user, student } = await signUpStudent(org, "plain");

      expect(await deriveAccess(org.ownerId, org.organizationId)).toEqual(STAFF_ONLY);
      expect(await deriveAccess(user.id, org.organizationId)).toEqual(NONE); // pending applicant: no membership yet

      await approve(org, student.id);
      expect(await deriveAccess(user.id, org.organizationId)).toEqual(PORTAL_ONLY);
    });

    it("REQUIRED: archiving takes the portal away and restoring gives it back", async () => {
      const org = await newOrganization();
      const { user, student } = await signUpStudent(org, "cycle");
      await approve(org, student.id);

      await archive(org, student.id);
      expect(await deriveAccess(user.id, org.organizationId)).toEqual(NONE);
      await restore(org, student.id);
      expect(await deriveAccess(user.id, org.organizationId)).toEqual(PORTAL_ONLY);
    });

    it("REQUIRED: a coach who also trains has BOTH — and archiving THEIR student record takes only the portal, not the staff app", async () => {
      const org = await newOrganization();
      const { user, student } = await signUpStudent(org, "coach");
      await approve(org, student.id);
      // The student's membership becomes an instructor's (the promotion itself has its own test in staff-management).
      await prisma.organizationMembership.update({
        where: { userId_organizationId: { userId: user.id, organizationId: org.organizationId } },
        data: { role: "INSTRUCTOR" },
      });
      expect(await deriveAccess(user.id, org.organizationId)).toEqual(BOTH);

      await archive(org, student.id);
      expect(await deriveAccess(user.id, org.organizationId)).toEqual(STAFF_ONLY);

      await restore(org, student.id);
      expect(await deriveAccess(user.id, org.organizationId)).toEqual(BOTH);
    });

    it("a student staff have not approved yet (PENDING) has no portal even when they hold a staff membership", async () => {
      const org = await newOrganization();
      const { user, student } = await signUpStudent(org, "pending-coach");
      await prisma.organizationMembership.create({ data: { userId: user.id, organizationId: org.organizationId, role: "INSTRUCTOR" } });
      expect((await prisma.student.findUniqueOrThrow({ where: { id: student.id } })).status).toBe("PENDING");

      expect(await deriveAccess(user.id, org.organizationId)).toEqual(STAFF_ONLY);
    });

    it("REQUIRED: everything that ends a membership ends access — deactivated membership, deactivated account, suspended organization, no membership, no organization", async () => {
      const org = await newOrganization();
      const other = await newOrganization();
      const { user, student } = await signUpStudent(org, "ends");
      await approve(org, student.id);
      expect(await deriveAccess(user.id, org.organizationId)).toEqual(PORTAL_ONLY);

      expect(await deriveAccess(user.id, other.organizationId)).toEqual(NONE); // a member of another organization only
      expect(await deriveAccess(user.id, null)).toEqual(NONE);
      expect(await deriveAccess("no-such-user", org.organizationId)).toEqual(NONE);

      await prisma.organizationMembership.updateMany({ where: { userId: user.id, organizationId: org.organizationId }, data: { active: false } });
      expect(await deriveAccess(user.id, org.organizationId)).toEqual(NONE);
      await prisma.organizationMembership.updateMany({ where: { userId: user.id, organizationId: org.organizationId }, data: { active: true } });

      await prisma.user.update({ where: { id: user.id }, data: { active: false } });
      expect(await deriveAccess(user.id, org.organizationId)).toEqual(NONE);
      await prisma.user.update({ where: { id: user.id }, data: { active: true } });

      await prisma.organization.update({ where: { id: org.organizationId }, data: { status: "SUSPENDED" } });
      expect(await deriveAccess(user.id, org.organizationId)).toEqual(NONE);
      expect(await deriveAccess(org.ownerId, org.organizationId)).toEqual(NONE);
    });
  });

  describe("the claim on the token (signInJwtCallback)", () => {
    const callback = signInJwtCallback as unknown as (params: Record<string, unknown>) => Promise<Record<string, unknown>>;

    it("REQUIRED: sign-in puts the derived claim on the token, for the organization it resolved", async () => {
      const org = await newOrganization();
      const { user, student } = await signUpStudent(org, "signin");
      await approve(org, student.id);

      const token = await callback({ token: {}, user: { id: user.id, email: "x", name: "x" }, trigger: "signIn" });
      expect(token.activeOrganizationId).toBe(org.organizationId);
      expect(token.access).toEqual(PORTAL_ONLY);

      const ownerToken = await callback({ token: {}, user: { id: org.ownerId, email: "x", name: "x" }, trigger: "signIn" });
      expect(ownerToken.access).toEqual(STAFF_ONLY);
    });

    it("a user who must still choose an organization has no access claim yet (nothing resolved to derive from)", async () => {
      const a = await newOrganization();
      const b = await newOrganization();
      await prisma.organizationMembership.create({ data: { userId: a.ownerId, organizationId: b.organizationId, role: "ADMIN" } });
      await prisma.user.update({ where: { id: a.ownerId }, data: { lastActiveOrganizationId: null } });

      const token = await callback({ token: {}, user: { id: a.ownerId, email: "x", name: "x" }, trigger: "signIn" });

      expect(token.activeOrganizationId).toBeNull();
      expect(token.access).toEqual(NONE);
    });

    it("REQUIRED: switching organization recomputes the claim for the NEW organization", async () => {
      const a = await newOrganization();
      const b = await newOrganization();
      const { user, student } = await signUpStudent(b, "switch");
      await approve(b, student.id);
      // One person: an instructor at A, and (separately) a student at B.
      await prisma.organizationMembership.create({ data: { userId: user.id, organizationId: a.organizationId, role: "INSTRUCTOR" } });

      let token = await callback({ token: {}, user: { id: user.id, email: "x", name: "x" }, trigger: "signIn", session: undefined });
      token = await callback({ token, trigger: "update", session: { activeOrganizationId: a.organizationId } });
      expect(token.access).toEqual(STAFF_ONLY);
      token = await callback({ token, trigger: "update", session: { activeOrganizationId: b.organizationId } });
      expect(token.access).toEqual(PORTAL_ONLY);
    });

    it("REQUIRED: an explicit refresh re-derives the claim from the database for the same organization — the building block for someone promoted while logged in", async () => {
      const org = await newOrganization();
      const { user, student } = await signUpStudent(org, "promoted");
      await approve(org, student.id);
      let token = await callback({ token: {}, user: { id: user.id, email: "x", name: "x" }, trigger: "signIn" });
      expect(token.access).toEqual(PORTAL_ONLY);

      // Promoted while logged in: the database changes, the token does not — until refreshed.
      await prisma.organizationMembership.update({
        where: { userId_organizationId: { userId: user.id, organizationId: org.organizationId } },
        data: { role: "INSTRUCTOR" },
      });
      expect(token.access).toEqual(PORTAL_ONLY);

      token = await callback({ token, trigger: "update", session: { refreshAccess: true } });
      expect(token.access).toEqual(BOTH);
      expect(token.activeOrganizationId).toBe(org.organizationId);
    });

    it("and the other direction: a refresh takes staff access away from someone demoted while logged in", async () => {
      const org = await newOrganization();
      let token = await callback({ token: {}, user: { id: org.ownerId, email: "x", name: "x" }, trigger: "signIn" });
      expect(token.access).toEqual(STAFF_ONLY);

      await prisma.organizationMembership.update({
        where: { userId_organizationId: { userId: org.ownerId, organizationId: org.organizationId } },
        data: { active: false },
      });
      token = await callback({ token, trigger: "update", session: { refreshAccess: true } });
      expect(token.access).toEqual(NONE);
    });

    it("the session exposes the claim next to the active organization — and a token with no claim yields a session with none (which the middleware fails closed on)", async () => {
      const sessionCallback = authConfig.callbacks!.session as unknown as (params: Record<string, unknown>) => Promise<Record<string, unknown>>;
      const withClaim = (await sessionCallback({
        session: { user: {}, expires: "" },
        token: { id: "u1", activeOrganizationId: "o1", access: BOTH },
      })) as { access: unknown; activeOrganizationId: unknown };
      expect(withClaim.access).toEqual(BOTH);
      expect(withClaim.activeOrganizationId).toBe("o1");

      const old = (await sessionCallback({ session: { user: {}, expires: "" }, token: { id: "u1", activeOrganizationId: "o1" } })) as { access: unknown };
      expect(old.access).toBeNull();
    });
  });
});
