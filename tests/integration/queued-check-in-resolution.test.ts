import "dotenv/config";
import { DateTime } from "luxon";
import { getTestPrismaClient } from "../helpers/test-db";
import { afterAll, describe, expect, it, vi } from "vitest";
import { hashSecret } from "../../src/lib/crypto";
import { cleanupClassFixtures, makeClassAcademy, makeClassStudent } from "../helpers/class-fixtures";
import { ALLIANCE_ATTENDANCE_CONFIG } from "../helpers/promotion-config";
import { makeAccountingOrg } from "../helpers/accounting-org";

let currentSession: { user: { id: string; role: string } | null; activeOrganizationId?: string } | null = null;
vi.mock("@/auth", () => ({ auth: () => Promise.resolve(currentSession) }));

const { resolveQueuedCheckInAction, dismissQueuedCheckInAction } = await import(
  "../../src/app/[locale]/(staff)/admin/kiosk-tokens/queued-check-in-actions"
);
const { getAtBeltSummary } = await import("../../src/lib/students/attendance-summary");

/**
 * The staff path for queued check-ins that were kept as untrusted evidence: a coach records the attendance ON THE ORIGINAL
 * DAY (a real, human-verified attendance for a class of that day), or sets the evidence aside with a reason. The evidence
 * row is never deleted, resolving is atomic and single-use, and nothing is recorded on the replay day.
 */
const prisma = getTestPrismaClient();
const cleanupUserIds: string[] = [];
const cleanupEvidence: string[] = [];

afterAll(async () => {
  await prisma.queuedCheckIn.deleteMany({ where: { id: { in: cleanupEvidence } } });
  await prisma.auditLog.deleteMany({ where: { actorId: { in: cleanupUserIds } } });
  await prisma.staffAssignment.deleteMany({ where: { userId: { in: cleanupUserIds } } });
  await cleanupClassFixtures();
  await prisma.organizationMembership.deleteMany({ where: { userId: { in: cleanupUserIds } } });
  await prisma.user.deleteMany({ where: { id: { in: cleanupUserIds } } });
});

async function signIn(organizationId: string, role: "ADMIN" | "DIRECTOR" | "INSTRUCTOR" | "STUDENT", academyId?: string) {
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
  const user = await prisma.user.create({ data: { email: `queued-resolve-${role.toLowerCase()}-${suffix}@example.com`, passwordHash: await hashSecret("irrelevant-password-123"), role: role === "STUDENT" ? "STUDENT" : "ADMIN" } });
  cleanupUserIds.push(user.id);
  await prisma.organizationMembership.create({ data: { userId: user.id, organizationId, role } });
  // A director or instructor acts inside the academies they are assigned to; an owner (ADMIN) sees every academy.
  if (academyId && (role === "DIRECTOR" || role === "INSTRUCTOR")) await prisma.staffAssignment.create({ data: { userId: user.id, academyId, organizationId, role } });
  currentSession = { user: { id: user.id, role: role === "STUDENT" ? "STUDENT" : "ADMIN" }, activeOrganizationId: organizationId };
  return user;
}

const form = (fields: Record<string, string>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
};
const mon = (h: number, m: number) => new Date(Date.UTC(2026, 0, 5, h + 6, m, 0, 0));
const tue = (h: number, m: number) => mon(24 + h, m);

/** An academy with Monday 18:00 (A) and Tuesday 18:00 (T), one student, and the evidence rows a stale replay would have kept. */
async function fixture() {
  const { academy, sessions } = await makeClassAcademy([
    { dayOfWeek: "MONDAY", startTime: "18:00", durationMinutes: 60, name: "A" },
    { dayOfWeek: "TUESDAY", startTime: "18:00", durationMinutes: 60, name: "T" },
    { dayOfWeek: "MONDAY", startTime: "20:00", durationMinutes: 60, name: "Retired", active: false },
  ]);
  const byName = Object.fromEntries(sessions.map((s) => [s.name, s]));
  const { student } = await makeClassStudent(academy.id, academy.organizationId);
  let n = 0;
  const evidence = async (over: Partial<{ claimedAt: Date | null; claimedAtRaw: string | null; claimedAtVerified: boolean; claimedClassSessionId: string | null }> = {}) => {
    const row = await prisma.queuedCheckIn.create({
      data: {
        organizationId: academy.organizationId, academyId: academy.id, studentId: student.id, eventKey: `id:test-${++n}-${Math.random()}`,
        claimedAtRaw: over.claimedAtRaw ?? String((over.claimedAt ?? mon(18, 40)).getTime()), claimedAt: over.claimedAt === undefined ? mon(18, 40) : over.claimedAt,
        claimedAtVerified: over.claimedAtVerified ?? false, claimedClassSessionId: over.claimedClassSessionId === undefined ? byName.A.id : over.claimedClassSessionId, reason: "TIMESTAMP_NOT_VERIFIED",
        receivedAt: new Date("2026-01-08T16:00:00Z"),
      },
    });
    cleanupEvidence.push(row.id);
    return row;
  };
  const resolve = (id: string, fields: Record<string, string>) => resolveQueuedCheckInAction(academy.organizationId, {}, form({ queuedCheckInId: id, ...fields }));
  const dismiss = (id: string, reason: string) => dismissQueuedCheckInAction(academy.organizationId, {}, form({ queuedCheckInId: id, reason }));
  const attendance = () => prisma.attendanceRecord.findMany({ where: { studentId: student.id }, orderBy: { occurredAt: "asc" } });
  return { academy, byName, student, evidence, resolve, dismiss, attendance };
}

describe("recording queued evidence on its ORIGINAL day", () => {
  it("creates a real attendance dated the claimed day at the claimed instant for the chosen class, and links the evidence to it", async () => {
    const f = await fixture();
    const staff = await signIn(f.academy.organizationId, "DIRECTOR", f.academy.id);
    const kept = await f.evidence({ claimedAt: mon(18, 40) });
    const result = await f.resolve(kept.id, { classSessionId: f.byName.A.id, date: "2026-01-05" });
    expect(result).toEqual({ ok: true });

    const [row] = await f.attendance();
    expect(row).toMatchObject({ classSessionId: f.byName.A.id, type: "CHECKIN", delta: 1, source: "KIOSK", matchSource: "STAFF_CORRECTED", correctedById: staff.id, createdById: staff.id, voidedAt: null });
    expect(row.date.toISOString().slice(0, 10)).toBe("2026-01-05"); // the ORIGINAL day, not the day it was processed
    expect(row.occurredAt.toISOString()).toBe(mon(18, 40).toISOString()); // the claimed instant survives

    const after = await prisma.queuedCheckIn.findUniqueOrThrow({ where: { id: kept.id } });
    expect(after).toMatchObject({ status: "RESOLVED", resolvedAttendanceId: row.id, resolvedById: staff.id });
    expect(after.resolvedAt).not.toBeNull();
    expect(after.claimedAtRaw).toBe(kept.claimedAtRaw); // the evidence itself is untouched
    const audit = await prisma.auditLog.findFirst({ where: { entityType: "QueuedCheckIn", entityId: kept.id } });
    expect(audit?.action).toBe("queued_checkin.resolve");

    const summary = await getAtBeltSummary(f.student.id, f.student.organizationId, ALLIANCE_ATTENDANCE_CONFIG);
    expect(summary.lifetimeCount).toBe(1);
  });

  it("is single-use: recording the same evidence again is refused, and only one attendance exists", async () => {
    const f = await fixture();
    await signIn(f.academy.organizationId, "ADMIN");
    const kept = await f.evidence();
    expect(await f.resolve(kept.id, { classSessionId: f.byName.A.id, date: "2026-01-05" })).toEqual({ ok: true });
    expect(await f.resolve(kept.id, { classSessionId: f.byName.A.id, date: "2026-01-05" })).toEqual({ error: "notPending" });
    expect(await f.attendance()).toHaveLength(1);
  });

  it("two coaches resolving the same evidence at the same moment: exactly one attendance", async () => {
    const f = await fixture();
    await signIn(f.academy.organizationId, "ADMIN");
    const kept = await f.evidence();
    const results = await Promise.all([1, 2, 3].map(() => f.resolve(kept.id, { classSessionId: f.byName.A.id, date: "2026-01-05" })));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => r.error === "notPending")).toHaveLength(2);
    expect(await f.attendance()).toHaveLength(1);
  });

  it("when the chosen day is not the claimed day (or the claim is malformed) the attendance is placed at the class's own start on that day, never the claimed or replay instant", async () => {
    const f = await fixture();
    await signIn(f.academy.organizationId, "INSTRUCTOR", f.academy.id);
    const other = await f.evidence({ claimedAt: tue(18, 40), claimedClassSessionId: f.byName.T.id }); // claimed Tuesday...
    expect(await f.resolve(other.id, { classSessionId: f.byName.A.id, date: "2026-01-05" })).toEqual({ ok: true }); // ...coach records Monday
    const malformed = await f.evidence({ claimedAt: null, claimedAtRaw: "yesterday evening", claimedClassSessionId: null });
    expect(await f.resolve(malformed.id, { classSessionId: f.byName.T.id, date: "2026-01-06" })).toEqual({ ok: true });
    const rows = await f.attendance();
    expect(rows.map((r) => [r.date.toISOString().slice(0, 10), r.occurredAt.toISOString()])).toEqual([
      ["2026-01-05", mon(18, 0).toISOString()],
      ["2026-01-06", tue(18, 0).toISOString()],
    ]);
  });

  it("a malformed or future claim needs a day chosen by the coach: a missing or invalid date is refused and nothing is recorded", async () => {
    const f = await fixture();
    await signIn(f.academy.organizationId, "ADMIN");
    const kept = await f.evidence({ claimedAt: null, claimedAtRaw: "garbage" });
    for (const date of ["", "not-a-date", "2026-13-40", "05/01/2026"]) {
      expect(await f.resolve(kept.id, { classSessionId: f.byName.A.id, date }), date).toEqual({ error: "invalidDate" });
    }
    expect(await f.attendance()).toHaveLength(0);
    expect((await prisma.queuedCheckIn.findUniqueOrThrow({ where: { id: kept.id } })).status).toBe("PENDING");
  });

  it("refuses a day in the future, a class that is not on that weekday, an inactive class, and another academy's class", async () => {
    const f = await fixture();
    const elsewhere = await makeClassAcademy([{ dayOfWeek: "MONDAY", startTime: "18:00", name: "Elsewhere" }]);
    await signIn(f.academy.organizationId, "ADMIN");
    const kept = await f.evidence();
    const tomorrow = DateTime.now().setZone("America/Costa_Rica").plus({ days: 1 }).toISODate()!;
    expect(await f.resolve(kept.id, { classSessionId: f.byName.A.id, date: tomorrow })).toEqual({ error: "futureDate" });
    expect(await f.resolve(kept.id, { classSessionId: f.byName.A.id, date: "2026-01-06" })).toEqual({ error: "classNotOnThatDay" }); // A is a Monday class
    expect(await f.resolve(kept.id, { classSessionId: f.byName.Retired.id, date: "2026-01-05" })).toEqual({ error: "invalidClass" });
    expect(await f.resolve(kept.id, { classSessionId: elsewhere.sessions[0].id, date: "2026-01-05" })).toEqual({ error: "invalidClass" });
    expect(await f.resolve(kept.id, { classSessionId: "nope", date: "2026-01-05" })).toEqual({ error: "invalidClass" });
    expect(await f.attendance()).toHaveLength(0);
    expect((await prisma.queuedCheckIn.findUniqueOrThrow({ where: { id: kept.id } })).status).toBe("PENDING");
  });

  it("a class the student already attended that day is alreadyRecorded, and the evidence stays PENDING (nothing half-done)", async () => {
    const f = await fixture();
    await signIn(f.academy.organizationId, "ADMIN");
    await prisma.attendanceRecord.create({ data: { studentId: f.student.id, academyId: f.academy.id, organizationId: f.academy.organizationId, classSessionId: f.byName.A.id, occurredAt: mon(18, 5), date: new Date(Date.UTC(2026, 0, 5)), type: "CHECKIN", delta: 1, source: "KIOSK", matchSource: "AUTO" } });
    const kept = await f.evidence();
    expect(await f.resolve(kept.id, { classSessionId: f.byName.A.id, date: "2026-01-05" })).toEqual({ error: "alreadyRecorded" });
    expect((await prisma.queuedCheckIn.findUniqueOrThrow({ where: { id: kept.id } })).status).toBe("PENDING");
    expect(await f.attendance()).toHaveLength(1);
  });
});

describe("dismissing evidence", () => {
  it("needs a reason, keeps the row (never deleted), and cannot then be recorded", async () => {
    const f = await fixture();
    const staff = await signIn(f.academy.organizationId, "DIRECTOR", f.academy.id);
    const kept = await f.evidence();
    expect(await f.dismiss(kept.id, "  ")).toEqual({ error: "reasonRequired" });
    expect(await f.dismiss(kept.id, "ab")).toEqual({ error: "reasonRequired" });
    expect(await f.dismiss(kept.id, "Student says they left early")).toEqual({ ok: true });
    const after = await prisma.queuedCheckIn.findUniqueOrThrow({ where: { id: kept.id } });
    expect(after).toMatchObject({ status: "DISMISSED", dismissReason: "Student says they left early", resolvedById: staff.id, resolvedAttendanceId: null });
    expect(await f.dismiss(kept.id, "again please")).toEqual({ error: "notPending" });
    expect(await f.resolve(kept.id, { classSessionId: f.byName.A.id, date: "2026-01-05" })).toEqual({ error: "notPending" });
    expect(await f.attendance()).toHaveLength(0);
    expect((await prisma.auditLog.findFirst({ where: { entityType: "QueuedCheckIn", entityId: kept.id } }))?.action).toBe("queued_checkin.dismiss");
  });
});

describe("who may do this, and only inside their own tenant", () => {
  it("a student cannot record or dismiss evidence (a member with the wrong role is refused with FORBIDDEN, as everywhere else; nothing is written)", async () => {
    const f = await fixture();
    await signIn(f.academy.organizationId, "STUDENT");
    const kept = await f.evidence();
    await expect(f.resolve(kept.id, { classSessionId: f.byName.A.id, date: "2026-01-05" })).rejects.toThrow("FORBIDDEN");
    await expect(f.dismiss(kept.id, "not allowed")).rejects.toThrow("FORBIDDEN");
    expect(await f.attendance()).toHaveLength(0);
    expect((await prisma.queuedCheckIn.findUniqueOrThrow({ where: { id: kept.id } })).status).toBe("PENDING");
  });

  it("a director of ANOTHER academy in the same organization cannot handle it (academy scope), while a director of its own academy can", async () => {
    const f = await fixture();
    const elsewhere = await makeClassAcademy([{ dayOfWeek: "MONDAY", startTime: "18:00", name: "Elsewhere" }]);
    const kept = await f.evidence();
    await signIn(f.academy.organizationId, "DIRECTOR", elsewhere.academy.id);
    expect(await f.resolve(kept.id, { classSessionId: f.byName.A.id, date: "2026-01-05" })).toEqual({ error: "notFound" });
    expect(await f.dismiss(kept.id, "not my academy")).toEqual({ error: "notFound" });
    expect((await prisma.queuedCheckIn.findUniqueOrThrow({ where: { id: kept.id } })).status).toBe("PENDING");
    await signIn(f.academy.organizationId, "DIRECTOR", f.academy.id);
    expect(await f.resolve(kept.id, { classSessionId: f.byName.A.id, date: "2026-01-05" })).toEqual({ ok: true });
  });

  it("another organization's staff cannot see or change it (it is reported as not found)", async () => {
    const f = await fixture();
    const otherOrg = await makeAccountingOrg("PER_INTERVAL", "queued-other");
    try {
      const kept = await f.evidence();
      const staff = await prisma.user.create({ data: { email: `queued-other-admin-${Date.now()}@example.com`, passwordHash: await hashSecret("irrelevant-password-123"), role: "ADMIN" } });
      cleanupUserIds.push(staff.id);
      await prisma.organizationMembership.create({ data: { userId: staff.id, organizationId: otherOrg.org.id, role: "ADMIN" } });
      currentSession = { user: { id: staff.id, role: "ADMIN" }, activeOrganizationId: otherOrg.org.id };
      // Acting under THEIR organization id on someone else's record.
      expect(await resolveQueuedCheckInAction(otherOrg.org.id, {}, form({ queuedCheckInId: kept.id, classSessionId: f.byName.A.id, date: "2026-01-05" }))).toEqual({ error: "notFound" });
      expect(await dismissQueuedCheckInAction(otherOrg.org.id, {}, form({ queuedCheckInId: kept.id, reason: "not mine to dismiss" }))).toEqual({ error: "notFound" });
      expect((await prisma.queuedCheckIn.findUniqueOrThrow({ where: { id: kept.id } })).status).toBe("PENDING");
    } finally {
      await prisma.organizationMembership.deleteMany({ where: { organizationId: otherOrg.org.id } });
      await otherOrg.drop();
    }
  });
});
