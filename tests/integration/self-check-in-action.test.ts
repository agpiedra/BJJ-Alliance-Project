import "dotenv/config";
import { getTestPrismaClient } from "../helpers/test-db";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { hashSecret } from "../../src/lib/crypto";
import { generateStudentCode } from "../../src/lib/students/generate-code";
import { adultRankId } from "../helpers/belt-ranks";

// Same `auth()` / `next-intl/server` mocks as student-session.test.ts — see
// the long note there. `requireTenantContext(["STUDENT"])` (called inside
// `selfCheckIn`) re-reads role from a real `OrganizationMembership` row on
// every call, and needs `activeOrganizationId` to know which one — so every
// session below must name a real, existing `User` row AND a matching
// membership.
let currentSession: { user: { id: string; role: string } | null; activeOrganizationId?: string } | null = null;

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

const prisma = getTestPrismaClient();

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
    await prisma.organizationMembership.deleteMany({ where: { userId: { in: cleanupUserIds } } });
    await prisma.notification.deleteMany({ where: { userId: { in: cleanupUserIds } } });
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

  await prisma.organizationMembership.create({
    data: { userId: user.id, organizationId: escazu.organizationId, role: "STUDENT" },
  });

  const { codeHash } = await generateStudentCode(escazu.organizationId);
  const student = await prisma.student.create({
    data: {
      userId: user.id,
      homeAcademyId: escazu.id,
      organizationId: escazu.organizationId,
      firstName: "SelfCheckInTest",
      lastName: "Student",
      phone: "88889999",
      email: `self-check-in-student-${suffix}@example.com`,
      codeHash,
      status,
      currentRankId: adultRankId("WHITE"),
    },
  });

  return { user: { ...user, organizationId: escazu.organizationId }, studentId: student.id };
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
    currentSession = { user: { id: user.id, role: "STUDENT" }, activeOrganizationId: user.organizationId };
    setSystemTime(WITHIN_MONDAY_GI_WINDOW);

    const state = await selfCheckIn(user.organizationId, {}, new FormData());

    expect(state.ok).toBe(true);
    expect(state.error).toBeUndefined();

    const record = await prisma.attendanceRecord.findFirstOrThrow({ where: { studentId } });
    expect(record.source).toBe("PORTAL");
  });

  it("rejects the same student self-checking in again immediately as already_checked_in", async () => {
    const { user, studentId } = await makeActiveStudentUser();
    currentSession = { user: { id: user.id, role: "STUDENT" }, activeOrganizationId: user.organizationId };
    setSystemTime(WITHIN_MONDAY_GI_WINDOW);

    const first = await selfCheckIn(user.organizationId, {}, new FormData());
    expect(first.ok).toBe(true);

    const second = await selfCheckIn(user.organizationId, {}, new FormData());
    expect(second).toEqual({ error: "already_checked_in" });

    expect(await prisma.attendanceRecord.count({ where: { studentId } })).toBe(1);
  });

  // REDESIGN_BRIEF.md Phase 9: this used to reject. `OUTSIDE_ANY_WINDOW` is a
  // Sunday and Escazú has no Sunday classes at all, so there is nothing to
  // offer the student to pick — the tap is saved unattributed
  // (`matchSource: UNMATCHED`, no classSession) instead of being dropped, and
  // staff review it on the Kiosco page's "Marcajes de hoy" table.
  it("saves a self check-in on a day with no classes at all as an UNMATCHED record", async () => {
    const { user, studentId } = await makeActiveStudentUser();
    currentSession = { user: { id: user.id, role: "STUDENT" }, activeOrganizationId: user.organizationId };
    setSystemTime(OUTSIDE_ANY_WINDOW);

    const state = await selfCheckIn(user.organizationId, {}, new FormData());

    expect(state.ok).toBe(true);
    const record = await prisma.attendanceRecord.findFirstOrThrow({ where: { studentId } });
    expect(record.classSessionId).toBeNull();
    expect(record.matchSource).toBe("UNMATCHED");
  });

  it("rejects a PENDING student's self check-in with the distinct notActive error, via the upfront status check", async () => {
    const { user, studentId } = await makeActiveStudentUser("PENDING");
    currentSession = { user: { id: user.id, role: "STUDENT" }, activeOrganizationId: user.organizationId };
    setSystemTime(WITHIN_MONDAY_GI_WINDOW);

    const state = await selfCheckIn(user.organizationId, {}, new FormData());

    // Exactly `notActive`, not performCheckIn's generic `invalid_code` — the
    // status check in self-check-in-action.ts must short-circuit BEFORE
    // performCheckIn (and therefore before any AttendanceRecord) is ever
    // attempted.
    expect(state).toEqual({ error: "notActive" });
    expect(await prisma.attendanceRecord.count({ where: { studentId } })).toBe(0);
  });

  it("rejects an ARCHIVED student's self check-in with the distinct notActive error, via the upfront status check", async () => {
    const { user, studentId } = await makeActiveStudentUser("ARCHIVED");
    currentSession = { user: { id: user.id, role: "STUDENT" }, activeOrganizationId: user.organizationId };
    setSystemTime(WITHIN_MONDAY_GI_WINDOW);

    const state = await selfCheckIn(user.organizationId, {}, new FormData());

    expect(state).toEqual({ error: "notActive" });
    expect(await prisma.attendanceRecord.count({ where: { studentId } })).toBe(0);
  });

  it("rejects an INACTIVE student's self check-in with the distinct notActive error, via the upfront status check", async () => {
    const { user, studentId } = await makeActiveStudentUser("INACTIVE");
    currentSession = { user: { id: user.id, role: "STUDENT" }, activeOrganizationId: user.organizationId };
    setSystemTime(WITHIN_MONDAY_GI_WINDOW);

    const state = await selfCheckIn(user.organizationId, {}, new FormData());

    expect(state).toEqual({ error: "notActive" });
    expect(await prisma.attendanceRecord.count({ where: { studentId } })).toBe(0);
  });

  it("I-1: fires notifyEligibilityReached through the REAL self-check-in action entry point when a check-in crosses the stripe threshold", async () => {
    const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
    const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
    const rawUser = await prisma.user.create({
      data: {
        email: `self-check-in-elig-${suffix}@example.com`,
        passwordHash: await hashSecret("irrelevant-password-123"),
        role: "STUDENT",
        active: true,
      },
    });
    cleanupUserIds.push(rawUser.id);
    await prisma.organizationMembership.create({
      data: { userId: rawUser.id, organizationId: escazu.organizationId, role: "STUDENT" },
    });
    const user = { ...rawUser, organizationId: escazu.organizationId };

    const { codeHash } = await generateStudentCode(escazu.organizationId);
    const beltAwardedAt = new Date("2025-12-01T00:00:00Z");
    const student = await prisma.student.create({
      data: {
        userId: user.id,
        homeAcademyId: escazu.id,
        organizationId: escazu.organizationId,
        firstName: "SelfCheckInEligTest",
        lastName: "Student",
        phone: "88887000",
        email: `self-check-in-elig-student-${suffix}@example.com`,
        codeHash,
        status: "ACTIVE",
        currentRankId: adultRankId("WHITE"),
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
          organizationId: escazu.organizationId,
          occurredAt,
          date: new Date(Date.UTC(occurredAt.getUTCFullYear(), occurredAt.getUTCMonth(), occurredAt.getUTCDate())),
          type: "CHECKIN" as const,
          delta: 1,
          source: "STAFF" as const,
        };
      }),
    });

    currentSession = { user: { id: user.id, role: "STUDENT" }, activeOrganizationId: user.organizationId };
    setSystemTime(WITHIN_MONDAY_GI_WINDOW);

    const state = await selfCheckIn(user.organizationId, {}, new FormData());

    expect(state.ok).toBe(true);
    expect(state.earnedStripe).toBe(true);
    expect(notifyEligibilityState.spy).toHaveBeenCalledWith(student.id, "STRIPE_THRESHOLD");
  });

  it("1f-4: a real STUDENT membership doesn't help against an organizationId their tab doesn't belong to — refuses with invalid_code, audits, and checks in nothing; the same session checking in against their own org still succeeds", async () => {
    const { user, studentId } = await makeActiveStudentUser();
    currentSession = { user: { id: user.id, role: "STUDENT" }, activeOrganizationId: user.organizationId };
    setSystemTime(WITHIN_MONDAY_GI_WINDOW);

    const otherOrg = await prisma.organization.create({
      data: { slug: `selfcheckin-crossorg-${Date.now()}`, name: "Cross-Org Test Org", status: "ACTIVE" },
    });

    try {
      const rejected = await selfCheckIn(otherOrg.id, {}, new FormData());
      expect(rejected).toEqual({ error: "invalid_code" });
      expect(await prisma.attendanceRecord.count({ where: { studentId } })).toBe(0);

      const refusalAudit = await prisma.auditLog.findFirst({
        where: { actorId: user.id, action: "organization.accessRefused", entityId: otherOrg.id },
      });
      expect(refusalAudit).not.toBeNull();

      const legitimate = await selfCheckIn(user.organizationId, {}, new FormData());
      expect(legitimate.ok).toBe(true);
      expect(await prisma.attendanceRecord.count({ where: { studentId } })).toBe(1);
    } finally {
      await prisma.auditLog.deleteMany({ where: { organizationId: otherOrg.id } });
      await prisma.organization.delete({ where: { id: otherOrg.id } });
    }
  });
});
