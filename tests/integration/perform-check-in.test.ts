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
// no DST) — a Monday, which falls inside the seeded Escazú "GI" session's
// check-in window (06:00 start, 60-minute duration, ±30-minute window ⇒
// [05:30, 07:30] CR).
const WITHIN_MONDAY_GI_WINDOW = new Date("2026-01-05T12:00:00Z");

// 2026-01-04T18:00:00Z is 2026-01-04 12:00 CR — a Sunday, and the seeded
// schedule has no Sunday sessions at all (nor any session whose ±30-minute
// window crosses into Sunday from Saturday or out to Monday), so this falls
// outside every active session's check-in window.
const OUTSIDE_ANY_WINDOW = new Date("2026-01-04T18:00:00Z");

const cleanupStudentIds: string[] = [];

async function cleanup() {
  if (cleanupStudentIds.length > 0) {
    await prisma.attendanceRecord.deleteMany({ where: { studentId: { in: cleanupStudentIds } } });
    await prisma.student.deleteMany({ where: { id: { in: cleanupStudentIds } } });
  }
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
    const { student, code } = await makeStudent({ homeAcademyId: escazu.id });

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
    }
  });

  it("rejects a second check-in for the same student/class/day as already_checked_in", async () => {
    const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
    const { student, code } = await makeStudent({ homeAcademyId: escazu.id });

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
});
