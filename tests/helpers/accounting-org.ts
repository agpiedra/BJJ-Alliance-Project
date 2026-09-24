import { getTestPrismaClient } from "./test-db";
import { hashSecret } from "../../src/lib/crypto";
import type { StripeAccounting } from "../../src/generated/prisma/client";

/**
 * A private organization on a chosen promotion accounting, with one academy and one ADMIN.
 *
 * Alliance in the test database is CUMULATIVE (the pre-activation rule) and is shared by every test file running in
 * parallel, so a test that needs PER_INTERVAL behaviour - or wants to pin CUMULATIVE explicitly - must not flip
 * Alliance's config. Each call seeds a fresh organization through the same `seedOrganizationDefaults` a real
 * registration uses (new organizations start on PER_INTERVAL), then sets the requested accounting on every track.
 */
export async function makeAccountingOrg(accounting: StripeAccounting, label: string) {
  const prisma = getTestPrismaClient();
  const { prisma: appPrisma } = await import("../../src/lib/prisma");
  const { seedOrganizationDefaults } = await import("../../src/lib/organizations/seed-defaults");

  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
  const slug = `${label}-${suffix}`;
  const org = await prisma.organization.create({ data: { slug, name: `Accounting Test ${label}`, status: "ACTIVE" } });
  await appPrisma.$transaction(async (tx) => {
    await seedOrganizationDefaults(tx, org.id, "ATTENDANCE");
  });
  await prisma.promotionConfig.updateMany({ where: { organizationId: org.id }, data: { stripeAccounting: accounting } });
  const academy = await prisma.academy.create({
    data: { organizationId: org.id, name: `${label} Academy`, slug: `${slug}-a`, kioskTokenHash: `${slug}-hash` },
  });
  const admin = await prisma.user.create({
    data: { email: `${slug}-admin@example.com`, passwordHash: await hashSecret("irrelevant-password-123"), role: "ADMIN" },
  });
  await prisma.organizationMembership.create({ data: { userId: admin.id, organizationId: org.id, role: "ADMIN" } });

  async function rankId(code: string, track: "ADULT" | "KIDS" = "ADULT") {
    return (await prisma.beltRank.findFirstOrThrow({ where: { organizationId: org.id, track, code } })).id;
  }

  async function drop() {
    await prisma.auditLog.deleteMany({ where: { organizationId: org.id } });
    await prisma.attendanceRecord.deleteMany({ where: { organizationId: org.id } });
    await prisma.promotionCredit.deleteMany({ where: { organizationId: org.id } });
    await prisma.promotion.deleteMany({ where: { organizationId: org.id } });
    await prisma.student.deleteMany({ where: { organizationId: org.id } });
    await prisma.organizationMembership.deleteMany({ where: { organizationId: org.id } });
    await prisma.user.deleteMany({ where: { id: admin.id } });
    await prisma.academy.deleteMany({ where: { organizationId: org.id } });
    await prisma.beltRank.deleteMany({ where: { organizationId: org.id } });
    await prisma.promotionConfig.deleteMany({ where: { organizationId: org.id } });
    await prisma.organizationBranding.deleteMany({ where: { organizationId: org.id } });
    await prisma.organization.deleteMany({ where: { id: org.id } });
  }

  return { org, academy, admin, rankId, drop };
}
