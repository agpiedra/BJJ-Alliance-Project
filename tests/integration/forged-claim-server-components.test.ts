import "dotenv/config";
import { getTestPrismaClient } from "../helpers/test-db";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/email/send-transactional-email", () => ({
  sendTransactionalEmail: vi.fn(async () => ({ success: true })),
}));

type MockSession = { user: { id: string }; activeOrganizationId: string | null; access: unknown } | null;
let currentSession: MockSession = null;
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

const { approveOrganization } = await import("../../src/lib/organizations/approve-organization");
const { acceptInvitation } = await import("../../src/app/[locale]/accept-invitation/actions");
const { registerOrganization } = await import("../../src/app/[locale]/register-academy/actions");
const { signup } = await import("../../src/app/[locale]/o/[orgSlug]/signup/actions");
const { approveStudent } = await import("../../src/app/[locale]/(staff)/students/[id]/actions");
const { hashSecret } = await import("../../src/lib/crypto");
const { GET: refreshAccess } = await import("../../src/app/api/access/refresh/route");
const { unstable_update: updateSession } = await import("@/auth");
const { default: DashboardPage } = await import("../../src/app/[locale]/(staff)/dashboard/page");
const { default: PaymentsPage } = await import("../../src/app/[locale]/(staff)/payments/page");
const { default: StudentsPage } = await import("../../src/app/[locale]/(staff)/students/page");
const { default: StaffManagementPage } = await import("../../src/app/[locale]/(staff)/admin/staff/page");
const { default: LocationsPage } = await import("../../src/app/[locale]/(staff)/admin/locations/page");

const prisma = getTestPrismaClient();

/**
 * The Edge middleware reads a `{ staff, portal }` claim out of the session token and
 * can only ever REFUSE on it — it has no database, so a token carrying a claim it
 * should not (forged, or simply stale after a demotion) is let through to the page.
 * What stops that person is the page's own database check. This drives that half for
 * real: a student-only member (registered, approved, the whole real path) presenting a
 * session whose claim says `staff: true`, against the REAL default export of each
 * staff page — not against `requireTenantContext` alone, which would not notice a page
 * that stopped calling it. (The other half — real HTTP through the running middleware —
 * is tests/smoke/stale-access-claim.test.ts.)
 */
const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
const orgIds: string[] = [];
const userIds: string[] = [];
const registrationEmails: string[] = [];
let counter = 0;
let approverId: string;

const FORGED = { staff: true, portal: true };
/** Where a page sends a refused student-only member: the route that corrects the claim from the database and explains. */
const REFRESH = "/api/access/refresh?to=%2Fen%2Fdashboard";

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) fd.set(key, value);
  return fd;
}

async function newOrganization() {
  counter += 1;
  const email = `forged-owner-${counter}-${suffix}@example.com`;
  const slug = `forged-${suffix}-${counter}`;
  registrationEmails.push(email);
  const registration = await registerOrganization(
    {},
    form({
      organizationName: `Forged ${counter}`,
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
  return { organizationId: organization.id, slug, academySlug: academy.slug, ownerId: owner.id };
}
type Org = Awaited<ReturnType<typeof newOrganization>>;

async function approvedStudent(org: Org) {
  counter += 1;
  const email = `forged-student-${counter}-${suffix}@example.com`;
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
  currentSession = { user: { id: org.ownerId }, activeOrganizationId: org.organizationId, access: { staff: true, portal: false } };
  expect(await approveStudent(org.organizationId, {}, form({ studentId: student.id }))).toEqual({ ok: true });
  currentSession = null;
  return user;
}

/** A page call's outcome: not found, redirected, or it got PAST its access check. */
async function outcomeOf(promise: Promise<unknown>) {
  try {
    await promise;
    return { passedTheGate: true } as const;
  } catch (error) {
    const digest = (error as { digest?: string }).digest ?? "";
    if (digest.includes("404")) return { notFound: true } as const;
    if (digest.startsWith("NEXT_REDIRECT")) return { redirect: digest.split(";")[2] } as const;
    // Anything else means the page ran PAST its access check and failed later (there is
    // no request scope for translations here) — which is exactly what a forged claim
    // must never reach.
    return { passedTheGate: true } as const;
  }
}

const STAFF_PAGES = [
  ["the dashboard", () => DashboardPage()],
  ["the student roster", () => StudentsPage({ searchParams: Promise.resolve({}) })],
  ["payments", () => PaymentsPage()],
  ["staff management (Owner only)", () => StaffManagementPage()],
  ["locations (Owner only)", () => LocationsPage()],
] as const;

describe("a forged or stale staff claim is stopped by the page, not the middleware", () => {
  let org: Org;
  let studentUserId: string;

  beforeAll(async () => {
    const approver = await prisma.user.create({
      data: { email: `forged-approver-${suffix}@example.com`, passwordHash: await hashSecret("irrelevant-password-123"), role: "ADMIN", isSuperAdmin: true },
    });
    userIds.push(approver.id);
    approverId = approver.id;
    org = await newOrganization();
    studentUserId = (await approvedStudent(org)).id;
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

  describe.each(STAFF_PAGES)("%s", (_label, renderPage) => {
    it("REQUIRED: refuses a student-only member whose session CLAIMS staff access — sent to the refresh, not a bare 404", async () => {
      currentSession = { user: { id: studentUserId }, activeOrganizationId: org.organizationId, access: FORGED };
      expect(await outcomeOf(renderPage())).toEqual({ redirect: REFRESH });
    });
  });

  it("REQUIRED: following that redirect corrects the stale claim from the database and lands on the no-access page", async () => {
    currentSession = { user: { id: studentUserId }, activeOrganizationId: org.organizationId, access: FORGED };
    vi.mocked(updateSession).mockClear();
    const hop = await outcomeOf(refreshAccess(new Request(`http://localhost${REFRESH}`)));
    expect(hop).toEqual({ redirect: "/en/no-access" });
    expect(updateSession).toHaveBeenCalledWith({ activeOrganizationId: org.organizationId });
  });

  it("control: a staff member refused an Owner-only page is NOT sent to the refresh — they still get the 404", async () => {
    const instructor = await approvedStudent(org);
    await prisma.organizationMembership.update({
      where: { userId_organizationId: { userId: instructor.id, organizationId: org.organizationId } },
      data: { role: "INSTRUCTOR" },
    });
    currentSession = { user: { id: instructor.id }, activeOrganizationId: org.organizationId, access: { staff: true, portal: true } };
    expect(await outcomeOf(StaffManagementPage())).toEqual({ notFound: true });
  });

  it("REQUIRED: a claim cannot name an organization the person does not belong to", async () => {
    const other = await newOrganization();
    currentSession = { user: { id: studentUserId }, activeOrganizationId: other.organizationId, access: FORGED };
    expect(await outcomeOf(DashboardPage())).not.toHaveProperty("passedTheGate");
  });

  it("positive control: the real Owner, with the same kind of claim, is NOT refused by the same pages", async () => {
    currentSession = { user: { id: org.ownerId }, activeOrganizationId: org.organizationId, access: FORGED };
    for (const [label, renderPage] of STAFF_PAGES) {
      expect(await outcomeOf(renderPage()), label).toEqual({ passedTheGate: true });
    }
  });
});
