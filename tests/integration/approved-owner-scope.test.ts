import "dotenv/config";
import { getTestPrismaClient } from "../helpers/test-db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/email/send-transactional-email", () => ({
  sendTransactionalEmail: vi.fn(async () => ({ success: true })),
}));

// signIn() carries out its own redirect (see login-actions.test.ts), so a real
// accept-invitation call ends in a NEXT_REDIRECT throw; auth() is needed only
// because tenant/context.ts imports it.
vi.mock("@/auth", () => ({
  auth: () => Promise.resolve(null),
  signIn: vi.fn((_provider: string, options: { redirectTo: string }) => {
    const error = new Error("NEXT_REDIRECT");
    (error as { digest?: string }).digest = `NEXT_REDIRECT;push;${options.redirectTo};307;`;
    throw error;
  }),
}));

const { approveOrganization } = await import("../../src/lib/organizations/approve-organization");
const { acceptInvitation } = await import("../../src/app/[locale]/accept-invitation/actions");
const { requireOrganizationAccess, branchScopeWhere } = await import("../../src/lib/tenant/context");
const { hashSecret } = await import("../../src/lib/crypto");

const prisma = getTestPrismaClient();

/**
 * The lockout (docs/MULTI_ACADEMY_AND_KIDS_BELTS.md, revision 33): every
 * organization created through the product had an owner who could see
 * nothing. `approveOrganization()` made the registering owner a DIRECTOR, and
 * a DIRECTOR's scope is the academies in their `staffAssignment` rows — of
 * which, outside the seed, there is no way to create any. So a genuine
 * customer's owner was "the manager of nothing": zero academies in scope, and
 * locked out of the owner-only gates (schedule, kiosk token, logo).
 *
 * It survived five phases because Alliance is seeded and the seed is the only
 * thing that ever wrote those rows. This test therefore never builds an owner
 * by hand: it registers one exactly the way the product does — the real
 * `approveOrganization()` and the real `acceptInvitation()` — and asserts on
 * what that owner can actually do. It deliberately asserts the OUTCOME (the
 * academy is in scope, owner authority is held), not which role/assignment
 * mechanism delivers it.
 */
describe("an owner created exactly as approveOrganization creates one", () => {
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
  const orgIds: string[] = [];
  const userIds: string[] = [];

  let organizationId: string;
  let academyId: string;
  let ownerId: string;

  beforeAll(async () => {
    const approver = await prisma.user.create({
      data: {
        email: `owner-scope-approver-${suffix}@example.com`,
        passwordHash: await hashSecret("irrelevant-password-123"),
        role: "ADMIN",
        isSuperAdmin: true,
      },
    });
    userIds.push(approver.id);

    const organization = await prisma.organization.create({
      data: {
        slug: `owner-scope-${suffix}`,
        name: `Owner Scope ${suffix}`,
        status: "PENDING",
        city: "Heredia",
        contactEmail: `owner-scope-${suffix}@example.com`,
      },
    });
    orgIds.push(organization.id);
    organizationId = organization.id;

    const approval = await approveOrganization(organization.slug, approver.id);
    const token = new URL(approval.invitationLink!).searchParams.get("token")!;

    const form = new FormData();
    form.set("token", token);
    form.set("password", "owner-password-123");
    await acceptInvitation("es", {}, form).catch((error: { digest?: string }) => {
      if (!error.digest?.startsWith("NEXT_REDIRECT")) throw error;
    });

    const owner = await prisma.user.findUniqueOrThrow({ where: { email: organization.contactEmail! } });
    userIds.push(owner.id);
    ownerId = owner.id;
    academyId = (await prisma.academy.findFirstOrThrow({ where: { organizationId } })).id;
  });

  afterAll(async () => {
    await prisma.invitation.deleteMany({ where: { organizationId: { in: orgIds } } });
    await prisma.staffAssignment.deleteMany({ where: { organizationId: { in: orgIds } } });
    await prisma.organizationMembership.deleteMany({ where: { organizationId: { in: orgIds } } });
    await prisma.paymentPlan.deleteMany({ where: { organizationId: { in: orgIds } } }); // approval seeds a default plan
    await prisma.academy.deleteMany({ where: { organizationId: { in: orgIds } } });
    await prisma.organization.deleteMany({ where: { id: { in: orgIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  });

  it("REQUIRED: can see the organization's academy — it is in their scope", async () => {
    const context = await requireOrganizationAccess(ownerId, organizationId);

    const inScope = context.academyIds === "ALL" || context.academyIds.includes(academyId);
    expect(inScope, `the owner's academy scope was ${JSON.stringify(context.academyIds)}, which excludes ${academyId}`).toBe(true);
  });

  it("REQUIRED: holds owner-level authority — the ADMIN-only gates (schedule, kiosk token, logo) let them through", async () => {
    await expect(requireOrganizationAccess(ownerId, organizationId, ["ADMIN"])).resolves.toMatchObject({
      organizationId,
    });
  });

  it("REQUIRED: no scope narrowing is applied to their queries", async () => {
    const context = await requireOrganizationAccess(ownerId, organizationId);

    // A scoped query for a manager of nothing is `{ academyId: { in: [] } }` —
    // every roster, payment list and analytics panel comes back empty.
    expect(branchScopeWhere(context)).toEqual({});
  });
});
