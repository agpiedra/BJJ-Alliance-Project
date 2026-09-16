import "dotenv/config";
import { getTestPrismaClient } from "../helpers/test-db";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requireEnv } from "../../src/lib/env";
import { digestLookupSecret, hashSecret } from "../../src/lib/crypto";
import { toAttendanceDate } from "../../src/lib/scheduling/zone";
import type { AccessContext } from "../../src/lib/tenant/types";
import { adultRankId, type BeltCode } from "../helpers/belt-ranks";
import { ALLIANCE_ATTENDANCE_CONFIG } from "../helpers/promotion-config";

const DAY_MS = 24 * 60 * 60 * 1000;

// `confirmPromotion` reaches `requireTenantContext()` -> `getTenantContext()`
// -> next-auth's `auth()`, which needs a real HTTP request's cookies to
// resolve a JWT session — unavailable in a plain integration test. Mocking
// `@/auth`'s `auth()` lets this Server Action be exercised directly against
// the real DB, matching `tests/integration/student-detail-actions.test.ts`'s
// established pattern for a cookie-bound write action, while still using
// real `User` / `OrganizationMembership` / `StaffAssignment` rows underneath
// so `getTenantContext()`'s own DB queries run unmodified.
let currentSession: { user: { id: string; role: string } | null; activeOrganizationId?: string } | null = null;

vi.mock("@/auth", () => ({
  auth: () => Promise.resolve(currentSession),
}));

// `confirmPromotion`'s scope-check read (read A) goes through
// `getScopedDb(context).student.findUnique` (1f-3), not the raw `prisma`
// singleton directly — so the race-condition regression tests below
// intercept `getScopedDb` itself (see `injectAfterScopeCheckRead`) rather
// than spying on a `prisma` method, which the code under test no longer
// calls for that read.
vi.mock("../../src/lib/tenant/scoped-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/tenant/scoped-client")>();
  return { ...actual };
});

const { confirmPromotion } = await import("../../src/app/[locale]/(staff)/dashboard/promotion-actions");
const { getAtBeltSummary } = await import("../../src/lib/students/attendance-summary");
const scopedClientModule = await import("../../src/lib/tenant/scoped-client");

/**
 * Lets `confirmPromotion`'s REAL scope-check read (read A) resolve
 * normally, then performs `sideEffect` — a separate, real write, as if
 * another staff member's own action ran concurrently — strictly between
 * that resolution and anything else `confirmPromotion` does. Reproduces a
 * race window deterministically without relying on real timing. One-shot
 * (`mockImplementationOnce`): only the very next `getScopedDb` call is
 * intercepted.
 */
function injectAfterScopeCheckRead(sideEffect: () => Promise<unknown>) {
  const realGetScopedDb = scopedClientModule.getScopedDb;
  vi.spyOn(scopedClientModule, "getScopedDb").mockImplementationOnce((context: AccessContext) => {
    const db = realGetScopedDb(context);
    // `findUnique` returns Prisma's fluent `Prisma__StudentClient` (not a
    // plain `Promise`), which supports chained relation calls
    // (`.homeAcademy()`, etc.) — irrelevant here, which only needs the
    // awaited result, so this is typed loosely via `as never` rather than
    // reproducing that fluent-client shape.
    const originalFindUnique = db.student.findUnique.bind(db.student) as (args: never) => Promise<unknown>;
    return {
      ...db,
      student: {
        ...db.student,
        findUnique: (async (args: never) => {
          const result = await originalFindUnique(args);
          await sideEffect();
          return result;
        }) as typeof db.student.findUnique,
      },
    } as never;
  });
}

const prisma = getTestPrismaClient();
const pepper = requireEnv("CODE_PEPPER");

function formData(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    fd.set(key, value);
  }
  return fd;
}

const cleanupUserIds: string[] = [];
const cleanupStudentIds: string[] = [];

async function cleanup() {
  if (cleanupStudentIds.length > 0 || cleanupUserIds.length > 0) {
    await prisma.auditLog.deleteMany({
      where: { OR: [{ entityId: { in: cleanupStudentIds } }, { actorId: { in: cleanupUserIds } }] },
    });
    await prisma.promotion.deleteMany({
      where: { OR: [{ studentId: { in: cleanupStudentIds } }, { awardedById: { in: cleanupUserIds } }] },
    });
    await prisma.attendanceRecord.deleteMany({
      where: { OR: [{ studentId: { in: cleanupStudentIds } }, { createdById: { in: cleanupUserIds } }] },
    });
  }
  if (cleanupStudentIds.length > 0) {
    await prisma.student.deleteMany({ where: { id: { in: cleanupStudentIds } } });
  }
  if (cleanupUserIds.length > 0) {
    await prisma.organizationMembership.deleteMany({ where: { userId: { in: cleanupUserIds } } });
    await prisma.staffAssignment.deleteMany({ where: { userId: { in: cleanupUserIds } } });
    await prisma.notification.deleteMany({ where: { userId: { in: cleanupUserIds } } });
    await prisma.user.deleteMany({ where: { id: { in: cleanupUserIds } } });
  }
}

let allianceOrgIdPromise: Promise<string> | null = null;
function getAllianceOrganizationId() {
  allianceOrgIdPromise ??= prisma.organization.findUniqueOrThrow({ where: { slug: "alliance-cr" } }).then((o) => o.id);
  return allianceOrgIdPromise;
}

async function makeStaffUser(role: "ADMIN" | "DIRECTOR" | "INSTRUCTOR", label: string, academyId?: string) {
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
  const user = await prisma.user.create({
    data: {
      email: `${label}-${suffix}@example.com`,
      passwordHash: await hashSecret("irrelevant-password-123"),
      role,
    },
  });
  cleanupUserIds.push(user.id);

  const organizationId = academyId
    ? (await prisma.academy.findUniqueOrThrow({ where: { id: academyId }, select: { organizationId: true } }))
        .organizationId
    : await getAllianceOrganizationId();

  await prisma.organizationMembership.create({ data: { userId: user.id, organizationId, role } });

  if (academyId && role !== "ADMIN") {
    await prisma.staffAssignment.create({
      data: {
        userId: user.id,
        academyId,
        organizationId,
        role: role === "DIRECTOR" ? "DIRECTOR" : "INSTRUCTOR",
      },
    });
  }
  return { ...user, organizationId };
}

async function makeStudent(
  academyId: string,
  organizationId: string,
  overrides: {
    currentBelt: BeltCode;
    currentStripes: number;
    beltAwardedAt: Date;
    lastName?: string;
    status?: "PENDING" | "ACTIVE" | "INACTIVE" | "ARCHIVED";
  },
) {
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
  const student = await prisma.student.create({
    data: {
      homeAcademyId: academyId,
      organizationId,
      firstName: "PromotionActionTest",
      lastName: overrides.lastName ?? `Student-${suffix}`,
      phone: "88880000",
      email: `promotion-action-${suffix}@example.com`,
      currentRankId: adultRankId(overrides.currentBelt),
      currentStripes: overrides.currentStripes,
      beltAwardedAt: overrides.beltAwardedAt,
      status: overrides.status ?? "ACTIVE",
      codeHash: digestLookupSecret(`promotion-action-${suffix}`, pepper),
    },
  });
  cleanupStudentIds.push(student.id);
  return student;
}

/**
 * Writes `count` synthetic CHECKIN rows with `classSessionId: null`, one per
 * day starting at `startAt` — same shape as `promotion-queue.test.ts`'s
 * fixture helper, so a test can hit an exact attendance count without
 * needing that many distinct real class occurrences to exist.
 */
async function addAttendances(
  studentId: string,
  academyId: string,
  organizationId: string,
  count: number,
  startAt: Date,
) {
  if (count === 0) return;
  const rows = Array.from({ length: count }, (_, i) => {
    const occurredAt = new Date(startAt.getTime() + i * DAY_MS);
    return {
      studentId,
      academyId,
      organizationId,
      occurredAt,
      date: toAttendanceDate(occurredAt),
      type: "CHECKIN" as const,
      delta: 1,
      source: "STAFF" as const,
    };
  });
  await prisma.attendanceRecord.createMany({ data: rows });
}

async function addAdjustment(
  studentId: string,
  academyId: string,
  organizationId: string,
  delta: number,
  occurredAt: Date,
) {
  await prisma.attendanceRecord.create({
    data: {
      studentId,
      academyId,
      organizationId,
      occurredAt,
      date: toAttendanceDate(occurredAt),
      type: "ADJUSTMENT",
      delta,
      reason: "test correction",
      source: "STAFF",
    },
  });
}

function promotionsFor(studentId: string) {
  return prisma.promotion.findMany({
    where: { studentId },
    orderBy: { awardedAt: "asc" },
    include: { fromRank: { select: { code: true } }, toRank: { select: { code: true } } },
  });
}

function auditRowsFor(studentId: string, action: string) {
  return prisma.auditLog.findMany({ where: { entityId: studentId, action }, orderBy: { createdAt: "asc" } });
}

describe("confirmPromotion", () => {
  afterAll(cleanup);

  beforeEach(() => {
    currentSession = null;
  });

  afterEach(() => {
    // Restores any `vi.spyOn(scopedClientModule, "getScopedDb")` from the
    // race-regression tests below — this file has no global `restoreMocks`,
    // so a leftover spy would otherwise bleed into later tests.
    vi.restoreAllMocks();
  });

  it("a student exactly at a stripe threshold: confirming increments currentStripes, leaves belt/beltAwardedAt unchanged, writes Promotion + AuditLog rows", async () => {
    const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
    const admin = await makeStaffUser("ADMIN", "confirm-stripe-admin");
    const beltAwardedAt = new Date("2026-01-01T12:00:00Z");
    const student = await makeStudent(escazu.id, escazu.organizationId, { currentBelt: "WHITE", currentStripes: 0, beltAwardedAt });

    // WHITE requires 30 attendancesPerStripe (global default) — exactly at
    // the threshold, not one short and not one over.
    await addAttendances(student.id, escazu.id, escazu.organizationId, 30, new Date(beltAwardedAt.getTime() + DAY_MS));

    currentSession = { user: { id: admin.id, role: "ADMIN" }, activeOrganizationId: admin.organizationId };
    const result = await confirmPromotion(admin.organizationId, {}, formData({ studentId: student.id, notes: "stripe review" }));
    expect(result.ok).toBe(true);

    const after = await prisma.student.findUniqueOrThrow({
      where: { id: student.id },
      include: { currentRank: { select: { code: true } } },
    });
    expect(after.currentStripes).toBe(1);
    expect(after.currentRank.code).toBe("WHITE");
    expect(after.beltAwardedAt.getTime()).toBe(beltAwardedAt.getTime());

    const promotions = await promotionsFor(student.id);
    expect(promotions).toHaveLength(1);
    expect(promotions[0]).toMatchObject({
      academyId: escazu.id,
      fromRank: { code: "WHITE" },
      fromStripes: 0,
      toRank: { code: "WHITE" },
      toStripes: 1,
      source: "MANUAL",
      awardedById: admin.id,
      notes: "stripe review",
    });

    const audits = await auditRowsFor(student.id, "student.promote");
    expect(audits).toHaveLength(1);
    expect(audits[0].actorId).toBe(admin.id);
    expect(audits[0].academyId).toBe(escazu.id);
    expect(audits[0].before).toMatchObject({ belt: "WHITE", stripes: 0 });
    expect(audits[0].after).toMatchObject({ belt: "WHITE", stripes: 1 });
  });

  it("a student exactly at the exam threshold (4 stripes): confirming advances currentBelt, resets currentStripes to 0 and beltAwardedAt to now, writes Promotion + AuditLog rows", async () => {
    const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
    const admin = await makeStaffUser("ADMIN", "confirm-exam-admin");
    const beltAwardedAt = new Date("2026-02-01T12:00:00Z");
    // 4 * 30 (attendancesPerStripe) + 30 (attendancesForExam) = 150, exactly
    // at the exam threshold — matches promotion-queue.test.ts's equivalent
    // fixture.
    const student = await makeStudent(escazu.id, escazu.organizationId, { currentBelt: "WHITE", currentStripes: 4, beltAwardedAt });
    await addAttendances(student.id, escazu.id, escazu.organizationId, 150, new Date(beltAwardedAt.getTime() + DAY_MS));

    const before = await getAtBeltSummary(student.id, ALLIANCE_ATTENDANCE_CONFIG);
    expect(before.nextTarget).toBe("BELT");
    expect(before.isEligible).toBe(true);

    currentSession = { user: { id: admin.id, role: "ADMIN" }, activeOrganizationId: admin.organizationId };
    const beforeConfirm = Date.now();
    const result = await confirmPromotion(admin.organizationId, {}, formData({ studentId: student.id }));
    expect(result.ok).toBe(true);

    const after = await prisma.student.findUniqueOrThrow({
      where: { id: student.id },
      include: { currentRank: { select: { code: true } } },
    });
    expect(after.currentRank.code).toBe("BLUE");
    expect(after.currentStripes).toBe(0);
    expect(after.beltAwardedAt.getTime()).toBeGreaterThanOrEqual(beforeConfirm);
    expect(after.beltAwardedAt.getTime()).toBeLessThanOrEqual(Date.now());

    const promotions = await promotionsFor(student.id);
    expect(promotions).toHaveLength(1);
    expect(promotions[0]).toMatchObject({
      academyId: escazu.id,
      fromRank: { code: "WHITE" },
      fromStripes: 4,
      toRank: { code: "BLUE" },
      toStripes: 0,
      source: "MANUAL",
      awardedById: admin.id,
      notes: null,
    });

    const audits = await auditRowsFor(student.id, "student.promote");
    expect(audits).toHaveLength(1);
    expect(audits[0].before).toMatchObject({ belt: "WHITE", stripes: 4 });
    expect(audits[0].after).toMatchObject({ belt: "BLUE", stripes: 0 });
  });

  it("the stale-eligibility race: a negative adjustment dropping the student back below the threshold BEFORE confirmPromotion is called must be rejected with notEligible, writing NO Promotion row and leaving Student unchanged", async () => {
    const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
    const admin = await makeStaffUser("ADMIN", "confirm-race-admin");
    const beltAwardedAt = new Date("2026-03-01T12:00:00Z");
    const student = await makeStudent(escazu.id, escazu.organizationId, { currentBelt: "WHITE", currentStripes: 0, beltAwardedAt });

    // Genuinely eligible at first: exactly 30 attendances.
    await addAttendances(student.id, escazu.id, escazu.organizationId, 30, new Date(beltAwardedAt.getTime() + DAY_MS));
    const eligibleSummary = await getAtBeltSummary(student.id, ALLIANCE_ATTENDANCE_CONFIG);
    expect(eligibleSummary.remainingAttendance).toBe(0);

    // A correction lands before the confirm click reaches the server —
    // drops the student back below the threshold it had just crossed.
    await addAdjustment(student.id, escazu.id, escazu.organizationId, -5, new Date(beltAwardedAt.getTime() + 31 * DAY_MS));
    const staleSummary = await getAtBeltSummary(student.id, ALLIANCE_ATTENDANCE_CONFIG);
    expect(staleSummary.remainingAttendance).toBe(5);

    currentSession = { user: { id: admin.id, role: "ADMIN" }, activeOrganizationId: admin.organizationId };
    const result = await confirmPromotion(admin.organizationId, {}, formData({ studentId: student.id }));
    expect(result.error).toBe("notEligible");

    const after = await prisma.student.findUniqueOrThrow({
      where: { id: student.id },
      include: { currentRank: { select: { code: true } } },
    });
    expect(after.currentRank.code).toBe("WHITE");
    expect(after.currentStripes).toBe(0);
    expect(after.beltAwardedAt.getTime()).toBe(beltAwardedAt.getTime());

    expect(await promotionsFor(student.id)).toHaveLength(0);
    expect(await auditRowsFor(student.id, "student.promote")).toHaveLength(0);
  });

  it("a merely 'approaching' student (not yet at a threshold) is rejected with notEligible the same way, regardless of how the request was constructed", async () => {
    const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
    const admin = await makeStaffUser("ADMIN", "confirm-approaching-admin");
    const beltAwardedAt = new Date("2026-04-01T12:00:00Z");
    const student = await makeStudent(escazu.id, escazu.organizationId, { currentBelt: "WHITE", currentStripes: 0, beltAwardedAt });

    // 3 attendances short of the next stripe — "approaching", not eligible.
    await addAttendances(student.id, escazu.id, escazu.organizationId, 27, new Date(beltAwardedAt.getTime() + DAY_MS));

    currentSession = { user: { id: admin.id, role: "ADMIN" }, activeOrganizationId: admin.organizationId };
    const result = await confirmPromotion(admin.organizationId, {}, formData({ studentId: student.id }));
    expect(result.error).toBe("notEligible");

    const after = await prisma.student.findUniqueOrThrow({
      where: { id: student.id },
      include: { currentRank: { select: { code: true } } },
    });
    expect(after.currentStripes).toBe(0);
    expect(await promotionsFor(student.id)).toHaveLength(0);
    expect(await auditRowsFor(student.id, "student.promote")).toHaveLength(0);
  });

  it("an INSTRUCTOR session is rejected (role gate), mutating nothing — spec §3 excludes INSTRUCTOR from promotions", async () => {
    const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
    const instructor = await makeStaffUser("INSTRUCTOR", "confirm-instructor", escazu.id);
    const beltAwardedAt = new Date("2026-05-01T12:00:00Z");
    const student = await makeStudent(escazu.id, escazu.organizationId, { currentBelt: "WHITE", currentStripes: 0, beltAwardedAt });
    await addAttendances(student.id, escazu.id, escazu.organizationId, 30, new Date(beltAwardedAt.getTime() + DAY_MS));

    currentSession = { user: { id: instructor.id, role: "INSTRUCTOR" }, activeOrganizationId: instructor.organizationId };
    await expect(
      confirmPromotion(instructor.organizationId, {}, formData({ studentId: student.id })),
    ).rejects.toThrow("FORBIDDEN");

    const after = await prisma.student.findUniqueOrThrow({
      where: { id: student.id },
      include: { currentRank: { select: { code: true } } },
    });
    expect(after.currentStripes).toBe(0);
    expect(await promotionsFor(student.id)).toHaveLength(0);
  });

  it("a DIRECTOR whose StaffAssignment doesn't cover the student's academy is rejected with notFound, mutating nothing", async () => {
    const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
    const escalante = await prisma.academy.findUniqueOrThrow({ where: { slug: "escalante" } });
    const outOfScopeDirector = await makeStaffUser("DIRECTOR", "confirm-scope-director", escalante.id);
    const beltAwardedAt = new Date("2026-06-01T12:00:00Z");
    const student = await makeStudent(escazu.id, escazu.organizationId, { currentBelt: "WHITE", currentStripes: 0, beltAwardedAt });
    await addAttendances(student.id, escazu.id, escazu.organizationId, 30, new Date(beltAwardedAt.getTime() + DAY_MS));

    currentSession = { user: { id: outOfScopeDirector.id, role: "DIRECTOR" }, activeOrganizationId: outOfScopeDirector.organizationId };
    const result = await confirmPromotion(outOfScopeDirector.organizationId, {}, formData({ studentId: student.id }));
    expect(result.error).toBe("notFound");

    const after = await prisma.student.findUniqueOrThrow({
      where: { id: student.id },
      include: { currentRank: { select: { code: true } } },
    });
    expect(after.currentStripes).toBe(0);
    expect(await promotionsFor(student.id)).toHaveLength(0);
    expect(await auditRowsFor(student.id, "student.promote")).toHaveLength(0);
  });

  it("an in-scope DIRECTOR can confirm a promotion", async () => {
    const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
    const director = await makeStaffUser("DIRECTOR", "confirm-inscope-director", escazu.id);
    const beltAwardedAt = new Date("2026-07-01T12:00:00Z");
    const student = await makeStudent(escazu.id, escazu.organizationId, { currentBelt: "WHITE", currentStripes: 0, beltAwardedAt });
    await addAttendances(student.id, escazu.id, escazu.organizationId, 30, new Date(beltAwardedAt.getTime() + DAY_MS));

    currentSession = { user: { id: director.id, role: "DIRECTOR" }, activeOrganizationId: director.organizationId };
    const result = await confirmPromotion(director.organizationId, {}, formData({ studentId: student.id }));
    expect(result.ok).toBe(true);

    const after = await prisma.student.findUniqueOrThrow({
      where: { id: student.id },
      include: { currentRank: { select: { code: true } } },
    });
    expect(after.currentStripes).toBe(1);

    const promotions = await promotionsFor(student.id);
    expect(promotions).toHaveLength(1);
    expect(promotions[0].awardedById).toBe(director.id);
  });

  it("finding I-1 regression: a concurrent stripe change landing between the scope-check read and getAtBeltSummary's internal read must not produce a mismatched decision", async () => {
    const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
    const admin = await makeStaffUser("ADMIN", "confirm-i1-admin");
    const beltAwardedAt = new Date("2026-08-01T12:00:00Z");
    // Created at currentStripes=1 — the value confirmPromotion's scope-check
    // read (read A) will observe.
    const student = await makeStudent(escazu.id, escazu.organizationId, { currentBelt: "WHITE", currentStripes: 1, beltAwardedAt });

    // Enough attendance for a student truly AT currentStripes=3 (the value
    // AFTER the concurrent write simulated below) to be exactly
    // stripe-eligible: nextStripeAt = (3 + 1) * 30 = 120.
    await addAttendances(student.id, escazu.id, escazu.organizationId, 120, new Date(beltAwardedAt.getTime() + DAY_MS));

    // Simulate a concurrent write (e.g. two manual stripe corrections by
    // another staff member) landing strictly between confirmPromotion's read
    // A (the scope-check `findUnique`) and read B (`getAtBeltSummary`'s
    // internal `findUniqueOrThrow`), bumping currentStripes 1 -> 3.
    //
    // Before fix round 1 (finding I-1), this reproduced a real regression:
    // read A's now-stale currentStripes=1 fed `classifyEligibility` /
    // `resolvePromotionTarget` directly, building a promotion target of
    // fromStripes:1 / toStripes:2 — even though the true, freshly-read
    // (read B) state was already currentStripes=3. Confirming would have
    // REGRESSED the stored value from 3 down to 2 and written a false
    // Promotion/AuditLog pair recording fromStripes:1. The fix makes this
    // structurally impossible: read A no longer selects currentBelt/
    // currentStripes at all, and every value feeding the decision comes from
    // `summary` (read B) alone.
    injectAfterScopeCheckRead(() =>
      prisma.student.update({ where: { id: student.id }, data: { currentStripes: 3 } }),
    );

    currentSession = { user: { id: admin.id, role: "ADMIN" }, activeOrganizationId: admin.organizationId };
    const result = await confirmPromotion(admin.organizationId, {}, formData({ studentId: student.id }));
    expect(result.ok).toBe(true);

    const after = await prisma.student.findUniqueOrThrow({
      where: { id: student.id },
      include: { currentRank: { select: { code: true } } },
    });
    expect(after.currentRank.code).toBe("WHITE");
    // Must be 4 (the true, read-B state of 3, incremented by exactly one) —
    // never 2 (what the pre-fix stale-read-A pairing would have produced).
    expect(after.currentStripes).toBe(4);

    const promotions = await promotionsFor(student.id);
    expect(promotions).toHaveLength(1);
    expect(promotions[0]).toMatchObject({
      fromRank: { code: "WHITE" },
      fromStripes: 3,
      toRank: { code: "WHITE" },
      toStripes: 4,
    });

    const audits = await auditRowsFor(student.id, "student.promote");
    expect(audits).toHaveLength(1);
    expect(audits[0].before).toMatchObject({ belt: "WHITE", stripes: 3 });
    expect(audits[0].after).toMatchObject({ belt: "WHITE", stripes: 4 });
  });

  it("finding I-2 regression: two genuinely concurrent confirms for the same eligible student produce exactly one success and one graceful conflict, with zero side effects from the loser", async () => {
    const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
    const admin = await makeStaffUser("ADMIN", "confirm-concurrent-admin");
    const beltAwardedAt = new Date("2026-08-15T12:00:00Z");
    const student = await makeStudent(escazu.id, escazu.organizationId, { currentBelt: "WHITE", currentStripes: 0, beltAwardedAt });
    await addAttendances(student.id, escazu.id, escazu.organizationId, 30, new Date(beltAwardedAt.getTime() + DAY_MS));

    currentSession = { user: { id: admin.id, role: "ADMIN" }, activeOrganizationId: admin.organizationId };

    // Genuinely concurrent — no artificial delay. Postgres's own row-lock +
    // WHERE-re-evaluation behavior (see the doc comment on
    // `PromotionConflictError` in promotion-actions.ts) is what closes the
    // race, not anything this test orchestrates.
    const [resultA, resultB] = await Promise.all([
      confirmPromotion(admin.organizationId, {}, formData({ studentId: student.id, notes: "first" })),
      confirmPromotion(admin.organizationId, {}, formData({ studentId: student.id, notes: "second" })),
    ]);

    const results = [resultA, resultB];
    const successes = results.filter((r) => r.ok === true);
    const conflicts = results.filter((r) => r.error === "conflict");
    expect(successes).toHaveLength(1);
    expect(conflicts).toHaveLength(1);

    const after = await prisma.student.findUniqueOrThrow({
      where: { id: student.id },
      include: { currentRank: { select: { code: true } } },
    });
    expect(after.currentRank.code).toBe("WHITE");
    // Exactly one stripe increment — never two, and never left unchanged.
    expect(after.currentStripes).toBe(1);

    // The loser's Promotion insert (and its AuditLog row) must have been
    // rolled back along with its failed Student update — zero partial or
    // duplicate side effects, not just "no duplicate Student mutation".
    const promotions = await promotionsFor(student.id);
    expect(promotions).toHaveLength(1);

    const audits = await auditRowsFor(student.id, "student.promote");
    expect(audits).toHaveLength(1);
  });

  it("finding N-1: a PENDING student (self-signup awaiting staff approval) with qualifying attendance is rejected with notActive, writing no Promotion row and leaving Student unchanged", async () => {
    const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
    const admin = await makeStaffUser("ADMIN", "confirm-pending-admin");
    const beltAwardedAt = new Date("2026-09-01T12:00:00Z");
    const student = await makeStudent(escazu.id, escazu.organizationId, {
      currentBelt: "WHITE",
      currentStripes: 0,
      beltAwardedAt,
      status: "PENDING",
    });
    // Exactly at the stripe threshold — would be genuinely eligible if this
    // student were ACTIVE. A PENDING self-signup can legitimately accrue
    // adjustment-based attendance to a threshold through ordinary staff
    // action before anyone approves them, so this is a realistic scenario,
    // not a hand-crafted one.
    await addAttendances(student.id, escazu.id, escazu.organizationId, 30, new Date(beltAwardedAt.getTime() + DAY_MS));

    currentSession = { user: { id: admin.id, role: "ADMIN" }, activeOrganizationId: admin.organizationId };
    const result = await confirmPromotion(admin.organizationId, {}, formData({ studentId: student.id }));
    expect(result.error).toBe("notActive");

    const after = await prisma.student.findUniqueOrThrow({
      where: { id: student.id },
      include: { currentRank: { select: { code: true } } },
    });
    expect(after.status).toBe("PENDING");
    expect(after.currentRank.code).toBe("WHITE");
    expect(after.currentStripes).toBe(0);
    expect(after.beltAwardedAt.getTime()).toBe(beltAwardedAt.getTime());

    expect(await promotionsFor(student.id)).toHaveLength(0);
    expect(await auditRowsFor(student.id, "student.promote")).toHaveLength(0);
  });

  it("finding N-1: an ARCHIVED student (someone who has left the academy) with qualifying attendance is rejected with notActive, writing no Promotion row and leaving Student unchanged", async () => {
    const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
    const admin = await makeStaffUser("ADMIN", "confirm-archived-admin");
    const beltAwardedAt = new Date("2026-09-02T12:00:00Z");
    const student = await makeStudent(escazu.id, escazu.organizationId, {
      currentBelt: "WHITE",
      currentStripes: 0,
      beltAwardedAt,
      status: "ARCHIVED",
    });
    await addAttendances(student.id, escazu.id, escazu.organizationId, 30, new Date(beltAwardedAt.getTime() + DAY_MS));

    currentSession = { user: { id: admin.id, role: "ADMIN" }, activeOrganizationId: admin.organizationId };
    const result = await confirmPromotion(admin.organizationId, {}, formData({ studentId: student.id }));
    expect(result.error).toBe("notActive");

    const after = await prisma.student.findUniqueOrThrow({
      where: { id: student.id },
      include: { currentRank: { select: { code: true } } },
    });
    expect(after.status).toBe("ARCHIVED");
    expect(after.currentRank.code).toBe("WHITE");
    expect(after.currentStripes).toBe(0);
    expect(after.beltAwardedAt.getTime()).toBe(beltAwardedAt.getTime());

    expect(await promotionsFor(student.id)).toHaveLength(0);
    expect(await auditRowsFor(student.id, "student.promote")).toHaveLength(0);
  });

  it("finding N-1 race regression: a student archived by ANOTHER staff member strictly between confirmPromotion's upfront read and its transaction's write must not produce a committed promotion — the status-scoped updateMany catches it exactly like a belt/stripe mismatch, returning a graceful {error: 'conflict'}", async () => {
    const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
    const admin = await makeStaffUser("ADMIN", "confirm-n1-race-admin");
    const beltAwardedAt = new Date("2026-09-03T12:00:00Z");
    // Genuinely ACTIVE and genuinely eligible at the moment confirmPromotion
    // is called — the upfront read (read A) observes status: ACTIVE.
    const student = await makeStudent(escazu.id, escazu.organizationId, { currentBelt: "WHITE", currentStripes: 0, beltAwardedAt });
    await addAttendances(student.id, escazu.id, escazu.organizationId, 30, new Date(beltAwardedAt.getTime() + DAY_MS));

    // Deterministically force the interleaving the same way the I-1
    // regression test above does: intercept the exact `getScopedDb(context)
    // .student.findUnique` call confirmPromotion's read A makes, let it
    // resolve normally (observing status: ACTIVE, since the archive below hasn't
    // happened yet), then — strictly between that resolution and anything
    // else confirmPromotion does — perform a real, separate write (as if
    // another staff member's own action ran concurrently) that archives the
    // student. This reproduces "a student archived by another staff member
    // in the exact race window between confirmPromotion's upfront
    // scope-check read and its later write" without relying on real
    // concurrency/timing.
    injectAfterScopeCheckRead(() =>
      prisma.student.update({ where: { id: student.id }, data: { status: "ARCHIVED" } }),
    );

    currentSession = { user: { id: admin.id, role: "ADMIN" }, activeOrganizationId: admin.organizationId };
    const result = await confirmPromotion(admin.organizationId, {}, formData({ studentId: student.id }));

    // Must be a graceful conflict, never {ok:true} — {ok:true} here would
    // mean a permanent Promotion/AuditLog pair was written for a student
    // that is, at the moment of writing, no longer ACTIVE.
    expect(result.error).toBe("conflict");

    const after = await prisma.student.findUniqueOrThrow({
      where: { id: student.id },
      include: { currentRank: { select: { code: true } } },
    });
    // The status change from the race is real and persists...
    expect(after.status).toBe("ARCHIVED");
    // ...but the promotion itself must NOT have been applied.
    expect(after.currentRank.code).toBe("WHITE");
    expect(after.currentStripes).toBe(0);
    expect(after.beltAwardedAt.getTime()).toBe(beltAwardedAt.getTime());

    expect(await promotionsFor(student.id)).toHaveLength(0);
    expect(await auditRowsFor(student.id, "student.promote")).toHaveLength(0);
  });

  it("1f-4: an ADMIN's real membership doesn't help against an organizationId their tab doesn't belong to — refused as notFound, writes nothing, and audits the attempt", async () => {
    const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
    const admin = await makeStaffUser("ADMIN", "confirm-crossorg-admin");
    const beltAwardedAt = new Date("2026-08-15T12:00:00Z");
    const student = await makeStudent(escazu.id, escazu.organizationId, { currentBelt: "WHITE", currentStripes: 0, beltAwardedAt });
    await addAttendances(student.id, escazu.id, escazu.organizationId, 30, new Date(beltAwardedAt.getTime() + DAY_MS));

    const otherOrg = await prisma.organization.create({
      data: { slug: `promotion-crossorg-${Date.now()}`, name: "Cross-Org Test Org", status: "ACTIVE" },
    });

    try {
      currentSession = { user: { id: admin.id, role: "ADMIN" }, activeOrganizationId: admin.organizationId };

      const result = await confirmPromotion(otherOrg.id, {}, formData({ studentId: student.id }));
      expect(result.error).toBe("notFound");

      const after = await prisma.student.findUniqueOrThrow({
      where: { id: student.id },
      include: { currentRank: { select: { code: true } } },
    });
      expect(after.currentStripes).toBe(0);
      expect(await promotionsFor(student.id)).toHaveLength(0);

      const refusalAudit = await prisma.auditLog.findFirst({
        where: { actorId: admin.id, action: "organization.accessRefused", entityId: otherOrg.id },
      });
      expect(refusalAudit).not.toBeNull();
    } finally {
      await prisma.auditLog.deleteMany({ where: { organizationId: otherOrg.id } });
      await prisma.organization.delete({ where: { id: otherOrg.id } });
    }
  });

  it("a concurrent double-confirm produces exactly one Promotion row — the loser reports conflict, never a duplicate", async () => {
    // MULTI_ACADEMY_AND_KIDS_BELTS.md Phase 2c-ii: proven by test, not by
    // the presence of a transaction. Deterministic under Postgres's own row
    // locking — both calls read the identical "before" state (neither has
    // written yet), race to the same scoped `updateMany`, and the loser's
    // WHERE predicate no longer matches once the winner's write commits. No
    // artificial delay or monkey-patch needed, unlike the vanished-student
    // race in promotion-queue.test.ts.
    const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
    const admin = await makeStaffUser("ADMIN", "confirm-concurrent-admin");
    const beltAwardedAt = new Date("2026-08-01T12:00:00Z");
    const student = await makeStudent(escazu.id, escazu.organizationId, { currentBelt: "WHITE", currentStripes: 0, beltAwardedAt });
    await addAttendances(student.id, escazu.id, escazu.organizationId, 30, new Date(beltAwardedAt.getTime() + DAY_MS));

    currentSession = { user: { id: admin.id, role: "ADMIN" }, activeOrganizationId: admin.organizationId };

    const [r1, r2] = await Promise.all([
      confirmPromotion(admin.organizationId, {}, formData({ studentId: student.id })),
      confirmPromotion(admin.organizationId, {}, formData({ studentId: student.id })),
    ]);
    const results = [r1, r2];

    expect(results.filter((r) => r.ok).length).toBe(1);
    expect(results.filter((r) => r.error === "conflict").length).toBe(1);

    const promotions = await promotionsFor(student.id);
    expect(promotions).toHaveLength(1);

    const after = await prisma.student.findUniqueOrThrow({ where: { id: student.id } });
    expect(after.currentStripes).toBe(1);
  });

  it("a catalog gap (a non-terminal rank with no rank at order+1) surfaces as a loud InvalidPromotionConfigError naming the rank and order, never a silent misfire", async () => {
    // MULTI_ACADEMY_AND_KIDS_BELTS.md Phase 2c-ii amendment: isTerminal and
    // "a rank exists at order+1" are two independently edited facts kept
    // aligned only by validateTrackConfig at config-update time, not a
    // database constraint. This scratch org's single rank is deliberately
    // misconfigured — isTerminal: false with nothing at order+1 — to prove
    // that gap is caught loudly rather than crashing on a null dereference
    // or silently writing a wrong promotion.
    const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
    const orgId = `promotion-catalog-gap-org-${suffix}`;
    const academyId = `promotion-catalog-gap-academy-${suffix}`;
    const rankId = `promotion-catalog-gap-rank-${suffix}`;

    await prisma.organization.create({ data: { id: orgId, slug: orgId, name: "Catalog Gap Test Org", status: "ACTIVE" } });
    await prisma.academy.create({
      data: { id: academyId, organizationId: orgId, name: "Catalog Gap Test Academy", slug: academyId, kioskTokenHash: `${academyId}-hash` },
    });
    await prisma.beltRank.create({
      data: {
        id: rankId,
        organizationId: orgId,
        track: "ADULT",
        code: "WHITE",
        labelEs: "Blanco",
        labelEn: "White",
        primaryColor: "#F0EBE0",
        barColor: "#111116",
        order: 1,
        maxStripes: 4,
        isTerminal: false, // the misconfiguration: no rank exists at order 2 either.
        attendancesPerStripe: 30,
        attendancesForExam: 30,
        stripeColors: ["a", "b", "c", "d"],
      },
    });
    await prisma.promotionConfig.create({ data: { organizationId: orgId, track: "ADULT", mode: "ATTENDANCE", requiresCoachApproval: true } });

    const admin = await makeStaffUser("ADMIN", "confirm-gap-admin", academyId);
    const beltAwardedAt = new Date("2026-08-15T12:00:00Z");
    const student = await prisma.student.create({
      data: {
        homeAcademyId: academyId,
        organizationId: orgId,
        firstName: "CatalogGapTest",
        lastName: `Student-${suffix}`,
        phone: "88880000",
        email: `catalog-gap-${suffix}@example.com`,
        currentRankId: rankId,
        currentStripes: 4, // at maxStripes -> engine reports BELT (isTerminal false -> hasNextRank true).
        beltAwardedAt,
        status: "ACTIVE",
        codeHash: digestLookupSecret(`catalog-gap-${suffix}`, pepper),
      },
    });
    cleanupStudentIds.push(student.id);
    // 4 stripes * 30 + 30 attendancesForExam = 150, exactly at the exam threshold.
    await addAttendances(student.id, academyId, orgId, 150, new Date(beltAwardedAt.getTime() + DAY_MS));

    try {
      currentSession = { user: { id: admin.id, role: "ADMIN" }, activeOrganizationId: orgId };
      const { InvalidPromotionConfigError } = await import("../../src/lib/promotion/engine");
      await expect(confirmPromotion(orgId, {}, formData({ studentId: student.id }))).rejects.toThrow(
        InvalidPromotionConfigError,
      );
      await expect(confirmPromotion(orgId, {}, formData({ studentId: student.id }))).rejects.toThrow(/WHITE/);

      // No partial write from the failed attempt.
      expect(await promotionsFor(student.id)).toHaveLength(0);
      const unchanged = await prisma.student.findUniqueOrThrow({ where: { id: student.id } });
      expect(unchanged.currentStripes).toBe(4);
    } finally {
      // Fully self-contained cleanup, in FK-safe order — this scratch org's
      // rows must all be gone before the Organization/Academy themselves
      // can be deleted, so this can't be deferred to the global
      // `afterAll(cleanup)` above (which runs later and isn't
      // organization-aware).
      await prisma.auditLog.deleteMany({ where: { OR: [{ entityId: student.id }, { organizationId: orgId }] } });
      await prisma.promotion.deleteMany({ where: { studentId: student.id } });
      await prisma.attendanceRecord.deleteMany({ where: { studentId: student.id } });
      await prisma.student.deleteMany({ where: { id: student.id } });
      await prisma.staffAssignment.deleteMany({ where: { organizationId: orgId } });
      await prisma.organizationMembership.deleteMany({ where: { organizationId: orgId } });
      await prisma.beltRank.deleteMany({ where: { organizationId: orgId } });
      await prisma.promotionConfig.deleteMany({ where: { organizationId: orgId } });
      await prisma.academy.deleteMany({ where: { id: academyId } });
      await prisma.user.deleteMany({ where: { id: admin.id } });
      await prisma.organization.deleteMany({ where: { id: orgId } });
    }
  });
});
