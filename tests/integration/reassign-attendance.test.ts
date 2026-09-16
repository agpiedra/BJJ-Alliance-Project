import "dotenv/config";
import { getTestPrismaClient } from "../helpers/test-db";
import { afterAll, describe, expect, it } from "vitest";
import { requireEnv } from "../../src/lib/env";
import { digestLookupSecret, hashSecret } from "../../src/lib/crypto";
import type { KioskContext } from "../../src/lib/tenant/types";
import { adultRankId } from "../helpers/belt-ranks";

const { reassignAttendance } = await import("../../src/lib/kiosk/reassign-attendance");

/** A KioskContext matching a fixture academy — 1f-3: reassignAttendance now requires one. */
function ctx(academy: { id: string; organizationId: string }): KioskContext {
  return { kind: "kiosk", organizationId: academy.organizationId, academyId: academy.id };
}

const prisma = getTestPrismaClient();

let allianceOrgIdPromise: Promise<string> | null = null;
function getAllianceOrganizationId() {
  allianceOrgIdPromise ??= prisma.organization.findUniqueOrThrow({ where: { slug: "alliance-cr" } }).then((o) => o.id);
  return allianceOrgIdPromise;
}
const pepper = requireEnv("CODE_PEPPER");

// Monday 2026-01-05, as the `@db.Date` UTC-midnight value AttendanceRecord.date
// stores (see src/lib/scheduling/zone.ts).
const MONDAY_DATE = new Date(Date.UTC(2026, 0, 5));
const MONDAY_INSTANT = new Date("2026-01-05T19:30:00Z");

const cleanupStudentIds: string[] = [];
const cleanupAcademyIds: string[] = [];
const cleanupUserIds: string[] = [];

afterAll(async () => {
  if (cleanupStudentIds.length > 0) {
    await prisma.attendanceRecord.deleteMany({ where: { studentId: { in: cleanupStudentIds } } });
    await prisma.student.deleteMany({ where: { id: { in: cleanupStudentIds } } });
  }
  if (cleanupUserIds.length > 0) {
    await prisma.auditLog.deleteMany({ where: { actorId: { in: cleanupUserIds } } });
    await prisma.notification.deleteMany({ where: { userId: { in: cleanupUserIds } } });
    await prisma.user.deleteMany({ where: { id: { in: cleanupUserIds } } });
  }
  if (cleanupAcademyIds.length > 0) {
    await prisma.classSession.deleteMany({ where: { academyId: { in: cleanupAcademyIds } } });
    await prisma.academy.deleteMany({ where: { id: { in: cleanupAcademyIds } } });
  }
});

function suffix() {
  return `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
}

/** Private academy with exactly the sessions a scenario needs — same reasoning
 * as perform-check-in.test.ts's own fixture helper (seed.test.ts asserts
 * Escazú's exact session count, and vitest runs files in parallel). */
async function makeAcademy(
  sessions: Array<{ dayOfWeek: "MONDAY" | "TUESDAY"; startTime: string; name: string; active?: boolean }>,
) {
  const id = suffix();
  const academy = await prisma.academy.create({
    data: {
      name: `Reassign Fixture ${id}`,
      slug: `reassign-fixture-${id}`,
      kioskTokenHash: `reassign-hash-${id}`,
      organizationId: await getAllianceOrganizationId(),
    },
  });
  cleanupAcademyIds.push(academy.id);

  const created = [];
  for (const session of sessions) {
    created.push(
      await prisma.classSession.create({
        data: {
          academyId: academy.id,
          organizationId: academy.organizationId,
          dayOfWeek: session.dayOfWeek,
          startTime: session.startTime,
          durationMinutes: 60,
          name: session.name,
          type: "GI",
          active: session.active ?? true,
        },
      }),
    );
  }
  return { academy, sessions: created };
}

async function makeStudent(homeAcademyId: string, organizationId: string) {
  const id = suffix();
  const student = await prisma.student.create({
    data: {
      homeAcademyId,
      organizationId,
      firstName: "ReassignTest",
      lastName: "Student",
      phone: "88881111",
      email: `reassign-${id}@example.com`,
      currentRankId: adultRankId("WHITE"),
      beltAwardedAt: new Date("2026-01-01T00:00:00Z"),
      status: "ACTIVE",
      codeHash: digestLookupSecret(`reassign-${id}`, pepper),
    },
  });
  cleanupStudentIds.push(student.id);
  return student;
}

async function makeStaffUser() {
  const id = suffix();
  const user = await prisma.user.create({
    data: {
      email: `reassign-staff-${id}@example.com`,
      passwordHash: await hashSecret("not-a-real-password"),
      role: "DIRECTOR",
    },
  });
  cleanupUserIds.push(user.id);
  return user;
}

async function makeCheckIn(studentId: string, academyId: string, organizationId: string, classSessionId: string | null) {
  return prisma.attendanceRecord.create({
    data: {
      studentId,
      academyId,
      organizationId,
      classSessionId,
      occurredAt: MONDAY_INSTANT,
      date: MONDAY_DATE,
      type: "CHECKIN",
      delta: 1,
      source: "KIOSK",
      matchSource: classSessionId ? "AUTO" : "UNMATCHED",
    },
  });
}

describe("reassignAttendance", () => {
  it("moves the record, stamps STAFF_CORRECTED + correctedBy, and leaves occurredAt/date alone", async () => {
    const { academy, sessions } = await makeAcademy([
      { dayOfWeek: "MONDAY", startTime: "18:00", name: "Uno" },
      { dayOfWeek: "MONDAY", startTime: "19:00", name: "Dos" },
    ]);
    const student = await makeStudent(academy.id, academy.organizationId);
    const staff = await makeStaffUser();
    const record = await makeCheckIn(student.id, academy.id, academy.organizationId, sessions[0].id);

    const result = await reassignAttendance(record.id, sessions[1].id, {
      actorUserId: staff.id,
      matchSource: "STAFF_CORRECTED",
      expectedAcademyId: academy.id,
      context: ctx(academy),
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.matchedClass.name).toBe("Dos");

    const after = await prisma.attendanceRecord.findUniqueOrThrow({ where: { id: record.id } });
    expect(after.classSessionId).toBe(sessions[1].id);
    expect(after.matchSource).toBe("STAFF_CORRECTED");
    expect(after.correctedById).toBe(staff.id);
    expect(after.correctedAt).not.toBeNull();
    // The raw instant of the original tap survives the correction.
    expect(after.occurredAt.toISOString()).toBe(MONDAY_INSTANT.toISOString());
    expect(after.date.toISOString()).toBe(MONDAY_DATE.toISOString());

    const audit = await prisma.auditLog.findFirst({
      where: { entityType: "AttendanceRecord", entityId: record.id },
    });
    expect(audit?.action).toBe("attendance.reassign");
  });

  it("attributes a student's own correction as STUDENT_PICKED, with no correctedBy", async () => {
    const { academy, sessions } = await makeAcademy([{ dayOfWeek: "MONDAY", startTime: "18:00", name: "Uno" }]);
    const student = await makeStudent(academy.id, academy.organizationId);
    // An UNMATCHED tap the student then attributes themselves, at the kiosk.
    const record = await makeCheckIn(student.id, academy.id, academy.organizationId, null);

    const result = await reassignAttendance(record.id, sessions[0].id, {
      actorUserId: null,
      matchSource: "STUDENT_PICKED",
      expectedAcademyId: academy.id,
      context: ctx(academy),
    });

    expect(result.ok).toBe(true);
    const after = await prisma.attendanceRecord.findUniqueOrThrow({ where: { id: record.id } });
    expect(after.matchSource).toBe("STUDENT_PICKED");
    expect(after.correctedById).toBeNull();
  });

  it("leaves an earlier staff correction's correctedBy intact when the student then re-picks", async () => {
    const { academy, sessions } = await makeAcademy([
      { dayOfWeek: "MONDAY", startTime: "18:00", name: "Uno" },
      { dayOfWeek: "MONDAY", startTime: "19:00", name: "Dos" },
    ]);
    const student = await makeStudent(academy.id, academy.organizationId);
    const staff = await makeStaffUser();
    const record = await makeCheckIn(student.id, academy.id, academy.organizationId, sessions[0].id);

    await reassignAttendance(record.id, sessions[1].id, {
      actorUserId: staff.id,
      matchSource: "STAFF_CORRECTED",
      expectedAcademyId: academy.id,
      context: ctx(academy),
    });
    // Student then self-corrects it back. `matchSource` follows the latest
    // actor, but WHO corrected it before must not be erased from the row —
    // the student path never writes those two columns at all.
    await reassignAttendance(record.id, sessions[0].id, {
      actorUserId: null,
      matchSource: "STUDENT_PICKED",
      expectedAcademyId: academy.id,
      context: ctx(academy),
    });

    const after = await prisma.attendanceRecord.findUniqueOrThrow({ where: { id: record.id } });
    expect(after.classSessionId).toBe(sessions[0].id);
    expect(after.matchSource).toBe("STUDENT_PICKED");
    expect(after.correctedById).toBe(staff.id);
    expect(after.correctedAt).not.toBeNull();
  });

  it("refuses to reassign anything that isn't a CHECKIN row", async () => {
    const { academy, sessions } = await makeAcademy([{ dayOfWeek: "MONDAY", startTime: "18:00", name: "Uno" }]);
    const student = await makeStudent(academy.id, academy.organizationId);
    const adjustment = await prisma.attendanceRecord.create({
      data: {
        studentId: student.id,
        academyId: academy.id,
        organizationId: academy.organizationId,
        occurredAt: MONDAY_INSTANT,
        date: MONDAY_DATE,
        type: "ADJUSTMENT",
        delta: 7,
        reason: "backfill",
        source: "STAFF",
      },
    });

    const result = await reassignAttendance(adjustment.id, sessions[0].id, {
      actorUserId: null,
      matchSource: "STUDENT_PICKED",
      expectedAcademyId: academy.id,
      context: ctx(academy),
    });

    expect(result).toEqual({ ok: false, error: "invalidRecord" });
    const after = await prisma.attendanceRecord.findUniqueOrThrow({ where: { id: adjustment.id } });
    expect(after.classSessionId).toBeNull();
  });

  it("rejects a class belonging to a different academy", async () => {
    const mine = await makeAcademy([{ dayOfWeek: "MONDAY", startTime: "18:00", name: "Mía" }]);
    const theirs = await makeAcademy([{ dayOfWeek: "MONDAY", startTime: "18:00", name: "Ajena" }]);
    const student = await makeStudent(mine.academy.id, mine.academy.organizationId);
    const record = await makeCheckIn(student.id, mine.academy.id, mine.academy.organizationId, mine.sessions[0].id);

    const result = await reassignAttendance(record.id, theirs.sessions[0].id, {
      actorUserId: null,
      matchSource: "STUDENT_PICKED",
      expectedAcademyId: mine.academy.id,
      context: ctx(mine.academy),
    });

    expect(result).toEqual({ ok: false, error: "invalidClass" });
  });

  it("rejects a class scheduled on a different weekday than the record's own date", async () => {
    const { academy, sessions } = await makeAcademy([
      { dayOfWeek: "MONDAY", startTime: "18:00", name: "Lunes" },
      { dayOfWeek: "TUESDAY", startTime: "18:00", name: "Martes" },
    ]);
    const student = await makeStudent(academy.id, academy.organizationId);
    const record = await makeCheckIn(student.id, academy.id, academy.organizationId, sessions[0].id);

    const result = await reassignAttendance(record.id, sessions[1].id, {
      actorUserId: null,
      matchSource: "STUDENT_PICKED",
      expectedAcademyId: academy.id,
      context: ctx(academy),
    });

    expect(result).toEqual({ ok: false, error: "invalidClass" });
  });

  it("rejects an inactive class, an unknown record, and an out-of-scope academy", async () => {
    const { academy, sessions } = await makeAcademy([
      { dayOfWeek: "MONDAY", startTime: "18:00", name: "Activa" },
      { dayOfWeek: "MONDAY", startTime: "20:00", name: "Inactiva", active: false },
    ]);
    const student = await makeStudent(academy.id, academy.organizationId);
    const record = await makeCheckIn(student.id, academy.id, academy.organizationId, sessions[0].id);

    expect(
      await reassignAttendance(record.id, sessions[1].id, {
        actorUserId: null,
        matchSource: "STUDENT_PICKED",
        expectedAcademyId: academy.id,
        context: ctx(academy),
      }),
    ).toEqual({ ok: false, error: "invalidClass" });

    expect(
      await reassignAttendance("no-such-record", sessions[0].id, {
        actorUserId: null,
        matchSource: "STUDENT_PICKED",
        expectedAcademyId: academy.id,
        context: ctx(academy),
      }),
    ).toEqual({ ok: false, error: "notFound" });

    expect(
      await reassignAttendance(record.id, sessions[0].id, {
        actorUserId: null,
        matchSource: "STUDENT_PICKED",
        expectedAcademyId: "some-other-academy",
        context: ctx(academy),
      }),
    ).toEqual({ ok: false, error: "notFound" });
  });

  it("reports a collision with an attendance the student already has in the target class", async () => {
    const { academy, sessions } = await makeAcademy([
      { dayOfWeek: "MONDAY", startTime: "18:00", name: "Uno" },
      { dayOfWeek: "MONDAY", startTime: "19:00", name: "Dos" },
    ]);
    const student = await makeStudent(academy.id, academy.organizationId);
    const first = await makeCheckIn(student.id, academy.id, academy.organizationId, sessions[0].id);
    await makeCheckIn(student.id, academy.id, academy.organizationId, sessions[1].id);

    const result = await reassignAttendance(first.id, sessions[1].id, {
      actorUserId: null,
      matchSource: "STUDENT_PICKED",
      expectedAcademyId: academy.id,
      context: ctx(academy),
    });

    expect(result).toEqual({ ok: false, error: "alreadyRecorded" });
  });

  it("expectedAcademyId is required at the type level — 1f-1: omitting it must be a compile error, not a silently-disabled runtime guard", () => {
    void (() =>
      // @ts-expect-error — expectedAcademyId is required; TS must refuse a call that omits it.
      reassignAttendance("x", "y", { actorUserId: null, matchSource: "STUDENT_PICKED" }));
  });
});
