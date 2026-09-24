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

// Counts calls into the REAL shared check-in core, so a test can prove the action refuses a request BEFORE reaching
// it (the core would also refuse a missing selection - two layers - and each is tested on its own).
const coreCalls = vi.hoisted(() => ({ count: 0 }));
vi.mock("@/lib/kiosk/perform-check-in", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/kiosk/perform-check-in")>();
  return {
    ...actual,
    performCheckIn: (...args: Parameters<typeof actual.performCheckIn>) => {
      coreCalls.count += 1;
      return actual.performCheckIn(...args);
    },
  };
});

const { selfCheckIn } = await import("../../src/app/[locale]/portal/self-check-in-action");

const prisma = getTestPrismaClient();

// Same fixed instants as perform-check-in.test.ts: 2026-01-05T12:00:00Z is
// 2026-01-05 06:00 America/Costa_Rica (UTC-6, fixed, no DST) — a Monday,
// exactly the seeded Escazú "GI" session's start, squarely inside its
// window (start - 30 minutes to end + 30 minutes). 2026-01-04T18:00:00Z is a Sunday, outside every seeded
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

async function makeActiveStudentUser(status: "ACTIVE" | "PENDING" | "ARCHIVED" | "INACTIVE" = "ACTIVE", academyId?: string) {
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
  const escazu = academyId
    ? await prisma.academy.findUniqueOrThrow({ where: { id: academyId } })
    : await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
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
/** The portal now checks in to an EXPLICIT class: the seeded Escazu Monday 06:00 GI class (open at WITHIN_MONDAY_GI_WINDOW). */
async function mondayGiClassId() {
  const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
  return (await prisma.classSession.findFirstOrThrow({ where: { academyId: escazu.id, dayOfWeek: "MONDAY", startTime: "06:00", active: true } })).id;
}
function selection(classSessionId: string): FormData {
  const fd = new FormData();
  fd.set("classSessionId", classSessionId);
  return fd;
}
async function selectMondayGi(): Promise<FormData> {
  return selection(await mondayGiClassId());
}

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

    const state = await selfCheckIn(user.organizationId, {}, await selectMondayGi());

    expect(state.ok).toBe(true);
    expect(state.error).toBeUndefined();

    const record = await prisma.attendanceRecord.findFirstOrThrow({ where: { studentId } });
    expect(record.source).toBe("PORTAL");
  });

  it("rejects the same student self-checking in again immediately as already_checked_in", async () => {
    const { user, studentId } = await makeActiveStudentUser();
    currentSession = { user: { id: user.id, role: "STUDENT" }, activeOrganizationId: user.organizationId };
    setSystemTime(WITHIN_MONDAY_GI_WINDOW);

    const first = await selfCheckIn(user.organizationId, {}, await selectMondayGi());
    expect(first.ok).toBe(true);

    const second = await selfCheckIn(user.organizationId, {}, await selectMondayGi());
    expect(second).toEqual({ error: "already_checked_in" });

    expect(await prisma.attendanceRecord.count({ where: { studentId } })).toBe(1);
  });

  // PR 3: the portal checks in to an EXPLICIT class. `OUTSIDE_ANY_WINDOW` is a Sunday and Escazu has no Sunday
  // classes, so there is nothing to select. The kiosk keeps its unmatched fallback (an attended device staff can
  // correct); the portal does not save an unattributed tap - the page explains the empty day instead.
  it("a request with no selection is refused by the action itself, before the shared core is ever called", async () => {
    const { user, studentId } = await makeActiveStudentUser();
    currentSession = { user: { id: user.id, role: "STUDENT" }, activeOrganizationId: user.organizationId };
    setSystemTime(WITHIN_MONDAY_GI_WINDOW);
    coreCalls.count = 0;

    expect(await selfCheckIn(user.organizationId, {}, new FormData())).toEqual({ error: "invalid_class" });
    const empty = new FormData();
    empty.set("classSessionId", "");
    expect(await selfCheckIn(user.organizationId, {}, empty)).toEqual({ error: "invalid_class" });
    expect(coreCalls.count).toBe(0);
    expect(await prisma.attendanceRecord.count({ where: { studentId } })).toBe(0);
  });

  it("on a day with no classes there is nothing to select: a selection is refused as not open and nothing is saved", async () => {
    const { user, studentId } = await makeActiveStudentUser();
    currentSession = { user: { id: user.id, role: "STUDENT" }, activeOrganizationId: user.organizationId };
    setSystemTime(OUTSIDE_ANY_WINDOW);

    expect(await selfCheckIn(user.organizationId, {}, new FormData())).toEqual({ error: "invalid_class" });
    expect(await selfCheckIn(user.organizationId, {}, await selectMondayGi())).toEqual({ error: "class_not_open" });
    expect(await prisma.attendanceRecord.count({ where: { studentId } })).toBe(0);
  });

  it("rejects a PENDING student's self check-in with the distinct notActive error, via the upfront status check", async () => {
    const { user, studentId } = await makeActiveStudentUser("PENDING");
    currentSession = { user: { id: user.id, role: "STUDENT" }, activeOrganizationId: user.organizationId };
    setSystemTime(WITHIN_MONDAY_GI_WINDOW);

    const state = await selfCheckIn(user.organizationId, {}, await selectMondayGi());

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

    const state = await selfCheckIn(user.organizationId, {}, await selectMondayGi());

    expect(state).toEqual({ error: "notActive" });
    expect(await prisma.attendanceRecord.count({ where: { studentId } })).toBe(0);
  });

  it("rejects an INACTIVE student's self check-in with the distinct notActive error, via the upfront status check", async () => {
    const { user, studentId } = await makeActiveStudentUser("INACTIVE");
    currentSession = { user: { id: user.id, role: "STUDENT" }, activeOrganizationId: user.organizationId };
    setSystemTime(WITHIN_MONDAY_GI_WINDOW);

    const state = await selfCheckIn(user.organizationId, {}, await selectMondayGi());

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

    const state = await selfCheckIn(user.organizationId, {}, await selectMondayGi());

    expect(state.ok).toBe(true);
    expect(state.thresholdReached).toBe(true);
    expect(notifyEligibilityState.spy).toHaveBeenCalledWith(student.id, user.organizationId, "STRIPE_THRESHOLD");
  });

  it("1f-4: a real STUDENT membership doesn't help against an organizationId their tab doesn't belong to — refuses with invalid_code, audits, and checks in nothing; the same session checking in against their own org still succeeds", async () => {
    const { user, studentId } = await makeActiveStudentUser();
    currentSession = { user: { id: user.id, role: "STUDENT" }, activeOrganizationId: user.organizationId };
    setSystemTime(WITHIN_MONDAY_GI_WINDOW);

    const otherOrg = await prisma.organization.create({
      data: { slug: `selfcheckin-crossorg-${Date.now()}`, name: "Cross-Org Test Org", status: "ACTIVE" },
    });

    try {
      const rejected = await selfCheckIn(otherOrg.id, {}, await selectMondayGi());
      expect(rejected).toEqual({ error: "invalid_code" });
      expect(await prisma.attendanceRecord.count({ where: { studentId } })).toBe(0);

      const refusalAudit = await prisma.auditLog.findFirst({
        where: { actorId: user.id, action: "organization.accessRefused", entityId: otherOrg.id },
      });
      expect(refusalAudit).not.toBeNull();

      const legitimate = await selfCheckIn(user.organizationId, {}, await selectMondayGi());
      expect(legitimate.ok).toBe(true);
      expect(await prisma.attendanceRecord.count({ where: { studentId } })).toBe(1);
    } finally {
      await prisma.auditLog.deleteMany({ where: { organizationId: otherOrg.id } });
      await prisma.organization.delete({ where: { id: otherOrg.id } });
    }
  });
});

// PR 3: explicit selection through the REAL portal action, against an academy with two same-day classes.
describe("selfCheckIn with an explicit class selection", () => {
  // Monday 2026-01-05 18:30 America/Costa_Rica: the 18:00 window has just closed and the 19:00 one has just opened,
  // so automatic matching alone would prefer the earlier class.
  const MONDAY_1830_CR = new Date("2026-01-06T00:30:00Z");
  const fixtures = { academyIds: [] as string[] };

  afterAll(async () => {
    await prisma.attendanceRecord.deleteMany({ where: { academyId: { in: fixtures.academyIds } } });
    await prisma.student.deleteMany({ where: { homeAcademyId: { in: fixtures.academyIds } } });
    await prisma.organizationMembership.deleteMany({ where: { userId: { in: cleanupUserIds } } });
    await prisma.user.deleteMany({ where: { id: { in: cleanupUserIds } } });
    await prisma.classSession.deleteMany({ where: { academyId: { in: fixtures.academyIds } } });
    await prisma.academy.deleteMany({ where: { id: { in: fixtures.academyIds } } });
  });
  afterEach(() => {
    vi.useRealTimers();
    currentSession = null;
  });

  async function twoClassStudent() {
    const alliance = await prisma.organization.findUniqueOrThrow({ where: { slug: "alliance-cr" } });
    const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
    const academy = await prisma.academy.create({ data: { organizationId: alliance.id, name: `Two Classes ${suffix}`, slug: `two-classes-${suffix}`, kioskTokenHash: `two-classes-${suffix}` } });
    fixtures.academyIds.push(academy.id);
    const mk = (startTime: string, name: string) =>
      prisma.classSession.create({ data: { academyId: academy.id, organizationId: alliance.id, dayOfWeek: "MONDAY", startTime, durationMinutes: 60, name, type: "GI" } });
    const early = await mk("18:00", "Early");
    const later = await mk("19:00", "Later");
    const { user, studentId } = await makeActiveStudentUser("ACTIVE", academy.id);
    currentSession = { user: { id: user.id, role: "STUDENT" }, activeOrganizationId: user.organizationId };
    setSystemTime(MONDAY_1830_CR);
    return { user, studentId, academy, early, later };
  }

  it("selecting the later class records exactly that class id, even though automatic matching would prefer the earlier one", async () => {
    const { user, studentId, later } = await twoClassStudent();
    const state = await selfCheckIn(user.organizationId, {}, selection(later.id));
    expect(state.ok).toBe(true);
    expect(state.classSessionId).toBe(later.id);
    const record = await prisma.attendanceRecord.findFirstOrThrow({ where: { studentId } });
    expect(record.classSessionId).toBe(later.id);
    expect(record.matchSource).toBe("STUDENT_PICKED");
    expect(record.source).toBe("PORTAL");
  });

  it("a second attempt at the same class is refused, and so are concurrent attempts (exactly one row)", async () => {
    const { user, studentId, later } = await twoClassStudent();
    const results = await Promise.all(Array.from({ length: 5 }, () => selfCheckIn(user.organizationId, {}, selection(later.id))));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => r.error === "already_checked_in")).toHaveLength(4);
    expect(await prisma.attendanceRecord.count({ where: { studentId } })).toBe(1);
    expect(await selfCheckIn(user.organizationId, {}, selection(later.id))).toEqual({ error: "already_checked_in" });
  });

  it("the two classes are separate check-ins: the student can attend both, each recorded on its own class", async () => {
    const { user, studentId, early, later } = await twoClassStudent();
    expect((await selfCheckIn(user.organizationId, {}, selection(later.id))).ok).toBe(true);
    expect((await selfCheckIn(user.organizationId, {}, selection(early.id))).ok).toBe(true);
    const classes = (await prisma.attendanceRecord.findMany({ where: { studentId } })).map((r) => r.classSessionId).sort();
    expect(classes).toEqual([early.id, later.id].sort());
  });

  it("tampered selections write nothing: no selection, an empty one, a class of another academy, of another organization, an unknown id", async () => {
    const { user, studentId, academy } = await twoClassStudent();
    const foreignOrg = await prisma.organization.create({ data: { slug: `sel-foreign-${Date.now()}`, name: "Foreign", status: "ACTIVE" } });
    try {
      const foreignAcademy = await prisma.academy.create({ data: { organizationId: foreignOrg.id, name: "Foreign Academy", slug: `sel-foreign-a-${Date.now()}`, kioskTokenHash: `sel-foreign-${Date.now()}` } });
      const foreignClass = await prisma.classSession.create({ data: { academyId: foreignAcademy.id, organizationId: foreignOrg.id, dayOfWeek: "MONDAY", startTime: "19:00", durationMinutes: 60, name: "Foreign", type: "GI" } });
      const otherAcademyInOrg = await prisma.academy.create({ data: { organizationId: academy.organizationId, name: "Sibling", slug: `sel-sibling-${Date.now()}`, kioskTokenHash: `sel-sibling-${Date.now()}` } });
      fixtures.academyIds.push(otherAcademyInOrg.id);
      const siblingClass = await prisma.classSession.create({ data: { academyId: otherAcademyInOrg.id, organizationId: academy.organizationId, dayOfWeek: "MONDAY", startTime: "19:00", durationMinutes: 60, name: "Sibling class", type: "GI" } });

      expect(await selfCheckIn(user.organizationId, {}, new FormData())).toEqual({ error: "invalid_class" });
      for (const id of ["", "does-not-exist", foreignClass.id, siblingClass.id]) {
        expect(await selfCheckIn(user.organizationId, {}, selection(id)), `id "${id}"`).toEqual({ error: "invalid_class" });
      }
      expect(await prisma.attendanceRecord.count({ where: { studentId } })).toBe(0);
      await prisma.classSession.deleteMany({ where: { academyId: foreignAcademy.id } });
      await prisma.academy.deleteMany({ where: { id: foreignAcademy.id } });
    } finally {
      await prisma.organization.deleteMany({ where: { id: foreignOrg.id } });
    }
  });
});
