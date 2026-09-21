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

const { registerOrganization } = await import("../../src/app/[locale]/register-academy/actions");
const { approveOrganization } = await import("../../src/lib/organizations/approve-organization");
const { acceptInvitation } = await import("../../src/app/[locale]/accept-invitation/actions");
const { dismissBrandingReminder } = await import("../../src/app/[locale]/(staff)/dashboard/branding-reminder-actions");
const { getMyNotifications, getUnreadCount, markAllRead } = await import("../../src/app/[locale]/(staff)/dashboard/notification-actions");
const { saveOnboardingStep1, advanceOnboardingStep, completeOnboarding } = await import("../../src/app/[locale]/onboarding/actions");
const { hashSecret } = await import("../../src/lib/crypto");

const prisma = getTestPrismaClient();

/**
 * These seven functions (the branding-reminder dismissal, the notification bell's
 * three, the onboarding wizard's three) were "use server" actions that resolved
 * their tenant through `requireTenantContext` — the PAGE primitive, which reads
 * the ambient session's active organization and `redirect()`s or `notFound()`s.
 * An action must instead act on the organization IT names (a two-tab session
 * whose selector points at A must not let an action meant for B land on A), and
 * must refuse a non-member quietly, because a redirect or a 404 thrown from a
 * server action means nothing to the caller. `resolveActionContext` is the
 * action primitive every other action already uses.
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

function actAs(userId: string, activeOrganizationId: string, role = "ADMIN") {
  currentSession = { user: { id: userId, role }, activeOrganizationId };
}

async function swallowRedirect<T>(run: () => Promise<T>): Promise<T | "redirected"> {
  try {
    return await run();
  } catch (error) {
    if ((error as { digest?: string }).digest?.startsWith("NEXT_REDIRECT")) return "redirected";
    throw error;
  }
}

/** An organization whose Owner is created the real way: registration, approval, accepted invitation. */
async function newOrganization() {
  counter += 1;
  const email = `utility-owner-${counter}-${suffix}@example.com`;
  const slug = `utility-${suffix}-${counter}`;
  registrationEmails.push(email);
  const registration = await registerOrganization(
    {},
    form({
      organizationName: `Utility ${counter}`,
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
  const approval = await approveOrganization(slug, approverId);
  await acceptInvitation("es", {}, form({ token: new URL(approval.invitationLink!).searchParams.get("token")!, password: "owner-password-123" })).catch(
    (error: { digest?: string }) => {
      if (!error.digest?.startsWith("NEXT_REDIRECT")) throw error;
    },
  );
  const owner = await prisma.user.findUniqueOrThrow({ where: { email } });
  userIds.push(owner.id);
  const academy = await prisma.academy.findFirstOrThrow({ where: { organizationId: organization.id } });
  return { organizationId: organization.id, ownerId: owner.id, academyId: academy.id };
}

async function addMember(org: { organizationId: string; academyId: string }, role: "INSTRUCTOR" | "STUDENT") {
  counter += 1;
  const user = await prisma.user.create({
    data: { email: `utility-${role.toLowerCase()}-${counter}-${suffix}@example.com`, passwordHash: await hashSecret("member-password-123"), role },
  });
  userIds.push(user.id);
  await prisma.organizationMembership.create({ data: { userId: user.id, organizationId: org.organizationId, role } });
  if (role === "INSTRUCTOR") {
    await prisma.staffAssignment.create({ data: { userId: user.id, academyId: org.academyId, organizationId: org.organizationId, role } });
  }
  return user;
}

async function notify(userId: string, organizationId: string, count: number) {
  for (let i = 0; i < count; i++) {
    await prisma.notification.create({ data: { userId, organizationId, type: "NEW_SIGNUP", title: `T${i}`, body: `B${i}` } });
  }
}

describe("the branding, notification and onboarding actions use the action primitive", () => {
  beforeAll(async () => {
    const approver = await prisma.user.create({
      data: { email: `utility-approver-${suffix}@example.com`, passwordHash: await hashSecret("irrelevant-password-123"), role: "ADMIN", isSuperAdmin: true },
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

  describe("REQUIRED: they act on the organization they NAME, not the session's ambient one", () => {
    it("dismissBrandingReminder writes to the named organization even when the session points at another", async () => {
      const a = await newOrganization();
      const b = await newOrganization();
      // One person who owns both (say, an owner who opened a second academy account).
      await prisma.organizationMembership.create({ data: { userId: a.ownerId, organizationId: b.organizationId, role: "ADMIN" } });
      actAs(a.ownerId, a.organizationId); // the session's selector says A

      await dismissBrandingReminder(b.organizationId);

      expect((await prisma.organization.findUniqueOrThrow({ where: { id: b.organizationId } })).brandingReminderDismissedAt).not.toBeNull();
      expect((await prisma.organization.findUniqueOrThrow({ where: { id: a.organizationId } })).brandingReminderDismissedAt).toBeNull();
    });

    it("the onboarding steps write to the named organization even when the session points at another", async () => {
      const a = await newOrganization();
      const b = await newOrganization();
      await prisma.organizationMembership.create({ data: { userId: a.ownerId, organizationId: b.organizationId, role: "ADMIN" } });
      actAs(a.ownerId, a.organizationId);

      expect(await swallowRedirect(() => saveOnboardingStep1(b.organizationId, "es", {}, form({ name: "Renamed B" })))).toBe("redirected");
      expect(await swallowRedirect(() => advanceOnboardingStep(b.organizationId, "es", 3))).toBe("redirected");

      const bAfter = await prisma.organization.findUniqueOrThrow({ where: { id: b.organizationId } });
      expect(bAfter).toMatchObject({ name: "Renamed B", onboardingStep: 3 });
      expect((await prisma.organization.findUniqueOrThrow({ where: { id: a.organizationId } })).name).not.toBe("Renamed B");

      expect(await swallowRedirect(() => completeOnboarding(b.organizationId, "es"))).toBe("redirected");
      expect((await prisma.organization.findUniqueOrThrow({ where: { id: b.organizationId } })).onboardingCompletedAt).not.toBeNull();
      expect((await prisma.organization.findUniqueOrThrow({ where: { id: a.organizationId } })).onboardingCompletedAt).toBeNull();
    });

    it("the notification actions read and mark the named organization's notifications", async () => {
      const a = await newOrganization();
      const b = await newOrganization();
      await prisma.organizationMembership.create({ data: { userId: a.ownerId, organizationId: b.organizationId, role: "ADMIN" } });
      await notify(a.ownerId, a.organizationId, 2);
      await notify(a.ownerId, b.organizationId, 3);
      actAs(a.ownerId, a.organizationId);

      expect((await getMyNotifications(b.organizationId)).map((n) => n.organizationId)).toEqual([b.organizationId, b.organizationId, b.organizationId]);
      expect(await getUnreadCount(b.organizationId)).toBe(3);

      await markAllRead(b.organizationId);

      expect(await getUnreadCount(b.organizationId)).toBe(0);
      expect(await getUnreadCount(a.organizationId)).toBe(2); // A's are untouched
    });
  });

  describe("REQUIRED: a non-member is refused quietly — nothing read, nothing written, nothing thrown", () => {
    it("names an organization they do not belong to", async () => {
      const a = await newOrganization();
      const b = await newOrganization();
      await notify(b.ownerId, b.organizationId, 2);
      actAs(a.ownerId, a.organizationId); // A's owner, naming B

      await dismissBrandingReminder(b.organizationId);
      expect(await saveOnboardingStep1(b.organizationId, "es", {}, form({ name: "Hijacked" }))).toEqual({ error: "notFound" });
      expect(await swallowRedirect(() => advanceOnboardingStep(b.organizationId, "es", 3))).toBe(undefined);
      expect(await swallowRedirect(() => completeOnboarding(b.organizationId, "es"))).toBe(undefined);
      expect(await getMyNotifications(b.organizationId)).toEqual([]);
      expect(await getUnreadCount(b.organizationId)).toBe(0);
      await markAllRead(b.organizationId);

      const after = await prisma.organization.findUniqueOrThrow({ where: { id: b.organizationId } });
      expect(after.brandingReminderDismissedAt).toBeNull();
      expect(after.name).not.toBe("Hijacked");
      expect(after.onboardingCompletedAt).toBeNull();
      expect(await prisma.notification.count({ where: { organizationId: b.organizationId, readAt: null } })).toBe(2);
    });
  });

  describe("a genuine member with the wrong role is refused like every other action refuses one", () => {
    it("an INSTRUCTOR cannot dismiss the reminder or drive the wizard (ADMIN/DIRECTOR only)", async () => {
      const org = await newOrganization();
      const instructor = await addMember(org, "INSTRUCTOR");
      actAs(instructor.id, org.organizationId, "INSTRUCTOR");

      await expect(dismissBrandingReminder(org.organizationId)).rejects.toThrow("FORBIDDEN");
      await expect(saveOnboardingStep1(org.organizationId, "es", {}, form({ name: "X" }))).rejects.toThrow("FORBIDDEN");
      await expect(advanceOnboardingStep(org.organizationId, "es", 3)).rejects.toThrow("FORBIDDEN");
      await expect(completeOnboarding(org.organizationId, "es")).rejects.toThrow("FORBIDDEN");
      expect((await prisma.organization.findUniqueOrThrow({ where: { id: org.organizationId } })).brandingReminderDismissedAt).toBeNull();
    });

    it("a STUDENT cannot read or mark the STAFF notification feed", async () => {
      const org = await newOrganization();
      const student = await addMember(org, "STUDENT");
      actAs(student.id, org.organizationId, "STUDENT");

      await expect(getMyNotifications(org.organizationId)).rejects.toThrow("FORBIDDEN");
      await expect(getUnreadCount(org.organizationId)).rejects.toThrow("FORBIDDEN");
      await expect(markAllRead(org.organizationId)).rejects.toThrow("FORBIDDEN");
    });
  });
});
