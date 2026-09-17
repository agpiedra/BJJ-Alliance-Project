import "dotenv/config";
import { getTestPrismaClient } from "../helpers/test-db";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { requireEnv } from "../../src/lib/env";
import { digestLookupSecret, hashSecret } from "../../src/lib/crypto";
import { adultRankId } from "../helpers/belt-ranks";
import { ALLIANCE_ATTENDANCE_CONFIG } from "../helpers/promotion-config";

// Same `auth()` mock as student-detail-actions.test.ts / create-student-action.test.ts.
let currentSession: { user: { id: string; role: string } | null; activeOrganizationId?: string } | null = null;

vi.mock("@/auth", () => ({
  auth: () => Promise.resolve(currentSession),
}));

const { adjustPromotionCredit } = await import(
  "../../src/app/[locale]/(staff)/students/[id]/promotion-credit-actions"
);
const { getAtBeltSummary } = await import("../../src/lib/students/attendance-summary");

const prisma = getTestPrismaClient();
const pepper = requireEnv("CODE_PEPPER");

function formData(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    fd.set(key, value);
  }
  return fd;
}

let allianceOrgIdPromise: Promise<string> | null = null;
function getAllianceOrganizationId() {
  allianceOrgIdPromise ??= prisma.organization.findUniqueOrThrow({ where: { slug: "alliance-cr" } }).then((o) => o.id);
  return allianceOrgIdPromise;
}

const cleanupUserIds: string[] = [];
const cleanupStudentIds: string[] = [];

async function cleanup() {
  await prisma.promotionCredit.deleteMany({
    where: { OR: [{ studentId: { in: cleanupStudentIds } }, { grantedById: { in: cleanupUserIds } }] },
  });
  await prisma.auditLog.deleteMany({
    where: { OR: [{ entityId: { in: cleanupStudentIds } }, { actorId: { in: cleanupUserIds } }] },
  });
  if (cleanupStudentIds.length > 0) {
    await prisma.student.deleteMany({ where: { id: { in: cleanupStudentIds } } });
  }
  if (cleanupUserIds.length > 0) {
    await prisma.organizationMembership.deleteMany({ where: { userId: { in: cleanupUserIds } } });
    await prisma.staffAssignment.deleteMany({ where: { userId: { in: cleanupUserIds } } });
    await prisma.user.deleteMany({ where: { id: { in: cleanupUserIds } } });
  }
}

async function makeStaffUser(role: "ADMIN" | "DIRECTOR" | "INSTRUCTOR" | "STUDENT", label: string, academyId?: string) {
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
  const user = await prisma.user.create({
    data: { email: `${label}-${suffix}@example.com`, passwordHash: await hashSecret("irrelevant-password-123"), role },
  });
  cleanupUserIds.push(user.id);

  const organizationId = academyId
    ? (await prisma.academy.findUniqueOrThrow({ where: { id: academyId }, select: { organizationId: true } }))
        .organizationId
    : await getAllianceOrganizationId();

  await prisma.organizationMembership.create({ data: { userId: user.id, organizationId, role } });

  if (academyId && role !== "ADMIN" && role !== "STUDENT") {
    await prisma.staffAssignment.create({
      data: { userId: user.id, academyId, organizationId, role: role === "DIRECTOR" ? "DIRECTOR" : "INSTRUCTOR" },
    });
  }
  return { ...user, organizationId };
}

async function makeStudent(
  academyId: string,
  organizationId: string,
  overrides: { status?: "ACTIVE" | "ARCHIVED"; beltAwardedAt?: Date } = {},
) {
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
  const student = await prisma.student.create({
    data: {
      homeAcademyId: academyId,
      organizationId,
      firstName: "CreditActionTest",
      lastName: "Student",
      phone: "88880040",
      email: `credit-action-${suffix}@example.com`,
      currentRankId: adultRankId("WHITE"),
      currentStripes: 0,
      codeHash: digestLookupSecret(`credit-action-${suffix}`, pepper),
      ...(overrides.status ? { status: overrides.status } : {}),
      ...(overrides.beltAwardedAt ? { beltAwardedAt: overrides.beltAwardedAt } : {}),
    },
  });
  cleanupStudentIds.push(student.id);
  return student;
}

/**
 * MULTI_ACADEMY_AND_KIDS_BELTS.md Phase 3d point 4: "Correctable through the
 * existing correction path, not a bespoke one." These tests exercise
 * adjustPromotionCredit — the reuse of addAttendanceAdjustment's own shape
 * (signed delta, required reason, ADMIN/DIRECTOR/INSTRUCTOR gate, one
 * transaction with an AuditLog row) applied to PromotionCredit instead of
 * AttendanceRecord.
 */
describe("adjustPromotionCredit", () => {
  afterAll(cleanup);
  beforeEach(() => {
    currentSession = null;
  });

  it("a positive correction increases the credited count, verified via getAtBeltSummary — never a mutation of a prior grant", async () => {
    const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
    const admin = await makeStaffUser("ADMIN", "credit-adj-admin");
    const beltAwardedAt = new Date("2026-04-01T12:00:00Z");
    const student = await makeStudent(escazu.id, escazu.organizationId, { beltAwardedAt });

    // Original onboarding estimate.
    await prisma.promotionCredit.create({
      data: {
        studentId: student.id,
        academyId: escazu.id,
        organizationId: escazu.organizationId,
        beltAwardedAtAnchor: beltAwardedAt,
        classesGranted: 10,
        reason: "Original onboarding estimate.",
      },
    });

    currentSession = { user: { id: admin.id, role: "ADMIN" }, activeOrganizationId: admin.organizationId };
    const result = await adjustPromotionCredit(
      admin.organizationId,
      {},
      formData({ studentId: student.id, delta: "5", reason: "Director remembered more classes." }),
    );
    expect(result.ok).toBe(true);

    const summary = await getAtBeltSummary(student.id, student.organizationId, ALLIANCE_ATTENDANCE_CONFIG);
    expect(summary.creditedClasses).toBe(15);

    // Two rows exist — the original AND the correction, both permanently
    // visible (append-only, never an edit of the first row).
    const rows = await prisma.promotionCredit.findMany({
      where: { studentId: student.id },
      orderBy: { grantedAt: "asc" },
    });
    expect(rows).toHaveLength(2);
    expect(rows[0].classesGranted).toBe(10);
    expect(rows[1].classesGranted).toBe(5);
    expect(rows[1].grantedById).toBe(admin.id);

    const audits = await prisma.auditLog.findMany({
      where: { entityId: rows[1].id, action: "promotionCredit.correct" },
    });
    expect(audits).toHaveLength(1);
    expect(audits[0].after).toMatchObject({ delta: 5, reason: "Director remembered more classes." });
  });

  it("a negative correction can bring an overestimate back down, including below zero net", async () => {
    const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
    const admin = await makeStaffUser("ADMIN", "credit-adj-negative-admin");
    const beltAwardedAt = new Date("2026-04-05T12:00:00Z");
    const student = await makeStudent(escazu.id, escazu.organizationId, { beltAwardedAt });

    await prisma.promotionCredit.create({
      data: {
        studentId: student.id,
        academyId: escazu.id,
        organizationId: escazu.organizationId,
        beltAwardedAtAnchor: beltAwardedAt,
        classesGranted: 10,
        reason: "Overestimated at onboarding.",
      },
    });

    currentSession = { user: { id: admin.id, role: "ADMIN" }, activeOrganizationId: admin.organizationId };
    const result = await adjustPromotionCredit(
      admin.organizationId,
      {},
      formData({ studentId: student.id, delta: "-15", reason: "Corrected after reviewing the old gym's records." }),
    );
    expect(result.ok).toBe(true);

    const summary = await getAtBeltSummary(student.id, student.organizationId, ALLIANCE_ATTENDANCE_CONFIG);
    expect(summary.creditedClasses).toBe(-5);
  });

  it("rejects a zero delta and a missing reason, writing nothing", async () => {
    const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
    const admin = await makeStaffUser("ADMIN", "credit-adj-invalid-admin");
    const student = await makeStudent(escazu.id, escazu.organizationId);

    currentSession = { user: { id: admin.id, role: "ADMIN" }, activeOrganizationId: admin.organizationId };

    const zeroDelta = await adjustPromotionCredit(
      admin.organizationId,
      {},
      formData({ studentId: student.id, delta: "0", reason: "irrelevant" }),
    );
    expect(zeroDelta.error).toBe("invalid");

    const missingReason = await adjustPromotionCredit(
      admin.organizationId,
      {},
      formData({ studentId: student.id, delta: "5", reason: "" }),
    );
    expect(missingReason.error).toBe("invalid");

    expect(await prisma.promotionCredit.count({ where: { studentId: student.id } })).toBe(0);
  });

  it("an in-scope INSTRUCTOR can correct a credit — same role gate as addAttendanceAdjustment, reused deliberately", async () => {
    const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
    const instructor = await makeStaffUser("INSTRUCTOR", "credit-adj-instructor", escazu.id);
    const student = await makeStudent(escazu.id, escazu.organizationId);

    currentSession = { user: { id: instructor.id, role: "INSTRUCTOR" }, activeOrganizationId: instructor.organizationId };
    const result = await adjustPromotionCredit(
      instructor.organizationId,
      {},
      formData({ studentId: student.id, delta: "2", reason: "Instructor correction." }),
    );
    expect(result.ok).toBe(true);

    const row = await prisma.promotionCredit.findFirstOrThrow({ where: { studentId: student.id } });
    expect(row.grantedById).toBe(instructor.id);
  });

  it("a STUDENT session is rejected outright — this is a staff correction, not a self-service one", async () => {
    const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
    const student0 = await makeStaffUser("STUDENT", "credit-adj-student-role", escazu.id);
    const targetStudent = await makeStudent(escazu.id, escazu.organizationId);

    currentSession = { user: { id: student0.id, role: "STUDENT" }, activeOrganizationId: student0.organizationId };
    // A genuine member with the wrong role is resolveActionContext's
    // "ordinary authorization failure" case — it rethrows FORBIDDEN rather
    // than returning {ok:false} (see context.ts's own doc comment), the
    // same behavior createStudent's own test asserts for a wrong-role
    // INSTRUCTOR. adjustPromotionCredit doesn't catch it, matching
    // addAttendanceAdjustment's identical shape.
    await expect(
      adjustPromotionCredit(
        student0.organizationId,
        {},
        formData({ studentId: targetStudent.id, delta: "5", reason: "attempted self-credit" }),
      ),
    ).rejects.toThrow("FORBIDDEN");
    expect(await prisma.promotionCredit.count({ where: { studentId: targetStudent.id } })).toBe(0);
  });

  it("an out-of-scope DIRECTOR is rejected with notFound, writing nothing", async () => {
    const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
    const escalante = await prisma.academy.findUniqueOrThrow({ where: { slug: "escalante" } });
    const outOfScopeDirector = await makeStaffUser("DIRECTOR", "credit-adj-scope-director", escalante.id);
    const student = await makeStudent(escazu.id, escazu.organizationId);

    currentSession = {
      user: { id: outOfScopeDirector.id, role: "DIRECTOR" },
      activeOrganizationId: outOfScopeDirector.organizationId,
    };
    const result = await adjustPromotionCredit(
      outOfScopeDirector.organizationId,
      {},
      formData({ studentId: student.id, delta: "5", reason: "out of scope attempt" }),
    );
    expect(result.error).toBe("notFound");
    expect(await prisma.promotionCredit.count({ where: { studentId: student.id } })).toBe(0);
  });

  it("an ARCHIVED student's credit can't be corrected", async () => {
    const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
    const admin = await makeStaffUser("ADMIN", "credit-adj-archived-admin");
    const student = await makeStudent(escazu.id, escazu.organizationId, { status: "ARCHIVED" });

    currentSession = { user: { id: admin.id, role: "ADMIN" }, activeOrganizationId: admin.organizationId };
    const result = await adjustPromotionCredit(
      admin.organizationId,
      {},
      formData({ studentId: student.id, delta: "5", reason: "should not land" }),
    );
    expect(result.error).toBe("archived");
    expect(await prisma.promotionCredit.count({ where: { studentId: student.id } })).toBe(0);
  });

  it("always anchors a new correction to the student's CURRENT beltAwardedAt, never a client-supplied one", async () => {
    const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
    const admin = await makeStaffUser("ADMIN", "credit-adj-anchor-admin");
    const beltAwardedAt = new Date("2026-04-10T12:00:00Z");
    const student = await makeStudent(escazu.id, escazu.organizationId, { beltAwardedAt });

    currentSession = { user: { id: admin.id, role: "ADMIN" }, activeOrganizationId: admin.organizationId };
    // No `beltAwardedAt` field is even part of this action's schema — the
    // form has no such input — this proves the server reads it fresh rather
    // than accepting one.
    await adjustPromotionCredit(
      admin.organizationId,
      {},
      formData({ studentId: student.id, delta: "5", reason: "anchor check" }),
    );

    const row = await prisma.promotionCredit.findFirstOrThrow({ where: { studentId: student.id } });
    expect(row.beltAwardedAtAnchor.getTime()).toBe(beltAwardedAt.getTime());
  });
});
