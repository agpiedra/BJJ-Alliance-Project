import "dotenv/config";
import { describe, expect, it } from "vitest";
import { PrismaClient } from "../../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { requireEnv } from "../../src/lib/env";
import { academyScopeWhere, isAcademyInScope, type StaffSession } from "../../src/lib/auth/session";

const adapter = new PrismaPg({ connectionString: requireEnv("DATABASE_URL") });
const prisma = new PrismaClient({ adapter });

describe("academy scoping", () => {
  it("an ADMIN session's scope covers every academy (empty where-fragment)", async () => {
    const admin: StaffSession = { userId: "x", role: "ADMIN", academyIds: "ALL" };
    expect(academyScopeWhere(admin)).toEqual({});

    const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
    const escalante = await prisma.academy.findUniqueOrThrow({ where: { slug: "escalante" } });
    expect(isAcademyInScope(admin, escazu.id)).toBe(true);
    expect(isAcademyInScope(admin, escalante.id)).toBe(true);
  });

  it("an Escalante-only INSTRUCTOR's scope excludes Escazú — through the query shape, not just the type", async () => {
    const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
    const escalante = await prisma.academy.findUniqueOrThrow({ where: { slug: "escalante" } });

    const escalanteInstructor: StaffSession = {
      userId: "x",
      role: "INSTRUCTOR",
      academyIds: [escalante.id],
    };

    expect(isAcademyInScope(escalanteInstructor, escazu.id)).toBe(false);
    expect(isAcademyInScope(escalanteInstructor, escalante.id)).toBe(true);

    // Prove it against real seeded data, not just the type: Escazú has 18
    // ClassSession rows (Phase 1's full schedule); Escalante has 0 (deliberately
    // empty per spec §5). Query with ONLY the scope where-fragment applied — no
    // additional academyId filter merged in, since that's how a real query
    // actually uses this helper (the scope IS the academy filter) — and assert
    // the Escalante-only session sees zero of Escazú's known-to-exist rows.
    const where = academyScopeWhere(escalanteInstructor);
    const visibleToEscalanteInstructor = await prisma.classSession.findMany({ where });
    expect(visibleToEscalanteInstructor).toHaveLength(0);
    expect(visibleToEscalanteInstructor.some((s) => s.academyId === escazu.id)).toBe(false);

    const escazuInstructor: StaffSession = { userId: "x", role: "INSTRUCTOR", academyIds: [escazu.id] };
    const visibleToEscazuInstructor = await prisma.classSession.findMany({
      where: academyScopeWhere(escazuInstructor),
    });
    expect(visibleToEscazuInstructor).toHaveLength(18);
    expect(visibleToEscazuInstructor.every((s) => s.academyId === escazu.id)).toBe(true);
  });

  it("a two-academy DIRECTOR's scope covers exactly their two assigned academies, no others", async () => {
    const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
    const escalante = await prisma.academy.findUniqueOrThrow({ where: { slug: "escalante" } });

    const bothAcademiesDirector: StaffSession = {
      userId: "x",
      role: "DIRECTOR",
      academyIds: [escazu.id, escalante.id],
    };

    const where = academyScopeWhere(bothAcademiesDirector);
    expect(where).toEqual({ academyId: { in: [escazu.id, escalante.id] } });
    expect(isAcademyInScope(bothAcademiesDirector, escazu.id)).toBe(true);
    expect(isAcademyInScope(bothAcademiesDirector, escalante.id)).toBe(true);
  });
});
