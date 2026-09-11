import "dotenv/config";
import { afterAll, describe, expect, it } from "vitest";
import { PrismaClient } from "../../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { requireEnv } from "../../src/lib/env";
import type { Recipient } from "../../src/lib/notifications/types";

const { resolveStaffRecipients } = await import("../../src/lib/notifications/recipients");

const adapter = new PrismaPg({ connectionString: requireEnv("DATABASE_URL") });
const prisma = new PrismaClient({ adapter });

const cleanupUserIds: string[] = [];

async function cleanup() {
  if (cleanupUserIds.length > 0) {
    await prisma.staffAssignment.deleteMany({ where: { userId: { in: cleanupUserIds } } });
    await prisma.user.deleteMany({ where: { id: { in: cleanupUserIds } } });
  }
}

async function makeUser(overrides: {
  role: "ADMIN" | "DIRECTOR" | "INSTRUCTOR";
  active?: boolean;
  locale?: string;
}) {
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
  const user = await prisma.user.create({
    data: {
      email: `notif-recipients-${suffix}@example.com`,
      passwordHash: "x",
      role: overrides.role,
      active: overrides.active ?? true,
      locale: overrides.locale ?? "es",
    },
  });
  cleanupUserIds.push(user.id);
  return user;
}

function findRecipient(list: Recipient[], userId: string) {
  return list.find((r) => r.userId === userId);
}

describe("resolveStaffRecipients", () => {
  afterAll(cleanup);

  it("includes an ADMIN regardless of academy, and excludes a DIRECTOR/INSTRUCTOR assigned only to the OTHER academy", async () => {
    const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
    const escalante = await prisma.academy.findUniqueOrThrow({ where: { slug: "escalante" } });

    const admin = await makeUser({ role: "ADMIN", locale: "en" });
    const escazuDirector = await makeUser({ role: "DIRECTOR" });
    await prisma.staffAssignment.create({ data: { userId: escazuDirector.id, academyId: escazu.id, role: "DIRECTOR" } });

    const escalanteInstructor = await makeUser({ role: "INSTRUCTOR" });
    await prisma.staffAssignment.create({
      data: { userId: escalanteInstructor.id, academyId: escalante.id, role: "INSTRUCTOR" },
    });

    const recipients = await resolveStaffRecipients(escazu.id);

    const adminRecipient = findRecipient(recipients, admin.id);
    expect(adminRecipient).toEqual({ userId: admin.id, email: admin.email, locale: "en" });

    const directorRecipient = findRecipient(recipients, escazuDirector.id);
    expect(directorRecipient).toEqual({ userId: escazuDirector.id, email: escazuDirector.email, locale: "es" });

    expect(findRecipient(recipients, escalanteInstructor.id)).toBeUndefined();
  });

  it("excludes an inactive user of any role, even an inactive ADMIN or an inactive assigned DIRECTOR", async () => {
    const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });

    const inactiveAdmin = await makeUser({ role: "ADMIN", active: false });
    const inactiveDirector = await makeUser({ role: "DIRECTOR", active: false });
    await prisma.staffAssignment.create({
      data: { userId: inactiveDirector.id, academyId: escazu.id, role: "DIRECTOR" },
    });

    const recipients = await resolveStaffRecipients(escazu.id);

    expect(findRecipient(recipients, inactiveAdmin.id)).toBeUndefined();
    expect(findRecipient(recipients, inactiveDirector.id)).toBeUndefined();
  });

  it("de-duplicates by userId even if the same user somehow has multiple StaffAssignment rows for that academy", async () => {
    // StaffAssignment has a real @@unique([userId, academyId]) constraint, so
    // this scenario can't occur via the DIRECTOR/INSTRUCTOR path in practice
    // — but an ADMIN can ALSO hold a (redundant, but not schema-forbidden)
    // StaffAssignment row, which is the realistic way one userId could
    // appear via both the "every ADMIN" branch and the assignment branch.
    // Proves resolveStaffRecipients's Map-keyed dedupe handles that overlap.
    const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
    const adminWithAssignment = await makeUser({ role: "ADMIN" });
    await prisma.staffAssignment.create({
      data: { userId: adminWithAssignment.id, academyId: escazu.id, role: "DIRECTOR" },
    });

    const recipients = await resolveStaffRecipients(escazu.id);
    const matches = recipients.filter((r) => r.userId === adminWithAssignment.id);
    expect(matches).toHaveLength(1);
  });
});
