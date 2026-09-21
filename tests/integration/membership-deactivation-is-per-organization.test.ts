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

const { approveOrganization } = await import("../../src/lib/organizations/approve-organization");
const { acceptInvitation } = await import("../../src/app/[locale]/accept-invitation/actions");
const { deactivateStaffMember, reactivateStaffMember } = await import("../../src/lib/staff/staff-actions");
const { requireOrganizationAccess, TenantAccessError } = await import("../../src/lib/tenant/context");
const { resolveActiveOrganizationForSignIn } = await import("../../src/lib/tenant/active-organization");
const { resolveStaffRecipients } = await import("../../src/lib/notifications/recipients");
const { verifyCredentials } = await import("../../src/lib/auth/verify-credentials");
const { hashSecret } = await import("../../src/lib/crypto");

const prisma = getTestPrismaClient();

/**
 * `User.active` is ONE flag on the ACCOUNT, but "deactivate this person" is an
 * organization-level act. With no per-organization switch, the only way to
 * remove someone from one academy was to disable the whole account — which
 * locked them out of every other organization they belong to (a coach who
 * teaches at two academies loses both when one owner lets them go).
 * `OrganizationMembership.active` is the per-organization switch, checked in
 * the tenant-context resolver so it takes effect on the very next request.
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

/** An organization whose Owner is created the way a real one is: approved, then the invitation accepted. */
async function newOrganization(approverId: string) {
  counter += 1;
  const email = `deact-owner-${counter}-${suffix}@example.com`;
  const organization = await prisma.organization.create({
    data: { slug: `deact-${suffix}-${counter}`, name: `Deactivation ${counter}`, status: "PENDING", city: "Heredia", contactEmail: email },
  });
  orgIds.push(organization.id);
  const approval = await approveOrganization(organization.slug, approverId);
  const token = new URL(approval.invitationLink!).searchParams.get("token")!;
  await acceptInvitation("es", {}, form({ token, password: "owner-password-123" })).catch((error: { digest?: string }) => {
    if (!error.digest?.startsWith("NEXT_REDIRECT")) throw error;
  });
  const owner = await prisma.user.findUniqueOrThrow({ where: { email } });
  userIds.push(owner.id);
  const academy = await prisma.academy.findFirstOrThrow({ where: { organizationId: organization.id } });
  return { organizationId: organization.id, academyId: academy.id, ownerId: owner.id };
}

function actAs(userId: string, organizationId: string, role = "ADMIN") {
  currentSession = { user: { id: userId, role }, activeOrganizationId: organizationId };
}

describe("deactivating someone in one organization never touches their access to another", () => {
  let approverId: string;

  beforeAll(async () => {
    const approver = await prisma.user.create({
      data: {
        email: `deact-approver-${suffix}@example.com`,
        passwordHash: await hashSecret("irrelevant-password-123"),
        role: "ADMIN",
        isSuperAdmin: true,
      },
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
    await prisma.academy.deleteMany({ where: { organizationId: { in: orgIds } } });
    await prisma.organization.deleteMany({ where: { id: { in: orgIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  });

  /** A coach who teaches at both academies: one account, an INSTRUCTOR membership in each. */
  async function coachAtBoth() {
    const a = await newOrganization(approverId);
    const b = await newOrganization(approverId);
    const coach = await prisma.user.create({
      data: {
        email: `deact-coach-${suffix}-${counter}@example.com`,
        passwordHash: await hashSecret("coach-password-123"),
        role: "INSTRUCTOR",
      },
    });
    userIds.push(coach.id);
    const membershipA = await prisma.organizationMembership.create({ data: { userId: coach.id, organizationId: a.organizationId, role: "INSTRUCTOR" } });
    const membershipB = await prisma.organizationMembership.create({ data: { userId: coach.id, organizationId: b.organizationId, role: "INSTRUCTOR" } });
    await prisma.staffAssignment.create({ data: { userId: coach.id, academyId: a.academyId, organizationId: a.organizationId, role: "INSTRUCTOR" } });
    await prisma.staffAssignment.create({ data: { userId: coach.id, academyId: b.academyId, organizationId: b.organizationId, role: "INSTRUCTOR" } });
    return { a, b, coach, membershipA, membershipB };
  }

  it("REQUIRED: the owner of A deactivates the coach — A refuses them on the very next request, B and their login are untouched", async () => {
    const { a, b, coach, membershipA } = await coachAtBoth();
    await expect(requireOrganizationAccess(coach.id, a.organizationId)).resolves.toMatchObject({ organizationId: a.organizationId });
    await expect(requireOrganizationAccess(coach.id, b.organizationId)).resolves.toMatchObject({ organizationId: b.organizationId });

    actAs(a.ownerId, a.organizationId);
    expect(await deactivateStaffMember(a.organizationId, membershipA.id)).toEqual({ ok: true });

    // A: refused, with no cache to wait out — a fresh resolution says NO_MEMBERSHIP.
    const refused = await requireOrganizationAccess(coach.id, a.organizationId).catch((error) => error);
    expect(refused).toBeInstanceOf(TenantAccessError);
    expect((refused as InstanceType<typeof TenantAccessError>).result.status).toBe("NO_MEMBERSHIP");

    // B: exactly as before.
    await expect(requireOrganizationAccess(coach.id, b.organizationId)).resolves.toMatchObject({ organizationId: b.organizationId });
    // The account itself: still active, still able to sign in.
    expect((await prisma.user.findUniqueOrThrow({ where: { id: coach.id } })).active).toBe(true);
    expect(await verifyCredentials(coach.email, "coach-password-123")).not.toBeNull();
  });

  it("sign-in no longer counts the deactivated membership: a coach left with one real organization lands straight in it", async () => {
    const { a, b, coach, membershipA } = await coachAtBoth();
    // Two live memberships: the picker is needed.
    expect(await resolveActiveOrganizationForSignIn(coach.id)).toEqual({ kind: "needsSelection" });

    actAs(a.ownerId, a.organizationId);
    await deactivateStaffMember(a.organizationId, membershipA.id);

    expect(await resolveActiveOrganizationForSignIn(coach.id)).toEqual({ kind: "resolved", organizationId: b.organizationId });
  });

  it("a deactivated member stops receiving that organization's notifications — and keeps receiving the other's", async () => {
    const { a, b, coach, membershipA } = await coachAtBoth();
    const before = await resolveStaffRecipients(a.academyId);
    expect(before.map((r) => r.userId)).toContain(coach.id);

    actAs(a.ownerId, a.organizationId);
    await deactivateStaffMember(a.organizationId, membershipA.id);

    expect((await resolveStaffRecipients(a.academyId)).map((r) => r.userId)).not.toContain(coach.id);
    expect((await resolveStaffRecipients(b.academyId)).map((r) => r.userId)).toContain(coach.id);
  });

  it("reactivating restores the same access and the same academy scope — the assignments were kept", async () => {
    const { a, coach, membershipA } = await coachAtBoth();
    actAs(a.ownerId, a.organizationId);
    await deactivateStaffMember(a.organizationId, membershipA.id);
    await expect(requireOrganizationAccess(coach.id, a.organizationId)).rejects.toBeInstanceOf(TenantAccessError);

    expect(await reactivateStaffMember(a.organizationId, membershipA.id)).toEqual({ ok: true });

    const context = await requireOrganizationAccess(coach.id, a.organizationId);
    expect(context.academyIds).toEqual([a.academyId]);
    expect(context.organizationRole).toBe("INSTRUCTOR");
  });
});
