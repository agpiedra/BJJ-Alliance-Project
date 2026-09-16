import "dotenv/config";
import { getTestPrismaClient } from "../helpers/test-db";
import { afterAll, describe, expect, it } from "vitest";
import type { Recipient } from "../../src/lib/notifications/types";

const { resolveStaffRecipients } = await import("../../src/lib/notifications/recipients");

const prisma = getTestPrismaClient();

const cleanupUserIds: string[] = [];

async function cleanup() {
  if (cleanupUserIds.length > 0) {
    await prisma.organizationMembership.deleteMany({ where: { userId: { in: cleanupUserIds } } });
    await prisma.staffAssignment.deleteMany({ where: { userId: { in: cleanupUserIds } } });
    await prisma.notification.deleteMany({ where: { userId: { in: cleanupUserIds } } });
    await prisma.user.deleteMany({ where: { id: { in: cleanupUserIds } } });
  }
}

// `resolveStaffRecipients` resolves ADMIN through OrganizationMembership
// (scoped to the target academy's own organization), not `User.role` — every
// test user needs a real membership row, matching whatever organization the
// test's own academy belongs to.
async function makeUser(overrides: {
  role: "ADMIN" | "DIRECTOR" | "INSTRUCTOR";
  organizationId: string;
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
  await prisma.organizationMembership.create({
    data: { userId: user.id, organizationId: overrides.organizationId, role: overrides.role },
  });
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

    const admin = await makeUser({ role: "ADMIN", locale: "en", organizationId: escazu.organizationId });
    const escazuDirector = await makeUser({ role: "DIRECTOR", organizationId: escazu.organizationId });
    await prisma.staffAssignment.create({
      data: { userId: escazuDirector.id, academyId: escazu.id, organizationId: escazu.organizationId, role: "DIRECTOR" },
    });

    const escalanteInstructor = await makeUser({ role: "INSTRUCTOR", organizationId: escalante.organizationId });
    await prisma.staffAssignment.create({
      data: {
        userId: escalanteInstructor.id,
        academyId: escalante.id,
        organizationId: escalante.organizationId,
        role: "INSTRUCTOR",
      },
    });

    const recipients = await resolveStaffRecipients(escazu.id);

    const adminRecipient = findRecipient(recipients, admin.id);
    expect(adminRecipient).toEqual({
      userId: admin.id,
      email: admin.email,
      locale: "en",
      organizationId: escazu.organizationId,
    });

    const directorRecipient = findRecipient(recipients, escazuDirector.id);
    expect(directorRecipient).toEqual({
      userId: escazuDirector.id,
      email: escazuDirector.email,
      locale: "es",
      organizationId: escazu.organizationId,
    });

    expect(findRecipient(recipients, escalanteInstructor.id)).toBeUndefined();
  });

  it("excludes an inactive user of any role, even an inactive ADMIN or an inactive assigned DIRECTOR", async () => {
    const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });

    const inactiveAdmin = await makeUser({ role: "ADMIN", active: false, organizationId: escazu.organizationId });
    const inactiveDirector = await makeUser({ role: "DIRECTOR", active: false, organizationId: escazu.organizationId });
    await prisma.staffAssignment.create({
      data: { userId: inactiveDirector.id, academyId: escazu.id, organizationId: escazu.organizationId, role: "DIRECTOR" },
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
    const adminWithAssignment = await makeUser({ role: "ADMIN", organizationId: escazu.organizationId });
    await prisma.staffAssignment.create({
      data: {
        userId: adminWithAssignment.id,
        academyId: escazu.id,
        organizationId: escazu.organizationId,
        role: "DIRECTOR",
      },
    });

    const recipients = await resolveStaffRecipients(escazu.id);
    const matches = recipients.filter((r) => r.userId === adminWithAssignment.id);
    expect(matches).toHaveLength(1);
  });
});
