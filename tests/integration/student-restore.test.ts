import "dotenv/config";
import { getTestPrismaClient } from "../helpers/test-db";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/email/send-transactional-email", () => ({
  sendTransactionalEmail: vi.fn(async () => ({ success: true })),
}));

let currentSession: { user: { id: string; role: string } | null; activeOrganizationId?: string } | null = null;
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
const { createStudent } = await import("../../src/app/[locale]/(staff)/students/create-student-action");
const { createLocation } = await import("../../src/lib/locations/location-actions");
const { requireOrganizationAccess, requireTenantContext, TenantAccessError } = await import("../../src/lib/tenant/context");
const { resolveActiveOrganizationForSignIn } = await import("../../src/lib/tenant/active-organization");
const { hashSecret } = await import("../../src/lib/crypto");
const { resolvePendingApplication } = await import("../../src/lib/tenant/platform-lookups");

const prisma = getTestPrismaClient();

/**
 * Restoring an archived student — the reverse of `archiveStudent`, which until
 * now had nothing behind its own dialog's promise ("This can be reversed by
 * editing status later"; status is deliberately not editable).
 *
 * What a restore returns a student to is STORED, not derived: archiving records
 * the status the student had (`statusBeforeArchive`), restoring reads it and
 * clears it. It must never be read from the audit log — an audit row records
 * what happened and gets pruned, rotated and exported, so a code path that
 * depends on one silently does the wrong thing the day rows are trimmed
 * (pinned below by deleting every audit row and restoring anyway).
 *
 * Every organization here is built the real way (public registration form,
 * approval, invitation accepted), every student through the public signup or
 * the real create action — a test that builds its world by hand tests a world
 * that does not exist.
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

function actAs(userId: string, organizationId: string, role: string) {
  currentSession = { user: { id: userId, role }, activeOrganizationId: organizationId };
}

async function newOrganization() {
  counter += 1;
  const email = `restore-owner-${counter}-${suffix}@example.com`;
  const slug = `restore-${suffix}-${counter}`;
  registrationEmails.push(email);
  const registration = await registerOrganization(
    {},
    form({
      organizationName: `Restore ${counter}`,
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

async function signUpStudent(org: { slug: string }, academySlug: string, label: string) {
  counter += 1;
  const email = `restore-student-${label}-${counter}-${suffix}@example.com`;
  const result = await signup(
    org.slug,
    {},
    form({
      firstName: "Real",
      lastName: `Student${counter}`,
      phone: "88880000",
      email,
      homeAcademySlug: academySlug,
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
const approve = (orgId: string, studentId: string) => approveStudent(orgId, {}, idForm(studentId));
const archive = (orgId: string, studentId: string) => archiveStudent(orgId, {}, idForm(studentId));
const restore = (orgId: string, studentId: string) => restoreStudent(orgId, {}, idForm(studentId));

const reload = (studentId: string) => prisma.student.findUniqueOrThrow({ where: { id: studentId } });
const membershipOf = (userId: string, organizationId: string) =>
  prisma.organizationMembership.findUnique({ where: { userId_organizationId: { userId, organizationId } } });

/** What `/portal` does, as that student. */
async function reachesPortal(userId: string, organizationId: string) {
  actAs(userId, organizationId, "STUDENT");
  try {
    await requireTenantContext(["STUDENT"]);
    return true;
  } catch {
    return false;
  } finally {
    currentSession = null;
  }
}

describe("restoring an archived student", () => {
  beforeAll(async () => {
    const approver = await prisma.user.create({
      data: { email: `restore-approver-${suffix}@example.com`, passwordHash: await hashSecret("irrelevant-password-123"), role: "ADMIN", isSuperAdmin: true },
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

  it("REQUIRED: sign up → approve → archive → restore — the student is back on the roster AND back in the portal", async () => {
    const org = await newOrganization();
    const { user, student } = await signUpStudent(org, org.academySlug, "full");
    actAs(org.ownerId, org.organizationId, "ADMIN");
    expect(await approve(org.organizationId, student.id)).toEqual({ ok: true });
    expect(await reachesPortal(user.id, org.organizationId)).toBe(true);

    actAs(org.ownerId, org.organizationId, "ADMIN");
    expect(await archive(org.organizationId, student.id)).toEqual({ ok: true });
    expect(await reload(student.id)).toMatchObject({ status: "ARCHIVED", statusBeforeArchive: "ACTIVE" });
    expect(await reachesPortal(user.id, org.organizationId)).toBe(false);

    actAs(org.ownerId, org.organizationId, "ADMIN");
    expect(await restore(org.organizationId, student.id)).toEqual({ ok: true });

    // Back to what they were, with the stored value cleared afterwards.
    expect(await reload(student.id)).toMatchObject({ status: "ACTIVE", statusBeforeArchive: null });
    expect(await membershipOf(user.id, org.organizationId)).toMatchObject({ role: "STUDENT", active: true });
    expect(await reachesPortal(user.id, org.organizationId)).toBe(true);
    expect(await resolveActiveOrganizationForSignIn(user.id)).toEqual({ kind: "resolved", organizationId: org.organizationId });

    const audit = await prisma.auditLog.findFirstOrThrow({ where: { entityId: student.id, action: "student.restore" } });
    expect(audit).toMatchObject({ actorId: org.ownerId, before: { status: "ARCHIVED" } });
    expect(audit.after).toMatchObject({ status: "ACTIVE", membership: "granted", fromStoredStatus: true });
  });

  it("REQUIRED: restore never reads the audit log — with every audit row deleted it still restores to the stored status", async () => {
    const org = await newOrganization();
    const { user, student } = await signUpStudent(org, org.academySlug, "audit");
    actAs(org.ownerId, org.organizationId, "ADMIN");
    await approve(org.organizationId, student.id);
    await archive(org.organizationId, student.id);

    // The day someone trims old audit rows, restore must not change what it does.
    await prisma.auditLog.deleteMany({ where: { organizationId: org.organizationId } });
    expect(await prisma.auditLog.count({ where: { entityId: student.id } })).toBe(0);

    actAs(org.ownerId, org.organizationId, "ADMIN");
    expect(await restore(org.organizationId, student.id)).toEqual({ ok: true });
    expect(await reload(student.id)).toMatchObject({ status: "ACTIVE", statusBeforeArchive: null });
    expect(await membershipOf(user.id, org.organizationId)).toMatchObject({ active: true });
  });

  it("REQUIRED: an applicant archived while PENDING comes back PENDING — no membership, no portal — and approval still works afterwards", async () => {
    const org = await newOrganization();
    const { user, student } = await signUpStudent(org, org.academySlug, "pending");
    actAs(org.ownerId, org.organizationId, "ADMIN");
    await archive(org.organizationId, student.id);
    expect(await reload(student.id)).toMatchObject({ status: "ARCHIVED", statusBeforeArchive: "PENDING" });

    actAs(org.ownerId, org.organizationId, "ADMIN");
    expect(await restore(org.organizationId, student.id)).toEqual({ ok: true });

    expect(await reload(student.id)).toMatchObject({ status: "PENDING", statusBeforeArchive: null });
    expect(await membershipOf(user.id, org.organizationId)).toBeNull();
    expect(await reachesPortal(user.id, org.organizationId)).toBe(false);
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { entityId: student.id, action: "student.restore" } });
    expect(audit.after).toMatchObject({ status: "PENDING", membership: "none", fromStoredStatus: true });

    actAs(org.ownerId, org.organizationId, "ADMIN");
    expect(await approve(org.organizationId, student.id)).toEqual({ ok: true });
    expect(await reachesPortal(user.id, org.organizationId)).toBe(true);
  });

  it("REQUIRED (the null case): a student archived BEFORE the column existed has no stored status and comes back PENDING — the fail-safe, visible choice — never silently ACTIVE", async () => {
    const org = await newOrganization();
    const { user, student } = await signUpStudent(org, org.academySlug, "legacy");
    actAs(org.ownerId, org.organizationId, "ADMIN");
    await approve(org.organizationId, student.id);
    // Exactly what an old archive left behind: ARCHIVED, membership off, nothing stored.
    await prisma.student.update({ where: { id: student.id }, data: { status: "ARCHIVED", statusBeforeArchive: null } });
    await prisma.organizationMembership.updateMany({ where: { userId: user.id, organizationId: org.organizationId }, data: { active: false } });

    actAs(org.ownerId, org.organizationId, "ADMIN");
    expect(await restore(org.organizationId, student.id)).toEqual({ ok: true });

    // Unknown history is never guessed as "approved": they show up in the awaiting-approval queue,
    // one click from ACTIVE, instead of silently getting portal access nobody granted.
    expect(await reload(student.id)).toMatchObject({ status: "PENDING", statusBeforeArchive: null });
    expect(await membershipOf(user.id, org.organizationId)).toMatchObject({ active: false });
    expect(await reachesPortal(user.id, org.organizationId)).toBe(false);
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { entityId: student.id, action: "student.restore" } });
    expect(audit.after).toMatchObject({ status: "PENDING", fromStoredStatus: false });

    actAs(org.ownerId, org.organizationId, "ADMIN");
    expect(await approve(org.organizationId, student.id)).toEqual({ ok: true });
    expect(await reachesPortal(user.id, org.organizationId)).toBe(true);
  });

  it("a student staff entered by hand (no account) is restored to ACTIVE, and nothing is granted", async () => {
    const org = await newOrganization();
    const rank = await prisma.beltRank.findFirstOrThrow({ where: { organizationId: org.organizationId, track: "ADULT", code: "WHITE" } });
    actAs(org.ownerId, org.organizationId, "ADMIN");
    counter += 1;
    const created = await createStudent(
      org.organizationId,
      {},
      form({
        firstName: "Hand",
        lastName: "Entered",
        phone: "88880000",
        email: `restore-hand-${counter}-${suffix}@example.com`,
        homeAcademyId: org.academyId,
        track: "ADULT",
        currentRankId: rank.id,
        currentStripes: "0",
      }),
    );
    expect(created, JSON.stringify(created)).toMatchObject({ ok: true });
    const student = await prisma.student.findFirstOrThrow({ where: { organizationId: org.organizationId, firstName: "Hand" } });

    await archive(org.organizationId, student.id);
    expect(await restore(org.organizationId, student.id)).toEqual({ ok: true });

    expect(await reload(student.id)).toMatchObject({ status: "ACTIVE", statusBeforeArchive: null, userId: null });
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { entityId: student.id, action: "student.restore" } });
    expect(audit.after).toMatchObject({ status: "ACTIVE", membership: "none" });
  });

  describe("archiving records what restore needs", () => {
    it("archiving an already-archived student is a quiet no-op — it must not overwrite the stored status with ARCHIVED", async () => {
      const org = await newOrganization();
      const { student } = await signUpStudent(org, org.academySlug, "twice");
      actAs(org.ownerId, org.organizationId, "ADMIN");
      await approve(org.organizationId, student.id);
      await archive(org.organizationId, student.id);
      expect(await archive(org.organizationId, student.id)).toEqual({ ok: true });

      expect(await reload(student.id)).toMatchObject({ status: "ARCHIVED", statusBeforeArchive: "ACTIVE" });
      expect(await prisma.auditLog.count({ where: { entityId: student.id, action: "student.archive" } })).toBe(1);

      expect(await restore(org.organizationId, student.id)).toEqual({ ok: true });
      expect((await reload(student.id)).status).toBe("ACTIVE");
    });

    it("a full round trip can be repeated — the stored status is cleared on restore and set again on the next archive", async () => {
      const org = await newOrganization();
      const { user, student } = await signUpStudent(org, org.academySlug, "round");
      actAs(org.ownerId, org.organizationId, "ADMIN");
      await approve(org.organizationId, student.id);
      for (let round = 0; round < 2; round += 1) {
        expect(await archive(org.organizationId, student.id)).toEqual({ ok: true });
        expect(await reload(student.id)).toMatchObject({ status: "ARCHIVED", statusBeforeArchive: "ACTIVE" });
        expect(await restore(org.organizationId, student.id)).toEqual({ ok: true });
        expect(await reload(student.id)).toMatchObject({ status: "ACTIVE", statusBeforeArchive: null });
      }
      expect(await reachesPortal(user.id, org.organizationId)).toBe(true);
    });
  });

  describe("guards", () => {
    it("REQUIRED: only an ARCHIVED student can be restored — an ACTIVE or PENDING one is refused (notArchived) and nothing changes", async () => {
      const org = await newOrganization();
      const active = await signUpStudent(org, org.academySlug, "act");
      const pending = await signUpStudent(org, org.academySlug, "pen");
      actAs(org.ownerId, org.organizationId, "ADMIN");
      await approve(org.organizationId, active.student.id);

      expect(await restore(org.organizationId, active.student.id)).toEqual({ error: "notArchived" });
      expect(await restore(org.organizationId, pending.student.id)).toEqual({ error: "notArchived" });
      expect(await reload(active.student.id)).toMatchObject({ status: "ACTIVE" });
      expect(await reload(pending.student.id)).toMatchObject({ status: "PENDING" });
      expect(await prisma.auditLog.count({ where: { organizationId: org.organizationId, action: "student.restore" } })).toBe(0);
    });

    it("REQUIRED: two restores at the same moment restore once — one succeeds, the rest are refused, one audit row", async () => {
      const org = await newOrganization();
      const { student } = await signUpStudent(org, org.academySlug, "race");
      actAs(org.ownerId, org.organizationId, "ADMIN");
      await approve(org.organizationId, student.id);
      await archive(org.organizationId, student.id);

      const results = await Promise.all(Array.from({ length: 4 }, () => restore(org.organizationId, student.id)));

      expect(results.filter((result) => result.ok)).toHaveLength(1);
      expect(results.filter((result) => result.error === "notArchived")).toHaveLength(3);
      expect(await prisma.auditLog.count({ where: { entityId: student.id, action: "student.restore" } })).toBe(1);
    });

    it("REQUIRED: a location director may restore only students at THEIR location (out of scope is notFound), and an instructor is refused (FORBIDDEN)", async () => {
      const org = await newOrganization();
      actAs(org.ownerId, org.organizationId, "ADMIN");
      const second = await createLocation(org.organizationId, {}, form({ name: "Cartago" }));
      expect(second.ok).toBe(true);
      const atFirst = await signUpStudent(org, org.academySlug, "first");
      const atSecond = await signUpStudent(org, second.slug!, "second");
      for (const s of [atFirst, atSecond]) {
        actAs(org.ownerId, org.organizationId, "ADMIN");
        await approve(org.organizationId, s.student.id);
        await archive(org.organizationId, s.student.id);
      }

      counter += 1;
      const director = await prisma.user.create({
        data: { email: `restore-director-${counter}-${suffix}@example.com`, passwordHash: await hashSecret("member-password-123"), role: "DIRECTOR" },
      });
      userIds.push(director.id);
      await prisma.organizationMembership.create({ data: { userId: director.id, organizationId: org.organizationId, role: "DIRECTOR" } });
      await prisma.staffAssignment.create({ data: { userId: director.id, academyId: org.academyId, organizationId: org.organizationId, role: "DIRECTOR" } });

      actAs(director.id, org.organizationId, "DIRECTOR");
      expect(await restore(org.organizationId, atSecond.student.id)).toEqual({ error: "notFound" });
      expect((await reload(atSecond.student.id)).status).toBe("ARCHIVED");
      expect(await restore(org.organizationId, atFirst.student.id)).toEqual({ ok: true });

      const instructor = await prisma.user.create({
        data: { email: `restore-instructor-${counter}-${suffix}@example.com`, passwordHash: await hashSecret("member-password-123"), role: "INSTRUCTOR" },
      });
      userIds.push(instructor.id);
      await prisma.organizationMembership.create({ data: { userId: instructor.id, organizationId: org.organizationId, role: "INSTRUCTOR" } });
      await prisma.staffAssignment.create({ data: { userId: instructor.id, academyId: org.academyId, organizationId: org.organizationId, role: "INSTRUCTOR" } });
      actAs(instructor.id, org.organizationId, "INSTRUCTOR");
      await expect(restore(org.organizationId, atSecond.student.id)).rejects.toThrow("FORBIDDEN");
    });

    it("REQUIRED: a non-member is told notFound, and it acts on the organization it NAMES, not the session's ambient one", async () => {
      const a = await newOrganization();
      const b = await newOrganization();
      const inB = await signUpStudent(b, b.academySlug, "named");
      actAs(b.ownerId, b.organizationId, "ADMIN");
      await approve(b.organizationId, inB.student.id);
      await archive(b.organizationId, inB.student.id);

      // A's Owner is nobody to B.
      actAs(a.ownerId, a.organizationId, "ADMIN");
      expect(await restore(b.organizationId, inB.student.id)).toEqual({ error: "notFound" });
      expect((await reload(inB.student.id)).status).toBe("ARCHIVED");

      // A person who owns both, with the session pointing at A, naming B.
      await prisma.organizationMembership.create({ data: { userId: a.ownerId, organizationId: b.organizationId, role: "ADMIN" } });
      actAs(a.ownerId, a.organizationId, "ADMIN");
      expect(await restore(b.organizationId, inB.student.id)).toEqual({ ok: true });
      expect((await reload(inB.student.id)).status).toBe("ACTIVE");
    });

    it("REQUIRED: restoring never overwrites a staff membership — a coach who also trains keeps their role", async () => {
      const org = await newOrganization();
      const { user, student } = await signUpStudent(org, org.academySlug, "coach");
      actAs(org.ownerId, org.organizationId, "ADMIN");
      await approve(org.organizationId, student.id);
      // They become an instructor at the same organization (a real coach who trains).
      await prisma.organizationMembership.update({
        where: { userId_organizationId: { userId: user.id, organizationId: org.organizationId } },
        data: { role: "INSTRUCTOR" },
      });
      await archive(org.organizationId, student.id);
      expect(await membershipOf(user.id, org.organizationId)).toMatchObject({ role: "INSTRUCTOR", active: true });

      expect(await restore(org.organizationId, student.id)).toEqual({ ok: true });

      expect(await membershipOf(user.id, org.organizationId)).toMatchObject({ role: "INSTRUCTOR", active: true });
      const audit = await prisma.auditLog.findFirstOrThrow({ where: { entityId: student.id, action: "student.restore" } });
      expect(audit.after).toMatchObject({ membership: "existing" });
    });

    it("an account with no membership at all is still unable to resolve a tenant context before restore (control for the portal check)", async () => {
      const org = await newOrganization();
      const { user, student } = await signUpStudent(org, org.academySlug, "control");
      const denied = await requireOrganizationAccess(user.id, org.organizationId).catch((error) => error);
      expect(denied).toBeInstanceOf(TenantAccessError);
      expect((await reload(student.id)).status).toBe("PENDING");
    });
  });

  /**
   * A pending applicant who logs in lands on "No organization access — your
   * account isn't linked to any organization", which reads as an error. The
   * page now says "awaiting approval" instead, driven by the signed-in user's OWN
   * Student record — never by anything about anyone else.
   */
  describe("the awaiting-approval notice (what /no-organization-access reads)", () => {
    it("REQUIRED: a user whose own Student record is PENDING is told which academy is reviewing it", async () => {
      const org = await newOrganization();
      const { user } = await signUpStudent(org, org.academySlug, "notice");
      const organization = await prisma.organization.findUniqueOrThrow({ where: { id: org.organizationId } });

      expect(await resolvePendingApplication(user.id)).toEqual({ organizationName: organization.name });
    });

    it("REQUIRED: the notice ends when the application does — approved, archived, or never a student: nothing to show", async () => {
      const org = await newOrganization();
      const { user, student } = await signUpStudent(org, org.academySlug, "ends");
      actAs(org.ownerId, org.organizationId, "ADMIN");
      await approve(org.organizationId, student.id);
      expect(await resolvePendingApplication(user.id)).toBeNull();

      await archive(org.organizationId, student.id);
      expect(await resolvePendingApplication(user.id)).toBeNull();

      // Restored to its stored status (ACTIVE) — still not pending; a restored PENDING one is, again.
      await restore(org.organizationId, student.id);
      expect(await resolvePendingApplication(user.id)).toBeNull();

      const other = await signUpStudent(org, org.academySlug, "again");
      await archive(org.organizationId, other.student.id);
      expect(await resolvePendingApplication(other.user.id)).toBeNull();
      await restore(org.organizationId, other.student.id);
      expect(await resolvePendingApplication(other.user.id)).toMatchObject({ organizationName: expect.any(String) });

      expect(await resolvePendingApplication(org.ownerId)).toBeNull(); // an Owner has no Student record
      expect(await resolvePendingApplication("no-such-user")).toBeNull();
    });
  });
});
