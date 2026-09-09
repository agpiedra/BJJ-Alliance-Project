import "dotenv/config";
import { afterAll, describe, expect, it } from "vitest";
import { PrismaClient } from "../../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { requireEnv } from "../../src/lib/env";
import { digestLookupSecret } from "../../src/lib/crypto";

const { performCheckIn } = await import("../../src/lib/kiosk/perform-check-in");

const adapter = new PrismaPg({ connectionString: requireEnv("DATABASE_URL") });
const prisma = new PrismaClient({ adapter });
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
    },
  });
  cleanupAcademyIds.push(academy.id);

  const created = [];
  for (const session of sessions) {
    created.push(
      await prisma.classSession.create({
        data: {
          academyId: academy.id,
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
  const student = await prisma.student.create({
    data: {
      homeAcademyId: overrides.homeAcademyId,
      firstName: "PerformCheckInTest",
      lastName: "Student",
      phone: "88881111",
      email: `perform-check-in-${suffix}@example.com`,
      currentBelt: "WHITE",
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
async function addSyntheticCheckins(studentId: string, academyId: string, count: number, startAt: Date) {
  const rows = Array.from({ length: count }, (_, i) => {
    const occurredAt = new Date(startAt.getTime() + i * DAY_MS);
    return {
      studentId,
      academyId,
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
      code,
      source: "KIOSK",
      now: WITHIN_MONDAY_GI_WINDOW,
    });
    expect(first.ok).toBe(true);

    const second = await performCheckIn({
      academyId: escazu.id,
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
      code: "no-such-code-ever",
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
      code,
      source: "KIOSK",
      now: WITHIN_MONDAY_GI_WINDOW,
    });

    expect(result).toEqual({ ok: false, error: "invalid_code" });
  });

  it("rejects a check-in attempt when `now` falls outside every session's window as no_active_class", async () => {
    const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
    const { code } = await makeStudent({ homeAcademyId: escazu.id });

    const result = await performCheckIn({
      academyId: escazu.id,
      code,
      source: "KIOSK",
      now: OUTSIDE_ANY_WINDOW,
    });

    expect(result).toEqual({ ok: false, error: "no_active_class" });
  });

  it("treats a student checking in away from their home academy as a visitor, recorded under the visited academy", async () => {
    const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
    const escalante = await prisma.academy.findUniqueOrThrow({ where: { slug: "escalante" } });
    const { student, code } = await makeStudent({ homeAcademyId: escalante.id });

    const result = await performCheckIn({
      academyId: escazu.id,
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

  it("reports earnedStripe: true when a check-in crosses the belt's attendances-per-stripe threshold", async () => {
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
    await addSyntheticCheckins(student.id, escazu.id, 29, new Date(beltAwardedAt.getTime() + DAY_MS));

    const result = await performCheckIn({
      academyId: escazu.id,
      code,
      source: "KIOSK",
      now: WITHIN_MONDAY_GI_WINDOW,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.summary.atBeltCount).toBe(30);
      expect(result.earnedStripe).toBe(true);
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
        studentId: student.id,
        source: "PORTAL",
        now: WITHIN_MONDAY_GI_WINDOW,
      });
      expect(first.ok).toBe(true);

      const second = await performCheckIn({
        academyId: escazu.id,
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
        studentId: student.id,
        source: "PORTAL",
        now: WITHIN_MONDAY_GI_WINDOW,
      });

      expect(result).toEqual({ ok: false, error: "invalid_code" });
    });

    it("rejects a check-in attempt when `now` falls outside every session's window as no_active_class", async () => {
      const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
      const { student } = await makeStudent({ homeAcademyId: escazu.id });

      const result = await performCheckIn({
        academyId: escazu.id,
        studentId: student.id,
        source: "PORTAL",
        now: OUTSIDE_ANY_WINDOW,
      });

      expect(result).toEqual({ ok: false, error: "no_active_class" });
    });

    it("treats a student checking in away from their home academy as a visitor, recorded under the visited academy", async () => {
      const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
      const escalante = await prisma.academy.findUniqueOrThrow({ where: { slug: "escalante" } });
      const { student } = await makeStudent({ homeAcademyId: escalante.id });

      const result = await performCheckIn({
        academyId: escazu.id,
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
        studentId: "00000000-0000-0000-0000-000000000000",
        source: "PORTAL",
        now: WITHIN_MONDAY_GI_WINDOW,
      });

      expect(result).toEqual({ ok: false, error: "invalid_code" });
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
