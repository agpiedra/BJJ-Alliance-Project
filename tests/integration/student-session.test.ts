import "dotenv/config";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "../../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { requireEnv } from "../../src/lib/env";
import { hashSecret } from "../../src/lib/crypto";
import { generateStudentCode } from "../../src/lib/students/generate-code";

// Same `auth()` mock as create-student-action.test.ts / student-detail-actions.test.ts
// — see the long note there. `getStudentSession()` re-reads `role`/`active`
// from the DB on every call, exactly like `getStaffSession()`, so every
// session below must name a real, existing `User` row.
let currentSession: { user: { id: string; role: string } } | null = null;

vi.mock("@/auth", () => ({
  auth: () => Promise.resolve(currentSession),
}));

// `requireStudentSession()` calls `getLocale()` (next-intl/server) to build
// its `/login` redirect target when no session exists. `getLocale()` reads
// from request-scoped machinery (headers/middleware context) that doesn't
// exist in a plain integration test — mocked here the same way `@/auth` is,
// rather than trying to fabricate a real Next.js request context.
vi.mock("next-intl/server", () => ({
  getLocale: () => Promise.resolve("en"),
}));

const { getStudentSession, requireStudentSession } = await import("../../src/lib/auth/session");

const adapter = new PrismaPg({ connectionString: requireEnv("DATABASE_URL") });
const prisma = new PrismaClient({ adapter });

const cleanupUserIds: string[] = [];

async function makeStudentUser(
  status: "PENDING" | "ACTIVE" | "INACTIVE" | "ARCHIVED",
  label: string,
  options?: { active?: boolean; withStudentRow?: boolean },
) {
  const active = options?.active ?? true;
  const withStudentRow = options?.withStudentRow ?? true;
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
  const user = await prisma.user.create({
    data: {
      email: `${label}-${suffix}@example.com`,
      passwordHash: await hashSecret("irrelevant-password-123"),
      role: "STUDENT",
      active,
    },
  });
  cleanupUserIds.push(user.id);

  let studentId: string | null = null;
  if (withStudentRow) {
    const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
    const { codeHash } = await generateStudentCode();
    const student = await prisma.student.create({
      data: {
        userId: user.id,
        homeAcademyId: escazu.id,
        firstName: "SessionTest",
        lastName: label,
        phone: "88881234",
        email: `student-${label}-${suffix}@example.com`,
        codeHash,
        status,
      },
    });
    studentId = student.id;
  }

  return { user, studentId };
}

async function makeStaffUser(role: "ADMIN" | "DIRECTOR" | "INSTRUCTOR", label: string) {
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
  const user = await prisma.user.create({
    data: {
      email: `${label}-${suffix}@example.com`,
      passwordHash: await hashSecret("irrelevant-password-123"),
      role,
    },
  });
  cleanupUserIds.push(user.id);
  return user;
}

describe("getStudentSession / requireStudentSession", () => {
  afterAll(async () => {
    if (cleanupUserIds.length > 0) {
      await prisma.student.deleteMany({ where: { userId: { in: cleanupUserIds } } });
      await prisma.user.deleteMany({ where: { id: { in: cleanupUserIds } } });
    }
  });

  beforeEach(() => {
    currentSession = null;
  });

  it("resolves a STUDENT session with an ACTIVE linked Student row", async () => {
    const { user, studentId } = await makeStudentUser("ACTIVE", "active");
    currentSession = { user: { id: user.id, role: "STUDENT" } };

    const session = await getStudentSession();
    expect(session).toEqual({ userId: user.id, studentId, status: "ACTIVE" });
  });

  it("resolves a STUDENT session whose linked Student row is PENDING — login isn't gated on status", async () => {
    const { user, studentId } = await makeStudentUser("PENDING", "pending");
    currentSession = { user: { id: user.id, role: "STUDENT" } };

    const session = await getStudentSession();
    expect(session).toEqual({ userId: user.id, studentId, status: "PENDING" });
  });

  it("resolves a STUDENT session whose linked Student row is ARCHIVED — login isn't gated on status", async () => {
    const { user, studentId } = await makeStudentUser("ARCHIVED", "archived");
    currentSession = { user: { id: user.id, role: "STUDENT" } };

    const session = await getStudentSession();
    expect(session).toEqual({ userId: user.id, studentId, status: "ARCHIVED" });
  });

  it("fails closed when a stale JWT claims STUDENT but the User's real DB role has changed", async () => {
    // Promoted to staff since the token was issued: the JWT still claims
    // STUDENT, but the DB now says ADMIN.
    const promoted = await makeStaffUser("ADMIN", "promoted-from-student");
    currentSession = { user: { id: promoted.id, role: "STUDENT" } };

    expect(await getStudentSession()).toBeNull();
  });

  it("fails closed when a stale JWT claims STUDENT but the User is now inactive", async () => {
    const { user } = await makeStudentUser("ACTIVE", "deactivated", { active: false });
    currentSession = { user: { id: user.id, role: "STUDENT" } };

    expect(await getStudentSession()).toBeNull();
  });

  it("fails closed (rather than throwing) when a STUDENT user has no linked Student row", async () => {
    const { user } = await makeStudentUser("ACTIVE", "orphaned", { withStudentRow: false });
    currentSession = { user: { id: user.id, role: "STUDENT" } };

    expect(await getStudentSession()).toBeNull();
  });

  it("resolves null for a STAFF-role session — disjoint session types", async () => {
    const instructor = await makeStaffUser("INSTRUCTOR", "staff-not-student");
    currentSession = { user: { id: instructor.id, role: "INSTRUCTOR" } };

    expect(await getStudentSession()).toBeNull();
  });

  it("requireStudentSession() redirects to /login when no session exists", async () => {
    currentSession = null;

    await expect(requireStudentSession()).rejects.toMatchObject({
      digest: expect.stringContaining("/en/login"),
    });
  });
});
