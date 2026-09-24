import "dotenv/config";
import { getTestPrismaClient } from "../helpers/test-db";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { hashSecret } from "../../src/lib/crypto";
import { generateStudentCode } from "../../src/lib/students/generate-code";
import { adultRankId } from "../helpers/belt-ranks";
import { cleanupClassFixtures, makeClassAcademy } from "../helpers/class-fixtures";

// Same `auth()` / `next-intl/server` mocks as self-check-in-action.test.ts: the action re-derives the caller's
// membership and linked student from real rows on every call.
let currentSession: { user: { id: string; role: string } | null; activeOrganizationId?: string } | null = null;
vi.mock("@/auth", () => ({ auth: () => Promise.resolve(currentSession) }));
vi.mock("next-intl/server", () => ({ getLocale: () => Promise.resolve("en") }));

const { loadMoreAttendance } = await import("../../src/app/[locale]/portal/attendance-history-actions");
const { getAttendanceHistoryPage } = await import("../../src/lib/students/attendance-history");

/**
 * "Show older attendance" (PR 3): the next page of the CALLER'S OWN history. There is no student id in the input, so
 * another student's records cannot be requested; a session for another organization is refused; a tampered cursor
 * cannot restart or loop the list.
 */
const prisma = getTestPrismaClient();
const cleanupUserIds: string[] = [];
const DAY_MS = 86_400_000;

afterEach(() => {
  currentSession = null;
});
afterAll(async () => {
  await prisma.attendanceRecord.deleteMany({ where: { student: { userId: { in: cleanupUserIds } } } });
  await prisma.student.deleteMany({ where: { userId: { in: cleanupUserIds } } });
  await prisma.organizationMembership.deleteMany({ where: { userId: { in: cleanupUserIds } } });
  await prisma.auditLog.deleteMany({ where: { actorId: { in: cleanupUserIds } } });
  await prisma.user.deleteMany({ where: { id: { in: cleanupUserIds } } });
  await cleanupClassFixtures();
});

async function studentUser(academyId: string, organizationId: string, rows: number) {
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
  const user = await prisma.user.create({ data: { email: `portal-history-${suffix}@example.com`, passwordHash: await hashSecret("irrelevant-password-123"), role: "STUDENT", active: true } });
  cleanupUserIds.push(user.id);
  await prisma.organizationMembership.create({ data: { userId: user.id, organizationId, role: "STUDENT" } });
  const { codeHash } = await generateStudentCode(organizationId);
  const student = await prisma.student.create({
    data: { userId: user.id, homeAcademyId: academyId, organizationId, firstName: "PortalHistory", lastName: "Student", phone: "88880077", email: `portal-history-student-${suffix}@example.com`, codeHash, status: "ACTIVE", currentRankId: adultRankId("WHITE") },
  });
  for (let i = 0; i < rows; i++) {
    const occurredAt = new Date(Date.UTC(2026, 0, 31, 18, 0, 0) - (i + 1) * DAY_MS);
    await prisma.attendanceRecord.create({
      data: { studentId: student.id, academyId, organizationId, occurredAt, date: new Date(Date.UTC(occurredAt.getUTCFullYear(), occurredAt.getUTCMonth(), occurredAt.getUTCDate())), type: "CHECKIN", delta: 1, source: "PORTAL", matchSource: "AUTO" },
    });
  }
  return { user, student };
}

describe("loadMoreAttendance", () => {
  it("returns the caller's own next page in order, with a cursor until the history ends, formatted in Costa Rica time", async () => {
    const { academy } = await makeClassAcademy([{ dayOfWeek: "MONDAY", startTime: "18:00", name: "GI" }]);
    const { user, student } = await studentUser(academy.id, academy.organizationId, 60);
    currentSession = { user: { id: user.id, role: "STUDENT" }, activeOrganizationId: academy.organizationId };
    const first = await getAttendanceHistoryPage(student.id, academy.organizationId, { limit: 25 });
    expect(first.nextCursor).not.toBeNull();

    const second = await loadMoreAttendance(academy.organizationId, first.nextCursor!);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.rows).toHaveLength(25);
    expect(second.nextCursor).not.toBeNull();
    const third = await loadMoreAttendance(academy.organizationId, second.nextCursor!);
    expect(third.ok && third.rows).toHaveLength(10); // 60 - 25 - 25
    expect(third.ok && third.nextCursor).toBeNull();

    const all = [...first.entries.map((e) => e.id), ...second.rows.map((r) => r.id), ...(third.ok ? third.rows.map((r) => r.id) : [])];
    expect(new Set(all).size).toBe(60);
    // Every row was recorded at 18:00Z = 12:00 in Costa Rica (UTC-6), shown for the academy, not for the server
    // (which runs on Kiritimati time in this suite).
    expect(second.rows[0].whenLabel).toMatch(/12:00/);
    expect(second.rows[0].iso).toMatch(/T18:00:00\.000Z$/);
  });

  it("only ever returns the CALLER's rows: another student's history is not reachable, even with that student's cursor", async () => {
    const { academy } = await makeClassAcademy([{ dayOfWeek: "MONDAY", startTime: "18:00", name: "GI" }]);
    const a = await studentUser(academy.id, academy.organizationId, 40);
    const b = await studentUser(academy.id, academy.organizationId, 40);
    const cursorFromA = (await getAttendanceHistoryPage(a.student.id, academy.organizationId, { limit: 25 })).nextCursor!;
    currentSession = { user: { id: b.user.id, role: "STUDENT" }, activeOrganizationId: academy.organizationId };
    const result = await loadMoreAttendance(academy.organizationId, cursorFromA);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const bIds = new Set((await prisma.attendanceRecord.findMany({ where: { studentId: b.student.id }, select: { id: true } })).map((r) => r.id));
    expect(result.rows.length).toBeGreaterThan(0);
    expect(result.rows.every((r) => bIds.has(r.id))).toBe(true);
  });

  it("refuses a session for another organization, a staff account with no student record, and an empty cursor; a garbage cursor is an empty last page", async () => {
    const { academy } = await makeClassAcademy([{ dayOfWeek: "MONDAY", startTime: "18:00", name: "GI" }]);
    const { user } = await studentUser(academy.id, academy.organizationId, 30);
    currentSession = { user: { id: user.id, role: "STUDENT" }, activeOrganizationId: academy.organizationId };
    const otherOrg = await prisma.organization.create({ data: { slug: `portal-history-other-${Date.now()}`, name: "Other", status: "ACTIVE" } });
    try {
      expect(await loadMoreAttendance(otherOrg.id, "x")).toEqual({ ok: false, error: "invalid" });
      expect(await loadMoreAttendance(academy.organizationId, "")).toEqual({ ok: false, error: "invalid" });
      expect(await loadMoreAttendance(academy.organizationId, "not-a-cursor")).toEqual({ ok: true, rows: [], nextCursor: null });

      const staff = await prisma.user.create({ data: { email: `portal-history-staff-${Date.now()}@example.com`, passwordHash: await hashSecret("irrelevant-password-123"), role: "ADMIN", active: true } });
      cleanupUserIds.push(staff.id);
      await prisma.organizationMembership.create({ data: { userId: staff.id, organizationId: academy.organizationId, role: "ADMIN" } });
      currentSession = { user: { id: staff.id, role: "ADMIN" }, activeOrganizationId: academy.organizationId };
      expect(await loadMoreAttendance(academy.organizationId, "x")).toEqual({ ok: false, error: "invalid" });
    } finally {
      await prisma.auditLog.deleteMany({ where: { organizationId: otherOrg.id } });
      await prisma.organization.delete({ where: { id: otherOrg.id } });
    }
  });
});
