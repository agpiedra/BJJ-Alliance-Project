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
// The signup fires a notification after the response; not under test.
vi.mock("@/lib/notifications/fire-and-forget", () => ({ fireAndForget: vi.fn() }));

const { approveOrganization } = await import("../../src/lib/organizations/approve-organization");
const { acceptInvitation } = await import("../../src/app/[locale]/accept-invitation/actions");
const { registerOrganization } = await import("../../src/app/[locale]/register-academy/actions");
const { signup } = await import("../../src/app/[locale]/o/[orgSlug]/signup/actions");
const { approveStudent, archiveStudent } = await import("../../src/app/[locale]/(staff)/students/[id]/actions");
const { requireOrganizationAccess, requirePortalContext, TenantAccessError } = await import("../../src/lib/tenant/context");
const { resolveActiveOrganizationForSignIn } = await import("../../src/lib/tenant/active-organization");
const { hashSecret, digestLookupSecret } = await import("../../src/lib/crypto");
const { requireEnv } = await import("../../src/lib/env");

const prisma = getTestPrismaClient();

/**
 * The student portal was unreachable for EVERY real student. A student who
 * signs up through the public form gets a `User` and a `Student` — and, until
 * now, nothing else: no `OrganizationMembership`, which is what the tenant
 * context resolver (and so `/portal`) requires. Only the seed, which writes its
 * students' memberships by hand, ever made the portal work; this whole class of
 * user was invisible for the same reason the owner lockout was (a seeded
 * fixture standing in for the real flow). So this test never builds the
 * student by hand: it signs one up through the real public action, has staff
 * approve them through the real action, and then does exactly what `/portal`
 * does — `requirePortalContext()` as that student.
 *
 * The membership is created at APPROVAL, not signup: a membership says "this
 * person belongs here", which a pending applicant does not yet — and it avoids
 * dangling rows for applicants who are never approved.
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

/** An organization whose Owner is created the real way: the public registration form (which is what seeds the belt ranks a signup needs), approval, then the invitation accepted. */
async function newOrganization() {
  counter += 1;
  const email = `portal-owner-${counter}-${suffix}@example.com`;
  const slug = `portal-${suffix}-${counter}`;
  registrationEmails.push(email);
  const registration = await registerOrganization(
    {},
    form({
      organizationName: `Portal ${counter}`,
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
  const token = new URL(approval.invitationLink!).searchParams.get("token")!;
  const fd = new FormData();
  fd.set("token", token);
  fd.set("password", "owner-password-123");
  await acceptInvitation("es", {}, fd).catch((error: { digest?: string }) => {
    if (!error.digest?.startsWith("NEXT_REDIRECT")) throw error;
  });
  const owner = await prisma.user.findUniqueOrThrow({ where: { email } });
  userIds.push(owner.id);
  const academy = await prisma.academy.findFirstOrThrow({ where: { organizationId: organization.id } });
  return { organizationId: organization.id, slug: organization.slug, academySlug: academy.slug, academyId: academy.id, ownerId: owner.id };
}

/** Signs a student up through the real public action. */
async function signUpStudent(org: { slug: string; academySlug: string }, label: string) {
  counter += 1;
  const email = `portal-student-${label}-${counter}-${suffix}@example.com`;
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
  return { user, student, email };
}

describe("a real student can reach the portal", () => {
  beforeAll(async () => {
    const approver = await prisma.user.create({
      data: { email: `portal-approver-${suffix}@example.com`, passwordHash: await hashSecret("irrelevant-password-123"), role: "ADMIN", isSuperAdmin: true },
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

  it("REQUIRED: signs up through the real form, is approved by staff, and reaches /portal with their own record", async () => {
    const org = await newOrganization();
    const { user, student } = await signUpStudent(org, "happy");

    // A pending applicant does not "belong" yet: no membership, no portal.
    expect(await prisma.organizationMembership.count({ where: { userId: user.id } })).toBe(0);
    const pending = await requireOrganizationAccess(user.id, org.organizationId).catch((error) => error);
    expect(pending).toBeInstanceOf(TenantAccessError);

    actAs(org.ownerId, org.organizationId, "ADMIN");
    const approval = new FormData();
    approval.set("studentId", student.id);
    expect(await approveStudent(org.organizationId, {}, approval)).toEqual({ ok: true });

    // Now do exactly what /portal does, as that student.
    actAs(user.id, org.organizationId, "STUDENT");
    const { context, studentId } = await requirePortalContext();
    expect(studentId).toBe(student.id);
    expect(context).toMatchObject({ organizationId: org.organizationId, organizationRole: "STUDENT", selfStudentId: student.id, linkedStudentId: student.id });
    expect(await prisma.organizationMembership.findUniqueOrThrow({ where: { userId_organizationId: { userId: user.id, organizationId: org.organizationId } } })).toMatchObject({
      role: "STUDENT",
      active: true,
    });
    // ...and sign-in lands them in their own academy rather than on "no organization access".
    expect(await resolveActiveOrganizationForSignIn(user.id)).toEqual({ kind: "resolved", organizationId: org.organizationId });
  });

  it("the approval is audited, including that it granted the membership", async () => {
    const org = await newOrganization();
    const { student } = await signUpStudent(org, "audit");
    actAs(org.ownerId, org.organizationId, "ADMIN");
    const approval = new FormData();
    approval.set("studentId", student.id);
    await approveStudent(org.organizationId, {}, approval);

    const audit = await prisma.auditLog.findFirstOrThrow({ where: { entityId: student.id, action: "student.approve" } });
    expect(audit.after).toMatchObject({ status: "ACTIVE", membership: "granted" });
  });

  it("REQUIRED: archiving a student switches their membership off — they lose the portal, and nothing else about their account changes", async () => {
    const org = await newOrganization();
    const { user, student } = await signUpStudent(org, "archive");
    actAs(org.ownerId, org.organizationId, "ADMIN");
    const fd = new FormData();
    fd.set("studentId", student.id);
    await approveStudent(org.organizationId, {}, fd);
    await expect(requireOrganizationAccess(user.id, org.organizationId)).resolves.toMatchObject({ organizationRole: "STUDENT" });

    expect(await archiveStudent(org.organizationId, {}, fd)).toEqual({ ok: true });

    const refused = await requireOrganizationAccess(user.id, org.organizationId).catch((error) => error);
    expect(refused).toBeInstanceOf(TenantAccessError);
    expect((refused as InstanceType<typeof TenantAccessError>).result.status).toBe("NO_MEMBERSHIP");
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).active).toBe(true); // the ACCOUNT is untouched
    expect((await prisma.organizationMembership.findUniqueOrThrow({ where: { userId_organizationId: { userId: user.id, organizationId: org.organizationId } } })).active).toBe(false);
  });

  it("REQUIRED: approving or archiving never overwrites or switches off a STAFF membership the same person holds", async () => {
    const org = await newOrganization();
    // A coach who also trains: a staff membership AND a linked, still-pending Student record.
    counter += 1;
    const coach = await prisma.user.create({ data: { email: `portal-coach-${counter}-${suffix}@example.com`, passwordHash: await hashSecret("coach-password-123"), role: "INSTRUCTOR" } });
    userIds.push(coach.id);
    await prisma.organizationMembership.create({ data: { userId: coach.id, organizationId: org.organizationId, role: "INSTRUCTOR" } });
    await prisma.staffAssignment.create({ data: { userId: coach.id, academyId: org.academyId, organizationId: org.organizationId, role: "INSTRUCTOR" } });
    const rank = await prisma.beltRank.findFirstOrThrow({ where: { organizationId: org.organizationId, track: "ADULT" } });
    const student = await prisma.student.create({
      data: {
        userId: coach.id,
        homeAcademyId: org.academyId,
        organizationId: org.organizationId,
        firstName: "Coach",
        lastName: "Trainee",
        phone: "88880000",
        email: coach.email,
        currentRankId: rank.id,
        status: "PENDING",
        codeHash: digestLookupSecret(`coach-${suffix}-${counter}`, requireEnv("CODE_PEPPER")),
      },
    });
    actAs(org.ownerId, org.organizationId, "ADMIN");
    const fd = new FormData();
    fd.set("studentId", student.id);

    await approveStudent(org.organizationId, {}, fd);
    expect(await prisma.organizationMembership.findUniqueOrThrow({ where: { userId_organizationId: { userId: coach.id, organizationId: org.organizationId } } })).toMatchObject({ role: "INSTRUCTOR", active: true });

    await archiveStudent(org.organizationId, {}, fd);
    expect(await prisma.organizationMembership.findUniqueOrThrow({ where: { userId_organizationId: { userId: coach.id, organizationId: org.organizationId } } })).toMatchObject({ role: "INSTRUCTOR", active: true });
    await expect(requireOrganizationAccess(coach.id, org.organizationId)).resolves.toMatchObject({ organizationRole: "INSTRUCTOR" });
  });

  it("a student staff entered by hand (no account) is approved and archived without inventing a membership", async () => {
    const org = await newOrganization();
    const rank = await prisma.beltRank.findFirstOrThrow({ where: { organizationId: org.organizationId, track: "ADULT" } });
    counter += 1;
    const student = await prisma.student.create({
      data: {
        homeAcademyId: org.academyId,
        organizationId: org.organizationId,
        firstName: "No",
        lastName: "Account",
        phone: "88880000",
        email: `portal-noaccount-${counter}-${suffix}@example.com`,
        currentRankId: rank.id,
        status: "PENDING",
        codeHash: digestLookupSecret(`noacct-${suffix}-${counter}`, requireEnv("CODE_PEPPER")),
      },
    });
    actAs(org.ownerId, org.organizationId, "ADMIN");
    const fd = new FormData();
    fd.set("studentId", student.id);

    expect(await approveStudent(org.organizationId, {}, fd)).toEqual({ ok: true });
    expect(await archiveStudent(org.organizationId, {}, fd)).toEqual({ ok: true });

    // Only the owner's membership exists in this organization.
    expect(await prisma.organizationMembership.count({ where: { organizationId: org.organizationId } })).toBe(1);
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { entityId: student.id, action: "student.approve" } });
    expect(audit.after).toMatchObject({ membership: "none" });
  });
});
