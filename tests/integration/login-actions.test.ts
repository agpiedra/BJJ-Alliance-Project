import "dotenv/config";
import { getTestPrismaClient } from "../helpers/test-db";
import { afterAll, describe, expect, it, vi } from "vitest";
import { hashSecret } from "../../src/lib/crypto";

// `login()` calls the real `signIn("credentials", ...)` from `@/auth`, which
// eventually needs to set a cookie on a real HTTP response — unavailable in
// a plain integration test (same reason every other actions.ts test in this
// repo mocks `@/auth`). This task's own logic under test is the PRE-signIn
// redirect target computation (role-aware default vs. an explicit
// callbackUrl), not credential verification itself. `login()` now passes
// that target to `signIn` as `redirectTo` and relies on signIn's own
// internal redirect (never `redirect: false` — that's what silently dropped
// the session cookie) to actually navigate, so the mock simulates a
// successful sign-in by throwing the same `NEXT_REDIRECT` digest Next.js's
// real `redirect()` throws, carrying the `redirectTo` value through.
vi.mock("@/auth", () => ({
  signIn: vi.fn((_provider: string, options: { redirectTo: string }) => {
    const error = new Error("NEXT_REDIRECT");
    (error as { digest?: string }).digest = `NEXT_REDIRECT;push;${options.redirectTo};307;`;
    throw error;
  }),
}));

const { login } = await import("../../src/app/[locale]/login/actions");

const prisma = getTestPrismaClient();

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
      await prisma.notification.deleteMany({ where: { userId: { in: cleanupUserIds } } });
      await prisma.user.deleteMany({ where: { id: { in: cleanupUserIds } } });
    }
  });

  // Where a login lands is decided from the DATABASE — memberships and the linked
  // student record — never the global `User.role`. So these use the seeded Alliance
  // accounts, which really have them (a bare user with a `role` and no membership is a
  // world that does not exist: nothing gets created that way).
  it("a student who really belongs to an academy (membership + an ACTIVE student record) lands on /portal", async () => {
    const target = await redirectTargetOf(login("en", undefined, {}, formData("student@test.com")));
    expect(target).toBe("/en/portal");
  });

  it("a coach who also trains lands in the STAFF app — it links to their training — not the portal", async () => {
    const director = await prisma.user.findUniqueOrThrow({ where: { email: "director@test.com" } });
    const organizationId = (await prisma.organizationMembership.findFirstOrThrow({ where: { userId: director.id } })).organizationId;
    const rank = await prisma.beltRank.findFirstOrThrow({ where: { organizationId, track: "ADULT", code: "WHITE" } });
    const academy = await prisma.academy.findFirstOrThrow({ where: { organizationId } });
    const student = await prisma.student.create({
      data: {
        userId: director.id,
        organizationId,
        homeAcademyId: academy.id,
        firstName: "Director",
        lastName: "LoginTrains",
        phone: "0000-0000",
        email: `director-login-trains-${Date.now()}@example.com`,
        codeHash: `login-actions-director-trains-${Date.now()}`,
        currentRankId: rank.id,
        status: "ACTIVE",
      },
    });
    try {
      const target = await redirectTargetOf(login("en", undefined, {}, formData("director@test.com")));
      expect(target).toBe("/en/dashboard");
    } finally {
      await prisma.student.delete({ where: { id: student.id } });
    }
  });

  it("an account with nothing to derive from lands on the staff path, where the refresh route sends them on to their notice — never a guess from the global role", async () => {
    const { email } = await makeUser("STUDENT", "login-student-orphan");
    const target = await redirectTargetOf(login("en", undefined, {}, formData(email)));
    expect(target).toBe("/en/dashboard");
  });

  it("a staff login with no callbackUrl still lands on /dashboard (no regression)", async () => {
    const { email } = await makeUser("ADMIN", "login-admin");
    const target = await redirectTargetOf(login("en", undefined, {}, formData(email)));
    expect(target).toBe("/en/dashboard");
  });

  it("an explicit callbackUrl still wins for a STUDENT login", async () => {
    const target = await redirectTargetOf(login("en", "/en/students?tab=active", {}, formData("student@test.com")));
    expect(target).toBe("/en/students?tab=active");
  });

  it("an explicit callbackUrl still wins for a staff login", async () => {
    const { email } = await makeUser("DIRECTOR", "login-director-cb");
    const target = await redirectTargetOf(login("en", "/en/students?tab=active", {}, formData(email)));
    expect(target).toBe("/en/students?tab=active");
  });
});
