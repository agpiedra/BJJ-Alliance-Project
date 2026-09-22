import "dotenv/config";
import { getTestPrismaClient } from "../helpers/test-db";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/email/send-transactional-email", () => ({
  sendTransactionalEmail: vi.fn(async () => ({ success: true })),
}));

let currentSession: { user: { id: string }; activeOrganizationId: string; access: unknown } | null = null;
vi.mock("@/auth", () => ({
  auth: () => Promise.resolve(currentSession),
  unstable_update: vi.fn(async () => null),
  signIn: vi.fn((_provider: string, options: { redirectTo: string }) => {
    const error = new Error("NEXT_REDIRECT");
    (error as { digest?: string }).digest = `NEXT_REDIRECT;push;${options.redirectTo};307;`;
    throw error;
  }),
}));
vi.mock("next-intl/server", () => ({ getLocale: () => Promise.resolve("en") }));
vi.mock("@/lib/notifications/fire-and-forget", () => ({ fireAndForget: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const { revalidatePath } = await import("next/cache");
const { approveOrganization } = await import("../../src/lib/organizations/approve-organization");
const { acceptInvitation } = await import("../../src/app/[locale]/accept-invitation/actions");
const { registerOrganization } = await import("../../src/app/[locale]/register-academy/actions");
const { signup } = await import("../../src/app/[locale]/o/[orgSlug]/signup/actions");
const { approveStudent, archiveStudent, restoreStudent, updateStudent } = await import("../../src/app/[locale]/(staff)/students/[id]/actions");
const { hashSecret } = await import("../../src/lib/crypto");

const prisma = getTestPrismaClient();

/**
 * "Student approved." appeared while the badge on the same page still read Pending, and
 * the Approve button stayed — so staff clicked it twice and got an error the second time.
 * A server action does not re-render the page it was called from unless it says the page
 * is stale; approve, archive, restore and edit never did. Each state-changing action must
 * revalidate the student's page (the detail page shows the status and the buttons that
 * depend on it) and the roster (which shows the status too).
 *
 * Built the real way throughout (registration form, approval, invitation, public signup).
 */
const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
const orgIds: string[] = [];
const userIds: string[] = [];
const registrationEmails: string[] = [];
let approverId: string;
let org: { organizationId: string; slug: string; academySlug: string; ownerId: string };
let studentId: string;

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) fd.set(key, value);
  return fd;
}

const asOwner = () => {
  currentSession = { user: { id: org.ownerId }, activeOrganizationId: org.organizationId, access: { staff: true, portal: false } };
};
const revalidated = () => vi.mocked(revalidatePath).mock.calls.map(([path]) => path);

describe("state-changing student actions refresh the page they were called from", () => {
  beforeAll(async () => {
    const approver = await prisma.user.create({
      data: { email: `refresh-page-approver-${suffix}@example.com`, passwordHash: await hashSecret("irrelevant-password-123"), role: "ADMIN", isSuperAdmin: true },
    });
    userIds.push(approver.id);
    approverId = approver.id;

    const email = `refresh-page-owner-${suffix}@example.com`;
    const slug = `refresh-page-${suffix}`;
    registrationEmails.push(email);
    const registration = await registerOrganization(
      {},
      form({
        organizationName: "Refresh Page",
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
    await acceptInvitation(
      "es",
      {},
      form({ token: new URL(approval.invitationLink!).searchParams.get("token")!, password: "owner-password-123" }),
    ).catch((error: { digest?: string }) => {
      if (!error.digest?.startsWith("NEXT_REDIRECT")) throw error;
    });
    const owner = await prisma.user.findUniqueOrThrow({ where: { email } });
    userIds.push(owner.id);
    const academy = await prisma.academy.findFirstOrThrow({ where: { organizationId: organization.id } });
    org = { organizationId: organization.id, slug, academySlug: academy.slug, ownerId: owner.id };

    const studentEmail = `refresh-page-student-${suffix}@example.com`;
    const signedUp = await signup(
      slug,
      {},
      form({
        firstName: "Real",
        lastName: "Student",
        phone: "88880000",
        email: studentEmail,
        homeAcademySlug: academy.slug,
        currentBelt: "WHITE",
        currentStripes: "0",
        password: "student-password-123",
      }),
    );
    expect(signedUp, JSON.stringify(signedUp)).toMatchObject({ ok: true });
    const user = await prisma.user.findUniqueOrThrow({ where: { email: studentEmail } });
    userIds.push(user.id);
    studentId = (await prisma.student.findFirstOrThrow({ where: { userId: user.id } })).id;
  });

  beforeEach(() => {
    vi.mocked(revalidatePath).mockClear();
    asOwner();
  });

  afterAll(async () => {
    await prisma.attendanceRecord.deleteMany({ where: { organizationId: { in: orgIds } } });
    await prisma.kioskAttempt.deleteMany({ where: { organizationId: { in: orgIds } } });
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

  // One ordered story: pending -> approved -> archived -> restored, each step's success
  // must have told Next the student's page and the roster are stale.
  const expectRefreshed = () => {
    expect(revalidated()).toEqual(expect.arrayContaining([`/en/students/${studentId}`, "/en/students"]));
  };

  it("REQUIRED: approving revalidates the student's page and the roster", async () => {
    expect(await approveStudent(org.organizationId, {}, form({ studentId }))).toEqual({ ok: true });
    expectRefreshed();
  });

  it("REQUIRED: archiving revalidates the student's page and the roster", async () => {
    expect(await archiveStudent(org.organizationId, {}, form({ studentId }))).toEqual({ ok: true });
    expectRefreshed();
  });

  it("REQUIRED: restoring revalidates the student's page and the roster", async () => {
    expect(await restoreStudent(org.organizationId, {}, form({ studentId }))).toEqual({ ok: true });
    expectRefreshed();
  });

  it("REQUIRED: editing revalidates the student's page and the roster", async () => {
    const result = await updateStudent(
      org.organizationId,
      {},
      form({ studentId, firstName: "Renamed", lastName: "Student", phone: "88880000", email: `refresh-page-student-${suffix}@example.com` }),
    );
    expect(result).toEqual({ ok: true });
    expectRefreshed();
  });

  it("a REFUSED action revalidates nothing (it changed nothing, so there is nothing stale)", async () => {
    // Approving a student who is no longer pending is refused.
    expect(await approveStudent(org.organizationId, {}, form({ studentId }))).toEqual({ error: "notPending" });
    expect(revalidated()).toEqual([]);
  });

  it("an action that cannot reach Next's request machinery still succeeds (revalidation is best-effort, never the reason a committed change reports failure)", async () => {
    vi.mocked(revalidatePath).mockImplementationOnce(() => {
      throw new Error("Invariant: static generation store missing in revalidatePath");
    });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await archiveStudent(org.organizationId, {}, form({ studentId }))).toEqual({ ok: true });
    expect(errors).toHaveBeenCalled();
    errors.mockRestore();
    // Leave the student restored for anything that follows.
    expect(await restoreStudent(org.organizationId, {}, form({ studentId }))).toEqual({ ok: true });
  });
});
