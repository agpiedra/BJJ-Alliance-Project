import "dotenv/config";
import { afterAll, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "../../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { requireEnv } from "../../src/lib/env";
import { hashSecret } from "../../src/lib/crypto";

// `login()` calls the real `signIn("credentials", ...)` from `@/auth`, which
// eventually needs to set a cookie on a real HTTP response — unavailable in
// a plain integration test (same reason every other actions.ts test in this
// repo mocks `@/auth`). This task's own logic under test is the POST-signIn
// redirect destination (role-aware default vs. an explicit callbackUrl), not
// credential verification itself, so the mock simply resolves — as if
// `signIn` succeeded — every time it's called.
vi.mock("@/auth", () => ({
  signIn: vi.fn(() => Promise.resolve(undefined)),
}));

const { login } = await import("../../src/app/[locale]/login/actions");

const adapter = new PrismaPg({ connectionString: requireEnv("DATABASE_URL") });
const prisma = new PrismaClient({ adapter });

const cleanupUserIds: string[] = [];

function formData(email: string): FormData {
  const fd = new FormData();
  fd.set("email", email);
  fd.set("password", "irrelevant-password-123");
  return fd;
}

async function makeUser(role: "ADMIN" | "DIRECTOR" | "INSTRUCTOR" | "STUDENT", label: string) {
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
  const email = `${label}-${suffix}@example.com`;
  const user = await prisma.user.create({
    data: { email, passwordHash: await hashSecret("irrelevant-password-123"), role },
  });
  cleanupUserIds.push(user.id);
  return { user, email };
}

/** Extracts the redirect target from the `NEXT_REDIRECT` error `login()` throws on success. */
async function redirectTargetOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    const digest = (error as { digest?: string }).digest;
    if (typeof digest === "string" && digest.startsWith("NEXT_REDIRECT")) {
      // digest shape: "NEXT_REDIRECT;<type>;<url>;<statusCode>;"
      return digest.split(";")[2];
    }
    throw error;
  }
  throw new Error("expected login() to redirect, but it resolved instead");
}

describe("login() redirect destination", () => {
  afterAll(async () => {
    if (cleanupUserIds.length > 0) {
      await prisma.user.deleteMany({ where: { id: { in: cleanupUserIds } } });
    }
  });

  it("a STUDENT login with no callbackUrl lands on /portal", async () => {
    const { email } = await makeUser("STUDENT", "login-student");
    const target = await redirectTargetOf(login("en", undefined, {}, formData(email)));
    expect(target).toBe("/en/portal");
  });

  it("a staff login with no callbackUrl still lands on /dashboard (no regression)", async () => {
    const { email } = await makeUser("ADMIN", "login-admin");
    const target = await redirectTargetOf(login("en", undefined, {}, formData(email)));
    expect(target).toBe("/en/dashboard");
  });

  it("an explicit callbackUrl still wins for a STUDENT login", async () => {
    const { email } = await makeUser("STUDENT", "login-student-cb");
    const target = await redirectTargetOf(login("en", "/en/students?tab=active", {}, formData(email)));
    expect(target).toBe("/en/students?tab=active");
  });

  it("an explicit callbackUrl still wins for a staff login", async () => {
    const { email } = await makeUser("DIRECTOR", "login-director-cb");
    const target = await redirectTargetOf(login("en", "/en/students?tab=active", {}, formData(email)));
    expect(target).toBe("/en/students?tab=active");
  });
});
