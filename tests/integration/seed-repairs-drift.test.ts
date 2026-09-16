import "dotenv/config";
import { getTestPrismaClient } from "../helpers/test-db";
import { describe, expect, it } from "vitest";
import { reseed } from "../helpers/reseed";

const prisma = getTestPrismaClient();

/**
 * SCOPE: pure omissions — a field present in an upsert's `create` branch
 * but missing from `update`, which seed-idempotence.test.ts's same-source
 * double-run cannot detect (proven there: reintroducing that exact bug and
 * rerunning the double-seed test still passed, because an omitted field
 * can't move between two runs of the same source — there's nothing to
 * diff).
 *
 * This test reproduces the actual historical failure mode instead: a row
 * whose STORED value has drifted from the seed source (exactly what
 * happened to BeltRank.stripeColors after the color columns were added —
 * existing rows kept an old value the seed's `update` branch never
 * touched). For one representative field per model that was found to have
 * this gap, write a deliberately wrong value directly (bypassing the seed
 * entirely), reseed, and assert the field is back to its seeded value. A
 * create-only field fails this immediately: reseed hits `update`, `update`
 * never touches the field, and the wrong value survives.
 *
 * One field per model, not every field — this is a regression net for the
 * exact bug class found in this phase's audit, not a second exhaustive
 * catalog test (kids-belt-catalog.test.ts already asserts BeltRank's full
 * color/tape shape).
 */
describe("Deterministic seed — reseeding repairs a value that drifted from the seed source", () => {
  it(
    "BeltRank.stripeColors: a corrupted tape array is restored",
    async () => {
      const id = "seed-belt-rank-adult-white";
      await prisma.beltRank.update({ where: { id }, data: { stripeColors: ["#000000", "#000000", "#000000", "#000000"] } });
      reseed();
      const rank = await prisma.beltRank.findUniqueOrThrow({ where: { id } });
      expect(rank.stripeColors).toEqual(["#FFFFFF", "#FFFFFF", "#FFFFFF", "#FFFFFF"]);
    },
    30_000,
  );

  it(
    "Organization.name: a corrupted name is restored",
    async () => {
      const id = "seed-org-alliance";
      await prisma.organization.update({ where: { id }, data: { name: "CORRUPTED" } });
      reseed();
      const org = await prisma.organization.findUniqueOrThrow({ where: { id } });
      expect(org.name).toBe("Alliance Jiu-Jitsu Costa Rica");
    },
    30_000,
  );

  it(
    "Academy.name: a corrupted name is restored",
    async () => {
      const id = "seed-academy-escazu";
      await prisma.academy.update({ where: { id }, data: { name: "CORRUPTED" } });
      reseed();
      const academy = await prisma.academy.findUniqueOrThrow({ where: { id } });
      expect(academy.name).toBe("Alliance Escazú");
    },
    30_000,
  );

  it(
    "User.email: a corrupted email is restored",
    async () => {
      const id = "seed-user-admin";
      await prisma.user.update({ where: { id }, data: { email: "corrupted@example.com" } });
      reseed();
      const user = await prisma.user.findUniqueOrThrow({ where: { id } });
      expect(user.email).toBe("admin@alliancecr.com");
    },
    30_000,
  );

  it(
    "Student.firstName: a corrupted name is restored",
    async () => {
      const id = "seed-student-qa-prueba";
      await prisma.student.update({ where: { id }, data: { firstName: "CORRUPTED" } });
      reseed();
      const student = await prisma.student.findUniqueOrThrow({ where: { id } });
      expect(student.firstName).toBe("Estudiante");
    },
    30_000,
  );

  it(
    "StaffAssignment.role: a corrupted role is restored",
    async () => {
      const id = "seed-staff-director-escazu";
      await prisma.staffAssignment.update({ where: { id }, data: { role: "INSTRUCTOR" } });
      reseed();
      const assignment = await prisma.staffAssignment.findUniqueOrThrow({ where: { id } });
      expect(assignment.role).toBe("DIRECTOR");
    },
    30_000,
  );

  it(
    "AttendanceRecord.type: a corrupted type is restored",
    async () => {
      const id = "seed-attendance-0001";
      await prisma.attendanceRecord.update({ where: { id }, data: { type: "ADJUSTMENT" } });
      reseed();
      const record = await prisma.attendanceRecord.findUniqueOrThrow({ where: { id } });
      expect(record.type).toBe("CHECKIN");
    },
    30_000,
  );

  it(
    "PaymentPeriod.status: a corrupted status is restored",
    async () => {
      const id = "seed-payment-001";
      await prisma.paymentPeriod.update({ where: { id }, data: { status: "PENDING" } });
      reseed();
      const period = await prisma.paymentPeriod.findUniqueOrThrow({ where: { id } });
      expect(period.status).toBe("PAID");
    },
    30_000,
  );
});
