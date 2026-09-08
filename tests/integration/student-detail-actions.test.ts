import "dotenv/config";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "../../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { requireEnv } from "../../src/lib/env";
import { digestLookupSecret, hashSecret } from "../../src/lib/crypto";

// `getStudentForStaff` / `updateStudent` / `archiveStudent` /
// `regenerateStudentCode` all reach `requireStaffSession()` ->
// `getStaffSession()` -> next-auth's `auth()`, which needs a real HTTP
// request's cookies to resolve a JWT session — unavailable in a plain
// integration test. Mocking `@/auth`'s `auth()` lets these Server Actions be
// exercised directly (matching this repo's existing pattern of testing
// action-shaped logic against the real DB) while still using a real
// `StaffAssignment` row underneath so `getStaffSession()`'s own DB query
// runs unmodified.
let currentSession: { user: { id: string; role: string } } | null = null;

vi.mock("@/auth", () => ({
  auth: () => Promise.resolve(currentSession),
}));

const { getStudentForStaff } = await import("../../src/app/[locale]/students/[id]/get-student");
const { updateStudent, archiveStudent, regenerateStudentCode } = await import(
  "../../src/app/[locale]/students/[id]/actions"
);
const { getStaffSession } = await import("../../src/lib/auth/session");

const adapter = new PrismaPg({ connectionString: requireEnv("DATABASE_URL") });
const prisma = new PrismaClient({ adapter });
const pepper = requireEnv("CODE_PEPPER");

function formData(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    fd.set(key, value);
  }
  return fd;
}

describe("student detail actions — every write independently re-verifies academy scope", () => {
  const cleanupUserIds: string[] = [];
  const cleanupStudentIds: string[] = [];

  afterAll(async () => {
    if (cleanupStudentIds.length > 0) {
      await prisma.student.deleteMany({ where: { id: { in: cleanupStudentIds } } });
    }
    if (cleanupUserIds.length > 0) {
      await prisma.staffAssignment.deleteMany({ where: { userId: { in: cleanupUserIds } } });
      await prisma.user.deleteMany({ where: { id: { in: cleanupUserIds } } });
    }
  });

  beforeEach(() => {
    currentSession = null;
  });

  it("verifies scope end to end: ADMIN and an in-scope INSTRUCTOR succeed, an out-of-scope DIRECTOR is turned back as not-found on every read and write", async () => {
    const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
    const escalante = await prisma.academy.findUniqueOrThrow({ where: { slug: "escalante" } });
    const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;

    // A DIRECTOR assigned ONLY to Escalante — used to prove the out-of-scope
    // path (this session must never see or mutate an Escazú student).
    const outOfScopeDirector = await prisma.user.create({
      data: {
        email: `detail-test-director-${suffix}@example.com`,
        passwordHash: await hashSecret("irrelevant-password-123"),
        role: "DIRECTOR",
      },
    });
    cleanupUserIds.push(outOfScopeDirector.id);
    await prisma.staffAssignment.create({
      data: { userId: outOfScopeDirector.id, academyId: escalante.id, role: "DIRECTOR" },
    });

    // An INSTRUCTOR assigned to Escazú — proves regenerateStudentCode has no
    // role restriction (spec §4.1), unlike update/archive.
    const inScopeInstructor = await prisma.user.create({
      data: {
        email: `detail-test-instructor-${suffix}@example.com`,
        passwordHash: await hashSecret("irrelevant-password-123"),
        role: "INSTRUCTOR",
      },
    });
    cleanupUserIds.push(inScopeInstructor.id);
    await prisma.staffAssignment.create({
      data: { userId: inScopeInstructor.id, academyId: escazu.id, role: "INSTRUCTOR" },
    });

    const originalCodeHash = digestLookupSecret(`detail-test-${suffix}`, pepper);
    const student = await prisma.student.create({
      data: {
        homeAcademyId: escazu.id,
        firstName: "DetailTest",
        lastName: "Original",
        phone: "88880099",
        email: `detail-test-${suffix}@example.com`,
        currentBelt: "WHITE",
        currentStripes: 1,
        codeHash: originalCodeHash,
      },
    });
    cleanupStudentIds.push(student.id);

    // --- getStudentForStaff: out-of-scope sees null, ADMIN sees the row ---
    currentSession = { user: { id: outOfScopeDirector.id, role: "DIRECTOR" } };
    const outOfScopeSession = await getStaffSession();
    expect(outOfScopeSession).not.toBeNull();
    await expect(getStudentForStaff(outOfScopeSession!, student.id)).resolves.toBeNull();

    const adminSession = { userId: "admin-x", role: "ADMIN" as const, academyIds: "ALL" as const };
    const found = await getStudentForStaff(adminSession, student.id);
    expect(found?.id).toBe(student.id);

    // --- updateStudent: out-of-scope DIRECTOR is rejected, row untouched ---
    currentSession = { user: { id: outOfScopeDirector.id, role: "DIRECTOR" } };
    const rejectedUpdate = await updateStudent(
      {},
      formData({
        studentId: student.id,
        firstName: "Hacked",
        lastName: "ShouldNotLand",
        phone: "00000000",
        email: `hacked-${suffix}@example.com`,
        currentBelt: "BLACK",
        currentStripes: "4",
      }),
    );
    expect(rejectedUpdate.error).toBe("notFound");
    const afterRejectedUpdate = await prisma.student.findUniqueOrThrow({ where: { id: student.id } });
    expect(afterRejectedUpdate.firstName).toBe("DetailTest");
    expect(afterRejectedUpdate.currentBelt).toBe("WHITE");

    // --- updateStudent: ADMIN (in scope) succeeds ---
    currentSession = { user: { id: "admin-x", role: "ADMIN" } };
    const acceptedUpdate = await updateStudent(
      {},
      formData({
        studentId: student.id,
        firstName: "DetailTest",
        lastName: "Updated",
        phone: "88880100",
        email: `detail-test-updated-${suffix}@example.com`,
        currentBelt: "BLUE",
        currentStripes: "2",
      }),
    );
    expect(acceptedUpdate.ok).toBe(true);
    const afterAcceptedUpdate = await prisma.student.findUniqueOrThrow({ where: { id: student.id } });
    expect(afterAcceptedUpdate.lastName).toBe("Updated");
    expect(afterAcceptedUpdate.currentBelt).toBe("BLUE");
    expect(afterAcceptedUpdate.currentStripes).toBe(2);

    // --- archiveStudent: out-of-scope DIRECTOR is rejected, status untouched ---
    currentSession = { user: { id: outOfScopeDirector.id, role: "DIRECTOR" } };
    const rejectedArchive = await archiveStudent({}, formData({ studentId: student.id }));
    expect(rejectedArchive.error).toBe("notFound");
    const afterRejectedArchive = await prisma.student.findUniqueOrThrow({ where: { id: student.id } });
    expect(afterRejectedArchive.status).not.toBe("ARCHIVED");

    // --- regenerateStudentCode: out-of-scope DIRECTOR is rejected, codeHash untouched ---
    const rejectedRegenerate = await regenerateStudentCode({}, formData({ studentId: student.id }));
    expect(rejectedRegenerate.error).toBe("notFound");
    const afterRejectedRegenerate = await prisma.student.findUniqueOrThrow({ where: { id: student.id } });
    expect(afterRejectedRegenerate.codeHash).toBe(originalCodeHash);

    // --- regenerateStudentCode: any in-scope staff role (INSTRUCTOR here) succeeds ---
    currentSession = { user: { id: inScopeInstructor.id, role: "INSTRUCTOR" } };
    const acceptedRegenerate = await regenerateStudentCode({}, formData({ studentId: student.id }));
    expect(acceptedRegenerate.ok).toBe(true);
    expect(acceptedRegenerate.code).toMatch(/^\d{4}$/);
    const afterAcceptedRegenerate = await prisma.student.findUniqueOrThrow({ where: { id: student.id } });
    expect(afterAcceptedRegenerate.codeHash).not.toBe(originalCodeHash);
    expect(afterAcceptedRegenerate.codeHash).toBe(digestLookupSecret(acceptedRegenerate.code!, pepper));

    // --- archiveStudent: ADMIN (in scope) succeeds — status flips, row still exists ---
    currentSession = { user: { id: "admin-x", role: "ADMIN" } };
    const acceptedArchive = await archiveStudent({}, formData({ studentId: student.id }));
    expect(acceptedArchive.ok).toBe(true);
    const afterAcceptedArchive = await prisma.student.findUnique({ where: { id: student.id } });
    expect(afterAcceptedArchive).not.toBeNull();
    expect(afterAcceptedArchive!.status).toBe("ARCHIVED");
  });
});
