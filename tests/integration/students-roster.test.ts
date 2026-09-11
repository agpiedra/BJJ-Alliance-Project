import "dotenv/config";
import { afterAll, describe, expect, it } from "vitest";
import { PrismaClient } from "../../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { requireEnv } from "../../src/lib/env";
import { digestLookupSecret } from "../../src/lib/crypto";
import { listStudents } from "../../src/app/[locale]/(staff)/students/actions";
import type { StaffSession } from "../../src/lib/auth/session";

const adapter = new PrismaPg({ connectionString: requireEnv("DATABASE_URL") });
const prisma = new PrismaClient({ adapter });

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
        firstName: "RosterIsolationTest",
        lastName: "EscazuStudent",
        phone: "88880001",
        email: `roster-isolation-escazu-${uniqueSuffix}@example.com`,
        codeHash: digestLookupSecret(`roster-escazu-${uniqueSuffix}`, pepper),
      },
    });
    createdStudentIds.push(escazuStudent.id);

    const escalanteStudent = await prisma.student.create({
      data: {
        homeAcademyId: escalante.id,
        firstName: "RosterIsolationTest",
        lastName: "EscalanteStudent",
        phone: "88880002",
        email: `roster-isolation-escalante-${uniqueSuffix}@example.com`,
        codeHash: digestLookupSecret(`roster-escalante-${uniqueSuffix}`, pepper),
      },
    });
    createdStudentIds.push(escalanteStudent.id);

    const escalanteOnlySession: StaffSession = {
      userId: "roster-test-instructor-escalante",
      role: "INSTRUCTOR",
      academyIds: [escalante.id],
    };
    const escazuOnlySession: StaffSession = {
      userId: "roster-test-instructor-escazu",
      role: "INSTRUCTOR",
      academyIds: [escazu.id],
    };
    const adminSession: StaffSession = {
      userId: "roster-test-admin",
      role: "ADMIN",
      academyIds: "ALL",
    };

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
        firstName: "RosterFilterTest",
        lastName: "EscazuStudent",
        phone: "88880003",
        email: `roster-filter-escazu-${uniqueSuffix}@example.com`,
        codeHash: digestLookupSecret(`roster-filter-escazu-${uniqueSuffix}`, pepper),
      },
    });
    createdStudentIds.push(escazuStudent.id);

    const escalanteStudent = await prisma.student.create({
      data: {
        homeAcademyId: escalante.id,
        firstName: "RosterFilterTest",
        lastName: "EscalanteStudent",
        phone: "88880004",
        email: `roster-filter-escalante-${uniqueSuffix}@example.com`,
        codeHash: digestLookupSecret(`roster-filter-escalante-${uniqueSuffix}`, pepper),
      },
    });
    createdStudentIds.push(escalanteStudent.id);

    const adminSession: StaffSession = {
      userId: "roster-test-admin-filter",
      role: "ADMIN",
      academyIds: "ALL",
    };

    const escazuOnly = await listStudents(adminSession, {
      search: "RosterFilterTest",
      academyId: escazu.id,
    });
    expect(escazuOnly.some((s) => s.id === escazuStudent.id)).toBe(true);
    expect(escazuOnly.some((s) => s.id === escalanteStudent.id)).toBe(false);

    // A non-admin's academyId filter is ignored, not trusted — an
    // Escalante-only session passing academyId: escazu.id must still be
    // fully scoped to Escalante, never widened.
    const escalanteOnlySession: StaffSession = {
      userId: "roster-test-instructor-filter",
      role: "INSTRUCTOR",
      academyIds: [escalante.id],
    };
    const ignoredFilterView = await listStudents(escalanteOnlySession, {
      search: "RosterFilterTest",
      academyId: escazu.id,
    });
    expect(ignoredFilterView.some((s) => s.id === escazuStudent.id)).toBe(false);
    expect(ignoredFilterView.some((s) => s.id === escalanteStudent.id)).toBe(true);
  });
});
