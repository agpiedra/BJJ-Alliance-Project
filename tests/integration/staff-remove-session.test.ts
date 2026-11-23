import "dotenv/config";
import { NextRequest } from "next/server";
import { encode, type JWT } from "next-auth/jwt";
import { afterAll, describe, expect, it, vi } from "vitest";
import { getTestPrismaClient } from "../helpers/test-db";

/**
 * "Remove from academy" through the REAL session path, for someone in TWO academies whose session currently points at
 * the one they are removed from. Driven through the app's own entry points against the isolated test database:
 *  - sign-in = `verifyCredentials` (what `authorize` calls) + the shared `signInJwtCallback` + `encode` — the real cookie;
 *  - session read = the real `/api/auth/session` handler (Auth.js + the Node jwt callback, credentials check included);
 *  - the page gate = the real `getTenantContext` / `requireTenantContext`, fed the session that handler returned. Only
 *    `auth()` is pointed at that session, because `next/headers` (where it reads the cookie) does not exist outside a
 *    request; everything after it is unmodified.
 * No email is involved. Records the CURRENT redirect (to /no-organization-access) — a known gap tracked separately:
 * this person still has another academy, and the academy picker would be the better destination.
 */
vi.mock("@/lib/after-response", () => ({ scheduleAfterResponse: () => true }));
vi.mock("next-intl/server", async (importOriginal) => ({ ...(await importOriginal<object>()), getLocale: async () => "en" }));
let currentSession: unknown = null;
vi.mock("@/auth", async (importOriginal) => ({ ...(await importOriginal<object>()), auth: () => Promise.resolve(currentSession) }));
vi.setConfig({ testTimeout: 60_000, hookTimeout: 30_000 });

const { handlers } = await import("../../src/auth");
const { signInJwtCallback } = await import("../../src/lib/auth/sign-in-jwt-callback");
const { verifyCredentials } = await import("../../src/lib/auth/verify-credentials");
const { getTenantContext, requireTenantContext, requireOrganizationAccess } = await import("../../src/lib/tenant/context");
const { removeStaffMembership, setMembershipActive } = await import("../../src/lib/staff/staff-service");
const { hashSecret, digestLookupSecret } = await import("../../src/lib/crypto");
const { requireEnv } = await import("../../src/lib/env");

const SESSION_COOKIE = "authjs.session-token";
const PASSWORD = "Two-Academies-Passw0rd";
const prisma = getTestPrismaClient();
const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
const orgIds: string[] = [];
const userIds: string[] = [];
let n = 0;

async function newAcademyOrg(label: string) {
  n += 1;
  const organization = await prisma.organization.create({ data: { slug: `rmsess-${label}-${suffix}`, name: `Remove session ${label}`, status: "ACTIVE" } });
  orgIds.push(organization.id);
  const academy = await prisma.academy.create({
    data: { organizationId: organization.id, name: `Academy ${label}`, slug: `rmsess-academy-${label}-${suffix}`, kioskTokenHash: digestLookupSecret(`rmsess-kiosk-${n}-${suffix}`, requireEnv("CODE_PEPPER")) },
  });
  return { organizationId: organization.id, academyId: academy.id };
}

async function newUser(label: string, role: "ADMIN" | "INSTRUCTOR") {
  const user = await prisma.user.create({ data: { email: `rmsess-${label}-${suffix}@example.com`, passwordHash: await hashSecret(PASSWORD), role } });
  userIds.push(user.id);
  return user;
}

async function staffIn(org: { organizationId: string; academyId: string }, userId: string, role: "ADMIN" | "INSTRUCTOR") {
  const membership = await prisma.organizationMembership.create({ data: { userId, organizationId: org.organizationId, role } });
  if (role !== "ADMIN") await prisma.staffAssignment.create({ data: { userId, academyId: org.academyId, organizationId: org.organizationId, role } });
  return membership;
}

/** A real sign-in, as `authorize` + the jwt callback + Auth.js encoding do it. */
async function signIn(email: string): Promise<{ token: JWT; cookie: string }> {
  const verified = await verifyCredentials(email, PASSWORD);
  expect(verified).not.toBeNull();
  const token = (await signInJwtCallback({ token: { sub: verified!.id, email: verified!.email, name: verified!.email }, user: verified!, trigger: "signIn" } as never))!;
  const cookie = await encode({ token, secret: requireEnv("AUTH_SECRET"), salt: SESSION_COOKIE });
  return { token, cookie };
}

/** The real Node session read: what every server-side `auth()` returns for this cookie. */
async function readSession(cookie: string): Promise<{ user?: { id?: string }; activeOrganizationId?: string | null } | null> {
  const response = await handlers.GET(
    new NextRequest("http://localhost:3000/api/auth/session", { headers: { cookie: `${SESSION_COOKIE}=${cookie}`, host: "localhost:3000", "x-forwarded-proto": "http" } }),
  );
  const body = (await response.json()) as { user?: { id?: string }; activeOrganizationId?: string | null } | null;
  return body && body.user ? body : null;
}

async function gate(session: unknown) {
  currentSession = session;
  try {
    return { context: await requireTenantContext(["ADMIN", "DIRECTOR", "INSTRUCTOR"]) };
  } catch (error) {
    const digest = (error as { digest?: string }).digest;
    if (!digest?.startsWith("NEXT_REDIRECT")) throw error;
    return { redirect: digest.split(";")[2] };
  }
}

afterAll(async () => {
  currentSession = null;
  await prisma.auditLog.deleteMany({ where: { organizationId: { in: orgIds } } });
  await prisma.staffAssignment.deleteMany({ where: { organizationId: { in: orgIds } } });
  await prisma.organizationMembership.deleteMany({ where: { organizationId: { in: orgIds } } });
  await prisma.user.updateMany({ where: { id: { in: userIds } }, data: { lastActiveOrganizationId: null } });
  await prisma.academy.deleteMany({ where: { organizationId: { in: orgIds } } });
  await prisma.organization.deleteMany({ where: { id: { in: orgIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
});

describe("remove from academy — the real session of someone in two academies", () => {
  it("REQUIRED: the existing session loses the removed academy on its next request; the other academy is intact; signing back in reaches it", async () => {
    const academyA = await newAcademyOrg("a");
    const academyB = await newAcademyOrg("b");
    const owner = await newUser("owner-a", "ADMIN");
    await staffIn(academyA, owner.id, "ADMIN");
    const coach = await newUser("coach", "INSTRUCTOR");
    const inA = await staffIn(academyA, coach.id, "INSTRUCTOR");
    const inB = await staffIn(academyB, coach.id, "INSTRUCTOR");
    // Two active memberships: sign-in uses the remembered choice, so the session points at A.
    await prisma.user.update({ where: { id: coach.id }, data: { lastActiveOrganizationId: academyA.organizationId } });

    // 1. A real session, currently in academy A.
    const first = await signIn(coach.email);
    expect(first.token.activeOrganizationId).toBe(academyA.organizationId);
    const before = await readSession(first.cookie);
    expect(before?.activeOrganizationId).toBe(academyA.organizationId);
    expect(await gate(before)).toMatchObject({ context: { organizationId: academyA.organizationId, organizationRole: "INSTRUCTOR" } });
    const bBefore = {
      membership: await prisma.organizationMembership.findUniqueOrThrow({ where: { id: inB.id } }),
      assignments: await prisma.staffAssignment.findMany({ where: { userId: coach.id, organizationId: academyB.organizationId }, orderBy: { id: "asc" } }),
    };

    // 2. The Owner of A deactivates, then removes them — through the service, as the action does.
    const ownerCtx = await requireOrganizationAccess(owner.id, academyA.organizationId);
    expect(await setMembershipActive(ownerCtx, inA.id, false)).toEqual({ ok: true });
    expect(await removeStaffMembership(ownerCtx, inA.id)).toEqual({ ok: true });

    // 3. The SAME cookie, next request: the session itself is still valid (removal does not end sessions) and still
    //    points at A, but the gate re-checks membership and refuses A.
    const after = await readSession(first.cookie);
    expect(after?.user?.id).toBe(coach.id);
    expect(after?.activeOrganizationId).toBe(academyA.organizationId);
    currentSession = after;
    expect(await getTenantContext()).toEqual({ status: "NO_MEMBERSHIP" });
    // CURRENT behaviour, recorded: they are sent to "no organization access" although they still belong to B.
    // (Tracked separately: the academy picker / the remaining academy would be the better destination.)
    expect(await gate(after)).toEqual({ redirect: "/en/no-organization-access" });

    // 4. Academy B untouched: same membership row and assignments, and access there works.
    expect(await prisma.organizationMembership.findUniqueOrThrow({ where: { id: inB.id } })).toEqual(bBefore.membership);
    expect(await prisma.staffAssignment.findMany({ where: { userId: coach.id, organizationId: academyB.organizationId }, orderBy: { id: "asc" } })).toEqual(bBefore.assignments);
    await expect(requireOrganizationAccess(coach.id, academyB.organizationId)).resolves.toMatchObject({ organizationRole: "INSTRUCTOR" });
    expect((await prisma.user.findUniqueOrThrow({ where: { id: coach.id } })).lastActiveOrganizationId).toBeNull();

    // 5. Signing back in (same password) resolves to B — the only academy left — and the gate admits them there.
    const second = await signIn(coach.email);
    expect(second.token.activeOrganizationId).toBe(academyB.organizationId);
    const fresh = await readSession(second.cookie);
    expect(fresh?.activeOrganizationId).toBe(academyB.organizationId);
    expect(await gate(fresh)).toMatchObject({ context: { organizationId: academyB.organizationId, organizationRole: "INSTRUCTOR" } });
    expect((await prisma.user.findUniqueOrThrow({ where: { id: coach.id } })).lastActiveOrganizationId).toBe(academyB.organizationId);
  });
});
