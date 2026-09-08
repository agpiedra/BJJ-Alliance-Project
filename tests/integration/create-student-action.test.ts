import "dotenv/config";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "../../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { requireEnv } from "../../src/lib/env";
import { digestLookupSecret, hashSecret } from "../../src/lib/crypto";

// Same `auth()` mock as student-detail-actions.test.ts — see the long note
// there. Every session must name a real, active `User` row now that
// `getStaffSession()` re-validates role/active against the DB.
let currentSession: { user: { id: string; role: string } } | null = null;

vi.mock("@/auth", () => ({
  auth: () => Promise.resolve(currentSession),
}));

const { createStudent } = await import("../../src/app/[locale]/students/create-student-action");

const adapter = new PrismaPg({ connectionString: requireEnv("DATABASE_URL") });
const prisma = new PrismaClient({ adapter });
const pepper = requireEnv("CODE_PEPPER");

/** A sha256 hex digest — the exact shape `Student.codeHash` takes. */
const SHA256_HEX = /[0-9a-f]{64}/i;

const cleanupUserIds: string[] = [];
const cleanupStudentEmails: string[] = [];

function formData(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    fd.set(key, value);
  }
  return fd;
}

async function makeStaffUser(
  role: "ADMIN" | "DIRECTOR" | "INSTRUCTOR",
  label: string,
  academyId?: string,
) {
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
  const user = await prisma.user.create({
    data: {
      email: `${label}-${suffix}@example.com`,
      passwordHash: await hashSecret("irrelevant-password-123"),
      role,
    },
  });
  cleanupUserIds.push(user.id);
  if (academyId && role !== "ADMIN") {
    await prisma.staffAssignment.create({
      data: { userId: user.id, academyId, role: role === "DIRECTOR" ? "DIRECTOR" : "INSTRUCTOR" },
    });
  }
  return user;
}

function newStudentFields(academyId: string, label: string) {
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
  const email = `create-${label}-${suffix}@example.com`;
  cleanupStudentEmails.push(email);
  return {
    firstName: "CreateTest",
    lastName: label,
    phone: "88881234",
    email,
    homeAcademyId: academyId,
    currentBelt: "BLUE",
    currentStripes: "2",
  };
}

describe("createStudent", () => {
  afterAll(async () => {
    const students = await prisma.student.findMany({
      where: { email: { in: cleanupStudentEmails } },
      select: { id: true },
    });
    const studentIds = students.map((s) => s.id);
    await prisma.auditLog.deleteMany({
      where: { OR: [{ entityId: { in: studentIds } }, { actorId: { in: cleanupUserIds } }] },
    });
    if (studentIds.length > 0) {
      await prisma.student.deleteMany({ where: { id: { in: studentIds } } });
    }
    if (cleanupUserIds.length > 0) {
      await prisma.staffAssignment.deleteMany({ where: { userId: { in: cleanupUserIds } } });
      await prisma.user.deleteMany({ where: { id: { in: cleanupUserIds } } });
    }
  });

  beforeEach(() => {
    currentSession = null;
  });

  it("an ADMIN creates an ACTIVE student and the create is audited without leaking the codeHash", async () => {
    const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
    const admin = await makeStaffUser("ADMIN", "create-test-admin");
    const fields = newStudentFields(escazu.id, "AdminCreated");

    currentSession = { user: { id: admin.id, role: "ADMIN" } };
    const result = await createStudent({}, formData(fields));
    expect(result.ok).toBe(true);
    expect(result.code).toMatch(/^\d{4}$/);

    const student = await prisma.student.findFirstOrThrow({ where: { email: fields.email } });
    expect(student.status).toBe("ACTIVE");
    expect(student.userId).toBeNull();
    expect(student.codeHash).toBe(digestLookupSecret(result.code!, pepper));

    const audits = await prisma.auditLog.findMany({
      where: { entityId: student.id, action: "student.create" },
    });
    expect(audits).toHaveLength(1);
    expect(audits[0].entityType).toBe("Student");
    expect(audits[0].actorId).toBe(admin.id);
    expect(audits[0].academyId).toBe(escazu.id);
    expect(audits[0].before).toBeNull();
    expect(audits[0].after).toMatchObject({
      firstName: "CreateTest",
      lastName: "AdminCreated",
      homeAcademyId: escazu.id,
      currentBelt: "BLUE",
      currentStripes: 2,
      status: "ACTIVE",
    });
    // The check-in secret never enters the audit trail.
    const payload = JSON.stringify({ before: audits[0].before, after: audits[0].after });
    expect(payload).not.toMatch(SHA256_HEX);
    expect(payload).not.toContain(student.codeHash);
    expect(payload).not.toContain(result.code!);
  });

  // Finding 7: role-based rejection, committed rather than merely
  // "verified live". An INSTRUCTOR is staff and passes the middleware, but
  // createStudent is ADMIN/DIRECTOR-only and throws FORBIDDEN.
  it("rejects an INSTRUCTOR session with FORBIDDEN, creating nothing", async () => {
    const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
    const instructor = await makeStaffUser("INSTRUCTOR", "create-test-instructor", escazu.id);
    const fields = newStudentFields(escazu.id, "InstructorAttempt");

    currentSession = { user: { id: instructor.id, role: "INSTRUCTOR" } };
    await expect(createStudent({}, formData(fields))).rejects.toThrow("FORBIDDEN");

    expect(await prisma.student.findFirst({ where: { email: fields.email } })).toBeNull();
  });

  // Finding 7: a single-academy DIRECTOR submitting the OTHER academy's id.
  // The UI only ever offers in-scope academies; this proves the server-side
  // gate holds when the form field is tampered with directly.
  it("rejects a single-academy DIRECTOR submitting another academy's homeAcademyId", async () => {
    const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
    const escalante = await prisma.academy.findUniqueOrThrow({ where: { slug: "escalante" } });
    const escalanteDirector = await makeStaffUser(
      "DIRECTOR",
      "create-test-director",
      escalante.id,
    );

    // Tampered payload: an Escalante-only DIRECTOR naming Escazú.
    const tampered = newStudentFields(escazu.id, "CrossAcademyAttempt");
    currentSession = { user: { id: escalanteDirector.id, role: "DIRECTOR" } };
    const rejected = await createStudent({}, formData(tampered));
    expect(rejected.error).toBe("forbiddenAcademy");
    expect(rejected.fieldErrors?.homeAcademyId).toEqual(["forbiddenAcademy"]);
    expect(await prisma.student.findFirst({ where: { email: tampered.email } })).toBeNull();
    expect(
      await prisma.auditLog.count({ where: { actorId: escalanteDirector.id, action: "student.create" } }),
    ).toBe(0);

    // ...and the same DIRECTOR creating in their OWN academy still works,
    // so the rejection above is about scope, not about DIRECTORs.
    const allowed = newStudentFields(escalante.id, "OwnAcademy");
    const accepted = await createStudent({}, formData(allowed));
    expect(accepted.ok).toBe(true);
    const created = await prisma.student.findFirstOrThrow({ where: { email: allowed.email } });
    expect(created.homeAcademyId).toBe(escalante.id);
    expect(
      await prisma.auditLog.count({ where: { entityId: created.id, action: "student.create" } }),
    ).toBe(1);
  });
});
