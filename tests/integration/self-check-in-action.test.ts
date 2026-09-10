import "dotenv/config";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "../../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { requireEnv } from "../../src/lib/env";
import { hashSecret } from "../../src/lib/crypto";
import { generateStudentCode } from "../../src/lib/students/generate-code";

// Same `auth()` / `next-intl/server` mocks as student-session.test.ts — see
// the long note there. `requireStudentSession()` (called inside
// `selfCheckIn`) re-reads `role`/`active` from the DB on every call, so every
// session below must name a real, existing `User` row.
let currentSession: { user: { id: string; role: string } } | null = null;

vi.mock("@/auth", () => ({
  auth: () => Promise.resolve(currentSession),
}));

vi.mock("next-intl/server", () => ({
  getLocale: () => Promise.resolve("en"),
}));

// I-1 regression coverage: notifyEligibilityReached must still fire when a
// check-in that crosses the stripe threshold comes in through this REAL
// portal action entry point (not just via a direct performCheckIn call).
// Mocked so this file doesn't depend on/pollute real staff Notification rows
// or make a real Resend call.
const notifyEligibilityState = vi.hoisted(() => ({ spy: vi.fn(async (..._args: unknown[]) => {}) }));
vi.mock("@/lib/notifications/notify-eligibility", () => ({
  notifyEligibilityReached: (...args: unknown[]) => notifyEligibilityState.spy(...args),
}));

const { selfCheckIn } = await import("../../src/app/[locale]/portal/self-check-in-action");

const adapter = new PrismaPg({ connectionString: requireEnv("DATABASE_URL") });
const prisma = new PrismaClient({ adapter });

// Same fixed instants as perform-check-in.test.ts: 2026-01-05T12:00:00Z is
// 2026-01-05 06:00 America/Costa_Rica (UTC-6, fixed, no DST) — a Monday,
// exactly the seeded Escazú "GI" session's start, squarely inside its
// ±30-minute window. 2026-01-04T18:00:00Z is a Sunday, outside every seeded
// session's window.
const WITHIN_MONDAY_GI_WINDOW = new Date("2026-01-05T12:00:00Z");
const OUTSIDE_ANY_WINDOW = new Date("2026-01-04T18:00:00Z");

const cleanupUserIds: string[] = [];

async function cleanup() {
  if (cleanupUserIds.length > 0) {
    await prisma.attendanceRecord.deleteMany({
      where: { student: { userId: { in: cleanupUserIds } } },
    });
    await prisma.student.deleteMany({ where: { userId: { in: cleanupUserIds } } });
    await prisma.user.deleteMany({ where: { id: { in: cleanupUserIds } } });
  }
}

async function makeActiveStudentUser(status: "ACTIVE" | "PENDING" | "ARCHIVED" | "INACTIVE" = "ACTIVE") {
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
  const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
  const user = await prisma.user.create({
    data: {
      email: `self-check-in-${suffix}@example.com`,
      passwordHash: await hashSecret("irrelevant-password-123"),
      role: "STUDENT",
      active: true,
    },
  });
  cleanupUserIds.push(user.id);

  const { codeHash } = await generateStudentCode();
  const student = await prisma.student.create({
    data: {
      userId: user.id,
      homeAcademyId: escazu.id,
      firstName: "SelfCheckInTest",
      lastName: "Student",
      phone: "88889999",
      email: `self-check-in-student-${suffix}@example.com`,
      codeHash,
      status,
    },
  });

  return { user, studentId: student.id };
}

// selfCheckIn always resolves `now` from the real clock (it never accepts a
// `now` override — that's an internal-only seam of performCheckIn, not part
// of this action's contract), so these tests fake only the `Date`
// constructor/`Date.now`, leaving real timers (and therefore the DB
// connection's own async machinery) untouched.
function setSystemTime(instant: Date) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(instant);
}

describe("selfCheckIn", () => {
  afterAll(cleanup);

  afterEach(() => {
    vi.useRealTimers();
    currentSession = null;
    notifyEligibilityState.spy.mockClear();
  });

  it("checks in the session's own student during a real window, recording source PORTAL", async () => {
    const { user, studentId } = await makeActiveStudentUser();
    currentSession = { user: { id: user.id, role: "STUDENT" } };
    setSystemTime(WITHIN_MONDAY_GI_WINDOW);

    const state = await selfCheckIn({}, new FormData());

    expect(state.ok).toBe(true);
    expect(state.error).toBeUndefined();

    const record = await prisma.attendanceRecord.findFirstOrThrow({ where: { studentId } });
    expect(record.source).toBe("PORTAL");
  });

  it("rejects the same student self-checking in again immediately as already_checked_in", async () => {
    const { user, studentId } = await makeActiveStudentUser();
    currentSession = { user: { id: user.id, role: "STUDENT" } };
    setSystemTime(WITHIN_MONDAY_GI_WINDOW);

    const first = await selfCheckIn({}, new FormData());
    expect(first.ok).toBe(true);

    const second = await selfCheckIn({}, new FormData());
    expect(second).toEqual({ error: "already_checked_in" });

    expect(await prisma.attendanceRecord.count({ where: { studentId } })).toBe(1);
  });

  it("rejects self check-in outside every session's window as no_active_class", async () => {
    const { user, studentId } = await makeActiveStudentUser();
    currentSession = { user: { id: user.id, role: "STUDENT" } };
    setSystemTime(OUTSIDE_ANY_WINDOW);

    const state = await selfCheckIn({}, new FormData());

    expect(state).toEqual({ error: "no_active_class" });
    expect(await prisma.attendanceRecord.count({ where: { studentId } })).toBe(0);
  });

  it("rejects a PENDING student's self check-in with the distinct notActive error, via the upfront status check", async () => {
    const { user, studentId } = await makeActiveStudentUser("PENDING");
    currentSession = { user: { id: user.id, role: "STUDENT" } };
    setSystemTime(WITHIN_MONDAY_GI_WINDOW);

    const state = await selfCheckIn({}, new FormData());

    // Exactly `notActive`, not performCheckIn's generic `invalid_code` — the
    // status check in self-check-in-action.ts must short-circuit BEFORE
    // performCheckIn (and therefore before any AttendanceRecord) is ever
    // attempted.
    expect(state).toEqual({ error: "notActive" });
    expect(await prisma.attendanceRecord.count({ where: { studentId } })).toBe(0);
  });

  it("rejects an ARCHIVED student's self check-in with the distinct notActive error, via the upfront status check", async () => {
    const { user, studentId } = await makeActiveStudentUser("ARCHIVED");
    currentSession = { user: { id: user.id, role: "STUDENT" } };
    setSystemTime(WITHIN_MONDAY_GI_WINDOW);

    const state = await selfCheckIn({}, new FormData());

    expect(state).toEqual({ error: "notActive" });
    expect(await prisma.attendanceRecord.count({ where: { studentId } })).toBe(0);
  });

  it("rejects an INACTIVE student's self check-in with the distinct notActive error, via the upfront status check", async () => {
    const { user, studentId } = await makeActiveStudentUser("INACTIVE");
    currentSession = { user: { id: user.id, role: "STUDENT" } };
    setSystemTime(WITHIN_MONDAY_GI_WINDOW);

    const state = await selfCheckIn({}, new FormData());

    expect(state).toEqual({ error: "notActive" });
    expect(await prisma.attendanceRecord.count({ where: { studentId } })).toBe(0);
  });

  it("I-1: fires notifyEligibilityReached through the REAL self-check-in action entry point when a check-in crosses the stripe threshold", async () => {
    const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
    const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
    const user = await prisma.user.create({
      data: {
        email: `self-check-in-elig-${suffix}@example.com`,
        passwordHash: await hashSecret("irrelevant-password-123"),
        role: "STUDENT",
        active: true,
      },
    });
    cleanupUserIds.push(user.id);

    const { codeHash } = await generateStudentCode();
    const beltAwardedAt = new Date("2025-12-01T00:00:00Z");
    const student = await prisma.student.create({
      data: {
        userId: user.id,
        homeAcademyId: escazu.id,
        firstName: "SelfCheckInEligTest",
        lastName: "Student",
        phone: "88887000",
        email: `self-check-in-elig-student-${suffix}@example.com`,
        codeHash,
        status: "ACTIVE",
        currentBelt: "WHITE",
        currentStripes: 0,
        beltAwardedAt,
      },
    });

    // WHITE belt requires 30 attendances/stripe — 29 synthetic (no
    // classSessionId, so no collision with the real session's unique
    // constraint) + this action's real check-in below crosses the threshold.
    const DAY_MS = 24 * 60 * 60 * 1000;
    await prisma.attendanceRecord.createMany({
      data: Array.from({ length: 29 }, (_, i) => {
        const occurredAt = new Date(beltAwardedAt.getTime() + DAY_MS + i * DAY_MS);
        return {
          studentId: student.id,
          academyId: escazu.id,
          occurredAt,
          date: new Date(Date.UTC(occurredAt.getUTCFullYear(), occurredAt.getUTCMonth(), occurredAt.getUTCDate())),
          type: "CHECKIN" as const,
          delta: 1,
          source: "STAFF" as const,
        };
      }),
    });

    currentSession = { user: { id: user.id, role: "STUDENT" } };
    setSystemTime(WITHIN_MONDAY_GI_WINDOW);

    const state = await selfCheckIn({}, new FormData());

    expect(state.ok).toBe(true);
    expect(state.earnedStripe).toBe(true);
    expect(notifyEligibilityState.spy).toHaveBeenCalledWith(student.id, "STRIPE_THRESHOLD");
  });
});
