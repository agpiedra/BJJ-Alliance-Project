import "dotenv/config";
import { getTestPrismaClient } from "../helpers/test-db";
import { afterAll, describe, expect, it, vi } from "vitest";
import { requireEnv } from "../../src/lib/env";
import { digestLookupSecret, hashSecret } from "../../src/lib/crypto";
import { toAttendanceDate } from "../../src/lib/scheduling/zone";
import { adultRankId, type BeltCode } from "../helpers/belt-ranks";
import type { TenantContext } from "../../src/lib/tenant/types";

// `correctPromotionAction`/`awardFromStudentPage` reach
// `resolveActionContext()` -> `auth()`, which needs a real HTTP request's
// cookies to resolve a JWT session — unavailable in a plain integration
// test. Same mock as `promotion-actions.test.ts`'s established pattern.
let currentSession: { user: { id: string; role: string } | null; activeOrganizationId?: string } | null = null;

vi.mock("@/auth", () => ({
  auth: () => Promise.resolve(currentSession),
}));

const { correctPromotion } = await import("../../src/lib/promotion/correction");
const { awardFromStudentPage, correctPromotionAction } = await import(
  "../../src/app/[locale]/(staff)/students/[id]/promotion-actions"
);
const { confirmPromotion } = await import("../../src/app/[locale]/(staff)/dashboard/promotion-actions");

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
  }
  if (cleanupStudentIds.length > 0) {
    await prisma.attendanceRecord.deleteMany({ where: { studentId: { in: cleanupStudentIds } } });
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

/** Builds a `TenantContext` directly for `correctPromotion`'s (library-level) tests — the same shape `context.ts`'s `resolveContext` would produce for an ADMIN, without a real session round trip. */
function adminContext(admin: { id: string; organizationId: string }): TenantContext {
  return {
    kind: "tenant",
    actorUserId: admin.id,
    organizationId: admin.organizationId,
    organizationRole: "ADMIN",
    academyIds: "ALL",
    selfStudentId: null, linkedStudentId: null,
  };
}

async function makeStudent(
  academyId: string,
  organizationId: string,
  overrides: {
    currentBelt: BeltCode;
    currentStripes: number;
    beltAwardedAt: Date;
    timeAnchorAt?: Date | null;
    status?: "PENDING" | "ACTIVE" | "INACTIVE" | "ARCHIVED";
  },
) {
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
  const student = await prisma.student.create({
    data: {
      homeAcademyId: academyId,
      organizationId,
      firstName: "PromotionCorrectionTest",
      lastName: `Student-${suffix}`,
      phone: "88880000",
      email: `promotion-correction-${suffix}@example.com`,
      currentRankId: adultRankId(overrides.currentBelt),
      currentStripes: overrides.currentStripes,
      beltAwardedAt: overrides.beltAwardedAt,
      timeAnchorAt: overrides.timeAnchorAt ?? null,
      status: overrides.status ?? "ACTIVE",
      codeHash: digestLookupSecret(`promotion-correction-${suffix}`, pepper),
    },
  });
  cleanupStudentIds.push(student.id);
  return student;
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

describe("correctPromotion", () => {
  afterAll(cleanup);

  it("writes the exact before/after belt+stripes, a Promotion row with source CORRECTION and the note, and APPENDS to history rather than replacing the prior promotion", async () => {
    const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
    const admin = await makeStaffUser("ADMIN", "correction-append-admin");
    const beltAwardedAt = new Date("2026-01-01T12:00:00Z");
    const student = await makeStudent(escazu.id, escazu.organizationId, {
      currentBelt: "WHITE",
      currentStripes: 2,
      beltAwardedAt,
    });

    // A genuine prior promotion already in history — proves the correction
    // is appended, not a replacement of the only row.
    const context = adminContext(admin);
    const firstCorrection = await correctPromotion(context, {
      studentId: student.id,
      toRankId: adultRankId("WHITE"),
      toStripes: 1,
      note: "earlier stripe correction",
    });
    expect(firstCorrection.ok).toBe(true);

    // The actual case under test: fixing a wrongly-awarded belt back down
    // from BLUE to WHITE/3, with an explicit note.
    const result = await correctPromotion(context, {
      studentId: student.id,
      toRankId: adultRankId("WHITE"),
      toStripes: 3,
      note: "reverted a mistaken belt promotion",
    });
    expect(result.ok).toBe(true);

    const after = await prisma.student.findUniqueOrThrow({
      where: { id: student.id },
      include: { currentRank: { select: { code: true } } },
    });
    expect(after.currentRank.code).toBe("WHITE");
    expect(after.currentStripes).toBe(3);

    const promotions = await promotionsFor(student.id);
    // Appended, not replaced: both the seed correction and this one exist.
    expect(promotions).toHaveLength(2);
    expect(promotions[0]).toMatchObject({ fromStripes: 2, toStripes: 1, source: "CORRECTION" });
    const secondPromotion = promotions[1];
    expect(secondPromotion).toMatchObject({
      academyId: escazu.id,
      fromRank: { code: "WHITE" },
      fromStripes: 1,
      toRank: { code: "WHITE" },
      toStripes: 3,
      source: "CORRECTION",
      awardedById: admin.id,
      notes: "reverted a mistaken belt promotion",
    });

    const audits = await auditRowsFor(student.id, "student.promote");
    expect(audits).toHaveLength(2);
    expect(audits[1].before).toMatchObject({ belt: "WHITE", stripes: 1 });
    expect(audits[1].after).toMatchObject({ belt: "WHITE", stripes: 3 });
  });

  it("rejects a blank note with noteRequired, writing no Promotion row and leaving the student unchanged", async () => {
    const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
    const admin = await makeStaffUser("ADMIN", "correction-noteless-admin");
    const student = await makeStudent(escazu.id, escazu.organizationId, {
      currentBelt: "WHITE",
      currentStripes: 1,
      beltAwardedAt: new Date("2026-01-02T12:00:00Z"),
    });

    const result = await correctPromotion(adminContext(admin), {
      studentId: student.id,
      toRankId: adultRankId("BLUE"),
      toStripes: 0,
      note: "   ",
    });
    expect(result).toEqual({ ok: false, error: "noteRequired" });

    const after = await prisma.student.findUniqueOrThrow({ where: { id: student.id } });
    expect(after.currentStripes).toBe(1);
    expect(await promotionsFor(student.id)).toHaveLength(0);
  });

  it("rejects a target rank that doesn't exist with invalidTarget, mutating nothing", async () => {
    const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
    const admin = await makeStaffUser("ADMIN", "correction-badrank-admin");
    const student = await makeStudent(escazu.id, escazu.organizationId, {
      currentBelt: "WHITE",
      currentStripes: 1,
      beltAwardedAt: new Date("2026-01-03T12:00:00Z"),
    });

    const result = await correctPromotion(adminContext(admin), {
      studentId: student.id,
      toRankId: "not-a-real-rank-id",
      toStripes: 0,
      note: "typo'd rank id",
    });
    expect(result).toEqual({ ok: false, error: "invalidTarget" });
    expect(await promotionsFor(student.id)).toHaveLength(0);
  });

  it("rejects toStripes beyond the target rank's maxStripes with invalidTarget, mutating nothing", async () => {
    const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
    const admin = await makeStaffUser("ADMIN", "correction-overstripe-admin");
    const student = await makeStudent(escazu.id, escazu.organizationId, {
      currentBelt: "WHITE",
      currentStripes: 1,
      beltAwardedAt: new Date("2026-01-04T12:00:00Z"),
    });

    // WHITE's seeded maxStripes is 4 (prisma/seed.ts) — 5 is one past it.
    const result = await correctPromotion(adminContext(admin), {
      studentId: student.id,
      toRankId: adultRankId("WHITE"),
      toStripes: 5,
      note: "over the cap",
    });
    expect(result).toEqual({ ok: false, error: "invalidTarget" });
    expect(await promotionsFor(student.id)).toHaveLength(0);
  });

  it("rejects a student outside the caller's academy scope with notFound, mutating nothing", async () => {
    const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
    const escalante = await prisma.academy.findUniqueOrThrow({ where: { slug: "escalante" } });
    const outOfScopeDirector = await makeStaffUser("DIRECTOR", "correction-scope-director", escalante.id);
    const student = await makeStudent(escazu.id, escazu.organizationId, {
      currentBelt: "WHITE",
      currentStripes: 1,
      beltAwardedAt: new Date("2026-01-05T12:00:00Z"),
    });

    const scopedContext: TenantContext = {
      kind: "tenant",
      actorUserId: outOfScopeDirector.id,
      organizationId: outOfScopeDirector.organizationId,
      organizationRole: "DIRECTOR",
      academyIds: [escalante.id],
      selfStudentId: null, linkedStudentId: null,
    };
    const result = await correctPromotion(scopedContext, {
      studentId: student.id,
      toRankId: adultRankId("BLUE"),
      toStripes: 0,
      note: "shouldn't reach this student",
    });
    expect(result).toEqual({ ok: false, error: "notFound" });
    expect(await promotionsFor(student.id)).toHaveLength(0);
  });

  it("rejects a non-ACTIVE student with notActive, mutating nothing", async () => {
    const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
    const admin = await makeStaffUser("ADMIN", "correction-archived-admin");
    const student = await makeStudent(escazu.id, escazu.organizationId, {
      currentBelt: "WHITE",
      currentStripes: 1,
      beltAwardedAt: new Date("2026-01-06T12:00:00Z"),
      status: "ARCHIVED",
    });

    const result = await correctPromotion(adminContext(admin), {
      studentId: student.id,
      toRankId: adultRankId("BLUE"),
      toStripes: 0,
      note: "student has left",
    });
    expect(result).toEqual({ ok: false, error: "notActive" });
    expect(await promotionsFor(student.id)).toHaveLength(0);
  });

  it('writes explicit beltAwardedAt/timeAnchorAt anchors when provided, and leaves both untouched when omitted — never silently inferred as "now"', async () => {
    const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
    const admin = await makeStaffUser("ADMIN", "correction-anchor-admin");
    const originalBeltAwardedAt = new Date("2026-01-07T12:00:00Z");
    const originalTimeAnchorAt = new Date("2026-01-08T12:00:00Z");
    const student = await makeStudent(escazu.id, escazu.organizationId, {
      currentBelt: "WHITE",
      currentStripes: 1,
      beltAwardedAt: originalBeltAwardedAt,
      timeAnchorAt: originalTimeAnchorAt,
    });
    const context = adminContext(admin);

    // Omitted anchors: a plain stripe fix leaves both dates exactly as they were.
    const omitted = await correctPromotion(context, {
      studentId: student.id,
      toRankId: adultRankId("WHITE"),
      toStripes: 2,
      note: "stripe-only fix, anchors untouched",
    });
    expect(omitted.ok).toBe(true);
    const afterOmitted = await prisma.student.findUniqueOrThrow({ where: { id: student.id } });
    expect(afterOmitted.beltAwardedAt.getTime()).toBe(originalBeltAwardedAt.getTime());
    expect(afterOmitted.timeAnchorAt?.getTime()).toBe(originalTimeAnchorAt.getTime());

    // Explicit anchors: both provided values are written verbatim.
    const newBeltAwardedAt = new Date("2026-02-01T12:00:00Z");
    const newTimeAnchorAt = new Date("2026-02-02T12:00:00Z");
    const explicit = await correctPromotion(context, {
      studentId: student.id,
      toRankId: adultRankId("BLUE"),
      toStripes: 0,
      beltAwardedAt: newBeltAwardedAt,
      timeAnchorAt: newTimeAnchorAt,
      note: "explicit anchor override",
    });
    expect(explicit.ok).toBe(true);
    const afterExplicit = await prisma.student.findUniqueOrThrow({ where: { id: student.id } });
    expect(afterExplicit.beltAwardedAt.getTime()).toBe(newBeltAwardedAt.getTime());
    expect(afterExplicit.timeAnchorAt?.getTime()).toBe(newTimeAnchorAt.getTime());

    // Explicit `null`: clears timeAnchorAt rather than leaving it alone.
    const cleared = await correctPromotion(context, {
      studentId: student.id,
      toRankId: adultRankId("BLUE"),
      toStripes: 1,
      timeAnchorAt: null,
      note: "clearing the time anchor",
    });
    expect(cleared.ok).toBe(true);
    const afterCleared = await prisma.student.findUniqueOrThrow({ where: { id: student.id } });
    expect(afterCleared.timeAnchorAt).toBeNull();
    // beltAwardedAt wasn't named in this call — still the value from the previous step.
    expect(afterCleared.beltAwardedAt.getTime()).toBe(newBeltAwardedAt.getTime());
  });

  it("two genuinely concurrent corrections for the same student produce exactly one success and one graceful conflict", async () => {
    const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
    const admin = await makeStaffUser("ADMIN", "correction-concurrent-admin");
    const student = await makeStudent(escazu.id, escazu.organizationId, {
      currentBelt: "WHITE",
      currentStripes: 1,
      beltAwardedAt: new Date("2026-01-09T12:00:00Z"),
    });
    const context = adminContext(admin);

    const [r1, r2] = await Promise.all([
      correctPromotion(context, { studentId: student.id, toRankId: adultRankId("WHITE"), toStripes: 2, note: "race A" }),
      correctPromotion(context, { studentId: student.id, toRankId: adultRankId("WHITE"), toStripes: 3, note: "race B" }),
    ]);
    const results = [r1, r2];
    expect(results.filter((r) => r.ok).length).toBe(1);
    expect(results.filter((r) => !r.ok && r.error === "conflict").length).toBe(1);

    // Exactly one of the two targets landed — never both, never neither.
    const after = await prisma.student.findUniqueOrThrow({ where: { id: student.id } });
    expect([2, 3]).toContain(after.currentStripes);
    expect(await promotionsFor(student.id)).toHaveLength(1);
  });
});

describe("awardFromStudentPage / correctPromotionAction (student-detail-page entry points)", () => {
  afterAll(cleanup);

  it("awardFromStudentPage rejects an INSTRUCTOR session (role gate), mutating nothing", async () => {
    const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
    const instructor = await makeStaffUser("INSTRUCTOR", "student-page-award-instructor", escazu.id);
    const student = await makeStudent(escazu.id, escazu.organizationId, {
      currentBelt: "WHITE",
      currentStripes: 0,
      beltAwardedAt: new Date("2026-01-10T12:00:00Z"),
    });

    currentSession = { user: { id: instructor.id, role: "INSTRUCTOR" }, activeOrganizationId: instructor.organizationId };
    await expect(
      awardFromStudentPage(instructor.organizationId, {}, formData({ studentId: student.id })),
    ).rejects.toThrow("FORBIDDEN");

    expect(await promotionsFor(student.id)).toHaveLength(0);
  });

  it("correctPromotionAction rejects an INSTRUCTOR session (role gate), mutating nothing — spec: manual promote/correct is ADMIN/DIRECTOR only", async () => {
    const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
    const instructor = await makeStaffUser("INSTRUCTOR", "student-page-correct-instructor", escazu.id);
    const student = await makeStudent(escazu.id, escazu.organizationId, {
      currentBelt: "WHITE",
      currentStripes: 1,
      beltAwardedAt: new Date("2026-01-11T12:00:00Z"),
    });

    currentSession = { user: { id: instructor.id, role: "INSTRUCTOR" }, activeOrganizationId: instructor.organizationId };
    await expect(
      correctPromotionAction(
        instructor.organizationId,
        {},
        formData({ studentId: student.id, toRankId: adultRankId("BLUE"), toStripes: "0", note: "instructor shouldn't reach this" }),
      ),
    ).rejects.toThrow("FORBIDDEN");

    const after = await prisma.student.findUniqueOrThrow({ where: { id: student.id } });
    expect(after.currentStripes).toBe(1);
    expect(await promotionsFor(student.id)).toHaveLength(0);
  });

  it("correctPromotionAction: an ADMIN session delegates to the shared correctPromotion — writes a CORRECTION Promotion row with the submitted note", async () => {
    const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
    const admin = await makeStaffUser("ADMIN", "student-page-correct-admin");
    const student = await makeStudent(escazu.id, escazu.organizationId, {
      currentBelt: "WHITE",
      currentStripes: 1,
      beltAwardedAt: new Date("2026-01-12T12:00:00Z"),
    });

    currentSession = { user: { id: admin.id, role: "ADMIN" }, activeOrganizationId: admin.organizationId };
    const result = await correctPromotionAction(
      admin.organizationId,
      {},
      formData({ studentId: student.id, toRankId: adultRankId("BLUE"), toStripes: "0", note: "action-layer correction" }),
    );
    expect(result.ok).toBe(true);

    const after = await prisma.student.findUniqueOrThrow({
      where: { id: student.id },
      include: { currentRank: { select: { code: true } } },
    });
    expect(after.currentRank.code).toBe("BLUE");
    expect(after.currentStripes).toBe(0);

    const promotions = await promotionsFor(student.id);
    expect(promotions).toHaveLength(1);
    expect(promotions[0]).toMatchObject({ source: "CORRECTION", notes: "action-layer correction", awardedById: admin.id });
  });

  it("correctPromotionAction: a whitespace-only note passes zod's min-length check but is still rejected by correctPromotion's own noteRequired guard", async () => {
    const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
    const admin = await makeStaffUser("ADMIN", "student-page-correct-blanknote-admin");
    const student = await makeStudent(escazu.id, escazu.organizationId, {
      currentBelt: "WHITE",
      currentStripes: 1,
      beltAwardedAt: new Date("2026-01-13T12:00:00Z"),
    });

    currentSession = { user: { id: admin.id, role: "ADMIN" }, activeOrganizationId: admin.organizationId };
    const result = await correctPromotionAction(
      admin.organizationId,
      {},
      formData({ studentId: student.id, toRankId: adultRankId("BLUE"), toStripes: "0", note: "   " }),
    );
    expect(result.error).toBe("noteRequired");

    const after = await prisma.student.findUniqueOrThrow({ where: { id: student.id } });
    expect(after.currentStripes).toBe(1);
    expect(await promotionsFor(student.id)).toHaveLength(0);
  });

  it("awardFromStudentPage: an ADMIN session delegates to the shared awardPromotion — same Promotion shape (source MANUAL) as the dashboard queue's confirmPromotion", async () => {
    const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
    const admin = await makeStaffUser("ADMIN", "student-page-award-admin");
    const beltAwardedAt = new Date("2026-01-14T12:00:00Z");
    const student = await makeStudent(escazu.id, escazu.organizationId, {
      currentBelt: "WHITE",
      currentStripes: 0,
      beltAwardedAt,
    });
    // WHITE's attendancesPerStripe is 30 (prisma/seed.ts) — exactly at threshold.
    const DAY_MS = 24 * 60 * 60 * 1000;
    await prisma.attendanceRecord.createMany({
      data: Array.from({ length: 30 }, (_, i) => {
        const occurredAt = new Date(beltAwardedAt.getTime() + (i + 1) * DAY_MS);
        return {
          studentId: student.id,
          academyId: escazu.id,
          organizationId: escazu.organizationId,
          occurredAt,
          date: toAttendanceDate(occurredAt),
          type: "CHECKIN" as const,
          delta: 1,
          source: "STAFF" as const,
        };
      }),
    });

    currentSession = { user: { id: admin.id, role: "ADMIN" }, activeOrganizationId: admin.organizationId };
    const result = await awardFromStudentPage(admin.organizationId, {}, formData({ studentId: student.id }));
    expect(result.ok).toBe(true);

    const promotions = await promotionsFor(student.id);
    expect(promotions).toHaveLength(1);
    expect(promotions[0]).toMatchObject({
      fromRank: { code: "WHITE" },
      fromStripes: 0,
      toRank: { code: "WHITE" },
      toStripes: 1,
      source: "MANUAL",
      awardedById: admin.id,
    });
  });

  it("acceptance criterion: awarding the same student from the queue (confirmPromotion) and the card (awardFromStudentPage) at the same moment produces exactly one promotion — the loser reports conflict, not a generic error", async () => {
    const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
    const admin = await makeStaffUser("ADMIN", "cross-entrypoint-race-admin");
    const beltAwardedAt = new Date("2026-01-15T12:00:00Z");
    const student = await makeStudent(escazu.id, escazu.organizationId, {
      currentBelt: "WHITE",
      currentStripes: 0,
      beltAwardedAt,
    });
    const DAY_MS = 24 * 60 * 60 * 1000;
    await prisma.attendanceRecord.createMany({
      data: Array.from({ length: 30 }, (_, i) => {
        const occurredAt = new Date(beltAwardedAt.getTime() + (i + 1) * DAY_MS);
        return {
          studentId: student.id,
          academyId: escazu.id,
          organizationId: escazu.organizationId,
          occurredAt,
          date: toAttendanceDate(occurredAt),
          type: "CHECKIN" as const,
          delta: 1,
          source: "STAFF" as const,
        };
      }),
    });

    currentSession = { user: { id: admin.id, role: "ADMIN" }, activeOrganizationId: admin.organizationId };
    // Two different entry points, same underlying `awardPromotion` — no
    // artificial delay, same Postgres row-locking guarantee the
    // queue-vs-queue and correction-vs-correction races above rely on.
    const [queueResult, cardResult] = await Promise.all([
      confirmPromotion(admin.organizationId, {}, formData({ studentId: student.id, notes: "from the queue" })),
      awardFromStudentPage(admin.organizationId, {}, formData({ studentId: student.id })),
    ]);
    const results = [queueResult, cardResult];
    expect(results.filter((r) => r.ok).length).toBe(1);
    expect(results.filter((r) => !r.ok && r.error === "conflict").length).toBe(1);

    const after = await prisma.student.findUniqueOrThrow({ where: { id: student.id } });
    expect(after.currentStripes).toBe(1);
    expect(await promotionsFor(student.id)).toHaveLength(1);
  });

  it("acceptance criterion: double-clicking the award button (two rapid awardFromStudentPage calls) produces one promotion", async () => {
    const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
    const admin = await makeStaffUser("ADMIN", "doubleclick-award-admin");
    const beltAwardedAt = new Date("2026-01-16T12:00:00Z");
    const student = await makeStudent(escazu.id, escazu.organizationId, {
      currentBelt: "WHITE",
      currentStripes: 0,
      beltAwardedAt,
    });
    const DAY_MS = 24 * 60 * 60 * 1000;
    await prisma.attendanceRecord.createMany({
      data: Array.from({ length: 30 }, (_, i) => {
        const occurredAt = new Date(beltAwardedAt.getTime() + (i + 1) * DAY_MS);
        return {
          studentId: student.id,
          academyId: escazu.id,
          organizationId: escazu.organizationId,
          occurredAt,
          date: toAttendanceDate(occurredAt),
          type: "CHECKIN" as const,
          delta: 1,
          source: "STAFF" as const,
        };
      }),
    });

    currentSession = { user: { id: admin.id, role: "ADMIN" }, activeOrganizationId: admin.organizationId };
    const [r1, r2] = await Promise.all([
      awardFromStudentPage(admin.organizationId, {}, formData({ studentId: student.id })),
      awardFromStudentPage(admin.organizationId, {}, formData({ studentId: student.id })),
    ]);
    const results = [r1, r2];
    expect(results.filter((r) => r.ok).length).toBe(1);
    expect(results.filter((r) => !r.ok && r.error === "conflict").length).toBe(1);

    expect(await promotionsFor(student.id)).toHaveLength(1);
    const after = await prisma.student.findUniqueOrThrow({ where: { id: student.id } });
    expect(after.currentStripes).toBe(1);
  });
});
