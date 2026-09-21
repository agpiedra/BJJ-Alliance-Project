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
const { suspendOrganizationAction, reactivateOrganizationAction } = await import(
  "../../src/app/[locale]/platform/organizations/actions"
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
const SUPER_ADMIN_USER_ID = "seed-user-super-admin";

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
  it("fails closed to UNAUTHENTICATED (not NO_MEMBERSHIP) when there is no session at all — the two are different facts and must not be conflated", async () => {
    currentSession = null;
    expect(await getTenantContext()).toEqual({ status: "UNAUTHENTICATED" });
  });

  it("self-heals to OK by auto-resolving the sole active membership when a signed-in session has no activeOrganizationId selector", async () => {
    // DIRECTOR_USER_ID has exactly one active membership (the seeded
    // Alliance org) throughout this file — unlike ADMIN_USER_ID, which this
    // file's beforeAll deliberately gives a second membership to exercise
    // the 2+ case below. This proves a session issued before sign-in
    // resolved a selector (or any other request that reaches here with a
    // null one) recovers on its very next call, per Appendix C decision 4
    // point 6: the exactly-one-membership case is not "picking arbitrarily."
    const orgId = await getAllianceOrganizationId();
    currentSession = { user: { id: DIRECTOR_USER_ID }, activeOrganizationId: null };
    const result = await getTenantContext();
    expect(result).toEqual({
      status: "OK",
      context: expect.objectContaining({ actorUserId: DIRECTOR_USER_ID, organizationId: orgId }),
    });
  });

  it("returns NEEDS_ORGANIZATION_SELECTION (never an arbitrary pick) when a signed-in session has no selector and the user has 2+ active memberships with no valid persisted choice", async () => {
    // ADMIN_USER_ID has two active memberships in this file (Alliance +
    // SCRATCH_ORG_ID, added in beforeAll) and no lastActiveOrganizationId
    // set — the picker case, not NO_MEMBERSHIP and not a silent default.
    currentSession = { user: { id: ADMIN_USER_ID }, activeOrganizationId: null };
    expect(await getTenantContext()).toEqual({ status: "NEEDS_ORGANIZATION_SELECTION" });
  });

  it("fails closed to NO_MEMBERSHIP for a user with no membership in the selected organization", async () => {
    const orgId = await getAllianceOrganizationId();
    currentSession = { user: { id: "not-a-real-user" }, activeOrganizationId: orgId };
    expect(await getTenantContext()).toEqual({ status: "NO_MEMBERSHIP" });
  });

  it("returns NO_MEMBERSHIP for a genuinely signed-in user with zero active memberships anywhere — a real state, never rendered as unauthenticated", async () => {
    const orphanUser = await prisma.user.create({
      data: {
        email: `tenant-context-orphan-${Date.now()}@example.com`,
        passwordHash: "irrelevant",
        role: "STUDENT",
      },
    });
    try {
      currentSession = { user: { id: orphanUser.id }, activeOrganizationId: null };
      expect(await getTenantContext()).toEqual({ status: "NO_MEMBERSHIP" });
    } finally {
      await prisma.user.delete({ where: { id: orphanUser.id } });
    }
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
        linkedStudentId: null, // the seeded Owner has no student record of their own
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

  it("REQUIRED: linkedStudentId is SEPARATE from selfStudentId — a coach with an ACTIVE student record of their own has a portal (linkedStudentId) yet is not narrowed to self (selfStudentId null), and an ARCHIVED record gives no portal", async () => {
    const orgId = await getAllianceOrganizationId();
    const id = "tenant-context-test-director-linked-student";
    const created = await prisma.student.create({
      data: {
        id,
        userId: DIRECTOR_USER_ID,
        organizationId: orgId,
        homeAcademyId: ESCAZU_ID,
        firstName: "Director",
        lastName: "Trains",
        phone: "0000-0000",
        email: "director-trains@tenant-context-test.example",
        codeHash: "tenant-context-test-director-linked-student-codehash",
        currentRankId: adultRankId("WHITE"),
        status: "ACTIVE",
      },
    });
    try {
      currentSession = { user: { id: DIRECTOR_USER_ID }, activeOrganizationId: orgId };
      const active = await getTenantContext();
      if (active.status !== "OK") throw new Error("unreachable");
      expect(active.context.organizationRole).toBe("DIRECTOR");
      expect(active.context.selfStudentId).toBeNull(); // roster scoping is unchanged
      expect(active.context.linkedStudentId).toBe(created.id);

      await prisma.student.update({ where: { id }, data: { status: "ARCHIVED" } });
      const archived = await getTenantContext();
      if (archived.status !== "OK") throw new Error("unreachable");
      expect(archived.context.linkedStudentId).toBeNull();
    } finally {
      await prisma.student.delete({ where: { id } });
    }
  });

  it("a pure student's linkedStudentId is their own active record, and an Owner with no student record has none", async () => {
    const orgId = await getAllianceOrganizationId();
    currentSession = { user: { id: STUDENT_LOGIN_USER_ID }, activeOrganizationId: orgId };
    const student = await getTenantContext();
    if (student.status !== "OK") throw new Error("unreachable");
    expect(student.context.linkedStudentId).toBe(QA_STUDENT_RECORD_ID);

    currentSession = { user: { id: ADMIN_USER_ID }, activeOrganizationId: orgId };
    const owner = await getTenantContext();
    if (owner.status !== "OK") throw new Error("unreachable");
    expect(owner.context.linkedStudentId).toBeNull();
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

  it("REQUIRED: MULTI_ACADEMY_AND_KIDS_BELTS.md Phase 6 — suspendOrganizationAction (the panel's own action, not a direct DB write) locks out an ADMIN's already-open session on their very next request, and reactivateOrganizationAction restores it. This is deliberately a different claim from the test above: that one proves the guard re-validates; this one proves the panel's action is what actually flips the switch the guard reads.", async () => {
    currentSession = { user: { id: ADMIN_USER_ID }, activeOrganizationId: SCRATCH_ORG_ID };
    expect(await getTenantContext()).toEqual({
      status: "OK",
      context: expect.objectContaining({ organizationId: SCRATCH_ORG_ID }),
    });

    // Switch to the platform admin's own session to call the real action —
    // exactly what a browser tab open on /platform/organizations would do,
    // not a test helper reaching around it into the database directly.
    currentSession = { user: { id: SUPER_ADMIN_USER_ID }, activeOrganizationId: null };
    const suspendResult = await suspendOrganizationAction(SCRATCH_ORG_ID);
    expect(suspendResult.ok).toBe(true);

    try {
      // The ADMIN's session cookie is completely unchanged — same JWT, same
      // organizationId — yet their very next request is now refused.
      currentSession = { user: { id: ADMIN_USER_ID }, activeOrganizationId: SCRATCH_ORG_ID };
      expect(await getTenantContext()).toEqual({ status: "ORG_NOT_ACTIVE", organizationStatus: "SUSPENDED" });

      currentSession = { user: { id: SUPER_ADMIN_USER_ID }, activeOrganizationId: null };
      const reactivateResult = await reactivateOrganizationAction(SCRATCH_ORG_ID);
      expect(reactivateResult.ok).toBe(true);

      currentSession = { user: { id: ADMIN_USER_ID }, activeOrganizationId: SCRATCH_ORG_ID };
      expect(await getTenantContext()).toEqual({
        status: "OK",
        context: expect.objectContaining({ organizationId: SCRATCH_ORG_ID }),
      });
    } finally {
      await prisma.organization.update({ where: { id: SCRATCH_ORG_ID }, data: { status: "ACTIVE" } });
    }
  });

  it("REQUIRED REGRESSION: returns NO_MEMBERSHIP (not OK) for a deactivated user, even with a real membership row and an unexpired JWT session — revision 23, resolveContext() must check User.active on every call, same as the deleted getStaffSession() used to", async () => {
    const orgId = await getAllianceOrganizationId();
    currentSession = { user: { id: DIRECTOR_USER_ID }, activeOrganizationId: orgId };
    expect(await getTenantContext()).toEqual({
      status: "OK",
      context: expect.objectContaining({ actorUserId: DIRECTOR_USER_ID, organizationId: orgId }),
    });

    // Deactivated after "login" — the JWT is unchanged and the membership
    // row is untouched, but the very next call must fail closed.
    await prisma.user.update({ where: { id: DIRECTOR_USER_ID }, data: { active: false } });
    try {
      expect(await getTenantContext()).toEqual({ status: "NO_MEMBERSHIP" });
    } finally {
      await prisma.user.update({ where: { id: DIRECTOR_USER_ID }, data: { active: true } });
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
