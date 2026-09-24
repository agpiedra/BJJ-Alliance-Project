import { getTestPrismaClient } from "./test-db";
import { requireEnv } from "../../src/lib/env";
import { digestLookupSecret } from "../../src/lib/crypto";
import { adultRankId } from "./belt-ranks";
import type { ClassType, DayOfWeek } from "../../src/generated/prisma/client";

/**
 * Private academies (and students) for check-in / class-list tests. The seeded Escazu schedule is asserted by other
 * test files (exact session counts) and vitest runs files in parallel, so a scenario that needs its own classes
 * gets its own academy instead of adding sessions to a shared one. Rows are registered as they are created and
 * removed by `cleanupClassFixtures`.
 */
const prisma = getTestPrismaClient();
const pepper = requireEnv("CODE_PEPPER");

const created = { students: [] as string[], academies: [] as string[] };

export interface FixtureSession {
  dayOfWeek: DayOfWeek;
  startTime: string;
  name: string;
  type?: ClassType;
  durationMinutes?: number;
  countsTowardPromotion?: boolean;
  active?: boolean;
}

/** An academy inside `organizationId` (default: Alliance) holding exactly the given sessions. */
export async function makeClassAcademy(sessions: FixtureSession[], organizationId?: string) {
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
  const orgId = organizationId ?? (await prisma.organization.findUniqueOrThrow({ where: { slug: "alliance-cr" } })).id;
  const academy = await prisma.academy.create({
    data: { organizationId: orgId, name: `Class Fixture ${suffix}`, slug: `class-fixture-${suffix}`, kioskTokenHash: `class-fixture-hash-${suffix}` },
  });
  created.academies.push(academy.id);
  const rows = [];
  for (const s of sessions) {
    rows.push(
      await prisma.classSession.create({
        data: {
          academyId: academy.id, organizationId: orgId, dayOfWeek: s.dayOfWeek, startTime: s.startTime,
          durationMinutes: s.durationMinutes ?? 60, name: s.name, type: s.type ?? "GI",
          countsTowardPromotion: s.countsTowardPromotion ?? true, active: s.active ?? true,
        },
      }),
    );
  }
  return { academy, sessions: rows };
}

/** An ACTIVE adult white belt whose home is `academyId`. `rankId` overrides the Alliance white belt for other organizations. */
export async function makeClassStudent(academyId: string, organizationId: string, opts: { rankId?: string; label?: string } = {}) {
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
  const code = `class-fixture-${suffix}`;
  const student = await prisma.student.create({
    data: {
      homeAcademyId: academyId, organizationId, firstName: opts.label ?? "ClassFixture", lastName: "Student", phone: "88880066",
      email: `class-fixture-${suffix}@example.com`, status: "ACTIVE", currentRankId: opts.rankId ?? adultRankId("WHITE"),
      beltAwardedAt: new Date("2026-01-01T00:00:00Z"), codeHash: digestLookupSecret(code, pepper),
    },
  });
  created.students.push(student.id);
  return { student, code };
}

export async function cleanupClassFixtures() {
  if (created.students.length) {
    await prisma.queuedCheckIn.deleteMany({ where: { studentId: { in: created.students } } });
    await prisma.attendanceRecord.deleteMany({ where: { studentId: { in: created.students } } });
    await prisma.auditLog.deleteMany({ where: { entityId: { in: created.students } } });
    await prisma.promotionCredit.deleteMany({ where: { studentId: { in: created.students } } });
    await prisma.promotion.deleteMany({ where: { studentId: { in: created.students } } });
    await prisma.student.deleteMany({ where: { id: { in: created.students } } });
  }
  if (created.academies.length) {
    await prisma.classSession.deleteMany({ where: { academyId: { in: created.academies } } });
    await prisma.academy.deleteMany({ where: { id: { in: created.academies } } });
  }
  created.students.length = 0;
  created.academies.length = 0;
}
