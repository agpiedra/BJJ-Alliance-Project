import "dotenv/config";
import { getTestPrismaClient } from "../helpers/test-db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

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

const { approveOrganization } = await import("../../src/lib/organizations/approve-organization");
const { acceptInvitation } = await import("../../src/app/[locale]/accept-invitation/actions");
const { registerOrganization } = await import("../../src/app/[locale]/register-academy/actions");
const { signup } = await import("../../src/app/[locale]/o/[orgSlug]/signup/actions");
const { approveStudent, regenerateStudentCode } = await import("../../src/app/[locale]/(staff)/students/[id]/actions");
const { hashSecret } = await import("../../src/lib/crypto");

const prisma = getTestPrismaClient();

/**
 * "Any STAFF role can regenerate a student's code" was the stated rule — and the action
 * called `resolveActionContext(organizationId)` with no role list, which admits ANY member of
 * the organization, students included. Its comment said staff; its code said everyone. The
 * role list is now required at every gate (tests/unit/tenant-gate-has-no-default.test.ts), and
 * this action names the roles its own comment always promised.
 *
 * Built the real way throughout (registration form, approval, invitation, public signup,
 * the real approve action).
 */
const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
const orgIds: string[] = [];
const userIds: string[] = [];
const registrationEmails: string[] = [];
let approverId: string;
let org: { organizationId: string; slug: string; academySlug: string; academyId: string; ownerId: string };
let counter = 0;

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) fd.set(key, value);
  return fd;
}

const actAs = (userId: string) => {
  currentSession = { user: { id: userId }, activeOrganizationId: org.organizationId, access: { staff: true, portal: true } };
};

async function approvedStudent(label: string) {
  counter += 1;
  const email = `regen-${label}-${counter}-${suffix}@example.com`;
  const signedUp = await signup(
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
  expect(signedUp, JSON.stringify(signedUp)).toMatchObject({ ok: true });
  const user = await prisma.user.findUniqueOrThrow({ where: { email } });
  userIds.push(user.id);
  const student = await prisma.student.findFirstOrThrow({ where: { userId: user.id } });
  actAs(org.ownerId);
  expect(await approveStudent(org.organizationId, {}, form({ studentId: student.id }))).toEqual({ ok: true });
  return { user, student };
}

const codeHashOf = async (studentId: string) => (await prisma.student.findUniqueOrThrow({ where: { id: studentId } })).codeHash;

describe("regenerating a student's check-in code is for staff", () => {
  let target: Awaited<ReturnType<typeof approvedStudent>>;

  beforeAll(async () => {
    const approver = await prisma.user.create({
      data: { email: `regen-approver-${suffix}@example.com`, passwordHash: await hashSecret("irrelevant-password-123"), role: "ADMIN", isSuperAdmin: true },
    });
    userIds.push(approver.id);
    approverId = approver.id;

    const email = `regen-owner-${suffix}@example.com`;
    const slug = `regen-${suffix}`;
    registrationEmails.push(email);
    const registration = await registerOrganization(
      {},
      form({
        organizationName: "Regen",
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
    org = { organizationId: organization.id, slug, academySlug: academy.slug, academyId: academy.id, ownerId: owner.id };
    target = await approvedStudent("target");
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

  it("REQUIRED: a student-only member cannot regenerate a student's code — their own or anyone's — and nothing changes", async () => {
    const other = await approvedStudent("other-student");
    const before = await codeHashOf(target.student.id);
    const beforeOwn = await codeHashOf(other.student.id);

    actAs(other.user.id);
    const outcomes: Record<string, unknown> = {};
    for (const [whose, studentId] of [["another student's", target.student.id], ["their own", other.student.id]] as const) {
      outcomes[whose] = await regenerateStudentCode(org.organizationId, {}, form({ studentId })).then(
        (result) => ({ resolved: result }),
        (error: Error) => ({ threw: error.message }),
      );
    }
    expect(outcomes).toEqual({ "another student's": { threw: "FORBIDDEN" }, "their own": { threw: "FORBIDDEN" } });

    expect(await codeHashOf(target.student.id)).toBe(before);
    expect(await codeHashOf(other.student.id)).toBe(beforeOwn);
  });

  it("REQUIRED: an instructor assigned to the academy still can (the rule is 'staff', as the comment always said)", async () => {
    const coach = await approvedStudent("coach");
    await prisma.organizationMembership.update({
      where: { userId_organizationId: { userId: coach.user.id, organizationId: org.organizationId } },
      data: { role: "INSTRUCTOR" },
    });
    await prisma.staffAssignment.create({ data: { userId: coach.user.id, academyId: org.academyId, organizationId: org.organizationId, role: "INSTRUCTOR" } });
    const before = await codeHashOf(target.student.id);

    actAs(coach.user.id);
    const result = await regenerateStudentCode(org.organizationId, {}, form({ studentId: target.student.id }));

    expect(result).toMatchObject({ ok: true, code: expect.stringMatching(/^\d{4}$/) });
    expect(await codeHashOf(target.student.id)).not.toBe(before);
  });

  it("control: the Owner can", async () => {
    actAs(org.ownerId);
    expect(await regenerateStudentCode(org.organizationId, {}, form({ studentId: target.student.id }))).toMatchObject({ ok: true });
  });
});
