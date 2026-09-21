import "dotenv/config";
import { getTestPrismaClient } from "../helpers/test-db";
import { afterAll, describe, expect, it } from "vitest";
import { requireEnv } from "../../src/lib/env";
import { digestLookupSecret } from "../../src/lib/crypto";
import type { TenantContext, KioskContext, MembershipRole } from "../../src/lib/tenant/types";

const { getOrganizationBranding } = await import("../../src/lib/branding/get-branding");
const { UnscopedTenantQueryError } = await import("../../src/lib/tenant/tenant-guard");
const { prisma } = await import("../../src/lib/prisma");

const testPrisma = getTestPrismaClient();
const pepper = requireEnv("CODE_PEPPER");

function tenantCtx(role: MembershipRole, organizationId: string): TenantContext {
  return { kind: "tenant", actorUserId: "x", organizationId, organizationRole: role, academyIds: "ALL", selfStudentId: null, linkedStudentId: null };
}

function kioskCtx(organizationId: string, academyId: string): KioskContext {
  return { kind: "kiosk", organizationId, academyId };
}

const cleanupOrgIds: string[] = [];
const cleanupAcademyIds: string[] = [];

async function cleanup() {
  if (cleanupAcademyIds.length > 0) {
    await testPrisma.academy.deleteMany({ where: { id: { in: cleanupAcademyIds } } });
  }
  if (cleanupOrgIds.length > 0) {
    await testPrisma.organizationBranding.deleteMany({ where: { organizationId: { in: cleanupOrgIds } } });
    await testPrisma.organization.deleteMany({ where: { id: { in: cleanupOrgIds } } });
  }
}

async function makeOrgWithBranding(label: string, brandingOverrides: Partial<{ primaryColor: string; sidebarBackground: string; logoUrl: string; displayName: string }>) {
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
  const org = await testPrisma.organization.create({
    data: { slug: `${label}-${suffix}`, name: `${label} Org ${suffix}`, status: "ACTIVE" },
  });
  cleanupOrgIds.push(org.id);

  await testPrisma.organizationBranding.create({
    data: { organizationId: org.id, ...brandingOverrides },
  });

  const academy = await testPrisma.academy.create({
    data: {
      organizationId: org.id,
      name: `${label} Academy`,
      slug: `${label}-academy-${suffix}`,
      kioskTokenHash: digestLookupSecret(`${label}-kiosk-${suffix}`, pepper),
    },
  });
  cleanupAcademyIds.push(academy.id);

  return { org, academy };
}

/**
 * MULTI_ACADEMY_AND_KIDS_BELTS.md Phase 4 item 4 — "make sure the tenant
 * guard covers the read... this is a hot path and a new one, so it's
 * exactly where a scoping mistake would be both easy and invisible." These
 * tests prove exactly that, against two REAL organizations with genuinely
 * different colors, not a mocked/stubbed read.
 */
describe("getOrganizationBranding — tenant isolation", () => {
  afterAll(cleanup);

  it("REQUIRED: two organizations with different colors each see only their own — never the other's", async () => {
    const yellow = await makeOrgWithBranding("branding-isolation-yellow", { primaryColor: "#FACC15", sidebarBackground: "#111827" });
    const blue = await makeOrgWithBranding("branding-isolation-blue", { primaryColor: "#215DA5", sidebarBackground: "#0B2545" });

    const yellowBranding = await getOrganizationBranding(tenantCtx("ADMIN", yellow.org.id));
    const blueBranding = await getOrganizationBranding(tenantCtx("ADMIN", blue.org.id));

    expect(yellowBranding.primary.background).toBe("#FACC15");
    expect(yellowBranding.sidebar.background).toBe("#111827");
    expect(blueBranding.primary.background).toBe("#215DA5");
    expect(blueBranding.sidebar.background).toBe("#0B2545");

    // Neither ever equals the other's — the actual regression this exists
    // to catch (a leaked/wrong-org read would show one org's color under
    // the other's context).
    expect(yellowBranding.primary.background).not.toBe(blueBranding.primary.background);
    expect(yellowBranding.sidebar.background).not.toBe(blueBranding.sidebar.background);
  });

  it("the kiosk (KioskContext, not a full tenant session) sees its own organization's branding through the SAME guarded read, never a platform-lookup escape hatch", async () => {
    const { org, academy } = await makeOrgWithBranding("branding-kiosk", { primaryColor: "#7F1D1D", sidebarBackground: "#1A0505" });

    const branding = await getOrganizationBranding(kioskCtx(org.id, academy.id));
    expect(branding.primary.background).toBe("#7F1D1D");
    expect(branding.sidebar.background).toBe("#1A0505");
  });

  it("an unscoped raw read against OrganizationBranding is blocked by the tenant guard — the table is really covered, not merely assumed to be", async () => {
    await expect(prisma.organizationBranding.findMany()).rejects.toThrow(UnscopedTenantQueryError);
  });

  it("a missing branding row (should never happen — created transactionally with every Organization) degrades to system defaults rather than crashing", async () => {
    const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
    const org = await testPrisma.organization.create({
      data: { slug: `branding-missing-row-${suffix}`, name: `Missing Row Org ${suffix}`, status: "ACTIVE" },
    });
    cleanupOrgIds.push(org.id);
    // Deliberately no OrganizationBranding row created for this org.

    const branding = await getOrganizationBranding(tenantCtx("ADMIN", org.id));
    expect(branding.primary.background).toBe("#FACC15");
    expect(branding.sidebar.background).toBe("#111827");
    expect(branding.logoUrl).toBeNull();
  });
});
