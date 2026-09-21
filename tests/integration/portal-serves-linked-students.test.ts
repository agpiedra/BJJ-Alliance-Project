import "dotenv/config";
import { getTestPrismaClient } from "../helpers/test-db";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

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
vi.mock("next-intl/server", () => ({ getLocale: () => Promise.resolve("en") }));
vi.mock("@/lib/notifications/fire-and-forget", () => ({ fireAndForget: vi.fn() }));
vi.mock("@/lib/notifications/notify-eligibility", () => ({ notifyEligibilityReached: vi.fn(async () => {}) }));

const { approveOrganization } = await import("../../src/lib/organizations/approve-organization");
const { acceptInvitation } = await import("../../src/app/[locale]/accept-invitation/actions");
const { registerOrganization } = await import("../../src/app/[locale]/register-academy/actions");
const { signup } = await import("../../src/app/[locale]/o/[orgSlug]/signup/actions");
const { approveStudent, archiveStudent } = await import("../../src/app/[locale]/(staff)/students/[id]/actions");
const { requirePortalContext, requireTenantContext } = await import("../../src/lib/tenant/context");
const { selfCheckIn } = await import("../../src/app/[locale]/portal/self-check-in-action");
const { hashSecret } = await import("../../src/lib/crypto");

const prisma = getTestPrismaClient();

/**
 * The portal and self-check-in serve anyone with a LINKED, ACTIVE student record —
 * whatever their membership role. A jiu-jitsu academy's coaches are its students:
 * the head coach trains there, so one account must reach both the staff app and
 * the portal. Until now both were gated on `["STUDENT"]`, the membership role, so a
 * coach with a student record of their own was refused their own training — and the
 * only workaround was a second email address.
 *
 * Built the real way throughout (registration form, approval, invitation accepted,
 * public student signup, the real approve / archive actions).
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
  const email = `portal-owner-${counter}-${suffix}@example.com`;
  const slug = `portalgate-${suffix}-${counter}`;
  registrationEmails.push(email);
  const registration = await registerOrganization(
    {},
    form({
      organizationName: `Portal Gate ${counter}`,
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

async function signUpStudent(org: Org, label: string) {
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
  return { user, student };
}

async function approve(org: Org, studentId: string) {
  actAs(org.ownerId, org.organizationId);
  expect(await approveStudent(org.organizationId, {}, form({ studentId }))).toEqual({ ok: true });
}
async function archive(org: Org, studentId: string) {
  actAs(org.ownerId, org.organizationId);
  expect(await archiveStudent(org.organizationId, {}, form({ studentId }))).toEqual({ ok: true });
}

/** An approved student who is ALSO an instructor at the organization: one account, a staff membership and an ACTIVE student record. */
async function makeCoach(org: Org, label: string) {
  const { user, student } = await signUpStudent(org, label);
  await approve(org, student.id);
  await prisma.organizationMembership.update({
    where: { userId_organizationId: { userId: user.id, organizationId: org.organizationId } },
    data: { role: "INSTRUCTOR" },
  });
  await prisma.staffAssignment.create({ data: { userId: user.id, academyId: org.academyId, organizationId: org.organizationId, role: "INSTRUCTOR" } });
  return { user, student };
}

/** What the outcome of a page-level gate looks like: a value, a not-found digest, or a redirect target. */
async function outcomeOf(promise: Promise<unknown>) {
  try {
    return { resolved: await promise } as const;
  } catch (error) {
    const digest = (error as { digest?: string }).digest ?? "";
    if (digest.includes("404")) return { notFound: true } as const;
    if (digest.startsWith("NEXT_REDIRECT")) return { redirect: digest.split(";")[2] } as const;
    throw error;
  }
}

describe("the portal serves anyone with a linked, active student record", () => {
  beforeAll(async () => {
    const approver = await prisma.user.create({
      data: { email: `portal-approver-${suffix}@example.com`, passwordHash: await hashSecret("irrelevant-password-123"), role: "ADMIN", isSuperAdmin: true },
    });
    userIds.push(approver.id);
    approverId = approver.id;
  });

  afterEach(() => {
    currentSession = null;
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

  describe("the page gate (requirePortalContext)", () => {
    it("REQUIRED: a coach who also trains reaches the portal — with THEIR OWN student record — and still reaches the staff app", async () => {
      const org = await newOrganization();
      const coach = await makeCoach(org, "both");

      actAs(coach.user.id, org.organizationId);
      const portal = await outcomeOf(requirePortalContext());
      expect(portal).toMatchObject({ resolved: { studentId: coach.student.id } });
      const staff = await outcomeOf(requireTenantContext(["ADMIN", "DIRECTOR", "INSTRUCTOR"]));
      expect(staff).toMatchObject({ resolved: { organizationRole: "INSTRUCTOR" } });
    });

    it("a pure student reaches the portal with their own record", async () => {
      const org = await newOrganization();
      const { user, student } = await signUpStudent(org, "pure");
      await approve(org, student.id);

      actAs(user.id, org.organizationId);
      expect(await outcomeOf(requirePortalContext())).toMatchObject({ resolved: { studentId: student.id } });
    });

    it("REQUIRED: someone with no student record of their own (an Owner) gets a 404 — the pinned refusal — not a crash and not someone else's portal", async () => {
      const org = await newOrganization();
      const { student } = await signUpStudent(org, "someone-else");
      await approve(org, student.id);

      actAs(org.ownerId, org.organizationId);
      expect(await outcomeOf(requirePortalContext())).toEqual({ notFound: true });
    });

    it("REQUIRED: a coach whose OWN student record is archived loses the portal and keeps the staff app — the same as any archived student", async () => {
      const org = await newOrganization();
      const coach = await makeCoach(org, "archived");
      await archive(org, coach.student.id);

      actAs(coach.user.id, org.organizationId);
      expect(await outcomeOf(requirePortalContext())).toEqual({ notFound: true });
      expect(await outcomeOf(requireTenantContext(["INSTRUCTOR"]))).toMatchObject({ resolved: { organizationRole: "INSTRUCTOR" } });
    });

    it("a staff member whose student record is still PENDING has no portal yet", async () => {
      const org = await newOrganization();
      const { user } = await signUpStudent(org, "pending-staff");
      await prisma.organizationMembership.create({ data: { userId: user.id, organizationId: org.organizationId, role: "INSTRUCTOR" } });

      actAs(user.id, org.organizationId);
      expect(await outcomeOf(requirePortalContext())).toEqual({ notFound: true });
    });

    it("the other refusals are unchanged: signed out goes to login, a non-member to no-organization-access", async () => {
      const org = await newOrganization();
      const outsider = await newOrganization();

      currentSession = null;
      expect(await outcomeOf(requirePortalContext())).toEqual({ redirect: "/en/login" });

      actAs(outsider.ownerId, org.organizationId);
      expect(await outcomeOf(requirePortalContext())).toEqual({ redirect: "/en/no-organization-access" });
    });
  });

  describe("self-check-in", () => {
    it("REQUIRED: a coach who also trains checks in for THEIR OWN training, recorded as a portal check-in on their own student record", async () => {
      const org = await newOrganization();
      const coach = await makeCoach(org, "checkin");

      actAs(coach.user.id, org.organizationId);
      const state = await selfCheckIn(org.organizationId, {}, new FormData());

      expect(state, JSON.stringify(state)).toMatchObject({ ok: true });
      const records = await prisma.attendanceRecord.findMany({ where: { organizationId: org.organizationId } });
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({ studentId: coach.student.id, source: "PORTAL", type: "CHECKIN" });
    });

    it("REQUIRED: a coach whose student record is archived cannot check in — honestly told notActive — and nothing is recorded", async () => {
      const org = await newOrganization();
      const coach = await makeCoach(org, "archived-checkin");
      await archive(org, coach.student.id);

      actAs(coach.user.id, org.organizationId);
      expect(await selfCheckIn(org.organizationId, {}, new FormData())).toEqual({ error: "notActive" });
      expect(await prisma.attendanceRecord.count({ where: { organizationId: org.organizationId } })).toBe(0);
    });

    it("someone with no student record at all is refused with the generic error, and a non-member likewise", async () => {
      const org = await newOrganization();
      const outsider = await newOrganization();

      actAs(org.ownerId, org.organizationId);
      expect(await selfCheckIn(org.organizationId, {}, new FormData())).toEqual({ error: "invalid_code" });

      actAs(outsider.ownerId, outsider.organizationId);
      expect(await selfCheckIn(org.organizationId, {}, new FormData())).toEqual({ error: "invalid_code" });
      expect(await prisma.attendanceRecord.count({ where: { organizationId: org.organizationId } })).toBe(0);
    });
  });
});
