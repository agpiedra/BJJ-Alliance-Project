import "dotenv/config";
import { getTestPrismaClient } from "../helpers/test-db";
import { afterAll, describe, expect, it, vi } from "vitest";
import { requireEnv } from "../../src/lib/env";
import { digestLookupSecret, hashSecret } from "../../src/lib/crypto";
import { adultRankId } from "../helpers/belt-ranks";

let currentSession: { user: { id: string; role: string } | null; activeOrganizationId?: string } | null = null;
vi.mock("@/auth", () => ({ auth: () => Promise.resolve(currentSession) }));

const { voidAttendanceEntry } = await import("../../src/app/[locale]/(staff)/students/[id]/attendance-void-actions");
const { performCheckIn } = await import("../../src/lib/kiosk/perform-check-in");
const { reassignAttendance } = await import("../../src/lib/kiosk/reassign-attendance");

/**
 * A voided entry must not block a valid replacement. The uniqueness rule for one class occurrence
 * (student, class, day) applies to VALID entries only: the voided row stays in the history, and at most one
 * valid entry exists for that occurrence - even under concurrent replacements.
 */
const prisma = getTestPrismaClient();
const pepper = requireEnv("CODE_PEPPER");

// Monday 2026-01-05 06:00 America/Costa_Rica: exactly the seeded Escazu "GI" session, inside its window only.
const WITHIN_MONDAY_GI_WINDOW = new Date("2026-01-05T12:00:00Z");
const MONDAY_DATE = new Date("2026-01-05T00:00:00Z");

const cleanupUserIds: string[] = [];
const cleanupStudentIds: string[] = [];
const cleanupAcademyIds: string[] = [];

afterAll(async () => {
  await prisma.auditLog.deleteMany({ where: { OR: [{ actorId: { in: cleanupUserIds } }, { entityId: { in: cleanupStudentIds } }] } });
  await prisma.attendanceRecord.deleteMany({ where: { studentId: { in: cleanupStudentIds } } });
  await prisma.student.deleteMany({ where: { id: { in: cleanupStudentIds } } });
  await prisma.classSession.deleteMany({ where: { academyId: { in: cleanupAcademyIds } } });
  await prisma.academy.deleteMany({ where: { id: { in: cleanupAcademyIds } } });
  await prisma.organizationMembership.deleteMany({ where: { userId: { in: cleanupUserIds } } });
  await prisma.user.deleteMany({ where: { id: { in: cleanupUserIds } } });
});

const ctx = (academy: { id: string; organizationId: string }): import("../../src/lib/tenant/types").KioskContext => ({
  kind: "kiosk",
  organizationId: academy.organizationId,
  academyId: academy.id,
});

async function signInAdmin(organizationId: string) {
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
  const user = await prisma.user.create({ data: { email: `void-checkin-admin-${suffix}@example.com`, passwordHash: await hashSecret("irrelevant-password-123"), role: "ADMIN" } });
  cleanupUserIds.push(user.id);
  await prisma.organizationMembership.create({ data: { userId: user.id, organizationId, role: "ADMIN" } });
  currentSession = { user: { id: user.id, role: "ADMIN" }, activeOrganizationId: organizationId };
  return user;
}

async function makeStudent(academyId: string, organizationId: string) {
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
  const code = `void-checkin-${suffix}`;
  const student = await prisma.student.create({
    data: {
      homeAcademyId: academyId, organizationId, firstName: "VoidCheckin", lastName: "Student", phone: "88880022",
      email: `void-checkin-${suffix}@example.com`, status: "ACTIVE", currentRankId: adultRankId("WHITE"), currentStripes: 0,
      beltAwardedAt: new Date("2026-01-01T00:00:00Z"), codeHash: digestLookupSecret(code, pepper),
    },
  });
  cleanupStudentIds.push(student.id);
  return { student, code };
}

const form = (fields: Record<string, string>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
};

const checkIn = (academy: { id: string; organizationId: string }, code: string) =>
  performCheckIn({ academyId: academy.id, context: ctx(academy), code, source: "KIOSK", now: WITHIN_MONDAY_GI_WINDOW });

const escazu = () => prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });

describe("check-in after a void", () => {
  it("a valid replacement check-in is accepted after the entry for that class was voided, and the voided row stays in the history", async () => {
    const ac = await escazu();
    await signInAdmin(ac.organizationId);
    const { student, code } = await makeStudent(ac.id, ac.organizationId);

    const first = await checkIn(ac, code);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(await voidAttendanceEntry(ac.organizationId, {}, form({ recordId: first.attendanceRecordId, reason: "tapped for the wrong student" }))).toEqual({ ok: true });

    const replacement = await checkIn(ac, code);
    expect(replacement.ok).toBe(true);
    if (!replacement.ok) return;
    expect(replacement.attendanceRecordId).not.toBe(first.attendanceRecordId);

    const rows = await prisma.attendanceRecord.findMany({ where: { studentId: student.id }, orderBy: { createdAt: "asc" } });
    expect(rows).toHaveLength(2); // the voided row was neither deleted nor reused
    expect(rows[0].voidedAt).not.toBeNull();
    expect(rows[1].voidedAt).toBeNull();
    expect(rows[0].classSessionId).toBe(rows[1].classSessionId);
    expect(rows[0].date.toISOString()).toBe(rows[1].date.toISOString());

    // Still at most one VALID entry for the occurrence: a further tap is refused.
    expect(await checkIn(ac, code)).toEqual({ ok: false, error: "already_checked_in" });
  });

  it("concurrent replacements after a void: exactly one is accepted, the rest are already_checked_in, one valid row exists", async () => {
    const ac = await escazu();
    await signInAdmin(ac.organizationId);
    const { student, code } = await makeStudent(ac.id, ac.organizationId);
    const first = await checkIn(ac, code);
    if (!first.ok) throw new Error("setup check-in failed");
    await voidAttendanceEntry(ac.organizationId, {}, form({ recordId: first.attendanceRecordId, reason: "wrong student" }));

    const results = await Promise.all(Array.from({ length: 6 }, () => checkIn(ac, code)));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok && r.error === "already_checked_in")).toHaveLength(5);
    expect(await prisma.attendanceRecord.count({ where: { studentId: student.id, voidedAt: null } })).toBe(1);
    expect(await prisma.attendanceRecord.count({ where: { studentId: student.id, voidedAt: { not: null } } })).toBe(1);
  });

  it("two valid entries for one class occurrence are still refused by the database itself (the rule is not app-only)", async () => {
    const ac = await escazu();
    const { student, code } = await makeStudent(ac.id, ac.organizationId);
    const first = await checkIn(ac, code);
    if (!first.ok) throw new Error("setup check-in failed");
    const original = await prisma.attendanceRecord.findUniqueOrThrow({ where: { id: first.attendanceRecordId } });
    await expect(
      prisma.attendanceRecord.create({
        data: { studentId: student.id, academyId: ac.id, organizationId: ac.organizationId, classSessionId: original.classSessionId, occurredAt: WITHIN_MONDAY_GI_WINDOW, date: original.date, type: "CHECKIN", delta: 1, source: "KIOSK" },
      }),
    ).rejects.toMatchObject({ code: "P2002" });
  });

  it("reassigning an entry to a class where only a VOIDED entry exists is allowed; where a valid one exists it is still refused; a voided entry cannot be reassigned", async () => {
    const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
    const organizationId = (await escazu()).organizationId;
    const academy = await prisma.academy.create({ data: { name: `Void Reassign ${suffix}`, slug: `void-reassign-${suffix}`, kioskTokenHash: `void-reassign-hash-${suffix}`, organizationId } });
    cleanupAcademyIds.push(academy.id);
    const [a, b] = await Promise.all(
      [["18:00", "Uno"], ["19:00", "Dos"]].map(([startTime, name]) =>
        prisma.classSession.create({ data: { academyId: academy.id, organizationId, dayOfWeek: "MONDAY", startTime, durationMinutes: 60, name, type: "GI" } }),
      ),
    );
    await signInAdmin(organizationId);
    const { student } = await makeStudent(academy.id, organizationId);
    const row = (classSessionId: string, voided = false) =>
      prisma.attendanceRecord.create({
        data: {
          studentId: student.id, academyId: academy.id, organizationId, classSessionId, occurredAt: WITHIN_MONDAY_GI_WINDOW, date: MONDAY_DATE, type: "CHECKIN", delta: 1, source: "KIOSK",
          ...(voided ? { voidedAt: new Date(), voidReason: "mistake" } : {}),
        },
      });
    const opts = { actorUserId: null, matchSource: "STAFF_CORRECTED" as const, expectedAcademyId: academy.id, context: ctx(academy) };

    const onA = await row(a.id);
    const validOnB = await row(b.id);
    expect(await reassignAttendance(onA.id, b.id, opts)).toMatchObject({ ok: false, error: "alreadyRecorded" });

    await voidAttendanceEntry(organizationId, {}, form({ recordId: validOnB.id, reason: "not there" }));
    expect(await reassignAttendance(onA.id, b.id, opts)).toMatchObject({ ok: true });

    // The voided entry itself is history: it cannot be moved around.
    expect(await reassignAttendance(validOnB.id, a.id, opts)).toMatchObject({ ok: false, error: "notFound" });
  });
});
