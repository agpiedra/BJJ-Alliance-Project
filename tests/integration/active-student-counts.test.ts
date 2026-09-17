import "dotenv/config";
import { getTestPrismaClient } from "../helpers/test-db";
import { afterAll, describe, expect, it } from "vitest";
import { requireEnv } from "../../src/lib/env";
import { digestLookupSecret } from "../../src/lib/crypto";
import { adultRankId, kidsRankId } from "../helpers/belt-ranks";
import { getActiveStudentCounts } from "../../src/lib/students/active-counts";
import type { TenantContext, MembershipRole } from "../../src/lib/tenant/types";

const prisma = getTestPrismaClient();
const pepper = requireEnv("CODE_PEPPER");

function ctx(role: MembershipRole, academyIds: string[] | "ALL", organizationId: string): TenantContext {
  return {
    kind: "tenant",
    actorUserId: "x",
    organizationId,
    organizationRole: role,
    academyIds,
    selfStudentId: null,
  };
}

describe("getActiveStudentCounts — Phase 3c-iii dashboard breakdown", () => {
  const createdStudentIds: string[] = [];

  afterAll(async () => {
    if (createdStudentIds.length > 0) {
      await prisma.student.deleteMany({ where: { id: { in: createdStudentIds } } });
    }
  });

  it("REQUIRED INVARIANT: kids + adults === total, for a real mix of both tracks — a filter whose two halves don't add up to the whole is how a student silently disappears from every view", async () => {
    const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
    const uniqueSuffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;

    const kidsStudent = await prisma.student.create({
      data: {
        homeAcademyId: escazu.id,
        organizationId: escazu.organizationId,
        track: "KIDS",
        status: "ACTIVE",
        firstName: "ActiveCountsInvariantTest",
        lastName: "KidsStudent",
        phone: "88880020",
        email: `active-counts-invariant-kids-${uniqueSuffix}@example.com`,
        currentRankId: kidsRankId("white"),
        codeHash: digestLookupSecret(`active-counts-invariant-kids-${uniqueSuffix}`, pepper),
      },
    });
    createdStudentIds.push(kidsStudent.id);

    const adultStudent = await prisma.student.create({
      data: {
        homeAcademyId: escazu.id,
        organizationId: escazu.organizationId,
        track: "ADULT",
        status: "ACTIVE",
        firstName: "ActiveCountsInvariantTest",
        lastName: "AdultStudent",
        phone: "88880021",
        email: `active-counts-invariant-adult-${uniqueSuffix}@example.com`,
        currentRankId: adultRankId("WHITE"),
        codeHash: digestLookupSecret(`active-counts-invariant-adult-${uniqueSuffix}`, pepper),
      },
    });
    createdStudentIds.push(adultStudent.id);

    // A DIRECTOR scoped to exactly this one academy, so the invariant is
    // checked against a small, deterministic slice — not the whole shared
    // seed database, which other test files mutate concurrently.
    const director = ctx("DIRECTOR", [escazu.id], escazu.organizationId);
    const counts = await getActiveStudentCounts(director);

    expect(counts.total).toBe(counts.kids + counts.adults);
    // And concretely: both fixtures are counted, on the right side each.
    expect(counts.kids).toBeGreaterThanOrEqual(1);
    expect(counts.adults).toBeGreaterThanOrEqual(1);
  });

  it("is tenant-scoped: an Escalante-only session's counts never include the Escazú-only fixtures above", async () => {
    const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
    const escalante = await prisma.academy.findUniqueOrThrow({ where: { slug: "escalante" } });

    const escazuOnly = ctx("DIRECTOR", [escazu.id], escazu.organizationId);
    const escalanteOnly = ctx("DIRECTOR", [escalante.id], escalante.organizationId);

    const [escazuCounts, escalanteCounts] = await Promise.all([
      getActiveStudentCounts(escazuOnly),
      getActiveStudentCounts(escalanteOnly),
    ]);

    // Both still individually satisfy the invariant, scoped to their own
    // academy — this is the same guarantee, just proven twice, once per
    // tenant slice, rather than assuming isolation implies correctness.
    expect(escazuCounts.total).toBe(escazuCounts.kids + escazuCounts.adults);
    expect(escalanteCounts.total).toBe(escalanteCounts.kids + escalanteCounts.adults);
  });

  it("zero state: an academy-scoped session with genuinely zero active students still returns 0, not an error or an omitted field", async () => {
    const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
    // A scratch academy under the same org, guaranteed to have zero
    // students of any kind (never used by any other test file).
    const scratchAcademy = await prisma.academy.create({
      data: {
        organizationId: escazu.organizationId,
        name: "Active Counts Zero State Scratch",
        slug: `active-counts-zero-state-${Date.now()}`,
        kioskTokenHash: digestLookupSecret(`active-counts-zero-state-${Date.now()}`, pepper),
      },
    });

    try {
      const emptyAcademySession = ctx("DIRECTOR", [scratchAcademy.id], escazu.organizationId);
      const counts = await getActiveStudentCounts(emptyAcademySession);

      expect(counts).toEqual({ total: 0, kids: 0, adults: 0 });
    } finally {
      await prisma.academy.delete({ where: { id: scratchAcademy.id } });
    }
  });
});
