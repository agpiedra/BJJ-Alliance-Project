import "dotenv/config";
import { getTestPrismaClient } from "../helpers/test-db";
import { afterEach, describe, expect, it } from "vitest";
import { hashSecret } from "../../src/lib/crypto";
import { resolveActiveOrganizationForSignIn } from "../../src/lib/tenant/active-organization";

const prisma = getTestPrismaClient();

const cleanupUserIds: string[] = [];
const cleanupOrganizationIds: string[] = [];

afterEach(async () => {
  if (cleanupUserIds.length > 0) {
    await prisma.organizationMembership.deleteMany({ where: { userId: { in: cleanupUserIds } } });
    await prisma.user.deleteMany({ where: { id: { in: cleanupUserIds } } });
  }
  if (cleanupOrganizationIds.length > 0) {
    await prisma.organization.deleteMany({ where: { id: { in: cleanupOrganizationIds } } });
  }
  cleanupUserIds.length = 0;
  cleanupOrganizationIds.length = 0;
});

function suffix() {
  return `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
}

async function makeUser() {
  const user = await prisma.user.create({
    data: { email: `active-org-${suffix()}@example.com`, passwordHash: await hashSecret("irrelevant"), role: "ADMIN" },
  });
  cleanupUserIds.push(user.id);
  return user;
}

async function makeOrg(status: "ACTIVE" | "SUSPENDED" | "PENDING" = "ACTIVE") {
  const org = await prisma.organization.create({
    data: { slug: `active-org-test-${suffix()}`, name: `Active Org Test ${suffix()}`, status },
  });
  cleanupOrganizationIds.push(org.id);
  return org;
}

async function addMembership(userId: string, organizationId: string) {
  await prisma.organizationMembership.create({ data: { userId, organizationId, role: "ADMIN" } });
}

describe("resolveActiveOrganizationForSignIn", () => {
  it("returns none for a user with zero active memberships", async () => {
    const user = await makeUser();
    expect(await resolveActiveOrganizationForSignIn(user.id)).toEqual({ kind: "none" });
  });

  it("returns none when the user's only membership is in a non-ACTIVE organization — a suspended-only membership is not real access", async () => {
    const user = await makeUser();
    const org = await makeOrg("SUSPENDED");
    await addMembership(user.id, org.id);
    expect(await resolveActiveOrganizationForSignIn(user.id)).toEqual({ kind: "none" });
  });

  it("auto-resolves the sole active membership — not a fallback among options, the unambiguous unique answer", async () => {
    const user = await makeUser();
    const org = await makeOrg();
    await addMembership(user.id, org.id);
    expect(await resolveActiveOrganizationForSignIn(user.id)).toEqual({ kind: "resolved", organizationId: org.id });
  });

  it("ignores a non-ACTIVE second membership when counting — one real active membership still auto-resolves", async () => {
    const user = await makeUser();
    const activeOrg = await makeOrg("ACTIVE");
    const pendingOrg = await makeOrg("PENDING");
    await addMembership(user.id, activeOrg.id);
    await addMembership(user.id, pendingOrg.id);
    expect(await resolveActiveOrganizationForSignIn(user.id)).toEqual({
      kind: "resolved",
      organizationId: activeOrg.id,
    });
  });

  it("returns needsSelection for 2+ active memberships with no persisted lastActiveOrganizationId — never picks arbitrarily", async () => {
    const user = await makeUser();
    const orgA = await makeOrg();
    const orgB = await makeOrg();
    await addMembership(user.id, orgA.id);
    await addMembership(user.id, orgB.id);
    expect(await resolveActiveOrganizationForSignIn(user.id)).toEqual({ kind: "needsSelection" });
  });

  it("resolves to the persisted lastActiveOrganizationId when it still names a real active membership", async () => {
    const user = await makeUser();
    const orgA = await makeOrg();
    const orgB = await makeOrg();
    await addMembership(user.id, orgA.id);
    await addMembership(user.id, orgB.id);
    await prisma.user.update({ where: { id: user.id }, data: { lastActiveOrganizationId: orgB.id } });

    expect(await resolveActiveOrganizationForSignIn(user.id)).toEqual({ kind: "resolved", organizationId: orgB.id });
  });

  it("falls through to needsSelection when the persisted lastActiveOrganizationId names a real org the user is no longer a member of (e.g. a revoked membership) — never trusted blindly", async () => {
    const user = await makeUser();
    const orgA = await makeOrg();
    const orgB = await makeOrg();
    const revokedOrg = await makeOrg(); // real row, but no membership for this user
    await addMembership(user.id, orgA.id);
    await addMembership(user.id, orgB.id);
    await prisma.user.update({ where: { id: user.id }, data: { lastActiveOrganizationId: revokedOrg.id } });

    expect(await resolveActiveOrganizationForSignIn(user.id)).toEqual({ kind: "needsSelection" });
  });
});
