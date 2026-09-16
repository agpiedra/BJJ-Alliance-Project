import "dotenv/config";
import { getTestPrismaClient } from "../helpers/test-db";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { adultRankId } from "../helpers/belt-ranks";

type MockSession = { user: { id: string } | null; activeOrganizationId: string | null } | null;
let currentSession: MockSession = null;

// Same pattern as admin-schedule-actions.test.ts's `auth()` mock —
// `getTenantContext`/`requireOrganizationAccess` call next-auth's `auth()`,
// which needs a real HTTP request's cookies to resolve a JWT session,
// unavailable in a plain integration test.
vi.mock("@/auth", () => ({
  auth: () => Promise.resolve(currentSession),
  unstable_update: vi.fn(),
}));

const { getTenantContext, requireOrganizationAccess, resolveSystemJobContext, TenantAccessError } = await import(
  "../../src/lib/tenant/context"
);

const prisma = getTestPrismaClient();

const ADMIN_USER_ID = "seed-user-admin";
const DIRECTOR_USER_ID = "seed-user-director";
const INSTRUCTOR_USER_ID = "seed-user-instructor";
const STUDENT_LOGIN_USER_ID = "seed-user-student";
const QA_STUDENT_RECORD_ID = "seed-student-qa-prueba";
const ESCAZU_ID = "seed-academy-escazu";

let allianceOrgIdPromise: Promise<string> | null = null;
function getAllianceOrganizationId() {
  allianceOrgIdPromise ??= prisma.organization
    .findUniqueOrThrow({ where: { slug: "alliance-cr" } })
    .then((o) => o.id);
  return allianceOrgIdPromise;
}

// A second, throwaway organization this file owns end-to-end — needed to
// prove org-status gating and the "two tabs, two organizations" requirement,
// neither of which the single seeded Alliance org can exercise on its own.
// ADMIN_USER_ID gets a second membership here; nothing else in the suite
// counts memberships globally, so this is safe alongside concurrent files.
const SCRATCH_ORG_ID = "tenant-context-test-scratch-org";

beforeAll(async () => {
  await prisma.organization.upsert({
    where: { id: SCRATCH_ORG_ID },
    update: { status: "ACTIVE" },
    create: { id: SCRATCH_ORG_ID, slug: "tenant-context-test-scratch-org", name: "Scratch Org", status: "ACTIVE" },
  });
  await prisma.organizationMembership.upsert({
    where: { userId_organizationId: { userId: ADMIN_USER_ID, organizationId: SCRATCH_ORG_ID } },
    update: { role: "ADMIN" },
    create: { userId: ADMIN_USER_ID, organizationId: SCRATCH_ORG_ID, role: "ADMIN" },
  });
});

afterAll(async () => {
  await prisma.organizationMembership.deleteMany({ where: { organizationId: SCRATCH_ORG_ID } });
  await prisma.organization.delete({ where: { id: SCRATCH_ORG_ID } });
});

afterEach(() => {
  currentSession = null;
});

describe("getTenantContext", () => {
  it("fails closed to NO_MEMBERSHIP when there is no session at all", async () => {
    currentSession = null;
    expect(await getTenantContext()).toEqual({ status: "NO_MEMBERSHIP" });
  });

  it("fails closed to NO_MEMBERSHIP when the session has no activeOrganizationId selector", async () => {
    currentSession = { user: { id: ADMIN_USER_ID }, activeOrganizationId: null };
    expect(await getTenantContext()).toEqual({ status: "NO_MEMBERSHIP" });
  });

  it("fails closed to NO_MEMBERSHIP for a user with no membership in the selected organization", async () => {
    const orgId = await getAllianceOrganizationId();
    currentSession = { user: { id: "not-a-real-user" }, activeOrganizationId: orgId };
    expect(await getTenantContext()).toEqual({ status: "NO_MEMBERSHIP" });
  });

  it("resolves ADMIN with academyIds: ALL and no selfStudentId", async () => {
    const orgId = await getAllianceOrganizationId();
    currentSession = { user: { id: ADMIN_USER_ID }, activeOrganizationId: orgId };
    const result = await getTenantContext();
    expect(result).toEqual({
      status: "OK",
      context: {
        kind: "tenant",
        actorUserId: ADMIN_USER_ID,
        organizationId: orgId,
        organizationRole: "ADMIN",
        academyIds: "ALL",
        selfStudentId: null,
      },
    });
  });

  it("resolves an INSTRUCTOR scoped to exactly their assigned academy, not ALL", async () => {
    const orgId = await getAllianceOrganizationId();
    currentSession = { user: { id: INSTRUCTOR_USER_ID }, activeOrganizationId: orgId };
    const result = await getTenantContext();
    expect(result.status).toBe("OK");
    if (result.status !== "OK") throw new Error("unreachable");
    expect(result.context.organizationRole).toBe("INSTRUCTOR");
    expect(result.context.academyIds).toEqual([ESCAZU_ID]);
    expect(result.context.selfStudentId).toBeNull();
  });

  it("resolves a STUDENT's own selfStudentId, gated on ROLE not on Student-row existence", async () => {
    const orgId = await getAllianceOrganizationId();
    currentSession = { user: { id: STUDENT_LOGIN_USER_ID }, activeOrganizationId: orgId };
    const result = await getTenantContext();
    expect(result.status).toBe("OK");
    if (result.status !== "OK") throw new Error("unreachable");
    expect(result.context.organizationRole).toBe("STUDENT");
    expect(result.context.selfStudentId).toBe(QA_STUDENT_RECORD_ID);
  });

  it("REQUIRED REGRESSION: a DIRECTOR who also has a linked Student record (staff train too) still sees the full roster, not narrowed to self", async () => {
    const orgId = await getAllianceOrganizationId();
    // DIRECTOR_USER_ID has no Student row in the seed — attach one
    // temporarily to prove selfStudentId gates on organizationRole, not on
    // "a Student row exists for this userId" (the bug this test guards
    // against: a staff member training under their own account must not be
    // narrowed to a single-row self view).
    await prisma.student.create({
      data: {
        id: "tenant-context-test-director-self-student",
        userId: DIRECTOR_USER_ID,
        organizationId: orgId,
        homeAcademyId: ESCAZU_ID,
        firstName: "Director",
        lastName: "AlsoTrains",
        phone: "0000-0000",
        email: "director-also-trains@tenant-context-test.example",
        codeHash: "tenant-context-test-director-self-student-codehash",
        currentRankId: adultRankId("WHITE"),
        status: "ARCHIVED", // excluded from every ACTIVE roster/count elsewhere
      },
    });
    try {
      currentSession = { user: { id: DIRECTOR_USER_ID }, activeOrganizationId: orgId };
      const result = await getTenantContext();
      expect(result.status).toBe("OK");
      if (result.status !== "OK") throw new Error("unreachable");
      expect(result.context.organizationRole).toBe("DIRECTOR");
      expect(result.context.selfStudentId).toBeNull();
      expect(result.context.academyIds).toEqual([ESCAZU_ID]);
    } finally {
      await prisma.student.delete({ where: { id: "tenant-context-test-director-self-student" } });
    }
  });

  it("returns ORG_NOT_ACTIVE (not NO_MEMBERSHIP) when the organization is suspended — proposal point 7, revocation takes effect on the very next call", async () => {
    currentSession = { user: { id: ADMIN_USER_ID }, activeOrganizationId: SCRATCH_ORG_ID };
    expect(await getTenantContext()).toEqual({
      status: "OK",
      context: expect.objectContaining({ organizationId: SCRATCH_ORG_ID }),
    });

    await prisma.organization.update({ where: { id: SCRATCH_ORG_ID }, data: { status: "SUSPENDED" } });
    try {
      expect(await getTenantContext()).toEqual({ status: "ORG_NOT_ACTIVE", organizationStatus: "SUSPENDED" });
    } finally {
      await prisma.organization.update({ where: { id: SCRATCH_ORG_ID }, data: { status: "ACTIVE" } });
    }
  });
});

describe("requireOrganizationAccess", () => {
  it("resolves a TenantContext for a valid membership + role, independent of any ambient session selector", async () => {
    const orgId = await getAllianceOrganizationId();
    // Simulates the "two tabs, two organizations" scenario (proposal point
    // 2): the ambient session selector points at Alliance, but this call
    // explicitly names the scratch org — it must resolve against what it was
    // TOLD, never the ambient selector.
    currentSession = { user: { id: ADMIN_USER_ID }, activeOrganizationId: orgId };
    const context = await requireOrganizationAccess(ADMIN_USER_ID, SCRATCH_ORG_ID);
    expect(context.organizationId).toBe(SCRATCH_ORG_ID);
    expect(context.organizationRole).toBe("ADMIN");
  });

  it("throws TenantAccessError(NO_MEMBERSHIP) for a user with no membership in the named organization", async () => {
    const orgId = await getAllianceOrganizationId();
    await expect(requireOrganizationAccess("not-a-real-user", orgId)).rejects.toThrow(TenantAccessError);
  });

  it("throws TenantAccessError(ORG_NOT_ACTIVE) for a suspended organization", async () => {
    await prisma.organization.update({ where: { id: SCRATCH_ORG_ID }, data: { status: "SUSPENDED" } });
    try {
      await expect(requireOrganizationAccess(ADMIN_USER_ID, SCRATCH_ORG_ID)).rejects.toThrow(TenantAccessError);
    } finally {
      await prisma.organization.update({ where: { id: SCRATCH_ORG_ID }, data: { status: "ACTIVE" } });
    }
  });

  it("throws FORBIDDEN when the resolved role is not in allowedRoles", async () => {
    const orgId = await getAllianceOrganizationId();
    await expect(requireOrganizationAccess(INSTRUCTOR_USER_ID, orgId, ["ADMIN", "DIRECTOR"])).rejects.toThrow(
      "FORBIDDEN",
    );
  });
});

describe("resolveSystemJobContext", () => {
  it("resolves a SystemJobContext for an ACTIVE organization", async () => {
    const orgId = await getAllianceOrganizationId();
    const context = await resolveSystemJobContext(orgId, "weekly-digest");
    expect(context).toEqual({ kind: "system-job", organizationId: orgId, jobName: "weekly-digest" });
  });

  it("returns null (skip) for a non-active organization, per spec: 'Skip non-active organizations'", async () => {
    await prisma.organization.update({ where: { id: SCRATCH_ORG_ID }, data: { status: "SUSPENDED" } });
    try {
      expect(await resolveSystemJobContext(SCRATCH_ORG_ID, "weekly-digest")).toBeNull();
    } finally {
      await prisma.organization.update({ where: { id: SCRATCH_ORG_ID }, data: { status: "ACTIVE" } });
    }
  });

  it("returns null for a nonexistent organization", async () => {
    expect(await resolveSystemJobContext("no-such-org", "weekly-digest")).toBeNull();
  });
});
