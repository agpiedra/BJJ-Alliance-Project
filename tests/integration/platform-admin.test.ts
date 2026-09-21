import "dotenv/config";
import { getTestPrismaClient } from "../helpers/test-db";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { hashSecret } from "../../src/lib/crypto";

const sendTransactionalEmailMock = vi.fn(async (_to: string, _subject: string, _bodyLines: string[]) => ({ success: true }));
vi.mock("@/lib/email/send-transactional-email", () => ({
  sendTransactionalEmail: (...args: [string, string, string[]]) => sendTransactionalEmailMock(...args),
}));

let currentSession: { user: { id: string } } | null = null;
vi.mock("@/auth", () => ({
  auth: () => Promise.resolve(currentSession),
}));

const { approveOrganization } = await import("../../src/lib/organizations/approve-organization");
const {
  approveOrganizationAction,
  rejectOrganizationAction,
  suspendOrganizationAction,
  reactivateOrganizationAction,
  cancelOrganizationAction,
} = await import("../../src/app/[locale]/platform/organizations/actions");
const { createOrganizationManually } = await import("../../src/app/[locale]/platform/organizations/new/actions");
const { grantSuperAdmin, revokeSuperAdmin } = await import("../../src/app/[locale]/platform/admins/actions");
const { requireSuperAdmin, resolveSuperAdminActionContext } = await import("../../src/lib/auth/require-super-admin");
const { resolveOrganizationAuditTrail } = await import("../../src/lib/tenant/platform-lookups");

const prisma = getTestPrismaClient();

const cleanupOrgIds: string[] = [];
const cleanupUserIds: string[] = [];

async function cleanup() {
  if (cleanupOrgIds.length > 0) {
    await prisma.auditLog.deleteMany({ where: { organizationId: { in: cleanupOrgIds } } });
    await prisma.invitation.deleteMany({ where: { organizationId: { in: cleanupOrgIds } } });
    await prisma.organizationMembership.deleteMany({ where: { organizationId: { in: cleanupOrgIds } } });
    await prisma.promotionConfig.deleteMany({ where: { organizationId: { in: cleanupOrgIds } } });
    await prisma.beltRank.deleteMany({ where: { organizationId: { in: cleanupOrgIds } } });
    await prisma.organizationBranding.deleteMany({ where: { organizationId: { in: cleanupOrgIds } } });
    await prisma.paymentPlan.deleteMany({ where: { organizationId: { in: cleanupOrgIds } } }); // approval seeds a default plan
    await prisma.academy.deleteMany({ where: { organizationId: { in: cleanupOrgIds } } });
    await prisma.organization.deleteMany({ where: { id: { in: cleanupOrgIds } } });
  }
  if (cleanupUserIds.length > 0) {
    await prisma.auditLog.deleteMany({ where: { entityId: { in: cleanupUserIds } } });
    await prisma.user.deleteMany({ where: { id: { in: cleanupUserIds } } });
  }
}

function uniqueSuffix(): string {
  return `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
}

async function makePendingOrganization(overrides: Partial<{ contactEmail: string; city: string }> = {}) {
  const suffix = uniqueSuffix();
  const org = await prisma.organization.create({
    data: {
      slug: `platform-admin-test-${suffix}`,
      name: `Platform Admin Test ${suffix}`,
      status: "PENDING",
      city: overrides.city ?? "Test City",
      country: "Costa Rica",
      contactEmail: overrides.contactEmail ?? `director-${suffix}@example.com`,
    },
  });
  cleanupOrgIds.push(org.id);
  return org;
}

async function makeActiveOrganization() {
  const org = await makePendingOrganization();
  const approver = await makeSuperAdmin();
  await approveOrganization(org.slug, approver.id);
  return prisma.organization.findUniqueOrThrow({ where: { id: org.id } });
}

async function makeSuperAdmin() {
  const suffix = uniqueSuffix();
  const user = await prisma.user.create({
    data: {
      email: `platform-super-${suffix}@example.com`,
      passwordHash: await hashSecret("irrelevant-password-123"),
      role: "ADMIN",
      isSuperAdmin: true,
    },
  });
  cleanupUserIds.push(user.id);
  return user;
}

async function makeOrgAdmin() {
  const suffix = uniqueSuffix();
  const user = await prisma.user.create({
    data: {
      email: `platform-org-admin-${suffix}@example.com`,
      passwordHash: await hashSecret("irrelevant-password-123"),
      role: "ADMIN",
      isSuperAdmin: false,
    },
  });
  cleanupUserIds.push(user.id);
  return user;
}

describe("MULTI_ACADEMY_AND_KIDS_BELTS.md Phase 6 — requireSuperAdmin / resolveSuperAdminActionContext", () => {
  afterAll(cleanup);
  afterEach(() => {
    currentSession = null;
  });

  it("REQUIRED REGRESSION: an org ADMIN (isSuperAdmin: false) is refused — the one privilege that crosses tenant boundaries by design must fail closed for everyone who isn't explicitly granted it", async () => {
    const orgAdmin = await makeOrgAdmin();
    currentSession = { user: { id: orgAdmin.id } };

    const result = await resolveSuperAdminActionContext();
    expect(result.ok).toBe(false);
  });

  it("an unauthenticated caller (no session) is refused", async () => {
    currentSession = null;
    const result = await resolveSuperAdminActionContext();
    expect(result.ok).toBe(false);
  });

  it("a real SUPER_ADMIN succeeds", async () => {
    const superAdmin = await makeSuperAdmin();
    currentSession = { user: { id: superAdmin.id } };

    const result = await resolveSuperAdminActionContext();
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.context.actorUserId).toBe(superAdmin.id);
  });

  it("REQUIRED: revoking isSuperAdmin takes effect on the very next call — never cached, matching Organization.status's own re-validation", async () => {
    const superAdmin = await makeSuperAdmin();
    currentSession = { user: { id: superAdmin.id } };

    expect((await resolveSuperAdminActionContext()).ok).toBe(true);

    await prisma.user.update({ where: { id: superAdmin.id }, data: { isSuperAdmin: false } });

    expect((await resolveSuperAdminActionContext()).ok).toBe(false);
  });

  it("requireSuperAdmin() refuses with a real notFound() digest, not a thrown FORBIDDEN error — the mechanism the smoke suite's real HTTP 404 assertion depends on", async () => {
    const orgAdmin = await makeOrgAdmin();
    currentSession = { user: { id: orgAdmin.id } };

    try {
      await requireSuperAdmin();
      throw new Error("expected requireSuperAdmin() to throw");
    } catch (error) {
      const digest = (error as { digest?: string }).digest;
      expect(digest).toContain("404");
    }
  });
});

describe("MULTI_ACADEMY_AND_KIDS_BELTS.md Phase 6 — approve: panel action vs CLI script share one function", () => {
  afterAll(cleanup);
  afterEach(() => {
    currentSession = null;
    sendTransactionalEmailMock.mockClear();
  });

  it("REQUIRED: the panel's approve action and a direct approveOrganization() call (what the CLI script does) produce identical results from identical starting states", async () => {
    const superAdmin = await makeSuperAdmin();
    currentSession = { user: { id: superAdmin.id } };

    const scriptOrg = await makePendingOrganization();
    const panelOrg = await makePendingOrganization();

    // "Script path" — exactly what scripts/approve-organization.ts does.
    await approveOrganization(scriptOrg.slug, superAdmin.id);
    // "Panel path" — exactly what approveOrganizationAction does: id -> slug lookup, then the SAME function.
    const panelResult = await approveOrganizationAction(panelOrg.id);
    expect(panelResult.ok).toBe(true);

    const [scriptUpdated, panelUpdated] = await Promise.all([
      prisma.organization.findUniqueOrThrow({ where: { id: scriptOrg.id } }),
      prisma.organization.findUniqueOrThrow({ where: { id: panelOrg.id } }),
    ]);
    expect(panelUpdated.status).toBe(scriptUpdated.status);
    expect(panelUpdated.status).toBe("ACTIVE");

    const [scriptAcademyCount, panelAcademyCount] = await Promise.all([
      prisma.academy.count({ where: { organizationId: scriptOrg.id } }),
      prisma.academy.count({ where: { organizationId: panelOrg.id } }),
    ]);
    expect(panelAcademyCount).toBe(scriptAcademyCount);
    expect(panelAcademyCount).toBe(1);

    const [scriptInvitations, panelInvitations] = await Promise.all([
      prisma.invitation.count({ where: { organizationId: scriptOrg.id, usedAt: null } }),
      prisma.invitation.count({ where: { organizationId: panelOrg.id, usedAt: null } }),
    ]);
    expect(panelInvitations).toBe(scriptInvitations);
    expect(panelInvitations).toBe(1);

    // Both paths produce the exact same audit action, since both call the
    // same shared approveOrganization() — this is the actual point of the test.
    const [scriptAudit, panelAudit] = await Promise.all([
      prisma.auditLog.findFirst({ where: { organizationId: scriptOrg.id, action: "organization.approve" } }),
      prisma.auditLog.findFirst({ where: { organizationId: panelOrg.id, action: "organization.approve" } }),
    ]);
    expect(panelAudit?.action).toBe(scriptAudit?.action);
    expect(panelAudit?.before).toEqual(scriptAudit?.before);
    expect(panelAudit?.after).toEqual(scriptAudit?.after);

    // Cleanup the directors both paths created.
    const [scriptDirector, panelDirector] = await Promise.all([
      prisma.user.findUnique({ where: { email: scriptOrg.contactEmail! } }),
      prisma.user.findUnique({ where: { email: panelOrg.contactEmail! } }),
    ]);
    if (scriptDirector) cleanupUserIds.push(scriptDirector.id);
    if (panelDirector) cleanupUserIds.push(panelDirector.id);
  });

  it("the panel's approve action is refused for a non-super-admin, and the organization is untouched", async () => {
    const orgAdmin = await makeOrgAdmin();
    currentSession = { user: { id: orgAdmin.id } };
    const org = await makePendingOrganization();

    const result = await approveOrganizationAction(org.id);
    expect(result.error).toBe("notFound");

    const unchanged = await prisma.organization.findUniqueOrThrow({ where: { id: org.id } });
    expect(unchanged.status).toBe("PENDING");
  });
});

describe("MULTI_ACADEMY_AND_KIDS_BELTS.md Phase 6 — reject / suspend / reactivate / cancel", () => {
  afterAll(cleanup);
  afterEach(() => {
    currentSession = null;
  });

  it("reject: PENDING -> CANCELLED with the note stored on internalNotes, audited", async () => {
    const superAdmin = await makeSuperAdmin();
    currentSession = { user: { id: superAdmin.id } };
    const org = await makePendingOrganization();

    const result = await rejectOrganizationAction(org.id, "Duplicate of an existing academy.");
    expect(result.ok).toBe(true);

    const updated = await prisma.organization.findUniqueOrThrow({ where: { id: org.id } });
    expect(updated.status).toBe("CANCELLED");
    expect(updated.internalNotes).toBe("Duplicate of an existing academy.");

    const audit = await prisma.auditLog.findFirstOrThrow({ where: { organizationId: org.id, action: "organization.reject" } });
    expect(audit.actorId).toBe(superAdmin.id);
  });

  it("reject requires a non-empty note", async () => {
    const superAdmin = await makeSuperAdmin();
    currentSession = { user: { id: superAdmin.id } };
    const org = await makePendingOrganization();

    const result = await rejectOrganizationAction(org.id, "   ");
    expect(result.error).toBe("noteRequired");

    const unchanged = await prisma.organization.findUniqueOrThrow({ where: { id: org.id } });
    expect(unchanged.status).toBe("PENDING");
  });

  it("suspend then reactivate: ACTIVE -> SUSPENDED -> ACTIVE, each audited", async () => {
    const superAdmin = await makeSuperAdmin();
    currentSession = { user: { id: superAdmin.id } };
    const org = await makeActiveOrganization();
    const director = await prisma.user.findUnique({ where: { email: org.contactEmail! } });
    if (director) cleanupUserIds.push(director.id);

    const suspendResult = await suspendOrganizationAction(org.id);
    expect(suspendResult.ok).toBe(true);
    expect((await prisma.organization.findUniqueOrThrow({ where: { id: org.id } })).status).toBe("SUSPENDED");

    const reactivateResult = await reactivateOrganizationAction(org.id);
    expect(reactivateResult.ok).toBe(true);
    expect((await prisma.organization.findUniqueOrThrow({ where: { id: org.id } })).status).toBe("ACTIVE");

    const audits = await prisma.auditLog.findMany({
      where: { organizationId: org.id, action: { in: ["organization.suspend", "organization.reactivate"] } },
    });
    expect(audits).toHaveLength(2);
  });

  it("reactivate refuses a non-SUSPENDED organization", async () => {
    const superAdmin = await makeSuperAdmin();
    currentSession = { user: { id: superAdmin.id } };
    const org = await makeActiveOrganization();
    const director = await prisma.user.findUnique({ where: { email: org.contactEmail! } });
    if (director) cleanupUserIds.push(director.id);

    const result = await reactivateOrganizationAction(org.id);
    expect(result.error).toBe("notSuspended");
  });

  it("cancel: ACTIVE -> CANCELLED with a note, never reversible through this action", async () => {
    const superAdmin = await makeSuperAdmin();
    currentSession = { user: { id: superAdmin.id } };
    const org = await makeActiveOrganization();
    const director = await prisma.user.findUnique({ where: { email: org.contactEmail! } });
    if (director) cleanupUserIds.push(director.id);

    const result = await cancelOrganizationAction(org.id, "Academy closed permanently.");
    expect(result.ok).toBe(true);

    const updated = await prisma.organization.findUniqueOrThrow({ where: { id: org.id } });
    expect(updated.status).toBe("CANCELLED");
    expect(updated.internalNotes).toBe("Academy closed permanently.");

    const secondAttempt = await cancelOrganizationAction(org.id, "Trying again.");
    expect(secondAttempt.error).toBe("notCancellable");
  });
});

describe("MULTI_ACADEMY_AND_KIDS_BELTS.md Phase 6 — manual organization creation", () => {
  afterAll(cleanup);
  afterEach(() => {
    currentSession = null;
  });

  it("creates a fully working ACTIVE organization: ranks seeded, branch created, director invited — reusing the same approveOrganization() path", async () => {
    const superAdmin = await makeSuperAdmin();
    currentSession = { user: { id: superAdmin.id } };
    const suffix = uniqueSuffix();

    const fd = new FormData();
    fd.set("organizationName", `Manual Test ${suffix}`);
    fd.set("desiredSlug", `manual-test-${suffix}`);
    fd.set("country", "Costa Rica");
    fd.set("city", "Heredia");
    fd.set("directorEmail", `manual-director-${suffix}@example.com`);
    fd.set("contactName", "Manual Director");
    fd.set("contactPhone", "88880000");
    fd.set("studentCountBand", "1-25");
    fd.set("preferredLocale", "es");
    fd.set("promotionMode", "TIME");

    const result = await createOrganizationManually({}, fd);
    expect(result.ok).toBe(true);

    const org = await prisma.organization.findUniqueOrThrow({ where: { slug: `manual-test-${suffix}` } });
    cleanupOrgIds.push(org.id);
    expect(org.status).toBe("ACTIVE");

    const beltRankCount = await prisma.beltRank.count({ where: { organizationId: org.id } });
    expect(beltRankCount).toBe(18);

    const promotionConfigs = await prisma.promotionConfig.findMany({ where: { organizationId: org.id } });
    expect(promotionConfigs).toHaveLength(2);
    expect(promotionConfigs.every((c) => c.mode === "TIME")).toBe(true);

    const academyCount = await prisma.academy.count({ where: { organizationId: org.id } });
    expect(academyCount).toBe(1);

    const director = await prisma.user.findUniqueOrThrow({ where: { email: `manual-director-${suffix}@example.com` } });
    cleanupUserIds.push(director.id);
    expect(director.active).toBe(false); // not yet accepted the invitation, same as self-serve registration

    const invitationCount = await prisma.invitation.count({ where: { organizationId: org.id, usedAt: null } });
    expect(invitationCount).toBe(1);
  });

  it("rejects a crafted request with an unrecognized field, same z.strictObject standard as the public form", async () => {
    const superAdmin = await makeSuperAdmin();
    currentSession = { user: { id: superAdmin.id } };
    const suffix = uniqueSuffix();

    const fd = new FormData();
    fd.set("organizationName", `Manual Test ${suffix}`);
    fd.set("desiredSlug", `manual-test-${suffix}`);
    fd.set("country", "Costa Rica");
    fd.set("city", "Heredia");
    fd.set("directorEmail", `manual-director-${suffix}@example.com`);
    fd.set("contactName", "Manual Director");
    fd.set("contactPhone", "88880000");
    fd.set("studentCountBand", "1-25");
    fd.set("preferredLocale", "es");
    fd.set("promotionMode", "ATTENDANCE");
    fd.set("logo", "unexpected-field");

    const result = await createOrganizationManually({}, fd);
    expect(result.error).toBe("invalid");
    expect(await prisma.organization.findUnique({ where: { slug: `manual-test-${suffix}` } })).toBeNull();
  });
});

describe("MULTI_ACADEMY_AND_KIDS_BELTS.md Phase 6 — platform admin grant/revoke", () => {
  afterAll(cleanup);
  afterEach(() => {
    currentSession = null;
  });

  it("grants isSuperAdmin by email, audited with organizationId: null (a genuinely platform-level action)", async () => {
    const granter = await makeSuperAdmin();
    const target = await makeOrgAdmin();
    currentSession = { user: { id: granter.id } };

    const fd = new FormData();
    fd.set("email", target.email);
    const result = await grantSuperAdmin({}, fd);
    expect(result.ok).toBe(true);

    const updated = await prisma.user.findUniqueOrThrow({ where: { id: target.id } });
    expect(updated.isSuperAdmin).toBe(true);

    const audit = await prisma.auditLog.findFirstOrThrow({ where: { entityId: target.id, action: "user.superAdminGranted" } });
    expect(audit.organizationId).toBeNull();
  });

  it("revokes isSuperAdmin from another user", async () => {
    const revoker = await makeSuperAdmin();
    const target = await makeSuperAdmin();
    currentSession = { user: { id: revoker.id } };

    const result = await revokeSuperAdmin(target.id);
    expect(result.ok).toBe(true);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: target.id } })).isSuperAdmin).toBe(false);
  });

  it("REQUIRED: cannot revoke your own access, even mid-session", async () => {
    const superAdmin = await makeSuperAdmin();
    currentSession = { user: { id: superAdmin.id } };

    const result = await revokeSuperAdmin(superAdmin.id);
    expect(result.error).toBe("cannotRevokeSelf");
    expect((await prisma.user.findUniqueOrThrow({ where: { id: superAdmin.id } })).isSuperAdmin).toBe(true);
  });

  // NOTE: the "cannot revoke the last remaining admin" guard
  // (admins/actions.ts) is currently unreachable through this action alone
  // — resolveSuperAdminActionContext() already requires the ACTOR to be a
  // super admin, so whenever exactly one exists, actor === target, which
  // the self-revoke check above refuses first. Kept as defense-in-depth
  // (see that guard's own comment) rather than tested here directly: there
  // is no honest way to construct actor !== target at remaining === 1
  // through the real action without fabricating an inconsistent DB state
  // the action itself could never produce.
});

describe("MULTI_ACADEMY_AND_KIDS_BELTS.md Phase 6 — AuditLog cross-tenant isolation", () => {
  afterAll(cleanup);

  it("REQUIRED: resolveOrganizationAuditTrail returns ONLY the target organization's rows, even with another organization's audit history present", async () => {
    const orgA = await makePendingOrganization();
    const orgB = await makePendingOrganization();
    const superAdmin = await makeSuperAdmin();

    await approveOrganization(orgA.slug, superAdmin.id);
    await approveOrganization(orgB.slug, superAdmin.id);
    const [directorA, directorB] = await Promise.all([
      prisma.user.findUnique({ where: { email: orgA.contactEmail! } }),
      prisma.user.findUnique({ where: { email: orgB.contactEmail! } }),
    ]);
    if (directorA) cleanupUserIds.push(directorA.id);
    if (directorB) cleanupUserIds.push(directorB.id);

    const trailA = await resolveOrganizationAuditTrail(orgA.id);
    expect(trailA.length).toBeGreaterThan(0);

    // The definitive isolation check: org B's own audit rows must never
    // appear in org A's trail (by id, not merely by count).
    const trailAIds = new Set(trailA.map((e) => e.id));
    const trailB = await resolveOrganizationAuditTrail(orgB.id);
    expect(trailB.length).toBeGreaterThan(0);
    for (const entry of trailB) {
      expect(trailAIds.has(entry.id)).toBe(false);
    }
  });
});
