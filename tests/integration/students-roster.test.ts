import "dotenv/config";
import { getTestPrismaClient } from "../helpers/test-db";
import { afterAll, describe, expect, it } from "vitest";
import { requireEnv } from "../../src/lib/env";
import { digestLookupSecret } from "../../src/lib/crypto";
import { adultRankId, kidsRankId } from "../helpers/belt-ranks";
import { listStudents } from "../../src/app/[locale]/(staff)/students/actions";
import type { TenantContext, MembershipRole } from "../../src/lib/tenant/types";

const prisma = getTestPrismaClient();

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

describe("student roster — cross-academy isolation (feature-level, on top of Task 2's helper)", () => {
  const pepper = requireEnv("CODE_PEPPER");
  const createdStudentIds: string[] = [];

  afterAll(async () => {
    if (createdStudentIds.length > 0) {
      await prisma.student.deleteMany({ where: { id: { in: createdStudentIds } } });
    }
  });

  it("an Escalante-only session never sees the Escazú student and vice versa; ADMIN sees both", async () => {
    const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
    const escalante = await prisma.academy.findUniqueOrThrow({ where: { slug: "escalante" } });

    const uniqueSuffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;

    const escazuStudent = await prisma.student.create({
      data: {
        homeAcademyId: escazu.id,
        organizationId: escazu.organizationId,
        firstName: "RosterIsolationTest",
        lastName: "EscazuStudent",
        phone: "88880001",
        email: `roster-isolation-escazu-${uniqueSuffix}@example.com`,
        currentRankId: adultRankId("WHITE"),
        codeHash: digestLookupSecret(`roster-escazu-${uniqueSuffix}`, pepper),
      },
    });
    createdStudentIds.push(escazuStudent.id);

    const escalanteStudent = await prisma.student.create({
      data: {
        homeAcademyId: escalante.id,
        organizationId: escalante.organizationId,
        firstName: "RosterIsolationTest",
        lastName: "EscalanteStudent",
        phone: "88880002",
        email: `roster-isolation-escalante-${uniqueSuffix}@example.com`,
        currentRankId: adultRankId("WHITE"),
        codeHash: digestLookupSecret(`roster-escalante-${uniqueSuffix}`, pepper),
      },
    });
    createdStudentIds.push(escalanteStudent.id);

    const escalanteOnlySession = ctx("INSTRUCTOR", [escalante.id], escalante.organizationId);
    const escazuOnlySession = ctx("INSTRUCTOR", [escazu.id], escazu.organizationId);
    const adminSession = ctx("ADMIN", "ALL", escazu.organizationId);

    // Scope the search to just our two throwaway rows so this assertion
    // holds regardless of whatever else is in the seeded/dev DB.
    const filters = { search: "RosterIsolationTest" };

    const escalanteView = await listStudents(escalanteOnlySession, filters);
    expect(escalanteView.some((s) => s.id === escazuStudent.id)).toBe(false);
    expect(escalanteView.some((s) => s.id === escalanteStudent.id)).toBe(true);
    expect(escalanteView.every((s) => s.homeAcademyId === escalante.id)).toBe(true);

    const escazuView = await listStudents(escazuOnlySession, filters);
    expect(escazuView.some((s) => s.id === escalanteStudent.id)).toBe(false);
    expect(escazuView.some((s) => s.id === escazuStudent.id)).toBe(true);
    expect(escazuView.every((s) => s.homeAcademyId === escazu.id)).toBe(true);

    const adminView = await listStudents(adminSession, filters);
    expect(adminView.some((s) => s.id === escazuStudent.id)).toBe(true);
    expect(adminView.some((s) => s.id === escalanteStudent.id)).toBe(true);
  });

  it("an ADMIN's academyId filter narrows to just that one academy (the Escazú/Escalante/Ambas switcher)", async () => {
    const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
    const escalante = await prisma.academy.findUniqueOrThrow({ where: { slug: "escalante" } });

    const uniqueSuffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;

    const escazuStudent = await prisma.student.create({
      data: {
        homeAcademyId: escazu.id,
        organizationId: escazu.organizationId,
        firstName: "RosterFilterTest",
        lastName: "EscazuStudent",
        phone: "88880003",
        email: `roster-filter-escazu-${uniqueSuffix}@example.com`,
        currentRankId: adultRankId("WHITE"),
        codeHash: digestLookupSecret(`roster-filter-escazu-${uniqueSuffix}`, pepper),
      },
    });
    createdStudentIds.push(escazuStudent.id);

    const escalanteStudent = await prisma.student.create({
      data: {
        homeAcademyId: escalante.id,
        organizationId: escalante.organizationId,
        firstName: "RosterFilterTest",
        lastName: "EscalanteStudent",
        phone: "88880004",
        email: `roster-filter-escalante-${uniqueSuffix}@example.com`,
        currentRankId: adultRankId("WHITE"),
        codeHash: digestLookupSecret(`roster-filter-escalante-${uniqueSuffix}`, pepper),
      },
    });
    createdStudentIds.push(escalanteStudent.id);

    const adminSession = ctx("ADMIN", "ALL", escazu.organizationId);

    const escazuOnly = await listStudents(adminSession, {
      search: "RosterFilterTest",
      academyId: escazu.id,
    });
    expect(escazuOnly.some((s) => s.id === escazuStudent.id)).toBe(true);
    expect(escazuOnly.some((s) => s.id === escalanteStudent.id)).toBe(false);

    // A non-admin's academyId filter is ignored, not trusted — an
    // Escalante-only session passing academyId: escazu.id must still be
    // fully scoped to Escalante, never widened.
    const escalanteOnlySession = ctx("INSTRUCTOR", [escalante.id], escalante.organizationId);
    const ignoredFilterView = await listStudents(escalanteOnlySession, {
      search: "RosterFilterTest",
      academyId: escazu.id,
    });
    expect(ignoredFilterView.some((s) => s.id === escazuStudent.id)).toBe(false);
    expect(ignoredFilterView.some((s) => s.id === escalanteStudent.id)).toBe(true);
  });
});

describe("student roster — Phase 3c-iii track filter (query-level, per getScopedDb)", () => {
  const pepper = requireEnv("CODE_PEPPER");
  const createdStudentIds: string[] = [];

  afterAll(async () => {
    if (createdStudentIds.length > 0) {
      await prisma.student.deleteMany({ where: { id: { in: createdStudentIds } } });
    }
  });

  it("REQUIRED: filters on track in the query — a KIDS-track student never appears under an ADULT filter and vice versa", async () => {
    const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
    const uniqueSuffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;

    const kidsStudent = await prisma.student.create({
      data: {
        homeAcademyId: escazu.id,
        organizationId: escazu.organizationId,
        track: "KIDS",
        firstName: "TrackFilterTest",
        lastName: "KidsStudent",
        phone: "88880010",
        email: `track-filter-kids-${uniqueSuffix}@example.com`,
        currentRankId: kidsRankId("white"),
        codeHash: digestLookupSecret(`track-filter-kids-${uniqueSuffix}`, pepper),
      },
    });
    createdStudentIds.push(kidsStudent.id);

    const adultStudent = await prisma.student.create({
      data: {
        homeAcademyId: escazu.id,
        organizationId: escazu.organizationId,
        track: "ADULT",
        firstName: "TrackFilterTest",
        lastName: "AdultStudent",
        phone: "88880011",
        email: `track-filter-adult-${uniqueSuffix}@example.com`,
        currentRankId: adultRankId("WHITE"),
        codeHash: digestLookupSecret(`track-filter-adult-${uniqueSuffix}`, pepper),
      },
    });
    createdStudentIds.push(adultStudent.id);

    const admin = ctx("ADMIN", "ALL", escazu.organizationId);
    const search = "TrackFilterTest";

    const kidsView = await listStudents(admin, { search, track: "KIDS" });
    expect(kidsView.some((s) => s.id === kidsStudent.id)).toBe(true);
    expect(kidsView.some((s) => s.id === adultStudent.id)).toBe(false);
    expect(kidsView.every((s) => s.track === "KIDS")).toBe(true);

    const adultsView = await listStudents(admin, { search, track: "ADULT" });
    expect(adultsView.some((s) => s.id === adultStudent.id)).toBe(true);
    expect(adultsView.some((s) => s.id === kidsStudent.id)).toBe(false);
    expect(adultsView.every((s) => s.track === "ADULT")).toBe(true);

    // Todos (no track filter): both appear.
    const allView = await listStudents(admin, { search });
    expect(allView.some((s) => s.id === kidsStudent.id)).toBe(true);
    expect(allView.some((s) => s.id === adultStudent.id)).toBe(true);
  });

  it("REQUIRED: a zero-match track filter renders as an empty list, not an error or a silently-ignored filter", async () => {
    const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
    const uniqueSuffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;

    // Exactly one ADULT student under this unique search term — no KIDS
    // student exists for it at all.
    const adultOnly = await prisma.student.create({
      data: {
        homeAcademyId: escazu.id,
        organizationId: escazu.organizationId,
        track: "ADULT",
        firstName: "TrackZeroStateTest",
        lastName: "OnlyAdult",
        phone: "88880012",
        email: `track-zero-state-${uniqueSuffix}@example.com`,
        currentRankId: adultRankId("WHITE"),
        codeHash: digestLookupSecret(`track-zero-state-${uniqueSuffix}`, pepper),
      },
    });
    createdStudentIds.push(adultOnly.id);

    const admin = ctx("ADMIN", "ALL", escazu.organizationId);
    const kidsView = await listStudents(admin, { search: "TrackZeroStateTest", track: "KIDS" });
    expect(kidsView).toEqual([]);
  });
});
