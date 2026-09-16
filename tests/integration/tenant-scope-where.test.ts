import "dotenv/config";
import { getTestPrismaClient } from "../helpers/test-db";
import { describe, expect, it } from "vitest";
import { branchScopeWhere, isAcademyInTenantScope } from "../../src/lib/tenant/context";
import type { TenantContext, SystemJobContext, KioskContext } from "../../src/lib/tenant/types";

const prisma = getTestPrismaClient();

let allianceOrgIdPromise: Promise<string> | null = null;
function getAllianceOrganizationId() {
  allianceOrgIdPromise ??= prisma.organization.findUniqueOrThrow({ where: { slug: "alliance-cr" } }).then((o) => o.id);
  return allianceOrgIdPromise;
}

function ctx(
  role: TenantContext["organizationRole"],
  academyIds: string[] | "ALL",
  organizationId: string,
): TenantContext {
  return {
    kind: "tenant",
    actorUserId: "x",
    organizationId,
    organizationRole: role,
    academyIds,
    selfStudentId: null,
  };
}

/**
 * `branchScopeWhere`/`isAcademyInTenantScope` — 1f-3's replacement for
 * `tenantScopeWhere` (removed from context.ts once every real call site
 * migrated onto `getScopedDb` for organization scope + `branchScopeWhere`
 * for the separate, optional branch-scope layer composed on top). Same
 * dedicated coverage `tenantScopeWhere` itself had (which in turn replaced
 * `academyScopeWhere`/`isAcademyInScope`'s coverage in 1d) — ported forward
 * again, this time WITHOUT organizationId: `branchScopeWhere` carries none
 * of its own, since organization enforcement is `getScopedDb`'s job now
 * (covered by tenant-scoped-client.test.ts), not this function's.
 */
describe("branchScopeWhere / isAcademyInTenantScope", () => {
  it("an ADMIN context's scope has no academy narrowing at all (empty fragment)", async () => {
    const organizationId = await getAllianceOrganizationId();
    const admin = ctx("ADMIN", "ALL", organizationId);
    expect(branchScopeWhere(admin)).toEqual({});

    const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
    const escalante = await prisma.academy.findUniqueOrThrow({ where: { slug: "escalante" } });
    expect(isAcademyInTenantScope(admin, escazu.id)).toBe(true);
    expect(isAcademyInTenantScope(admin, escalante.id)).toBe(true);
  });

  it("an Escalante-only INSTRUCTOR's scope excludes Escazú — through the query shape, not just the type", async () => {
    const organizationId = await getAllianceOrganizationId();
    const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
    const escalante = await prisma.academy.findUniqueOrThrow({ where: { slug: "escalante" } });

    const escalanteInstructor = ctx("INSTRUCTOR", [escalante.id], organizationId);

    expect(isAcademyInTenantScope(escalanteInstructor, escazu.id)).toBe(false);
    expect(isAcademyInTenantScope(escalanteInstructor, escalante.id)).toBe(true);

    // Prove it against real seeded data, not just the type: Escazú has 18
    // ClassSession rows (its full schedule); Escalante has its own smaller
    // 6-session schedule. `branchScopeWhere` alone (no organizationId — that
    // half is `getScopedDb`'s job now) is enough to isolate by academy here,
    // since a real academyId already names exactly one academy.
    const where = branchScopeWhere(escalanteInstructor);
    const visibleToEscalanteInstructor = await prisma.classSession.findMany({ where });
    expect(visibleToEscalanteInstructor).toHaveLength(6);
    expect(visibleToEscalanteInstructor.some((s) => s.academyId === escazu.id)).toBe(false);

    const escazuInstructor = ctx("INSTRUCTOR", [escazu.id], organizationId);
    const visibleToEscazuInstructor = await prisma.classSession.findMany({
      where: branchScopeWhere(escazuInstructor),
    });
    expect(visibleToEscazuInstructor).toHaveLength(18);
    expect(visibleToEscazuInstructor.every((s) => s.academyId === escazu.id)).toBe(true);
  });

  it("a two-academy DIRECTOR's scope covers exactly their two assigned academies, no others", async () => {
    const organizationId = await getAllianceOrganizationId();
    const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
    const escalante = await prisma.academy.findUniqueOrThrow({ where: { slug: "escalante" } });

    const bothAcademiesDirector = ctx("DIRECTOR", [escazu.id, escalante.id], organizationId);

    const where = branchScopeWhere(bothAcademiesDirector);
    expect(where).toEqual({ academyId: { in: [escazu.id, escalante.id] } });
    expect(isAcademyInTenantScope(bothAcademiesDirector, escazu.id)).toBe(true);
    expect(isAcademyInTenantScope(bothAcademiesDirector, escalante.id)).toBe(true);
  });

  it("a SystemJobContext's and a KioskContext's scope both have no academy narrowing — neither has a per-user academy list of its own", () => {
    const organizationId = "does-not-matter-for-this-check";
    const job: SystemJobContext = { kind: "system-job", organizationId, jobName: "weekly-digest" };
    expect(branchScopeWhere(job)).toEqual({});

    const kiosk: KioskContext = { kind: "kiosk", organizationId, academyId: "some-academy-id" };
    expect(branchScopeWhere(kiosk)).toEqual({});
  });
});
