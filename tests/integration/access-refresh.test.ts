import "dotenv/config";
import { getTestPrismaClient } from "../helpers/test-db";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/email/send-transactional-email", () => ({
  sendTransactionalEmail: vi.fn(async () => ({ success: true })),
}));

type MockSession = { user: { id: string }; activeOrganizationId: string | null; access: unknown } | null;
let currentSession: MockSession = null;
const updateSpy = vi.hoisted(() => ({ fn: vi.fn<(data: Record<string, unknown>) => Promise<null>>(async () => null) }));
vi.mock("@/auth", () => ({
  auth: () => Promise.resolve(currentSession),
  unstable_update: (data: Record<string, unknown>) => updateSpy.fn(data),
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
const { approveStudent } = await import("../../src/app/[locale]/(staff)/students/[id]/actions");
const { GET: refreshAccess } = await import("../../src/app/api/access/refresh/route");
const { landingPathForUser } = await import("../../src/lib/auth/landing");
const authConfig = (await import("../../src/auth.config")).default;
const { hashSecret } = await import("../../src/lib/crypto");

const prisma = getTestPrismaClient();

/**
 * "Anny promotes a student to instructor while they are logged in." Their token's
 * claim still says portal-only until it is refreshed. The middleware can only
 * REFUSE on a claim (it runs on the Edge, no database), so what the person must
 * NEVER get is a silent refusal for access they were just granted — and "log out
 * and back in" is not an answer we give a customer.
 *
 * The decision, made deliberately: when a WELL-FORMED claim denies the tree, the
 * middleware sends the request to `/api/access/refresh?to=<path>`. That route
 * (Node) re-derives access from the database. If the database disagrees with the
 * claim — in EITHER direction — it rewrites the claim (`unstable_update`); then it
 * continues to the page if access is now allowed, and otherwise shows a plain
 * "you don't have access to this area" page (`/no-access`). Never a bounce to the
 * login page, never a request to log out. A token with NO usable claim is not
 * refreshed here at all: it fails closed and is sent to login, as required.
 *
 * Built the real way throughout (registration form, approval, invitation accepted,
 * public student signup, the real approve action).
 */
const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
const orgIds: string[] = [];
const userIds: string[] = [];
const registrationEmails: string[] = [];
let counter = 0;
let approverId: string;

const NONE = { staff: false, portal: false };
const STAFF_ONLY = { staff: true, portal: false };
const PORTAL_ONLY = { staff: false, portal: true };
const BOTH = { staff: true, portal: true };

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) fd.set(key, value);
  return fd;
}

async function newOrganization() {
  counter += 1;
  const email = `refresh-owner-${counter}-${suffix}@example.com`;
  const slug = `refresh-${suffix}-${counter}`;
  registrationEmails.push(email);
  const registration = await registerOrganization(
    {},
    form({
      organizationName: `Refresh ${counter}`,
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
  const email = `refresh-student-${label}-${counter}-${suffix}@example.com`;
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
  currentSession = { user: { id: org.ownerId }, activeOrganizationId: org.organizationId, access: STAFF_ONLY };
  expect(await approveStudent(org.organizationId, {}, form({ studentId: student.id }))).toEqual({ ok: true });
  currentSession = null;
  return { user, student };
}

async function promote(org: Org, userId: string, role: "INSTRUCTOR" | "STUDENT") {
  await prisma.organizationMembership.update({ where: { userId_organizationId: { userId, organizationId: org.organizationId } }, data: { role } });
}

async function outcomeOf(promise: Promise<unknown>) {
  try {
    await promise;
    return { returned: true } as const;
  } catch (error) {
    const digest = (error as { digest?: string }).digest ?? "";
    if (digest.startsWith("NEXT_REDIRECT")) return { redirect: digest.split(";")[2] } as const;
    throw error;
  }
}

const refresh = (to: string | null) => outcomeOf(refreshAccess(new Request(`http://localhost/api/access/refresh${to === null ? "" : `?to=${encodeURIComponent(to)}`}`)));

describe("access: refresh, landing, and the role-less session", () => {
  beforeAll(async () => {
    const approver = await prisma.user.create({
      data: { email: `refresh-approver-${suffix}@example.com`, passwordHash: await hashSecret("irrelevant-password-123"), role: "ADMIN", isSuperAdmin: true },
    });
    userIds.push(approver.id);
    approverId = approver.id;
  });

  afterEach(() => {
    currentSession = null;
    updateSpy.fn.mockClear();
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

  it("REQUIRED (promoted while logged in): a portal-only token asking for the staff app is refreshed from the database and let through — no login page, no 'log out'", async () => {
    const org = await newOrganization();
    const { user } = await approvedStudent(org, "promoted");
    currentSession = { user: { id: user.id }, activeOrganizationId: org.organizationId, access: PORTAL_ONLY }; // the token as issued when they were only a student

    await promote(org, user.id, "INSTRUCTOR"); // Anny promotes them while they are logged in

    expect(await refresh("/en/dashboard")).toEqual({ redirect: "/en/dashboard" });
    expect(updateSpy.fn).toHaveBeenCalledTimes(1);
    expect(updateSpy.fn).toHaveBeenCalledWith({ activeOrganizationId: org.organizationId });
  });

  it("REQUIRED (the same thing for the other side): a staff-only token asking for the portal, after their student record was approved, is refreshed and let through", async () => {
    const org = await newOrganization();
    const { user } = await approvedStudent(org, "gains-portal");
    await promote(org, user.id, "INSTRUCTOR");
    currentSession = { user: { id: user.id }, activeOrganizationId: org.organizationId, access: STAFF_ONLY }; // stale: the database says BOTH

    expect(await refresh("/en/portal")).toEqual({ redirect: "/en/portal" });
    expect(updateSpy.fn).toHaveBeenCalledTimes(1);
  });

  it("REQUIRED (silently refusing is not an option): when the database agrees with the refusal, the person is TOLD — a plain no-access page, never the login page — and the claim is not rewritten needlessly", async () => {
    const org = await newOrganization();
    const { user } = await approvedStudent(org, "just-a-student");
    currentSession = { user: { id: user.id }, activeOrganizationId: org.organizationId, access: PORTAL_ONLY }; // correct claim: they really are only a student

    expect(await refresh("/en/dashboard")).toEqual({ redirect: "/en/no-access" });
    expect(updateSpy.fn).not.toHaveBeenCalled();
  });

  it("the restrictive direction heals too: a demoted person's stale staff claim is rewritten to what the database says, and they are told, not bounced", async () => {
    const org = await newOrganization();
    const { user } = await approvedStudent(org, "demoted");
    await promote(org, user.id, "INSTRUCTOR");
    await promote(org, user.id, "STUDENT"); // demoted while logged in
    currentSession = { user: { id: user.id }, activeOrganizationId: org.organizationId, access: BOTH }; // stale

    expect(await refresh("/en/dashboard")).toEqual({ redirect: "/en/no-access" });
    expect(updateSpy.fn).toHaveBeenCalledTimes(1); // the claim now says portal-only, so it stops asking

    expect(await refresh("/en/portal")).toEqual({ redirect: "/en/portal" }); // and the side they DO have works
  });

  it("REQUIRED (fail closed is kept): a token with no usable claim is NOT refreshed here — it is sent to login, as the middleware would", async () => {
    const org = await newOrganization();
    for (const access of [null, undefined, {}, { staff: true }, "staff"]) {
      currentSession = { user: { id: org.ownerId }, activeOrganizationId: org.organizationId, access };
      expect(await refresh("/en/dashboard")).toEqual({ redirect: "/en/login?callbackUrl=%2Fen%2Fdashboard" });
    }
    currentSession = null;
    expect(await refresh("/en/dashboard")).toEqual({ redirect: "/en/login?callbackUrl=%2Fen%2Fdashboard" });
    expect(updateSpy.fn).not.toHaveBeenCalled();
  });

  it("tenant-less states go where every page sends them — choose an organization, no organization, organization unavailable — not to a generic refusal", async () => {
    const a = await newOrganization();
    const b = await newOrganization();
    await prisma.organizationMembership.create({ data: { userId: a.ownerId, organizationId: b.organizationId, role: "ADMIN" } });
    await prisma.user.update({ where: { id: a.ownerId }, data: { lastActiveOrganizationId: null } });

    currentSession = { user: { id: a.ownerId }, activeOrganizationId: null, access: NONE };
    expect(await refresh("/en/dashboard")).toEqual({ redirect: "/en/select-organization" });

    const stranger = await prisma.user.create({ data: { email: `refresh-stranger-${suffix}@example.com`, passwordHash: await hashSecret("x-password-123"), role: "DIRECTOR" } });
    userIds.push(stranger.id);
    currentSession = { user: { id: stranger.id }, activeOrganizationId: null, access: NONE };
    expect(await refresh("/en/dashboard")).toEqual({ redirect: "/en/no-organization-access" });

    await prisma.organization.update({ where: { id: b.organizationId }, data: { status: "SUSPENDED" } });
    currentSession = { user: { id: b.ownerId }, activeOrganizationId: b.organizationId, access: STAFF_ONLY };
    expect(await refresh("/en/dashboard")).toEqual({ redirect: "/en/organization-unavailable" });
    expect(updateSpy.fn).not.toHaveBeenCalled();
  });

  it("REQUIRED: it never redirects off-site — an absolute, protocol-relative or backslash target is ignored, not followed", async () => {
    const org = await newOrganization();
    currentSession = { user: { id: org.ownerId }, activeOrganizationId: org.organizationId, access: STAFF_ONLY };
    for (const to of ["https://evil.example/dashboard", "//evil.example/dashboard", "/\\evil.example", "javascript:alert(1)", "evil.example", null]) {
      const outcome = await refresh(to);
      expect(outcome, String(to)).toEqual({ redirect: "/es/no-access" });
    }
  });

  it("a path that is not a gated tree simply continues once the session is sound", async () => {
    const org = await newOrganization();
    currentSession = { user: { id: org.ownerId }, activeOrganizationId: org.organizationId, access: STAFF_ONLY };
    expect(await refresh("/en/payments")).toEqual({ redirect: "/en/payments" });
  });

describe("where sign-in lands (landingPathForUser)", () => {
  it("a student lands in the portal; staff — including a coach who also trains — in the staff app", async () => {
    const org = await newOrganization();
    const student = await approvedStudent(org, "landing-student");
    const coach = await approvedStudent(org, "landing-coach");
    await promote(org, coach.user.id, "INSTRUCTOR");

    expect(await landingPathForUser(student.user.id)).toBe("/portal");
    expect(await landingPathForUser(org.ownerId)).toBe("/dashboard");
    expect(await landingPathForUser(coach.user.id)).toBe("/dashboard");
  });

  it("someone with nothing resolved yet lands on the staff path, where the refresh route sends them on to choose an organization or to their notice", async () => {
    const stranger = await prisma.user.create({ data: { email: `landing-stranger-${suffix}@example.com`, passwordHash: await hashSecret("x-password-123"), role: "STUDENT" } });
    userIds.push(stranger.id);

    expect(await landingPathForUser(stranger.id)).toBe("/dashboard");
    expect(await landingPathForUser("no-such-user")).toBe("/dashboard");
  });
});

describe("nothing authorizes on the global role any more", () => {
  it("the session no longer carries `role` — only the id, the active organization and the claim", async () => {
    const sessionCallback = authConfig.callbacks!.session as unknown as (params: Record<string, unknown>) => Promise<Record<string, unknown>>;
    const session = (await sessionCallback({
      session: { user: {}, expires: "" },
      token: { id: "u1", activeOrganizationId: "o1", access: BOTH, role: "ADMIN" },
    })) as { user: Record<string, unknown> };

    expect(session.user).toEqual({ id: "u1" });
  });
});
});
