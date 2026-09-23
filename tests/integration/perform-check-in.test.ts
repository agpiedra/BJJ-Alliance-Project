import "dotenv/config";
import { getTestPrismaClient } from "../helpers/test-db";
import { afterAll, describe, expect, it } from "vitest";
import { requireEnv } from "../../src/lib/env";
import { digestLookupSecret } from "../../src/lib/crypto";
import { adultRankId } from "../helpers/belt-ranks";
import { ALLIANCE_ATTENDANCE_CONFIG } from "../helpers/promotion-config";

const { performCheckIn } = await import("../../src/lib/kiosk/perform-check-in");
const { selectActiveSessionOccurrence } = await import("../../src/lib/scheduling/check-in-window");
const { reassignAttendance } = await import("../../src/lib/kiosk/reassign-attendance");
const { getAtBeltSummary } = await import("../../src/lib/students/attendance-summary");

/** A KioskContext matching a fixture/seeded academy — 1f-3: performCheckIn/reassignAttendance now require one. */
function ctx(academy: { id: string; organizationId: string }): import("../../src/lib/tenant/types").KioskContext {
  return { kind: "kiosk", organizationId: academy.organizationId, academyId: academy.id };
}

const prisma = getTestPrismaClient();

let allianceOrgIdPromise: Promise<string> | null = null;
function getAllianceOrganizationId() {
  allianceOrgIdPromise ??= prisma.organization.findUniqueOrThrow({ where: { slug: "alliance-cr" } }).then((o) => o.id);
  return allianceOrgIdPromise;
}
const pepper = requireEnv("CODE_PEPPER");

const DAY_MS = 24 * 60 * 60 * 1000;

// 2026-01-05T12:00:00Z is 2026-01-05 06:00 America/Costa_Rica (UTC-6, fixed,
// no DST) — a Monday, which is exactly the seeded Escazú "GI" session's start,
// squarely inside its ±30-minute window ([05:30, 06:30] CR) and inside no
// other Escazú session's.
const WITHIN_MONDAY_GI_WINDOW = new Date("2026-01-05T12:00:00Z");

// 2026-01-04T18:00:00Z is 2026-01-04 12:00 CR — a Sunday, and the seeded
// schedule has no Sunday sessions at all (nor any session whose ±30-minute
// window crosses into Sunday from Saturday or out to Monday), so this falls
// outside every active session's check-in window.
const OUTSIDE_ANY_WINDOW = new Date("2026-01-04T18:00:00Z");

const cleanupStudentIds: string[] = [];
/**
 * Some scenarios below (a window that crosses CR midnight; a class flagged
 * `countsTowardPromotion: false` alongside one that counts) can't be expressed
 * with the seeded Escazú schedule. They get private throwaway academies rather
 * than new sessions inside Escazú, because `seed.test.ts` and
 * `session-scoping.test.ts` both assert Escazú's exact session count and
 * vitest runs test files in parallel.
 */
const cleanupAcademyIds: string[] = [];

async function cleanup() {
  if (cleanupStudentIds.length > 0) {
    await prisma.attendanceRecord.deleteMany({ where: { studentId: { in: cleanupStudentIds } } });
    await prisma.student.deleteMany({ where: { id: { in: cleanupStudentIds } } });
  }
  if (cleanupAcademyIds.length > 0) {
    await prisma.classSession.deleteMany({ where: { academyId: { in: cleanupAcademyIds } } });
    await prisma.academy.deleteMany({ where: { id: { in: cleanupAcademyIds } } });
  }
}

/** A private academy with exactly the sessions a scenario needs, and nothing else. */
async function makeFixtureAcademy(
  sessions: Array<{
    dayOfWeek: "MONDAY" | "TUESDAY" | "WEDNESDAY" | "THURSDAY" | "FRIDAY" | "SATURDAY" | "SUNDAY";
    startTime: string;
    name: string;
    countsTowardPromotion?: boolean;
  }>,
) {
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
  const academy = await prisma.academy.create({
    data: {
      name: `Check-In Fixture ${suffix}`,
      slug: `check-in-fixture-${suffix}`,
      kioskTokenHash: `check-in-fixture-hash-${suffix}`,
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
          countsTowardPromotion: session.countsTowardPromotion ?? true,
        },
      }),
    );
  }

  return { academy, sessions: created };
}

async function makeStudent(overrides: {
  homeAcademyId: string;
  status?: "PENDING" | "ACTIVE" | "INACTIVE" | "ARCHIVED";
  currentStripes?: number;
  beltAwardedAt?: Date;
}) {
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
  const code = `chk-${suffix}`;
  const academy = await prisma.academy.findUniqueOrThrow({
    where: { id: overrides.homeAcademyId },
    select: { organizationId: true },
  });
  const student = await prisma.student.create({
    data: {
      homeAcademyId: overrides.homeAcademyId,
      organizationId: academy.organizationId,
      firstName: "PerformCheckInTest",
      lastName: "Student",
      phone: "88881111",
      email: `perform-check-in-${suffix}@example.com`,
      currentRankId: adultRankId("WHITE"),
      currentStripes: overrides.currentStripes ?? 0,
      beltAwardedAt: overrides.beltAwardedAt ?? new Date("2026-01-01T00:00:00Z"),
      status: overrides.status ?? "ACTIVE",
      codeHash: digestLookupSecret(code, pepper),
    },
  });
  cleanupStudentIds.push(student.id);
  return { student, code };
}

/** Writes `count` real CHECKIN rows (no classSessionId), one per day starting at `startAt`. */
async function addSyntheticCheckins(
  studentId: string,
  academyId: string,
  organizationId: string,
  count: number,
  startAt: Date,
) {
  const rows = Array.from({ length: count }, (_, i) => {
    const occurredAt = new Date(startAt.getTime() + i * DAY_MS);
    return {
      studentId,
      academyId,
      organizationId,
      occurredAt,
      // Naive UTC-date slice is fine here — this helper never runs near
      // midnight CR and correctness of `date` for these synthetic rows isn't
      // under test (attendance-summary.test.ts already covers toAttendanceDate).
      date: new Date(Date.UTC(occurredAt.getUTCFullYear(), occurredAt.getUTCMonth(), occurredAt.getUTCDate())),
      type: "CHECKIN" as const,
      delta: 1,
      source: "STAFF" as const,
    };
  });
  await prisma.attendanceRecord.createMany({ data: rows });
}

describe("performCheckIn", () => {
  afterAll(cleanup);

  it("checks in a valid ACTIVE student within an active class's window, at their home academy", async () => {
    const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
    const { code } = await makeStudent({ homeAcademyId: escazu.id });

    const result = await performCheckIn({
      academyId: escazu.id,
      context: ctx(escazu),
      code,
      source: "KIOSK",
      now: WITHIN_MONDAY_GI_WINDOW,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.student).toEqual({
        firstName: "PerformCheckInTest",
        lastName: "Student",
        currentBelt: "WHITE",
        currentBeltVisual: {
          primaryColor: "#F0EBE0",
          centerStripeColor: null,
          barColor: "#111116",
          stripeColors: ["#FFFFFF", "#FFFFFF", "#FFFFFF", "#FFFFFF"],
          maxStripes: 4,
          visibleStripeSlots: 4,
        },
        currentBeltLabelEs: "Blanco",
        currentBeltLabelEn: "White",
        currentStripes: 0,
      });
      expect(result.summary.currentBelt).toBe("WHITE");
      expect(result.summary.atBeltCount).toBe(1);
      expect(result.isVisitor).toBe(false);
      expect(result.homeAcademyName).toBe(escazu.name);
    }
  });

  it("rejects a second check-in for the same student/class/day as already_checked_in", async () => {
    const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
    const { code } = await makeStudent({ homeAcademyId: escazu.id });

    const first = await performCheckIn({
      academyId: escazu.id,
      context: ctx(escazu),
      code,
      source: "KIOSK",
      now: WITHIN_MONDAY_GI_WINDOW,
    });
    expect(first.ok).toBe(true);

    const second = await performCheckIn({
      academyId: escazu.id,
      context: ctx(escazu),
      code,
      source: "KIOSK",
      now: WITHIN_MONDAY_GI_WINDOW,
    });
    expect(second).toEqual({ ok: false, error: "already_checked_in" });
  });

  it("rejects an invalid/nonexistent code as invalid_code", async () => {
    const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });

    const result = await performCheckIn({
      academyId: escazu.id,
      context: ctx(escazu),
      code: "no-such-code-ever",
      source: "KIOSK",
      now: WITHIN_MONDAY_GI_WINDOW,
    });

    expect(result).toEqual({ ok: false, error: "invalid_code" });
  });

  it("rejects an empty-string code as invalid_code rather than throwing (presence, not truthiness)", async () => {
    // Regression test: a `code ? <resolve by code> : <resolve by studentId>`
    // truthiness check would misroute this falsy-but-present `code: ""` into
    // the studentId branch, where `input.studentId` is `undefined` —
    // `prisma.student.findUnique({ where: { id: undefined } })` throws a
    // PrismaClientValidationError instead of returning invalid_code. The
    // fix must use a presence check (`input.code !== undefined`) instead.
    const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });

    const result = await performCheckIn({
      academyId: escazu.id,
      context: ctx(escazu),
      code: "",
      source: "KIOSK",
      now: WITHIN_MONDAY_GI_WINDOW,
    });

    expect(result).toEqual({ ok: false, error: "invalid_code" });
  });

  it("rejects a PENDING student's code as invalid_code (not a more specific error)", async () => {
    const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
    const { code } = await makeStudent({ homeAcademyId: escazu.id, status: "PENDING" });

    const result = await performCheckIn({
      academyId: escazu.id,
      context: ctx(escazu),
      code,
      source: "KIOSK",
      now: WITHIN_MONDAY_GI_WINDOW,
    });

    expect(result).toEqual({ ok: false, error: "invalid_code" });
  });

  it("rejects an ARCHIVED student's code as invalid_code (not a more specific error)", async () => {
    const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
    const { code } = await makeStudent({ homeAcademyId: escazu.id, status: "ARCHIVED" });

    const result = await performCheckIn({
      academyId: escazu.id,
      context: ctx(escazu),
      code,
      source: "KIOSK",
      now: WITHIN_MONDAY_GI_WINDOW,
    });

    expect(result).toEqual({ ok: false, error: "invalid_code" });
  });

  // REDESIGN_BRIEF.md Phase 9: this used to reject. `OUTSIDE_ANY_WINDOW` is a
  // Sunday and Escazú has NO Sunday sessions at all, so there is nothing to
  // offer the student to pick — the tap is saved unattributed instead of being
  // dropped, and staff review it on the Kiosco page's "Marcajes de hoy" table.
  it("saves a tap on a day with no classes at all as an UNMATCHED record, rather than rejecting it", async () => {
    const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
    const { student, code } = await makeStudent({ homeAcademyId: escazu.id });

    const result = await performCheckIn({
      academyId: escazu.id,
      context: ctx(escazu),
      code,
      source: "KIOSK",
      now: OUTSIDE_ANY_WINDOW,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.matchedClass).toBeNull();
    }

    const record = await prisma.attendanceRecord.findFirstOrThrow({ where: { studentId: student.id } });
    expect(record.classSessionId).toBeNull();
    expect(record.matchSource).toBe("UNMATCHED");
    expect(record.date.toISOString().slice(0, 10)).toBe("2026-01-04");
  });

  it("treats a student checking in away from their home academy as a visitor, recorded under the visited academy", async () => {
    const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
    const escalante = await prisma.academy.findUniqueOrThrow({ where: { slug: "escalante" } });
    const { student, code } = await makeStudent({ homeAcademyId: escalante.id });

    const result = await performCheckIn({
      academyId: escazu.id,
      context: ctx(escazu),
      code,
      source: "KIOSK",
      now: WITHIN_MONDAY_GI_WINDOW,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.isVisitor).toBe(true);
      expect(result.homeAcademyName).toBe(escalante.name);
    }

    const record = await prisma.attendanceRecord.findFirstOrThrow({ where: { studentId: student.id } });
    expect(record.academyId).toBe(escazu.id);
    expect(record.academyId).not.toBe(escalante.id);
  });

  it("reports thresholdReached: true when a check-in crosses the belt's attendances-per-stripe threshold", async () => {
    const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
    const beltAwardedAt = new Date("2025-12-01T00:00:00Z");
    const { student, code } = await makeStudent({
      homeAcademyId: escazu.id,
      currentStripes: 0,
      beltAwardedAt,
    });

    // 29 attendances since beltAwardedAt (White belt requires 30 per stripe) —
    // no classSessionId, so these can't collide with the real session's
    // unique (studentId, classSessionId, date) constraint below regardless
    // of date overlap.
    await addSyntheticCheckins(student.id, escazu.id, escazu.organizationId, 29, new Date(beltAwardedAt.getTime() + DAY_MS));

    const result = await performCheckIn({
      academyId: escazu.id,
      context: ctx(escazu),
      code,
      source: "KIOSK",
      now: WITHIN_MONDAY_GI_WINDOW,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.summary.atBeltCount).toBe(30);
      expect(result.thresholdReached).toBe(true);
    }
  });

  describe("a class occurrence whose window crosses CR midnight", () => {
    it("buckets both sides of midnight onto the occurrence's own day, so the second check-in is refused", async () => {
      // Wednesday 23:50 start ⇒ window [Wed 23:20, Thu 00:20] CR.
      const { academy } = await makeFixtureAcademy([
        { dayOfWeek: "WEDNESDAY", startTime: "23:50", name: "Late Night" },
      ]);
      const { student, code } = await makeStudent({ homeAcademyId: academy.id });

      // Wed 2026-06-17 23:55 CR, then Thu 2026-06-18 00:10 CR — the SAME
      // class occurrence, on either side of local midnight.
      const beforeMidnight = new Date("2026-06-18T05:55:00Z");
      const afterMidnight = new Date("2026-06-18T06:10:00Z");

      const first = await performCheckIn({
        academyId: academy.id,
        context: ctx(academy),
        code,
        source: "KIOSK",
        now: beforeMidnight,
      });
      expect(first.ok).toBe(true);

      // Stamped from the occurrence's Wednesday, not from `now`'s CR day.
      const record = await prisma.attendanceRecord.findFirstOrThrow({ where: { studentId: student.id } });
      expect(record.date.toISOString().slice(0, 10)).toBe("2026-06-17");
      expect(record.occurredAt.toISOString()).toBe(beforeMidnight.toISOString());

      // Under the old `toAttendanceDate(now)` stamping this second call landed
      // on 2026-06-18 and slipped past the (studentId, classSessionId, date)
      // unique constraint — two ledger rows for one class.
      const second = await performCheckIn({
        academyId: academy.id,
        context: ctx(academy),
        code,
        source: "KIOSK",
        now: afterMidnight,
      });
      expect(second).toEqual({ ok: false, error: "already_checked_in" });
      expect(await prisma.attendanceRecord.count({ where: { studentId: student.id } })).toBe(1);
    });

    it("files a check-in made just before midnight for a just-after-midnight class under the class's day", async () => {
      // Thursday 00:05 start ⇒ window [Wed 23:35, Thu 00:35] CR.
      const { academy } = await makeFixtureAcademy([
        { dayOfWeek: "THURSDAY", startTime: "00:05", name: "Madrugada" },
      ]);
      const { student, code } = await makeStudent({ homeAcademyId: academy.id });

      // Wed 2026-06-17 23:40 CR — the wall clock says Wednesday, the class is
      // Thursday's.
      const result = await performCheckIn({
        academyId: academy.id,
        context: ctx(academy),
        code,
        source: "KIOSK",
        now: new Date("2026-06-18T05:40:00Z"),
      });
      expect(result.ok).toBe(true);

      const record = await prisma.attendanceRecord.findFirstOrThrow({ where: { studentId: student.id } });
      expect(record.date.toISOString().slice(0, 10)).toBe("2026-06-18");
    });
  });

  describe("studentId path (portal self check-in)", () => {
    it("checks in a valid ACTIVE student within an active class's window, at their home academy", async () => {
      const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
      const { student } = await makeStudent({ homeAcademyId: escazu.id });

      const result = await performCheckIn({
        academyId: escazu.id,
        context: ctx(escazu),
        studentId: student.id,
        source: "PORTAL",
        now: WITHIN_MONDAY_GI_WINDOW,
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.student).toEqual({
          firstName: "PerformCheckInTest",
          lastName: "Student",
          currentBelt: "WHITE",
          currentBeltVisual: {
            primaryColor: "#F0EBE0",
            centerStripeColor: null,
            barColor: "#111116",
            stripeColors: ["#FFFFFF", "#FFFFFF", "#FFFFFF", "#FFFFFF"],
            maxStripes: 4,
            visibleStripeSlots: 4,
          },
          currentBeltLabelEs: "Blanco",
          currentBeltLabelEn: "White",
          currentStripes: 0,
        });
        expect(result.summary.currentBelt).toBe("WHITE");
        expect(result.summary.atBeltCount).toBe(1);
        expect(result.isVisitor).toBe(false);
        expect(result.homeAcademyName).toBe(escazu.name);
      }
    });

    it("rejects a second check-in for the same student/class/day as already_checked_in", async () => {
      const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
      const { student } = await makeStudent({ homeAcademyId: escazu.id });

      const first = await performCheckIn({
        academyId: escazu.id,
        context: ctx(escazu),
        studentId: student.id,
        source: "PORTAL",
        now: WITHIN_MONDAY_GI_WINDOW,
      });
      expect(first.ok).toBe(true);

      const second = await performCheckIn({
        academyId: escazu.id,
        context: ctx(escazu),
        studentId: student.id,
        source: "PORTAL",
        now: WITHIN_MONDAY_GI_WINDOW,
      });
      expect(second).toEqual({ ok: false, error: "already_checked_in" });
    });

    it("rejects a PENDING student's studentId as invalid_code (not a more specific error)", async () => {
      const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
      const { student } = await makeStudent({ homeAcademyId: escazu.id, status: "PENDING" });

      const result = await performCheckIn({
        academyId: escazu.id,
        context: ctx(escazu),
        studentId: student.id,
        source: "PORTAL",
        now: WITHIN_MONDAY_GI_WINDOW,
      });

      expect(result).toEqual({ ok: false, error: "invalid_code" });
    });

    it("rejects an ARCHIVED student's studentId as invalid_code (not a more specific error)", async () => {
      const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
      const { student } = await makeStudent({ homeAcademyId: escazu.id, status: "ARCHIVED" });

      const result = await performCheckIn({
        academyId: escazu.id,
        context: ctx(escazu),
        studentId: student.id,
        source: "PORTAL",
        now: WITHIN_MONDAY_GI_WINDOW,
      });

      expect(result).toEqual({ ok: false, error: "invalid_code" });
    });

    it("saves a tap on a day with no classes at all as an UNMATCHED record, rather than rejecting it", async () => {
      const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
      const { student } = await makeStudent({ homeAcademyId: escazu.id });

      const result = await performCheckIn({
        academyId: escazu.id,
        context: ctx(escazu),
        studentId: student.id,
        source: "PORTAL",
        now: OUTSIDE_ANY_WINDOW,
      });

      expect(result.ok).toBe(true);

      const record = await prisma.attendanceRecord.findFirstOrThrow({ where: { studentId: student.id } });
      expect(record.classSessionId).toBeNull();
      expect(record.matchSource).toBe("UNMATCHED");
    });

    it("treats a student checking in away from their home academy as a visitor, recorded under the visited academy", async () => {
      const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
      const escalante = await prisma.academy.findUniqueOrThrow({ where: { slug: "escalante" } });
      const { student } = await makeStudent({ homeAcademyId: escalante.id });

      const result = await performCheckIn({
        academyId: escazu.id,
        context: ctx(escazu),
        studentId: student.id,
        source: "PORTAL",
        now: WITHIN_MONDAY_GI_WINDOW,
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.isVisitor).toBe(true);
        expect(result.homeAcademyName).toBe(escalante.name);
      }

      const record = await prisma.attendanceRecord.findFirstOrThrow({ where: { studentId: student.id } });
      expect(record.academyId).toBe(escazu.id);
      expect(record.academyId).not.toBe(escalante.id);
    });

    it("rejects a nonexistent studentId as invalid_code, without throwing", async () => {
      const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });

      const result = await performCheckIn({
        academyId: escazu.id,
        context: ctx(escazu),
        studentId: "00000000-0000-0000-0000-000000000000",
        source: "PORTAL",
        now: WITHIN_MONDAY_GI_WINDOW,
      });

      expect(result).toEqual({ ok: false, error: "invalid_code" });
    });
  });

  // REDESIGN_BRIEF.md Phase 9's own verification table, run against the REAL
  // seeded Escazú schedule rather than synthetic sessions (tests/unit/
  // check-in-window.test.ts already covers the selection RULES in isolation;
  // this is the "does it still do the right thing on our actual timetable"
  // guard the brief asks for). `selectActiveSessionOccurrence` is untouched by
  // Phase 9 — these must keep passing exactly as they did before it.
  describe("nearest-class matching against the seeded Escazú schedule", () => {
    const CASES: Array<{ label: string; now: string; expected: string | null }> = [
      { label: "Mon 17:52 -> 18:00 GI Principiantes", now: "2026-01-05T23:52:00Z", expected: "GI — Principiantes" },
      { label: "Mon 18:40 -> 19:00 GI Avanzados", now: "2026-01-06T00:40:00Z", expected: "GI — Avanzados" },
      { label: "Mon 18:30 exactly -> 18:00 (tie goes to the earlier start)", now: "2026-01-06T00:30:00Z", expected: "GI — Principiantes" },
      { label: "Wed 18:10 -> 18:30 Competición", now: "2026-01-08T00:10:00Z", expected: "Competición" },
      { label: "Fri 18:52 -> 18:30 GI Todos los niveles", now: "2026-01-10T00:52:00Z", expected: "GI — Todos los niveles" },
      { label: "Sat 09:50 -> 10:00 Kids", now: "2026-01-10T15:50:00Z", expected: "Kids" },
      { label: "Mon 13:30 -> no match (the student is asked to pick)", now: "2026-01-05T19:30:00Z", expected: null },
    ];

    it.each(CASES)("$label", async ({ now, expected }) => {
      const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
      const sessions = await prisma.classSession.findMany({ where: { academyId: escazu.id, active: true } });

      const match = selectActiveSessionOccurrence(sessions, new Date(now));
      expect(match?.session.name ?? null).toBe(expected);
    });
  });

  // REDESIGN_BRIEF.md Phase 9's no-match path. `selectActiveSessionOccurrence`
  // itself is untouched and still covered by tests/unit/check-in-window.test.ts
  // — everything here is about what happens when it returns null.
  describe("no auto match (Phase 9)", () => {
    // Monday 2026-01-05 13:30 CR. Escazú's Monday classes are 06:00 / 12:00 /
    // 18:00 / 19:00, so 13:30 sits in no window (12:00's closed at 12:30,
    // 18:00's opens at 17:30) — the brief's own "Mon 13:30 -> the student is
    // asked to pick" verification row, against the real seeded schedule.
    const MONDAY_BETWEEN_ESCAZU_WINDOWS = new Date("2026-01-05T19:30:00Z");

    it("offers that day's active classes, sorted by startTime, when the day HAS classes", async () => {
      const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
      const { student, code } = await makeStudent({ homeAcademyId: escazu.id });

      const result = await performCheckIn({
        academyId: escazu.id,
        context: ctx(escazu),
        code,
        source: "KIOSK",
        now: MONDAY_BETWEEN_ESCAZU_WINDOWS,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe("no_active_class");
        expect(result.picklist?.map((entry) => entry.startTime)).toEqual(["06:00", "12:00", "18:00", "19:00"]);
      }

      // Nothing was written — the student still has to answer the picker.
      expect(await prisma.attendanceRecord.count({ where: { studentId: student.id } })).toBe(0);
    });

    it("records the student's pick as STUDENT_PICKED, and refuses the same pick twice", async () => {
      const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
      const { student, code } = await makeStudent({ homeAcademyId: escazu.id });

      const offered = await performCheckIn({
        academyId: escazu.id,
        context: ctx(escazu),
        code,
        source: "KIOSK",
        now: MONDAY_BETWEEN_ESCAZU_WINDOWS,
      });
      const picked = offered.ok ? undefined : offered.picklist?.[1];
      expect(picked).toBeDefined();

      const result = await performCheckIn({
        academyId: escazu.id,
        context: ctx(escazu),
        code,
        source: "KIOSK",
        now: MONDAY_BETWEEN_ESCAZU_WINDOWS,
        pickedClassSessionId: picked!.id,
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.matchedClass?.id).toBe(picked!.id);
      }

      const record = await prisma.attendanceRecord.findFirstOrThrow({ where: { studentId: student.id } });
      expect(record.classSessionId).toBe(picked!.id);
      expect(record.matchSource).toBe("STUDENT_PICKED");
      expect(record.date.toISOString().slice(0, 10)).toBe("2026-01-05");

      const again = await performCheckIn({
        academyId: escazu.id,
        context: ctx(escazu),
        code,
        source: "KIOSK",
        now: MONDAY_BETWEEN_ESCAZU_WINDOWS,
        pickedClassSessionId: picked!.id,
      });
      expect(again).toEqual({ ok: false, error: "already_checked_in" });
      expect(await prisma.attendanceRecord.count({ where: { studentId: student.id } })).toBe(1);
    });

    it("ignores a pick that isn't one of that academy's classes for that day, falling back to the picker", async () => {
      const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
      const { academy: other, sessions } = await makeFixtureAcademy([
        { dayOfWeek: "MONDAY", startTime: "13:00", name: "Somebody Else's Class" },
      ]);
      void other;
      const { student, code } = await makeStudent({ homeAcademyId: escazu.id });

      const result = await performCheckIn({
        academyId: escazu.id,
        context: ctx(escazu),
        code,
        source: "KIOSK",
        now: MONDAY_BETWEEN_ESCAZU_WINDOWS,
        pickedClassSessionId: sessions[0].id,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe("no_active_class");
      expect(await prisma.attendanceRecord.count({ where: { studentId: student.id } })).toBe(0);
    });

    it("auto-saves an UNMATCHED record when the day has no active classes at all", async () => {
      // Tuesday-only fixture, tapped on a Monday.
      const { academy } = await makeFixtureAcademy([
        { dayOfWeek: "TUESDAY", startTime: "18:00", name: "Martes" },
      ]);
      const { student, code } = await makeStudent({ homeAcademyId: academy.id });

      const result = await performCheckIn({
        academyId: academy.id,
        context: ctx(academy),
        code,
        source: "KIOSK",
        now: MONDAY_BETWEEN_ESCAZU_WINDOWS,
      });

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.matchedClass).toBeNull();

      const record = await prisma.attendanceRecord.findFirstOrThrow({ where: { studentId: student.id } });
      expect(record.classSessionId).toBeNull();
      expect(record.matchSource).toBe("UNMATCHED");

      // A second tap the same day must not double-count: the unique constraint
      // can't see it (Postgres treats NULLs as distinct), so performCheckIn
      // checks for it itself.
      const again = await performCheckIn({
        academyId: academy.id,
        context: ctx(academy),
        code,
        source: "KIOSK",
        now: MONDAY_BETWEEN_ESCAZU_WINDOWS,
      });
      expect(again).toEqual({ ok: false, error: "already_checked_in" });
    });

    it("saves an UNATTENDED (offline-replay) tap as UNMATCHED instead of returning a picklist nobody can answer", async () => {
      const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
      const { student, code } = await makeStudent({ homeAcademyId: escazu.id });

      const result = await performCheckIn({
        academyId: escazu.id,
        context: ctx(escazu),
        code,
        source: "KIOSK",
        now: MONDAY_BETWEEN_ESCAZU_WINDOWS,
        unattended: true,
      });

      expect(result.ok).toBe(true);
      const record = await prisma.attendanceRecord.findFirstOrThrow({ where: { studentId: student.id } });
      expect(record.classSessionId).toBeNull();
      expect(record.matchSource).toBe("UNMATCHED");
    });

    it("still stamps AUTO, and names the matched class, when a window does match", async () => {
      const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
      const { student, code } = await makeStudent({ homeAcademyId: escazu.id });

      const result = await performCheckIn({
        academyId: escazu.id,
        context: ctx(escazu),
        code,
        source: "KIOSK",
        now: WITHIN_MONDAY_GI_WINDOW,
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.matchedClass).toMatchObject({ dayOfWeek: "MONDAY", startTime: "06:00" });
        expect(result.attendanceRecordId).toEqual(expect.any(String));
      }

      const record = await prisma.attendanceRecord.findFirstOrThrow({ where: { studentId: student.id } });
      expect(record.matchSource).toBe("AUTO");
    });
  });

  describe("countsTowardPromotion", () => {
    it("records a non-counting class in the ledger but leaves belt progress untouched", async () => {
      const { academy, sessions } = await makeFixtureAcademy([
        { dayOfWeek: "MONDAY", startTime: "06:00", name: "Striking", countsTowardPromotion: false },
        { dayOfWeek: "MONDAY", startTime: "12:00", name: "GI", countsTowardPromotion: true },
      ]);
      const [striking, gi] = sessions;
      const { student, code } = await makeStudent({ homeAcademyId: academy.id });

      // Monday 2026-01-05 06:00 CR — the Striking window.
      const strikingResult = await performCheckIn({
        academyId: academy.id,
        context: ctx(academy),
        code,
        source: "KIOSK",
        now: WITHIN_MONDAY_GI_WINDOW,
      });
      expect(strikingResult.ok).toBe(true);
      if (strikingResult.ok) {
        // The physical check-in happened and is in the ledger...
        expect(strikingResult.summary.atBeltCount).toBe(0);
      }
      const strikingRecord = await prisma.attendanceRecord.findFirstOrThrow({
        where: { studentId: student.id, classSessionId: striking.id },
      });
      expect(strikingRecord.delta).toBe(1);

      // ...but only the counting class moves atBeltCount.
      // Monday 2026-01-05 12:00 CR = 18:00Z.
      const giResult = await performCheckIn({
        academyId: academy.id,
        context: ctx(academy),
        code,
        source: "KIOSK",
        now: new Date("2026-01-05T18:00:00Z"),
      });
      expect(giResult.ok).toBe(true);
      if (giResult.ok) {
        expect(giResult.summary.atBeltCount).toBe(1);
      }
      expect(
        await prisma.attendanceRecord.count({ where: { studentId: student.id, classSessionId: gi.id } }),
      ).toBe(1);
    });

    it("keeps an UNMATCHED tap out of belt progress until a human resolves it, but in the lifetime total", async () => {
      // Tuesday-only fixture, tapped on a Monday -> UNMATCHED. An unreviewed
      // tap with no evidence of attending any specific class must not advance
      // a belt on its own: a PORTAL self-check-in needs no physical presence
      // at all, so counting it would be a free stripe. It is still a real tap,
      // so it stays in the unfiltered lifetime total.
      const { academy } = await makeFixtureAcademy([
        { dayOfWeek: "TUESDAY", startTime: "18:00", name: "Martes" },
      ]);
      const { student, code } = await makeStudent({ homeAcademyId: academy.id });

      const result = await performCheckIn({
        academyId: academy.id,
        context: ctx(academy),
        code,
        source: "KIOSK",
        // Monday 2026-01-05 13:30 CR.
        now: new Date("2026-01-05T19:30:00Z"),
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.summary.atBeltCount).toBe(0);
        expect(result.summary.lifetimeCount).toBe(1);
        expect(result.thresholdReached).toBe(false);
      }

      // ...and once the schedule is fixed and the row is reassigned to a real
      // counting class, it counts — review-then-count needs no extra logic,
      // the row simply stops being classSessionId-null.
      const monday = await prisma.classSession.create({
        data: {
          academyId: academy.id,
          organizationId: academy.organizationId,
          dayOfWeek: "MONDAY",
          startTime: "13:00",
          durationMinutes: 60,
          name: "Lunes (agregada después)",
          type: "GI",
          countsTowardPromotion: true,
        },
      });
      const record = await prisma.attendanceRecord.findFirstOrThrow({ where: { studentId: student.id } });
      expect(
        (
          await reassignAttendance(record.id, monday.id, {
            actorUserId: null,
            matchSource: "STUDENT_PICKED",
            expectedAcademyId: academy.id,
            context: ctx(academy),
          })
        ).ok,
      ).toBe(true);

      const summary = await getAtBeltSummary(student.id, student.organizationId, ALLIANCE_ATTENDANCE_CONFIG);
      expect(summary.atBeltCount).toBe(1);
      expect(summary.lifetimeCount).toBe(1);
    });

    it("still counts a manual staff adjustment, which has no classSession to inherit a flag from", async () => {
      const { academy } = await makeFixtureAcademy([
        { dayOfWeek: "MONDAY", startTime: "06:00", name: "Striking", countsTowardPromotion: false },
      ]);
      const { student, code } = await makeStudent({ homeAcademyId: academy.id });

      const adjustedAt = new Date("2026-01-02T18:00:00Z");
      await prisma.attendanceRecord.create({
        data: {
          studentId: student.id,
          academyId: academy.id,
          organizationId: academy.organizationId,
          occurredAt: adjustedAt,
          date: new Date(Date.UTC(2026, 0, 2)),
          type: "ADJUSTMENT",
          delta: 7,
          reason: "backfill",
          source: "STAFF",
        },
      });

      const result = await performCheckIn({
        academyId: academy.id,
        context: ctx(academy),
        code,
        source: "KIOSK",
        now: WITHIN_MONDAY_GI_WINDOW,
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        // 7 from the adjustment; the Striking check-in itself adds nothing.
        expect(result.summary.atBeltCount).toBe(7);
      }
    });
  });
});
