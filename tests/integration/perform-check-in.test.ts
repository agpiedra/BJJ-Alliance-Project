import "dotenv/config";
import { getTestPrismaClient } from "../helpers/test-db";
import { afterAll, describe, expect, it } from "vitest";
import { requireEnv } from "../../src/lib/env";
import { digestLookupSecret } from "../../src/lib/crypto";
import { adultRankId } from "../helpers/belt-ranks";
import { ALLIANCE_ATTENDANCE_CONFIG } from "../helpers/promotion-config";

const { performCheckIn } = await import("../../src/lib/kiosk/perform-check-in");
const { openOccurrences } = await import("../../src/lib/scheduling/check-in-window");
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
// squarely inside its window (start - 30 .. start + 60-minute duration + 30 =
// [05:30, 07:30] CR) and inside no other Escazú session's.
const WITHIN_MONDAY_GI_WINDOW = new Date("2026-01-05T12:00:00Z");

// 2026-01-04T18:00:00Z is 2026-01-04 12:00 CR — a Sunday, and the seeded
// schedule has no Sunday sessions at all (nor any session whose window - up to
// 30 minutes after its end - crosses into Sunday from Saturday or out to
// Monday), so this falls outside every active session's check-in window.
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

  // Owner-approved rule: a NEW online attempt with no open class is refused and writes NOTHING. `OUTSIDE_ANY_WINDOW` is a
  // Sunday and Escazu has no Sunday sessions at all; check-in is unavailable and a coach can record the attendance.
  it("refuses a tap when no class is open (a Sunday) with no_open_class, and writes nothing", async () => {
    const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
    const { student, code } = await makeStudent({ homeAcademyId: escazu.id });

    const result = await performCheckIn({
      academyId: escazu.id,
      context: ctx(escazu),
      code,
      source: "KIOSK",
      now: OUTSIDE_ANY_WINDOW,
    });

    expect(result).toEqual({ ok: false, error: "no_open_class" });
    expect(await prisma.attendanceRecord.count({ where: { studentId: student.id } })).toBe(0);
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
      // Wednesday 23:50 start, 60 minutes ⇒ window [Wed 23:20, Thu 01:20] CR.
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
      // Thursday 00:05 start, 60 minutes ⇒ window [Wed 23:35, Thu 01:35] CR.
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

    it("keeps a check-in after midnight on the previous day's class until its own close (end + 30 minutes, inclusive), and no longer", async () => {
      // Wednesday 23:50 for 60 minutes ends Thursday 00:50 and closes Thursday 01:20 CR (= 07:20Z).
      const { academy } = await makeFixtureAcademy([
        { dayOfWeek: "WEDNESDAY", startTime: "23:50", name: "Late Night" },
      ]);
      const inside = await makeStudent({ homeAcademyId: academy.id });
      const open = await performCheckIn({
        academyId: academy.id,
        context: ctx(academy),
        code: inside.code,
        source: "KIOSK",
        now: new Date("2026-06-18T07:20:00.000Z"),
      });
      expect(open.ok).toBe(true);
      const record = await prisma.attendanceRecord.findFirstOrThrow({ where: { studentId: inside.student.id } });
      expect(record.date.toISOString().slice(0, 10)).toBe("2026-06-17"); // Wednesday's class, at Thursday 01:20
      expect(record.matchSource).toBe("AUTO");

      // One millisecond later no window contains the instant: a NEW attempt is refused and writes nothing...
      const late = await makeStudent({ homeAcademyId: academy.id });
      const closed = await performCheckIn({
        academyId: academy.id,
        context: ctx(academy),
        code: late.code,
        source: "KIOSK",
        now: new Date("2026-06-18T07:20:00.001Z"),
      });
      expect(closed).toEqual({ ok: false, error: "no_open_class" });
      expect(await prisma.attendanceRecord.count({ where: { studentId: late.student.id } })).toBe(0);
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

    it("refuses a tap when no class is open (a Sunday) with no_open_class, and writes nothing", async () => {
      const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
      const { student } = await makeStudent({ homeAcademyId: escazu.id });

      const result = await performCheckIn({
        academyId: escazu.id,
        context: ctx(escazu),
        studentId: student.id,
        source: "PORTAL",
        now: OUTSIDE_ANY_WINDOW,
      });

      expect(result).toEqual({ ok: false, error: "no_open_class" });
      expect(await prisma.attendanceRecord.count({ where: { studentId: student.id } })).toBe(0);
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

  // Which classes are OPEN at an instant, against the REAL seeded Escazu schedule rather than synthetic sessions (every
  // seeded class is 60 minutes; the owner-confirmed window is start - 30 .. scheduled end + 30, inclusive). Overlaps are
  // expected: when several are open the kiosk asks which class the student attended before anything is written.
  describe("open classes against the seeded Escazu schedule", () => {
    const CASES: Array<{ label: string; now: string; expected: string[] }> = [
      { label: "Mon 17:52 -> only 18:00 GI Principiantes (19:00 opens 18:30)", now: "2026-01-05T23:52:00Z", expected: ["GI — Principiantes"] },
      { label: "Mon 18:30 exactly -> both evening classes (the later one has just opened)", now: "2026-01-06T00:30:00Z", expected: ["GI — Principiantes", "GI — Avanzados"] },
      { label: "Mon 18:40 -> both evening classes", now: "2026-01-06T00:40:00Z", expected: ["GI — Principiantes", "GI — Avanzados"] },
      { label: "Mon 19:20 -> both evening classes (18:00 is open until 19:30)", now: "2026-01-06T01:20:00Z", expected: ["GI — Principiantes", "GI — Avanzados"] },
      { label: "Mon 19:30:00.001 -> only 19:00 GI Avanzados", now: "2026-01-06T01:30:00.001Z", expected: ["GI — Avanzados"] },
      { label: "Mon 20:30 exactly -> 19:00 GI Avanzados (its end + 30 minutes, inclusive)", now: "2026-01-06T02:30:00Z", expected: ["GI — Avanzados"] },
      { label: "Mon 20:30:00.001 -> nothing open", now: "2026-01-06T02:30:00.001Z", expected: [] },
      { label: "Mon 14:00 -> nothing open (between the 12:00 and 18:00 windows)", now: "2026-01-05T20:00:00Z", expected: [] },
      { label: "Mon 13:30 exactly -> 12:00 NO-GI (its end + 30 minutes, inclusive)", now: "2026-01-05T19:30:00Z", expected: ["NO-GI"] },
      { label: "Mon 13:30:00.001 -> nothing open", now: "2026-01-05T19:30:00.001Z", expected: [] },
      { label: "Wed 18:10 -> 18:30 Competicion", now: "2026-01-08T00:10:00Z", expected: ["Competición"] },
      { label: "Fri 18:52 -> 18:30 GI Todos los niveles", now: "2026-01-10T00:52:00Z", expected: ["GI — Todos los niveles"] },
      { label: "Sat 09:50 -> Striking (09:00) and Kids (10:00) are both open", now: "2026-01-10T15:50:00Z", expected: ["Striking", "Kids"] },
    ];

    it.each(CASES)("$label", async ({ now, expected }) => {
      const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
      const sessions = await prisma.classSession.findMany({ where: { academyId: escazu.id, active: true } });

      expect(openOccurrences(sessions, new Date(now)).map((o) => o.session.name)).toEqual(expected);
    });
  });

  // A live check-in with no selection. (The full matrix - zero / one / several open classes, selection, cancellation,
  // duplicates, corrections and offline replay - is in tests/integration/kiosk-window-rules.test.ts.)
  describe("a live check-in with no selection", () => {
    it("names the class and stamps AUTO when exactly one class is open", async () => {
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
        expect(result.canCorrect).toBe(false); // nothing else was open to correct it to
      }

      const record = await prisma.attendanceRecord.findFirstOrThrow({ where: { studentId: student.id } });
      expect(record.matchSource).toBe("AUTO");
    });

    it("refuses with no_open_class between windows (Mon 14:00) and writes nothing", async () => {
      const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
      const { student, code } = await makeStudent({ homeAcademyId: escazu.id });

      const result = await performCheckIn({
        academyId: escazu.id,
        context: ctx(escazu),
        code,
        source: "KIOSK",
        now: new Date("2026-01-05T20:00:00Z"),
      });

      expect(result).toEqual({ ok: false, error: "no_open_class" });
      expect(await prisma.attendanceRecord.count({ where: { studentId: student.id } })).toBe(0);
    });

    it("asks WHICH class when several are open (Mon 18:40): the open classes with name, time range and type, in start order, nothing written", async () => {
      const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
      const { student, code } = await makeStudent({ homeAcademyId: escazu.id });

      const result = await performCheckIn({
        academyId: escazu.id,
        context: ctx(escazu),
        code,
        source: "KIOSK",
        now: new Date("2026-01-06T00:40:00Z"),
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe("class_selection_required");
        expect(result.openClasses).toEqual([
          expect.objectContaining({ name: "GI — Principiantes", startTime: "18:00", endTime: "19:00", type: "GI" }),
          expect.objectContaining({ name: "GI — Avanzados", startTime: "19:00", endTime: "20:00", type: "GI" }),
        ]);
      }
      expect(await prisma.attendanceRecord.count({ where: { studentId: student.id } })).toBe(0);
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
      // Tuesday-only fixture, a queued tap from a Monday -> retained UNMATCHED (a NEW online attempt would be refused).
      // An unreviewed tap with no evidence of attending any specific class must not advance
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
        // Monday 2026-01-05 13:30 CR, replayed from the offline queue with a verified original instant.
        now: new Date("2026-01-05T19:30:00Z"),
        replay: { timestampVerified: true },
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
            matchSource: "STAFF_CORRECTED",
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
