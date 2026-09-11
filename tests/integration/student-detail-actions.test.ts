import "dotenv/config";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "../../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { requireEnv } from "../../src/lib/env";
import { digestLookupSecret, hashSecret } from "../../src/lib/crypto";
import { toAttendanceDate } from "../../src/lib/scheduling/zone";

const DAY_MS = 24 * 60 * 60 * 1000;

// `getStudentForStaff` / `updateStudent` / `archiveStudent` /
// `approveStudent` / `regenerateStudentCode` all reach
// `requireStaffSession()` -> `getStaffSession()` -> next-auth's `auth()`,
// which needs a real HTTP request's cookies to resolve a JWT session —
// unavailable in a plain integration test. Mocking `@/auth`'s `auth()` lets
// these Server Actions be exercised directly (matching this repo's existing
// pattern of testing action-shaped logic against the real DB) while still
// using real `User` / `StaffAssignment` rows underneath so
// `getStaffSession()`'s own DB queries run unmodified.
//
// NOTE: every session below must name a user id that genuinely exists and is
// `active`, because `getStaffSession()` now re-reads `role`/`active` from the
// DB on every call and fails closed on a mismatch — a made-up id no longer
// resolves to a session at all.
let currentSession: { user: { id: string; role: string } } | null = null;

vi.mock("@/auth", () => ({
  auth: () => Promise.resolve(currentSession),
}));

const { getStudentForStaff } = await import("../../src/app/[locale]/(staff)/students/[id]/get-student");
const { updateStudent, archiveStudent, approveStudent, regenerateStudentCode } = await import(
  "../../src/app/[locale]/(staff)/students/[id]/actions"
);
const { addAttendanceAdjustment } = await import(
  "../../src/app/[locale]/(staff)/students/[id]/adjustment-actions"
);
const { getStaffSession } = await import("../../src/lib/auth/session");
const { getAtBeltSummary } = await import("../../src/lib/students/attendance-summary");

const adapter = new PrismaPg({ connectionString: requireEnv("DATABASE_URL") });
const prisma = new PrismaClient({ adapter });
const pepper = requireEnv("CODE_PEPPER");

/** A sha256 hex digest — the exact shape `Student.codeHash` takes. */
const SHA256_HEX = /[0-9a-f]{64}/i;

function formData(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    fd.set(key, value);
  }
  return fd;
}

const cleanupUserIds: string[] = [];
const cleanupStudentIds: string[] = [];

async function cleanup() {
  // AuditLog and AttendanceRecord rows FK to both User and Student — clear
  // them first or the deletes below fail.
  if (cleanupStudentIds.length > 0 || cleanupUserIds.length > 0) {
    await prisma.auditLog.deleteMany({
      where: {
        OR: [{ entityId: { in: cleanupStudentIds } }, { actorId: { in: cleanupUserIds } }],
      },
    });
    await prisma.attendanceRecord.deleteMany({
      where: {
        OR: [{ studentId: { in: cleanupStudentIds } }, { createdById: { in: cleanupUserIds } }],
      },
    });
  }
  if (cleanupStudentIds.length > 0) {
    await prisma.student.deleteMany({ where: { id: { in: cleanupStudentIds } } });
  }
  if (cleanupUserIds.length > 0) {
    await prisma.staffAssignment.deleteMany({ where: { userId: { in: cleanupUserIds } } });
    await prisma.user.deleteMany({ where: { id: { in: cleanupUserIds } } });
  }
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

async function makeStudent(
  academyId: string,
  overrides: Partial<{
    status: "PENDING" | "ACTIVE" | "INACTIVE" | "ARCHIVED";
    lastName: string;
    currentBelt: "WHITE" | "BLUE" | "PURPLE" | "BROWN" | "BLACK";
    currentStripes: number;
    beltAwardedAt: Date;
  }> = {},
) {
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
  const student = await prisma.student.create({
    data: {
      homeAcademyId: academyId,
      firstName: "DetailTest",
      lastName: overrides.lastName ?? "Original",
      phone: "88880099",
      email: `detail-test-${suffix}@example.com`,
      currentBelt: overrides.currentBelt ?? "PURPLE",
      currentStripes: overrides.currentStripes ?? 1,
      codeHash: digestLookupSecret(`detail-test-${suffix}`, pepper),
      ...(overrides.status ? { status: overrides.status } : {}),
      ...(overrides.beltAwardedAt ? { beltAwardedAt: overrides.beltAwardedAt } : {}),
    },
  });
  cleanupStudentIds.push(student.id);
  return student;
}

/** Writes `count` real CHECKIN rows, one per day starting at `startAt` — the
 * same shape `tests/integration/attendance-summary.test.ts` uses to build up
 * atBeltCount toward a stripe threshold. */
async function addCheckins(studentId: string, academyId: string, count: number, startAt: Date) {
  const rows = Array.from({ length: count }, (_, i) => {
    const occurredAt = new Date(startAt.getTime() + i * DAY_MS);
    return {
      studentId,
      academyId,
      occurredAt,
      date: toAttendanceDate(occurredAt),
      type: "CHECKIN" as const,
      delta: 1,
      source: "STAFF" as const,
    };
  });
  await prisma.attendanceRecord.createMany({ data: rows });
}

function auditRowsFor(studentId: string, action: string) {
  return prisma.auditLog.findMany({
    where: { entityId: studentId, action },
    orderBy: { createdAt: "asc" },
  });
}

describe("student detail actions", () => {
  afterAll(cleanup);

  beforeEach(() => {
    currentSession = null;
  });

  it("verifies scope end to end: ADMIN and an in-scope INSTRUCTOR succeed, an out-of-scope DIRECTOR is turned back as not-found on every read and write", async () => {
    const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
    const escalante = await prisma.academy.findUniqueOrThrow({ where: { slug: "escalante" } });

    // A DIRECTOR assigned ONLY to Escalante — used to prove the out-of-scope
    // path (this session must never see or mutate an Escazú student).
    const outOfScopeDirector = await makeStaffUser("DIRECTOR", "detail-test-director", escalante.id);

    // An INSTRUCTOR assigned to Escazú — proves regenerateStudentCode has no
    // role restriction (spec §4.1), unlike update/archive.
    const inScopeInstructor = await makeStaffUser("INSTRUCTOR", "detail-test-instructor", escazu.id);

    const admin = await makeStaffUser("ADMIN", "detail-test-admin");

    const student = await makeStudent(escazu.id);
    const originalCodeHash = student.codeHash;

    // --- getStudentForStaff: out-of-scope sees null, ADMIN sees the row ---
    currentSession = { user: { id: outOfScopeDirector.id, role: "DIRECTOR" } };
    const outOfScopeSession = await getStaffSession();
    expect(outOfScopeSession).not.toBeNull();
    await expect(getStudentForStaff(outOfScopeSession!, student.id)).resolves.toBeNull();

    currentSession = { user: { id: admin.id, role: "ADMIN" } };
    const adminSession = await getStaffSession();
    expect(adminSession).not.toBeNull();
    const found = await getStudentForStaff(adminSession!, student.id);
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
        email: `hacked-${student.id}@example.com`,
      }),
    );
    expect(rejectedUpdate.error).toBe("notFound");
    const afterRejectedUpdate = await prisma.student.findUniqueOrThrow({ where: { id: student.id } });
    expect(afterRejectedUpdate.firstName).toBe("DetailTest");
    // A rejected write leaves NO audit row behind.
    expect(await auditRowsFor(student.id, "student.update")).toHaveLength(0);

    // --- updateStudent: ADMIN (in scope) succeeds ---
    currentSession = { user: { id: admin.id, role: "ADMIN" } };
    const acceptedUpdate = await updateStudent(
      {},
      formData({
        studentId: student.id,
        firstName: "DetailTest",
        lastName: "Updated",
        phone: "88880100",
        email: `detail-test-updated-${student.id}@example.com`,
      }),
    );
    expect(acceptedUpdate.ok).toBe(true);
    const afterAcceptedUpdate = await prisma.student.findUniqueOrThrow({ where: { id: student.id } });
    expect(afterAcceptedUpdate.lastName).toBe("Updated");
    expect(afterAcceptedUpdate.phone).toBe("88880100");

    // Belt/stripes are no longer editable through this form at all — even a
    // hand-crafted payload naming them is ignored, since the zod schema
    // strips unknown keys and the update data object never reads them.
    const beltTamper = await updateStudent(
      {},
      formData({
        studentId: student.id,
        firstName: "DetailTest",
        lastName: "Updated",
        phone: "88880100",
        email: `detail-test-updated-${student.id}@example.com`,
        currentBelt: "BLACK",
        currentStripes: "4",
      }),
    );
    expect(beltTamper.ok).toBe(true);
    const afterBeltTamper = await prisma.student.findUniqueOrThrow({ where: { id: student.id } });
    expect(afterBeltTamper.currentBelt).toBe("PURPLE");
    expect(afterBeltTamper.currentStripes).toBe(1);

    // --- the successful updates each wrote an audit row ---
    const updateAudits = await auditRowsFor(student.id, "student.update");
    expect(updateAudits).toHaveLength(2);
    const firstUpdateAudit = updateAudits[0];
    expect(firstUpdateAudit.entityType).toBe("Student");
    expect(firstUpdateAudit.entityId).toBe(student.id);
    expect(firstUpdateAudit.actorId).toBe(admin.id);
    expect(firstUpdateAudit.academyId).toBe(escazu.id);
    expect(firstUpdateAudit.before).toMatchObject({ lastName: "Original", phone: "88880099" });
    expect(firstUpdateAudit.after).toMatchObject({ lastName: "Updated", phone: "88880100" });
    // The snapshot never carries the check-in secret.
    expect(JSON.stringify(firstUpdateAudit.before)).not.toMatch(SHA256_HEX);
    expect(JSON.stringify(firstUpdateAudit.after)).not.toMatch(SHA256_HEX);

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

    // --- and it audited the event WITHOUT leaking either codeHash ---
    const regenerateAudits = await auditRowsFor(student.id, "student.regenerateCode");
    expect(regenerateAudits).toHaveLength(1);
    const regenerateAudit = regenerateAudits[0];
    expect(regenerateAudit.entityType).toBe("Student");
    expect(regenerateAudit.entityId).toBe(student.id);
    expect(regenerateAudit.actorId).toBe(inScopeInstructor.id);
    // This is the whole point of the assertion: neither the old nor the new
    // codeHash may appear anywhere in the audit payload, in any form.
    const regeneratePayload = JSON.stringify({
      before: regenerateAudit.before,
      after: regenerateAudit.after,
    });
    expect(regeneratePayload).not.toMatch(SHA256_HEX);
    expect(regeneratePayload).not.toContain(originalCodeHash);
    expect(regeneratePayload).not.toContain(afterAcceptedRegenerate.codeHash);
    expect(regeneratePayload).not.toContain(acceptedRegenerate.code!);

    // --- archiveStudent: ADMIN (in scope) succeeds — status flips, row still exists ---
    currentSession = { user: { id: admin.id, role: "ADMIN" } };
    const acceptedArchive = await archiveStudent({}, formData({ studentId: student.id }));
    expect(acceptedArchive.ok).toBe(true);
    const afterAcceptedArchive = await prisma.student.findUnique({ where: { id: student.id } });
    expect(afterAcceptedArchive).not.toBeNull();
    expect(afterAcceptedArchive!.status).toBe("ARCHIVED");

    const archiveAudits = await auditRowsFor(student.id, "student.archive");
    expect(archiveAudits).toHaveLength(1);
    expect(archiveAudits[0].entityType).toBe("Student");
    expect(archiveAudits[0].actorId).toBe(admin.id);
    // `before` is the row's REAL prior status read fresh from the DB, not an
    // assumption — this student was created with the schema's PENDING default.
    expect(archiveAudits[0].before).toMatchObject({ status: afterRejectedArchive.status });
    expect(archiveAudits[0].after).toMatchObject({ status: "ARCHIVED" });
  });

  it("approveStudent flips PENDING -> ACTIVE, audits it, and refuses any other starting status", async () => {
    const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
    const admin = await makeStaffUser("ADMIN", "approve-test-admin");
    const pendingStudent = await makeStudent(escazu.id, { status: "PENDING", lastName: "Pending" });

    currentSession = { user: { id: admin.id, role: "ADMIN" } };
    const approved = await approveStudent({}, formData({ studentId: pendingStudent.id }));
    expect(approved.ok).toBe(true);

    const afterApproval = await prisma.student.findUniqueOrThrow({ where: { id: pendingStudent.id } });
    expect(afterApproval.status).toBe("ACTIVE");

    const approveAudits = await auditRowsFor(pendingStudent.id, "student.approve");
    expect(approveAudits).toHaveLength(1);
    expect(approveAudits[0].entityType).toBe("Student");
    expect(approveAudits[0].entityId).toBe(pendingStudent.id);
    expect(approveAudits[0].actorId).toBe(admin.id);
    expect(approveAudits[0].academyId).toBe(escazu.id);
    expect(approveAudits[0].before).toMatchObject({ status: "PENDING" });
    expect(approveAudits[0].after).toMatchObject({ status: "ACTIVE" });

    // Approving again (now ACTIVE) is refused, and writes no second audit row.
    const secondApproval = await approveStudent({}, formData({ studentId: pendingStudent.id }));
    expect(secondApproval.error).toBe("notPending");
    expect(await auditRowsFor(pendingStudent.id, "student.approve")).toHaveLength(1);

    // An ARCHIVED student can't be quietly resurrected through this path.
    const archivedStudent = await makeStudent(escazu.id, { status: "ARCHIVED", lastName: "Archived" });
    const archivedApproval = await approveStudent({}, formData({ studentId: archivedStudent.id }));
    expect(archivedApproval.error).toBe("notPending");
    expect(
      (await prisma.student.findUniqueOrThrow({ where: { id: archivedStudent.id } })).status,
    ).toBe("ARCHIVED");
  });

  it("an out-of-scope DIRECTOR cannot approve another academy's PENDING student", async () => {
    const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
    const escalante = await prisma.academy.findUniqueOrThrow({ where: { slug: "escalante" } });
    const director = await makeStaffUser("DIRECTOR", "approve-scope-director", escalante.id);
    const student = await makeStudent(escazu.id, { status: "PENDING", lastName: "OtherAcademy" });

    currentSession = { user: { id: director.id, role: "DIRECTOR" } };
    const rejected = await approveStudent({}, formData({ studentId: student.id }));
    expect(rejected.error).toBe("notFound");
    expect((await prisma.student.findUniqueOrThrow({ where: { id: student.id } })).status).toBe(
      "PENDING",
    );
    expect(await auditRowsFor(student.id, "student.approve")).toHaveLength(0);
  });

  // ROLE-based rejection, distinct from the academy-scope rejections above:
  // an INSTRUCTOR who is genuinely IN SCOPE for the student still must not
  // reach the ADMIN/DIRECTOR-only writes. `requireStaffSession` throws a raw
  // `Error("FORBIDDEN")` for this (caught by `src/app/[locale]/error.tsx` in
  // the real app), so these assert a throw rather than an error state.
  describe("role-based rejection — an in-scope INSTRUCTOR is refused the ADMIN/DIRECTOR-only writes", () => {
    it("rejects updateStudent, archiveStudent and approveStudent with FORBIDDEN, mutating nothing", async () => {
      const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
      const instructor = await makeStaffUser("INSTRUCTOR", "role-reject-instructor", escazu.id);
      const student = await makeStudent(escazu.id, { status: "PENDING", lastName: "RoleReject" });

      currentSession = { user: { id: instructor.id, role: "INSTRUCTOR" } };

      await expect(
        updateStudent(
          {},
          formData({
            studentId: student.id,
            firstName: "InstructorEdit",
            lastName: "ShouldNotLand",
            phone: "00000000",
            email: `instructor-edit-${student.id}@example.com`,
          }),
        ),
      ).rejects.toThrow("FORBIDDEN");

      await expect(archiveStudent({}, formData({ studentId: student.id }))).rejects.toThrow(
        "FORBIDDEN",
      );

      await expect(approveStudent({}, formData({ studentId: student.id }))).rejects.toThrow(
        "FORBIDDEN",
      );

      const untouched = await prisma.student.findUniqueOrThrow({ where: { id: student.id } });
      expect(untouched.firstName).toBe("DetailTest");
      expect(untouched.lastName).toBe("RoleReject");
      expect(untouched.status).toBe("PENDING");
      expect(await prisma.auditLog.count({ where: { entityId: student.id } })).toBe(0);
    });
  });

  // Finding 6: the JWT lives for up to 30 days, so `role`/`active` in it are
  // a snapshot from login time. `getStaffSession` must re-read both from the
  // DB on every call and fail closed.
  describe("stale JWT claims are re-validated against the database on every call", () => {
    it("returns null once the user is deactivated, even though the JWT's role claim is still staff", async () => {
      const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
      const director = await makeStaffUser("DIRECTOR", "stale-session-director", escazu.id);

      // Still active: a normal session resolves.
      currentSession = { user: { id: director.id, role: "DIRECTOR" } };
      expect(await getStaffSession()).toMatchObject({ userId: director.id, role: "DIRECTOR" });

      // Deactivated after "login" — the JWT is unchanged and still claims
      // DIRECTOR, but the session must now fail closed.
      await prisma.user.update({ where: { id: director.id }, data: { active: false } });
      expect(await getStaffSession()).toBeNull();
    });

    it("returns null for a deactivated ADMIN too — the branch that previously never touched the DB", async () => {
      const admin = await makeStaffUser("ADMIN", "stale-session-admin");

      currentSession = { user: { id: admin.id, role: "ADMIN" } };
      expect(await getStaffSession()).toMatchObject({ userId: admin.id, role: "ADMIN", academyIds: "ALL" });

      await prisma.user.update({ where: { id: admin.id }, data: { active: false } });
      expect(await getStaffSession()).toBeNull();
    });

    it("returns null when the DB role no longer matches the JWT's claimed role (a demotion)", async () => {
      const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
      const demoted = await makeStaffUser("ADMIN", "stale-session-demoted");

      currentSession = { user: { id: demoted.id, role: "ADMIN" } };
      expect(await getStaffSession()).not.toBeNull();

      // Demoted to INSTRUCTOR. The stale token still claims ADMIN — that
      // claim must be refused outright, not silently downgraded.
      await prisma.user.update({ where: { id: demoted.id }, data: { role: "INSTRUCTOR" } });
      await prisma.staffAssignment.create({
        data: { userId: demoted.id, academyId: escazu.id, role: "INSTRUCTOR" },
      });
      expect(await getStaffSession()).toBeNull();

      // A freshly-issued token claiming their real, current role works again.
      currentSession = { user: { id: demoted.id, role: "INSTRUCTOR" } };
      expect(await getStaffSession()).toMatchObject({
        userId: demoted.id,
        role: "INSTRUCTOR",
        academyIds: [escazu.id],
      });
    });

    it("returns null when the JWT names a user that no longer exists", async () => {
      currentSession = { user: { id: "this-user-id-does-not-exist", role: "ADMIN" } };
      expect(await getStaffSession()).toBeNull();
    });
  });

  // Task 8: addAttendanceAdjustment. Unlike updateStudent/archiveStudent
  // (ADMIN/DIRECTOR only), spec §3 grants attendance marking/correction to
  // INSTRUCTOR too — this is the one write in this file an in-scope
  // INSTRUCTOR is genuinely allowed to make.
  describe("addAttendanceAdjustment", () => {
    it("a positive adjustment increases atBeltCount, verified via getAtBeltSummary", async () => {
      const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
      const admin = await makeStaffUser("ADMIN", "adj-positive-admin");
      const student = await makeStudent(escazu.id, { lastName: "AdjPositive" });

      const before = await getAtBeltSummary(student.id);

      currentSession = { user: { id: admin.id, role: "ADMIN" } };
      const result = await addAttendanceAdjustment(
        {},
        formData({ studentId: student.id, delta: "3", reason: "makeup classes" }),
      );
      expect(result.ok).toBe(true);

      const after = await getAtBeltSummary(student.id);
      expect(after.atBeltCount).toBe(before.atBeltCount + 3);
      expect(after.lifetimeCount).toBe(before.lifetimeCount + 3);

      const audits = await auditRowsFor(
        (await prisma.attendanceRecord.findFirstOrThrow({
          where: { studentId: student.id, type: "ADJUSTMENT" },
        })).id,
        "attendance.adjustment",
      );
      expect(audits).toHaveLength(1);
      expect(audits[0].entityType).toBe("AttendanceRecord");
      expect(audits[0].actorId).toBe(admin.id);
      expect(audits[0].academyId).toBe(escazu.id);
      expect(audits[0].before).toBeNull();
      expect(audits[0].after).toMatchObject({ delta: 3, reason: "makeup classes" });
    });

    it("a negative adjustment decreases atBeltCount and can bring a student back below a threshold already crossed", async () => {
      const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
      const admin = await makeStaffUser("ADMIN", "adj-negative-admin");
      const beltAwardedAt = new Date("2026-03-01T12:00:00Z");
      // WHITE requires 30 attendancesPerStripe (see prisma/seed) — 30
      // CHECKIN rows crosses the first-stripe threshold exactly.
      const student = await makeStudent(escazu.id, {
        lastName: "AdjNegative",
        currentBelt: "WHITE",
        currentStripes: 0,
        beltAwardedAt,
      });

      await addCheckins(student.id, escazu.id, 30, new Date(beltAwardedAt.getTime() + DAY_MS));
      const crossed = await getAtBeltSummary(student.id);
      expect(crossed.atBeltCount).toBe(30);
      expect(crossed.remainingToNextStripe).toBe(0);

      currentSession = { user: { id: admin.id, role: "ADMIN" } };
      const result = await addAttendanceAdjustment(
        {},
        formData({ studentId: student.id, delta: "-5", reason: "duplicate check-ins removed" }),
      );
      expect(result.ok).toBe(true);

      // Back below the threshold it had just crossed.
      const after = await getAtBeltSummary(student.id);
      expect(after.atBeltCount).toBe(25);
      expect(after.remainingToNextStripe).toBe(5);
    });

    it("an in-scope INSTRUCTOR can successfully add an adjustment — the one write in this file INSTRUCTOR is allowed to make", async () => {
      const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
      const instructor = await makeStaffUser("INSTRUCTOR", "adj-instructor", escazu.id);
      const student = await makeStudent(escazu.id, { lastName: "AdjInstructor" });

      currentSession = { user: { id: instructor.id, role: "INSTRUCTOR" } };
      const result = await addAttendanceAdjustment(
        {},
        formData({ studentId: student.id, delta: "1", reason: "instructor correction" }),
      );
      expect(result.ok).toBe(true);

      const record = await prisma.attendanceRecord.findFirstOrThrow({
        where: { studentId: student.id, type: "ADJUSTMENT" },
      });
      expect(record.createdById).toBe(instructor.id);
      expect(record.academyId).toBe(escazu.id);
      expect(record.delta).toBe(1);
    });

    it("an out-of-scope DIRECTOR is rejected with notFound, and no AttendanceRecord is created", async () => {
      const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
      const escalante = await prisma.academy.findUniqueOrThrow({ where: { slug: "escalante" } });
      const outOfScopeDirector = await makeStaffUser("DIRECTOR", "adj-scope-director", escalante.id);
      const student = await makeStudent(escazu.id, { lastName: "AdjScope" });

      const countBefore = await prisma.attendanceRecord.count({ where: { studentId: student.id } });

      currentSession = { user: { id: outOfScopeDirector.id, role: "DIRECTOR" } };
      const result = await addAttendanceAdjustment(
        {},
        formData({ studentId: student.id, delta: "2", reason: "should not land" }),
      );
      expect(result.error).toBe("notFound");

      const countAfter = await prisma.attendanceRecord.count({ where: { studentId: student.id } });
      expect(countAfter).toBe(countBefore);
    });

    it("a missing or empty reason is rejected by zod validation before any DB write", async () => {
      const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
      const admin = await makeStaffUser("ADMIN", "adj-invalid-admin");
      const student = await makeStudent(escazu.id, { lastName: "AdjInvalid" });

      const countBefore = await prisma.attendanceRecord.count({ where: { studentId: student.id } });

      currentSession = { user: { id: admin.id, role: "ADMIN" } };

      // Missing `reason` entirely.
      const missingReason = await addAttendanceAdjustment(
        {},
        formData({ studentId: student.id, delta: "1" }),
      );
      expect(missingReason.error).toBe("invalid");
      expect(missingReason.fieldErrors?.reason).toBeTruthy();

      // Present but empty.
      const emptyReason = await addAttendanceAdjustment(
        {},
        formData({ studentId: student.id, delta: "1", reason: "" }),
      );
      expect(emptyReason.error).toBe("invalid");
      expect(emptyReason.fieldErrors?.reason).toBeTruthy();

      const countAfter = await prisma.attendanceRecord.count({ where: { studentId: student.id } });
      expect(countAfter).toBe(countBefore);
    });
  });
});
