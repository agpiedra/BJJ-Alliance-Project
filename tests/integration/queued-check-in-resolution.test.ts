import "dotenv/config";
import { getTestPrismaClient } from "../helpers/test-db";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { hashSecret } from "../../src/lib/crypto";
import { cleanupClassFixtures, makeClassAcademy, makeClassStudent } from "../helpers/class-fixtures";
import { ALLIANCE_ATTENDANCE_CONFIG, ALLIANCE_PER_INTERVAL_CONFIG } from "../helpers/promotion-config";
import { makeAccountingOrg } from "../helpers/accounting-org";

let currentSession: { user: { id: string; role: string } | null; activeOrganizationId?: string } | null = null;
vi.mock("@/auth", () => ({ auth: () => Promise.resolve(currentSession) }));

const { resolveQueuedCheckInAction, dismissQueuedCheckInAction } = await import(
  "../../src/app/[locale]/(staff)/admin/kiosk-tokens/queued-check-in-actions"
);
const { getAtBeltSummary } = await import("../../src/lib/students/attendance-summary");
const { listContributingDays } = await import("../../src/lib/promotion/progress-days");

/**
 * The staff path for queued check-ins that were kept as untrusted evidence: a coach records the attendance ON THE ORIGINAL
 * DAY (a real, human-verified attendance for a class of that day), or sets the evidence aside with a reason. The evidence
 * row is never deleted, resolving is atomic and single-use, and nothing is recorded on the replay day.
 */
const prisma = getTestPrismaClient();
const cleanupUserIds: string[] = [];
const cleanupEvidence: string[] = [];

afterEach(() => vi.useRealTimers());

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
    { dayOfWeek: "MONDAY", startTime: "20:00", durationMinutes: 60, name: "Later" },
    // Opens Monday 23:40: a tap late on Monday night belongs to THIS class, whose own day is Tuesday.
    { dayOfWeek: "TUESDAY", startTime: "00:10", durationMinutes: 60, name: "Late" },
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
  // `time` is the tap time (HH:mm, Costa Rica) the coach CONFIRMS; most tests confirm the usual 18:40.
  const resolve = (id: string, fields: Record<string, string>) => resolveQueuedCheckInAction(academy.organizationId, {}, form({ queuedCheckInId: id, time: "18:40", ...fields }));
  const dismiss = (id: string, reason: string) => dismissQueuedCheckInAction(academy.organizationId, {}, form({ queuedCheckInId: id, reason }));
  // A promotion at `at`: both accountings measure the new interval from these two instants (see attendance-summary.ts).
  const promote = (at: Date) => prisma.student.update({ where: { id: student.id }, data: { beltAwardedAt: at, progressBaselineAt: at } });
  const counts = async () => ({
    perInterval: (await getAtBeltSummary(student.id, academy.organizationId, ALLIANCE_PER_INTERVAL_CONFIG)).atBeltCount,
    cumulative: (await getAtBeltSummary(student.id, academy.organizationId, ALLIANCE_ATTENDANCE_CONFIG)).atBeltCount,
  });
  const attendance = () => prisma.attendanceRecord.findMany({ where: { studentId: student.id }, orderBy: { occurredAt: "asc" } });
  return { academy, byName, student, evidence, resolve, dismiss, attendance, promote, counts };
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

  it("a malformed claim has no time to confirm: the coach must state one, and it is recorded as the coach's, never invented from the class start", async () => {
    const f = await fixture();
    await signIn(f.academy.organizationId, "INSTRUCTOR", f.academy.id);
    const malformed = await f.evidence({ claimedAt: null, claimedAtRaw: "yesterday evening", claimedClassSessionId: null });
    for (const time of ["", "  ", "7pm", "25:00", "18:60", "18:40:15"]) {
      expect(await f.resolve(malformed.id, { classSessionId: f.byName.T.id, date: "2026-01-06", time }), time).toEqual({ error: "invalidTime" });
    }
    expect(await f.attendance()).toHaveLength(0);
    expect(await f.resolve(malformed.id, { classSessionId: f.byName.T.id, date: "2026-01-06", time: "18:10" })).toEqual({ ok: true });
    const [row] = await f.attendance();
    expect([row.date.toISOString().slice(0, 10), row.occurredAt.toISOString()]).toEqual(["2026-01-06", tue(18, 10).toISOString()]);
    const after = await prisma.queuedCheckIn.findUniqueOrThrow({ where: { id: malformed.id } });
    expect(after).toMatchObject({ claimedAt: null, claimedAtRaw: "yesterday evening", claimedAtVerified: false }); // the claim itself is untouched
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { entityType: "QueuedCheckIn", entityId: malformed.id } });
    expect(audit.after).toMatchObject({ confirmedTime: "18:10", instantSource: "STAFF_ENTERED", occurredAt: tue(18, 10).toISOString() });
  });

  it("a claim on a different day than the class's: the confirmed time is the coach's, on the class's own occurrence (still never the class start)", async () => {
    const f = await fixture();
    await signIn(f.academy.organizationId, "INSTRUCTOR", f.academy.id);
    const other = await f.evidence({ claimedAt: tue(18, 40), claimedClassSessionId: f.byName.T.id }); // the tablet claimed Tuesday...
    expect(await f.resolve(other.id, { classSessionId: f.byName.A.id, date: "2026-01-05", time: "18:25" })).toEqual({ ok: true }); // ...the coach says Monday 18:25
    const [row] = await f.attendance();
    expect([row.date.toISOString().slice(0, 10), row.occurredAt.toISOString()]).toEqual(["2026-01-05", mon(18, 25).toISOString()]);
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { entityType: "QueuedCheckIn", entityId: other.id } });
    expect(audit.after).toMatchObject({ instantSource: "STAFF_ENTERED" });
    expect(audit.before).toMatchObject({ claimedAtRaw: other.claimedAtRaw }); // the original claim stays on record
  });

  it("a missing or invalid class day is refused and nothing is recorded", async () => {
    const f = await fixture();
    await signIn(f.academy.organizationId, "ADMIN");
    const kept = await f.evidence({ claimedAt: null, claimedAtRaw: "garbage" });
    for (const date of ["", "not-a-date", "2026-13-40", "05/01/2026"]) {
      expect(await f.resolve(kept.id, { classSessionId: f.byName.A.id, date }), date).toEqual({ error: "invalidDate" });
    }
    expect(await f.attendance()).toHaveLength(0);
    expect((await prisma.queuedCheckIn.findUniqueOrThrow({ where: { id: kept.id } })).status).toBe("PENDING");
  });

  it("refuses a class that is not on that weekday, an inactive class, and another academy's class", async () => {
    const f = await fixture();
    const elsewhere = await makeClassAcademy([{ dayOfWeek: "MONDAY", startTime: "18:00", name: "Elsewhere" }]);
    await signIn(f.academy.organizationId, "ADMIN");
    const kept = await f.evidence();
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

describe("which instant the coach is confirming (the class's ledger day is not the tap's calendar day)", () => {
  it("a Monday 23:50 tap for Tuesday's 00:10 class keeps its OWN instant: a promotion at Monday 23:55 leaves it behind, and it adds nothing to the new interval", async () => {
    const f = await fixture();
    await signIn(f.academy.organizationId, "ADMIN");
    const promotedAt = mon(23, 55);
    await f.promote(promotedAt);
    const tap = new Date(mon(23, 50).getTime() + 27_000); // seconds must survive too
    const kept = await f.evidence({ claimedAt: tap, claimedClassSessionId: f.byName.Late.id });

    expect(await f.resolve(kept.id, { classSessionId: f.byName.Late.id, date: "2026-01-06", time: "23:50" })).toEqual({ ok: true });

    const [row] = await f.attendance();
    expect(row.date.toISOString().slice(0, 10)).toBe("2026-01-06"); // the class occurrence's own (Tuesday) ledger day...
    expect(row.occurredAt.toISOString()).toBe(tap.toISOString()); // ...and the tap's own instant, NOT Tuesday 00:10
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { entityType: "QueuedCheckIn", entityId: kept.id } });
    expect(audit.after).toMatchObject({ confirmedTime: "23:50", instantSource: "CLAIMED" });

    // Nothing after the reset, under BOTH accountings; the attendance is still real (lifetime) and belongs to the interval before.
    expect(await f.counts()).toEqual({ perInterval: 0, cumulative: 0 });
    expect((await getAtBeltSummary(f.student.id, f.student.organizationId, ALLIANCE_ATTENDANCE_CONFIG)).lifetimeCount).toBe(1);
    const before = await listContributingDays(prisma, { studentId: f.student.id, organizationId: f.student.organizationId, from: mon(0, 0), until: promotedAt });
    expect(before.map((d) => [d.day, d.firstAt.toISOString()])).toEqual([["2026-01-06", tap.toISOString()]]);
  });

  it("the control: a tap at Tuesday 00:05, after the same promotion, does count in the new interval (so the test above can tell)", async () => {
    const f = await fixture();
    await signIn(f.academy.organizationId, "ADMIN");
    await f.promote(mon(23, 55));
    const kept = await f.evidence({ claimedAt: tue(0, 5), claimedClassSessionId: f.byName.Late.id });
    expect(await f.resolve(kept.id, { classSessionId: f.byName.Late.id, date: "2026-01-06", time: "00:05" })).toEqual({ ok: true });
    const [row] = await f.attendance();
    expect(row.occurredAt.toISOString()).toBe(tue(0, 5).toISOString());
    expect(await f.counts()).toEqual({ perInterval: 1, cumulative: 1 });
  });

  it("a time that fits no occurrence of the chosen class is refused (never moved onto the class start): the window is start - 30 min to end + 30 min, inclusive", async () => {
    const f = await fixture();
    await signIn(f.academy.organizationId, "ADMIN");
    const kept = await f.evidence({ claimedAt: null, claimedAtRaw: "garbage" });
    for (const time of ["12:00", "17:29", "19:31", "00:00"]) {
      expect(await f.resolve(kept.id, { classSessionId: f.byName.A.id, date: "2026-01-05", time }), time).toEqual({ error: "timeOutsideClass" });
    }
    expect(await f.resolve(kept.id, { classSessionId: f.byName.Late.id, date: "2026-01-06", time: "12:00" })).toEqual({ error: "timeOutsideClass" });
    expect(await f.attendance()).toHaveLength(0);
    expect((await prisma.queuedCheckIn.findUniqueOrThrow({ where: { id: kept.id } })).status).toBe("PENDING");
    expect(await f.resolve(kept.id, { classSessionId: f.byName.A.id, date: "2026-01-05", time: "19:30" })).toEqual({ ok: true }); // the closing boundary is inclusive
    expect((await f.attendance())[0].occurredAt.toISOString()).toBe(mon(19, 30).toISOString());
  });
});

describe("the recorded instant itself must be inside the window (not only its minute)", () => {
  const closesAt = mon(19, 30); // class A runs 18:00-19:00, so its window closes at 19:30:00.000

  it("a claim exactly at closesAt is accepted and keeps its exact instant", async () => {
    const f = await fixture();
    await signIn(f.academy.organizationId, "ADMIN");
    const kept = await f.evidence({ claimedAt: closesAt });
    expect(await f.resolve(kept.id, { classSessionId: f.byName.A.id, date: "2026-01-05", time: "19:30" })).toEqual({ ok: true });
    expect((await f.attendance())[0].occurredAt.toISOString()).toBe(closesAt.toISOString());
  });

  it("a claim 1 ms after closesAt is refused even though staff confirm the same HH:mm: timeOutsideClass, evidence stays PENDING, nothing written", async () => {
    const f = await fixture();
    await signIn(f.academy.organizationId, "ADMIN");
    const kept = await f.evidence({ claimedAt: new Date(closesAt.getTime() + 1) });
    expect(await f.resolve(kept.id, { classSessionId: f.byName.A.id, date: "2026-01-05", time: "19:30" })).toEqual({ error: "timeOutsideClass" });
    expect(await f.attendance()).toHaveLength(0);
    expect(await f.counts()).toEqual({ perInterval: 0, cumulative: 0 });
    const after = await prisma.queuedCheckIn.findUniqueOrThrow({ where: { id: kept.id } });
    expect(after.status).toBe("PENDING");
    expect(after.claimedAt?.toISOString()).toBe(new Date(closesAt.getTime() + 1).toISOString()); // the claim is untouched
    // The coach can still record the same evidence with a time that is inside the window (their own time, not the claim).
    expect(await f.resolve(kept.id, { classSessionId: f.byName.A.id, date: "2026-01-05", time: "19:29" })).toEqual({ ok: true });
    expect((await f.attendance())[0].occurredAt.toISOString()).toBe(mon(19, 29).toISOString());
  });

  it("a valid claimed instant retains its original precision, milliseconds included", async () => {
    const f = await fixture();
    await signIn(f.academy.organizationId, "ADMIN");
    const claim = new Date(mon(18, 40).getTime() + 12_345);
    const kept = await f.evidence({ claimedAt: claim });
    expect(await f.resolve(kept.id, { classSessionId: f.byName.A.id, date: "2026-01-05", time: "18:40" })).toEqual({ ok: true });
    expect((await f.attendance())[0].occurredAt.toISOString()).toBe(claim.toISOString());
  });
});

describe("the FINAL instant is validated, not only the chosen day", () => {
  const at = (instant: Date) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(instant);
  };

  it("a claimed time later today (still in the future) is refused, stays PENDING and records nothing; once it has passed the same evidence is recordable at exactly that instant", async () => {
    const f = await fixture();
    await signIn(f.academy.organizationId, "ADMIN");
    const kept = await f.evidence({ claimedAt: mon(19, 20) }); // class A runs 18:00-19:00 (open to 19:30)
    at(mon(19, 0));
    expect(await f.resolve(kept.id, { classSessionId: f.byName.A.id, date: "2026-01-05", time: "19:20" })).toEqual({ error: "futureTime" });
    expect(await f.attendance()).toHaveLength(0);
    expect((await prisma.queuedCheckIn.findUniqueOrThrow({ where: { id: kept.id } })).status).toBe("PENDING");
    expect(await f.counts()).toEqual({ perInterval: 0, cumulative: 0 });

    at(mon(19, 25));
    expect(await f.resolve(kept.id, { classSessionId: f.byName.A.id, date: "2026-01-05", time: "19:20" })).toEqual({ ok: true });
    expect((await f.attendance())[0].occurredAt.toISOString()).toBe(mon(19, 20).toISOString());
  });

  it("a class that starts later today is no fallback: an unreadable claim confirmed as the class start is future and refused, and a time before that class opens is outside it", async () => {
    const f = await fixture();
    await signIn(f.academy.organizationId, "ADMIN");
    const kept = await f.evidence({ claimedAt: null, claimedAtRaw: "garbage", claimedClassSessionId: null });
    at(mon(19, 0)); // "Later" runs 20:00-21:00, open from 19:30
    expect(await f.resolve(kept.id, { classSessionId: f.byName.Later.id, date: "2026-01-05", time: "20:00" })).toEqual({ error: "futureTime" });
    expect(await f.resolve(kept.id, { classSessionId: f.byName.Later.id, date: "2026-01-05", time: "18:50" })).toEqual({ error: "timeOutsideClass" });
    expect(await f.resolve(kept.id, { classSessionId: f.byName.Later.id, date: "2026-01-05", time: "" })).toEqual({ error: "invalidTime" });
    expect(await f.attendance()).toHaveLength(0);
    expect((await prisma.queuedCheckIn.findUniqueOrThrow({ where: { id: kept.id } })).status).toBe("PENDING");
  });

  it("a Monday-night tap for Tuesday's early class is future at 23:45 and recordable at 23:58, while it is still Monday night", async () => {
    const f = await fixture();
    await signIn(f.academy.organizationId, "ADMIN");
    const kept = await f.evidence({ claimedAt: mon(23, 50), claimedClassSessionId: f.byName.Late.id });
    at(mon(23, 45));
    expect(await f.resolve(kept.id, { classSessionId: f.byName.Late.id, date: "2026-01-06", time: "23:50" })).toEqual({ error: "futureTime" });
    at(mon(23, 58)); // still Monday in Costa Rica: the tap is in the past although the class occurrence's day (Tuesday) has not started
    expect(await f.resolve(kept.id, { classSessionId: f.byName.Late.id, date: "2026-01-06", time: "23:50" })).toEqual({ ok: true });
    expect((await f.attendance())[0].occurredAt.toISOString()).toBe(mon(23, 50).toISOString());
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
