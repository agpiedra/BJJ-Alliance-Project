import "dotenv/config";
import { getTestPrismaClient } from "../helpers/test-db";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { requireEnv } from "../../src/lib/env";
import { digestLookupSecret, hashSecret } from "../../src/lib/crypto";
import { adultRankId, kidsRankId } from "../helpers/belt-ranks";

// Same `auth()` mock as student-detail-actions.test.ts — see the long note
// there. Every session must name a real, active `User` row AND a real
// `OrganizationMembership` row now that `createStudent` calls
// `requireTenantContext()`, which resolves role from membership, not
// `User.role`, and needs `activeOrganizationId` to know which one.
let currentSession: { user: { id: string; role: string } | null; activeOrganizationId?: string } | null = null;

vi.mock("@/auth", () => ({
  auth: () => Promise.resolve(currentSession),
}));

const { createStudent } = await import("../../src/app/[locale]/(staff)/students/create-student-action");

const prisma = getTestPrismaClient();
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

let allianceOrgIdPromise: Promise<string> | null = null;
function getAllianceOrganizationId() {
  allianceOrgIdPromise ??= prisma.organization.findUniqueOrThrow({ where: { slug: "alliance-cr" } }).then((o) => o.id);
  return allianceOrgIdPromise;
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

  const organizationId = academyId
    ? (await prisma.academy.findUniqueOrThrow({ where: { id: academyId }, select: { organizationId: true } }))
        .organizationId
    : await getAllianceOrganizationId();

  await prisma.organizationMembership.create({ data: { userId: user.id, organizationId, role } });

  if (academyId && role !== "ADMIN") {
    await prisma.staffAssignment.create({
      data: {
        userId: user.id,
        academyId,
        organizationId,
        role: role === "DIRECTOR" ? "DIRECTOR" : "INSTRUCTOR",
      },
    });
  }
  return { ...user, organizationId };
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
    track: "ADULT",
    currentRankId: adultRankId("BLUE"),
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
    // PromotionCredit rows (Phase 3d) reference Student with ON DELETE
    // RESTRICT — must go first, or student.deleteMany below fails outright.
    const credits = await prisma.promotionCredit.findMany({
      where: { studentId: { in: studentIds } },
      select: { id: true },
    });
    await prisma.auditLog.deleteMany({
      where: {
        OR: [
          { entityId: { in: studentIds } },
          { entityId: { in: credits.map((c) => c.id) } },
          { actorId: { in: cleanupUserIds } },
        ],
      },
    });
    await prisma.promotionCredit.deleteMany({ where: { studentId: { in: studentIds } } });
    if (studentIds.length > 0) {
      await prisma.student.deleteMany({ where: { id: { in: studentIds } } });
    }
    if (cleanupUserIds.length > 0) {
      await prisma.organizationMembership.deleteMany({ where: { userId: { in: cleanupUserIds } } });
      await prisma.staffAssignment.deleteMany({ where: { userId: { in: cleanupUserIds } } });
      await prisma.notification.deleteMany({ where: { userId: { in: cleanupUserIds } } });
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

    currentSession = { user: { id: admin.id, role: "ADMIN" }, activeOrganizationId: admin.organizationId };
    const result = await createStudent(admin.organizationId, {}, formData(fields));
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
      track: "ADULT",
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

    currentSession = { user: { id: instructor.id, role: "INSTRUCTOR" }, activeOrganizationId: instructor.organizationId };
    await expect(createStudent(instructor.organizationId, {}, formData(fields))).rejects.toThrow("FORBIDDEN");

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
    currentSession = { user: { id: escalanteDirector.id, role: "DIRECTOR" }, activeOrganizationId: escalanteDirector.organizationId };
    const rejected = await createStudent(escalanteDirector.organizationId, {}, formData(tampered));
    expect(rejected.error).toBe("forbiddenAcademy");
    expect(rejected.fieldErrors?.homeAcademyId).toEqual(["forbiddenAcademy"]);
    expect(await prisma.student.findFirst({ where: { email: tampered.email } })).toBeNull();
    expect(
      await prisma.auditLog.count({ where: { actorId: escalanteDirector.id, action: "student.create" } }),
    ).toBe(0);

    // ...and the same DIRECTOR creating in their OWN academy still works,
    // so the rejection above is about scope, not about DIRECTORs.
    const allowed = newStudentFields(escalante.id, "OwnAcademy");
    const accepted = await createStudent(escalanteDirector.organizationId, {}, formData(allowed));
    expect(accepted.ok).toBe(true);
    const created = await prisma.student.findFirstOrThrow({ where: { email: allowed.email } });
    expect(created.homeAcademyId).toBe(escalante.id);
    expect(
      await prisma.auditLog.count({ where: { entityId: created.id, action: "student.create" } }),
    ).toBe(1);
  });

  // MULTI_ACADEMY_AND_KIDS_BELTS.md Phase 3c-i: the track selector actually
  // reaches the write — a KIDS student lands on a KIDS rank, not silently
  // defaulted to ADULT.
  it("an ADMIN creates a KIDS-track student on a kids rank", async () => {
    const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
    const admin = await makeStaffUser("ADMIN", "create-test-kids-admin");
    const fields = {
      ...newStudentFields(escazu.id, "KidsCreated"),
      track: "KIDS",
      currentRankId: kidsRankId("grey"),
      currentStripes: "5",
    };

    currentSession = { user: { id: admin.id, role: "ADMIN" }, activeOrganizationId: admin.organizationId };
    const result = await createStudent(admin.organizationId, {}, formData(fields));
    expect(result.ok).toBe(true);

    const student = await prisma.student.findFirstOrThrow({
      where: { email: fields.email },
      include: { currentRank: { select: { code: true, track: true } } },
    });
    expect(student.track).toBe("KIDS");
    expect(student.currentRank.code).toBe("grey");
    expect(student.currentRank.track).toBe("KIDS");
    expect(student.currentStripes).toBe(5);
  });

  // A track/rank mismatch can only reach the server via a tampered
  // request — the UI's own dropdown only ever offers ranks for the
  // currently-selected track. Proves the server-side check (not just the
  // client filter) is what actually holds.
  it("rejects a submitted rank that doesn't belong to the submitted track, writing nothing", async () => {
    const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
    const admin = await makeStaffUser("ADMIN", "create-test-mismatch-admin");
    const fields = {
      ...newStudentFields(escazu.id, "TrackMismatch"),
      track: "ADULT",
      currentRankId: kidsRankId("grey"),
    };

    currentSession = { user: { id: admin.id, role: "ADMIN" }, activeOrganizationId: admin.organizationId };
    const result = await createStudent(admin.organizationId, {}, formData(fields));
    expect(result.error).toBe("invalid");
    expect(result.fieldErrors?.currentRankId).toEqual(["invalid"]);
    expect(await prisma.student.findFirst({ where: { email: fields.email } })).toBeNull();
  });

  it("1f-4: an ADMIN's real membership doesn't help against an organizationId their tab doesn't belong to — refused as forbiddenAcademy, writes nothing, and audits the attempt", async () => {
    const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
    const admin = await makeStaffUser("ADMIN", "create-crossorg-admin");
    const fields = newStudentFields(escazu.id, "CrossOrg");

    const otherOrg = await prisma.organization.create({
      data: { slug: `create-student-crossorg-${Date.now()}`, name: "Cross-Org Test Org", status: "ACTIVE" },
    });

    try {
      currentSession = { user: { id: admin.id, role: "ADMIN" }, activeOrganizationId: admin.organizationId };

      const result = await createStudent(otherOrg.id, {}, formData(fields));
      expect(result.error).toBe("forbiddenAcademy");
      expect(await prisma.student.findFirst({ where: { email: fields.email } })).toBeNull();

      const refusalAudit = await prisma.auditLog.findFirst({
        where: { actorId: admin.id, action: "organization.accessRefused", entityId: otherOrg.id },
      });
      expect(refusalAudit).not.toBeNull();
    } finally {
      await prisma.auditLog.deleteMany({ where: { organizationId: otherOrg.id } });
      await prisma.organization.delete({ where: { id: otherOrg.id } });
    }
  });

  // MULTI_ACADEMY_AND_KIDS_BELTS.md Phase 3d — "Estado inicial" onboarding
  // credit, granted in the same transaction as student.create.
  describe("Phase 3d: onboarding credit", () => {
    it("grants a PromotionCredit anchored to the submitted beltAwardedAt when classesCredited is nonzero", async () => {
      const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
      const admin = await makeStaffUser("ADMIN", "create-test-credit-admin");
      const fields = {
        ...newStudentFields(escazu.id, "CreditedOnboard"),
        beltAwardedAt: "2025-06-01",
        classesCredited: "20",
        creditReason: "Estimated from prior gym's own records.",
      };

      currentSession = { user: { id: admin.id, role: "ADMIN" }, activeOrganizationId: admin.organizationId };
      const result = await createStudent(admin.organizationId, {}, formData(fields));
      expect(result.ok).toBe(true);

      const student = await prisma.student.findFirstOrThrow({ where: { email: fields.email } });
      expect(student.beltAwardedAt.toISOString().slice(0, 10)).toBe("2025-06-01");

      const credit = await prisma.promotionCredit.findFirstOrThrow({ where: { studentId: student.id } });
      expect(credit.classesGranted).toBe(20);
      expect(credit.reason).toBe("Estimated from prior gym's own records.");
      expect(credit.grantedById).toBe(admin.id);
      expect(credit.beltAwardedAtAnchor.getTime()).toBe(student.beltAwardedAt.getTime());

      const audits = await prisma.auditLog.findMany({
        where: { entityId: credit.id, action: "promotionCredit.grant" },
      });
      expect(audits).toHaveLength(1);
    });

    it("a classesCredited of 0 (explicit or omitted) creates no PromotionCredit row at all", async () => {
      const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
      const admin = await makeStaffUser("ADMIN", "create-test-zero-credit-admin");
      currentSession = { user: { id: admin.id, role: "ADMIN" }, activeOrganizationId: admin.organizationId };

      const explicitZero = { ...newStudentFields(escazu.id, "ExplicitZeroCredit"), classesCredited: "0" };
      const explicitResult = await createStudent(admin.organizationId, {}, formData(explicitZero));
      expect(explicitResult.ok).toBe(true);
      const explicitStudent = await prisma.student.findFirstOrThrow({ where: { email: explicitZero.email } });
      expect(await prisma.promotionCredit.count({ where: { studentId: explicitStudent.id } })).toBe(0);

      const omitted = newStudentFields(escazu.id, "OmittedCredit");
      const omittedResult = await createStudent(admin.organizationId, {}, formData(omitted));
      expect(omittedResult.ok).toBe(true);
      const omittedStudent = await prisma.student.findFirstOrThrow({ where: { email: omitted.email } });
      expect(await prisma.promotionCredit.count({ where: { studentId: omittedStudent.id } })).toBe(0);
    });

    it("rejects a nonzero classesCredited with no reason, writing nothing", async () => {
      const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
      const admin = await makeStaffUser("ADMIN", "create-test-missing-reason-admin");
      const fields = { ...newStudentFields(escazu.id, "MissingReason"), classesCredited: "10" };

      currentSession = { user: { id: admin.id, role: "ADMIN" }, activeOrganizationId: admin.organizationId };
      const result = await createStudent(admin.organizationId, {}, formData(fields));
      expect(result.error).toBe("invalid");
      expect(result.fieldErrors?.creditReason).toEqual(["creditReasonRequired"]);
      expect(await prisma.student.findFirst({ where: { email: fields.email } })).toBeNull();
    });
  });
});
