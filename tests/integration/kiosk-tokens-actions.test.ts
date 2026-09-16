import "dotenv/config";
import { getTestPrismaClient } from "../helpers/test-db";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { hashSecret, digestLookupSecret } from "../../src/lib/crypto";
import { requireEnv } from "../../src/lib/env";
import { adultRankId } from "../helpers/belt-ranks";

// Same `auth()` mock as the other action-layer integration suites in this
// repo (see student-detail-actions.test.ts's long note) —
// `resolveActionContext` -> `requireOrganizationAccess` -> `getTenantContext`'s
// sibling `resolveContext` needs a real `OrganizationMembership` row, never a
// real HTTP session.
let currentSession: { user: { id: string; role: string } | null; activeOrganizationId?: string } | null = null;

vi.mock("@/auth", () => ({
  auth: () => Promise.resolve(currentSession),
}));

vi.mock("next-intl/server", () => ({
  getLocale: () => Promise.resolve("en"),
}));

const { regenerateKioskToken } = await import(
  "../../src/app/[locale]/(staff)/admin/kiosk-tokens/actions"
);
const { reassignAttendanceRecord } = await import(
  "../../src/app/[locale]/(staff)/admin/kiosk-tokens/reassign-attendance-action"
);

const prisma = getTestPrismaClient();
const pepper = requireEnv("CODE_PEPPER");

let allianceOrgIdPromise: Promise<string> | null = null;
function getAllianceOrganizationId() {
  allianceOrgIdPromise ??= prisma.organization.findUniqueOrThrow({ where: { slug: "alliance-cr" } }).then((o) => o.id);
  return allianceOrgIdPromise;
}

function formData(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    fd.set(key, value);
  }
  return fd;
}

// Same reasoning as admin-schedule-actions.test.ts: a private academy so
// this suite's ClassSession/Academy writes never collide with seed.test.ts's
// exact-count assertions on the shared Escazú fixture.
let testAcademyId: string;
let testOrganizationId: string;

const cleanupUserIds: string[] = [];
const cleanupStudentIds: string[] = [];
const cleanupClassSessionIds: string[] = [];

async function cleanup() {
  if (cleanupStudentIds.length > 0) {
    await prisma.attendanceRecord.deleteMany({ where: { studentId: { in: cleanupStudentIds } } });
    await prisma.student.deleteMany({ where: { id: { in: cleanupStudentIds } } });
  }
  if (cleanupClassSessionIds.length > 0 || cleanupUserIds.length > 0) {
    await prisma.auditLog.deleteMany({
      where: {
        OR: [{ entityId: { in: cleanupClassSessionIds } }, { actorId: { in: cleanupUserIds } }],
      },
    });
  }
  if (cleanupClassSessionIds.length > 0) {
    await prisma.classSession.deleteMany({ where: { id: { in: cleanupClassSessionIds } } });
  }
  if (cleanupUserIds.length > 0) {
    await prisma.organizationMembership.deleteMany({ where: { userId: { in: cleanupUserIds } } });
    await prisma.staffAssignment.deleteMany({ where: { userId: { in: cleanupUserIds } } });
    await prisma.notification.deleteMany({ where: { userId: { in: cleanupUserIds } } });
    await prisma.user.deleteMany({ where: { id: { in: cleanupUserIds } } });
  }
  cleanupStudentIds.length = 0;
  cleanupClassSessionIds.length = 0;
  cleanupUserIds.length = 0;
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
  await prisma.organizationMembership.create({
    data: { userId: user.id, organizationId: testOrganizationId, role },
  });
  return user;
}

describe("kiosk-tokens admin actions", () => {
  beforeAll(async () => {
    const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
    const academy = await prisma.academy.create({
      data: {
        name: `Kiosk Tokens Test Academy ${suffix}`,
        slug: `kiosk-tokens-test-${suffix}`,
        kioskTokenHash: `kiosk-tokens-test-hash-${suffix}`,
        organizationId: await getAllianceOrganizationId(),
      },
    });
    testAcademyId = academy.id;
    testOrganizationId = academy.organizationId;
  });

  afterEach(cleanup);

  afterAll(async () => {
    await cleanup();
    await prisma.classSession.deleteMany({ where: { academyId: testAcademyId } });
    await prisma.academy.deleteMany({ where: { id: testAcademyId } });
  });

  beforeEach(() => {
    currentSession = null;
  });

  describe("regenerateKioskToken", () => {
    it("an ADMIN rotates the academy's kiosk token and it is audited without leaking the plaintext or the hash", async () => {
      const admin = await makeStaffUser("ADMIN", "kiosk-regen-admin");
      currentSession = { user: { id: admin.id, role: "ADMIN" }, activeOrganizationId: testOrganizationId };

      const before = await prisma.academy.findUniqueOrThrow({ where: { id: testAcademyId } });

      const result = await regenerateKioskToken(testOrganizationId, {}, formData({ academyId: testAcademyId }));
      expect(result.ok).toBe(true);
      expect(result.token).toMatch(/^[A-Za-z0-9_-]+$/);

      const after = await prisma.academy.findUniqueOrThrow({ where: { id: testAcademyId } });
      expect(after.kioskTokenHash).not.toBe(before.kioskTokenHash);
      expect(after.kioskTokenHash).toBe(digestLookupSecret(result.token!, pepper));

      const audits = await prisma.auditLog.findMany({
        where: { entityId: testAcademyId, action: "academy.regenerateKioskToken" },
      });
      expect(audits).toHaveLength(1);
      expect(audits[0].actorId).toBe(admin.id);
      const payload = JSON.stringify({ before: audits[0].before, after: audits[0].after });
      expect(payload).not.toContain(result.token!);
      expect(payload).not.toContain(after.kioskTokenHash);
    });

    it("1f-4: an ADMIN's real membership doesn't help against an organizationId their tab doesn't belong to — refuses, audits, and leaves the kiosk token untouched; the same admin acting on their own org still succeeds", async () => {
      const admin = await makeStaffUser("ADMIN", "kiosk-regen-crossorg-admin");
      currentSession = { user: { id: admin.id, role: "ADMIN" }, activeOrganizationId: testOrganizationId };

      const before = await prisma.academy.findUniqueOrThrow({ where: { id: testAcademyId } });

      const otherOrg = await prisma.organization.create({
        data: { slug: `kiosk-regen-crossorg-${Date.now()}`, name: "Cross-Org Test Org", status: "ACTIVE" },
      });

      try {
        const rejected = await regenerateKioskToken(otherOrg.id, {}, formData({ academyId: testAcademyId }));
        expect(rejected.error).toBe("notFound");

        const untouched = await prisma.academy.findUniqueOrThrow({ where: { id: testAcademyId } });
        expect(untouched.kioskTokenHash).toBe(before.kioskTokenHash);

        const refusalAudit = await prisma.auditLog.findFirst({
          where: { actorId: admin.id, action: "organization.accessRefused", entityId: otherOrg.id },
        });
        expect(refusalAudit).not.toBeNull();

        const legitimate = await regenerateKioskToken(testOrganizationId, {}, formData({ academyId: testAcademyId }));
        expect(legitimate.ok).toBe(true);
      } finally {
        await prisma.auditLog.deleteMany({ where: { organizationId: otherOrg.id } });
        await prisma.organization.delete({ where: { id: otherOrg.id } });
      }
    });
  });

  describe("reassignAttendanceRecord", () => {
    async function makeMondaySessions() {
      const target = await prisma.classSession.create({
        data: {
          academyId: testAcademyId,
          organizationId: testOrganizationId,
          dayOfWeek: "MONDAY",
          startTime: "19:00",
          durationMinutes: 60,
          name: "Target Class",
          type: "GI",
        },
      });
      cleanupClassSessionIds.push(target.id);
      return target;
    }

    async function makeMondayCheckIn() {
      const student = await prisma.student.create({
        data: {
          homeAcademyId: testAcademyId,
          organizationId: testOrganizationId,
          firstName: "KioskReassign",
          lastName: "Student",
          phone: "88882222",
          email: `kiosk-reassign-${Date.now()}@example.com`,
          currentRankId: adultRankId("WHITE"),
          beltAwardedAt: new Date("2026-01-01T00:00:00Z"),
          status: "ACTIVE",
          codeHash: digestLookupSecret(`kiosk-reassign-${Date.now()}`, pepper),
        },
      });
      cleanupStudentIds.push(student.id);
      const record = await prisma.attendanceRecord.create({
        data: {
          studentId: student.id,
          academyId: testAcademyId,
          organizationId: testOrganizationId,
          classSessionId: null,
          // Monday 2026-01-05, matching this file's own fixtures — no shared
          // fixture, no cross-file date coupling.
          occurredAt: new Date("2026-01-05T19:30:00Z"),
          date: new Date(Date.UTC(2026, 0, 5)),
          type: "CHECKIN",
          delta: 1,
          source: "KIOSK",
          matchSource: "UNMATCHED",
        },
      });
      return { student, record };
    }

    it("an in-scope INSTRUCTOR reassigns an unmatched check-in to a real class, and it is audited", async () => {
      const instructor = await makeStaffUser("INSTRUCTOR", "kiosk-reassign-instructor");
      await prisma.staffAssignment.create({
        data: { userId: instructor.id, academyId: testAcademyId, organizationId: testOrganizationId, role: "INSTRUCTOR" },
      });
      const target = await makeMondaySessions();
      const { record } = await makeMondayCheckIn();

      currentSession = { user: { id: instructor.id, role: "INSTRUCTOR" }, activeOrganizationId: testOrganizationId };
      const result = await reassignAttendanceRecord(
        testOrganizationId,
        {},
        formData({ attendanceRecordId: record.id, classSessionId: target.id }),
      );
      expect(result.ok).toBe(true);

      const after = await prisma.attendanceRecord.findUniqueOrThrow({ where: { id: record.id } });
      expect(after.classSessionId).toBe(target.id);
      expect(after.matchSource).toBe("STAFF_CORRECTED");
    });

    it("1f-4: a real membership doesn't help against an organizationId their tab doesn't belong to — refuses, audits, and reassigns nothing; the same session acting on their own org still succeeds", async () => {
      const admin = await makeStaffUser("ADMIN", "kiosk-reassign-crossorg-admin");
      const target = await makeMondaySessions();
      const { record } = await makeMondayCheckIn();

      currentSession = { user: { id: admin.id, role: "ADMIN" }, activeOrganizationId: testOrganizationId };

      const otherOrg = await prisma.organization.create({
        data: { slug: `kiosk-reassign-crossorg-${Date.now()}`, name: "Cross-Org Test Org", status: "ACTIVE" },
      });

      try {
        const rejected = await reassignAttendanceRecord(
          otherOrg.id,
          {},
          formData({ attendanceRecordId: record.id, classSessionId: target.id }),
        );
        expect(rejected.error).toBe("notFound");

        const untouched = await prisma.attendanceRecord.findUniqueOrThrow({ where: { id: record.id } });
        expect(untouched.classSessionId).toBeNull();
        expect(untouched.matchSource).toBe("UNMATCHED");

        const refusalAudit = await prisma.auditLog.findFirst({
          where: { actorId: admin.id, action: "organization.accessRefused", entityId: otherOrg.id },
        });
        expect(refusalAudit).not.toBeNull();

        const legitimate = await reassignAttendanceRecord(
          testOrganizationId,
          {},
          formData({ attendanceRecordId: record.id, classSessionId: target.id }),
        );
        expect(legitimate.ok).toBe(true);
      } finally {
        await prisma.auditLog.deleteMany({ where: { organizationId: otherOrg.id } });
        await prisma.organization.delete({ where: { id: otherOrg.id } });
      }
    });
  });
});
