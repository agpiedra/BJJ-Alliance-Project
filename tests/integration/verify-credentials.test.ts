import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient, Role } from "../../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { hashSecret } from "../../src/lib/crypto";
import { requireEnv } from "../../src/lib/env";
import { verifyCredentials } from "../../src/lib/auth/verify-credentials";

const adapter = new PrismaPg({ connectionString: requireEnv("DATABASE_URL") });
const prisma = new PrismaClient({ adapter });

const TEST_EMAIL = "phase2-auth-fixture@example.test";
const TEST_PASSWORD = "correct horse battery staple";

beforeAll(async () => {
  await prisma.user.deleteMany({ where: { email: TEST_EMAIL } });
  await prisma.user.create({
    data: {
      email: TEST_EMAIL,
      passwordHash: await hashSecret(TEST_PASSWORD),
      role: Role.INSTRUCTOR,
      active: true,
    },
  });
});

afterAll(async () => {
  await prisma.user.deleteMany({ where: { email: TEST_EMAIL } });
});

describe("verifyCredentials", () => {
  it("returns the user for correct email + password", async () => {
    const result = await verifyCredentials(TEST_EMAIL, TEST_PASSWORD);
    expect(result).not.toBeNull();
    expect(result?.email).toBe(TEST_EMAIL);
    expect(result?.role).toBe("INSTRUCTOR");
  });

  it("returns null for a wrong password", async () => {
    expect(await verifyCredentials(TEST_EMAIL, "wrong password")).toBeNull();
  });

  it("returns null for a nonexistent email", async () => {
    expect(await verifyCredentials("nobody@example.test", TEST_PASSWORD)).toBeNull();
  });

  it("returns null for an inactive user", async () => {
    await prisma.user.update({ where: { email: TEST_EMAIL }, data: { active: false } });
    expect(await verifyCredentials(TEST_EMAIL, TEST_PASSWORD)).toBeNull();
    await prisma.user.update({ where: { email: TEST_EMAIL }, data: { active: true } });
  });
});
