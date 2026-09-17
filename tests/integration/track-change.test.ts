import "dotenv/config";
import { getTestPrismaClient } from "../helpers/test-db";
import { afterAll, describe, expect, it, vi } from "vitest";
import { requireEnv } from "../../src/lib/env";
import { digestLookupSecret, hashSecret } from "../../src/lib/crypto";
import { adultRankId, kidsRankId } from "../helpers/belt-ranks";
import type { TenantContext } from "../../src/lib/tenant/types";

// `changeTrackAction` reaches `resolveActionContext()` -> `auth()`, which
// needs a real HTTP request's cookies to resolve a JWT session —
// unavailable in a plain integration test. Same mock as
// `promotion-correction.test.ts`'s established pattern.
let currentSession: { user: { id: string; role: string } | null; activeOrganizationId?: string } | null = null;

vi.mock("@/auth", () => ({
  auth: () => Promise.resolve(currentSession),
}));

const { changeTrack } = await import("../../src/lib/promotion/track-change");
const { changeTrackAction } = await import(
  "../../src/app/[locale]/(staff)/students/[id]/track-change-actions"
);

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
    data: { email: `${label}-${suffix}@example.com`, passwordHash: await hashSecret("irrelevant-password-123"), role },
  });
  cleanupUserIds.push(user.id);

  const organizationId = academyId
    ? (await prisma.academy.findUniqueOrThrow({ where: { id: academyId }, select: { organizationId: true } }))
        .organizationId
    : await getAllianceOrganizationId();

  await prisma.organizationMembership.create({ data: { userId: user.id, organizationId, role } });
  if (academyId && role !== "ADMIN") {
    await prisma.staffAssignment.create({
      data: { userId: user.id, academyId, organizationId, role: role === "DIRECTOR" ? "DIRECTOR" : "INSTRUCTOR" },
    });
  }
  return { ...user, organizationId };
}

function adminContext(admin: { id: string; organizationId: string }): TenantContext {
  return {
    kind: "tenant",
    actorUserId: admin.id,
    organizationId: admin.organizationId,
    organizationRole: "ADMIN",
    academyIds: "ALL",
    selfStudentId: null,
  };
}

async function makeKidsStudent(
  academyId: string,
  organizationId: string,
  overrides: { currentRankId: string; currentStripes: number; beltAwardedAt: Date; status?: "ACTIVE" | "ARCHIVED" },
) {
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
  const student = await prisma.student.create({
    data: {
      homeAcademyId: academyId,
      organizationId,
      track: "KIDS",
      firstName: "TrackChangeTest",
      lastName: `Student-${suffix}`,
      phone: "88880000",
      email: `track-change-${suffix}@example.com`,
      currentRankId: overrides.currentRankId,
      currentStripes: overrides.currentStripes,
      beltAwardedAt: overrides.beltAwardedAt,
      status: overrides.status ?? "ACTIVE",
      codeHash: digestLookupSecret(`track-change-${suffix}`, pepper),
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

function trackChangeAuditRowsFor(studentId: string) {
  return prisma.auditLog.findMany({ where: { entityId: studentId, action: "student.trackChange" }, orderBy: { createdAt: "asc" } });
}

describe("changeTrack", () => {
  afterAll(cleanup);

  it("moves a KIDS student at green_black to an explicitly chosen adult rank: flips track, writes a TRACK_CHANGE Promotion, sets beltAwardedAt to now, and audits under student.trackChange", async () => {
    const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
    const admin = await makeStaffUser("ADMIN", "trackchange-greenblack-admin");
    const oldBeltAwardedAt = new Date("2020-01-01T12:00:00Z");
    const student = await makeKidsStudent(escazu.id, escazu.organizationId, {
      currentRankId: kidsRankId("green_black"),
      currentStripes: 4,
      beltAwardedAt: oldBeltAwardedAt,
    });

    const before = Date.now();
    const result = await changeTrack(adminContext(admin), {
      studentId: student.id,
      toRankId: adultRankId("BLUE"),
      toStripes: 0,
      note: "turned 16, moving to the adult track",
    });
    expect(result).toEqual({ ok: true });

    const after = await prisma.student.findUniqueOrThrow({
      where: { id: student.id },
      include: { currentRank: { select: { code: true } } },
    });
    expect(after.track).toBe("ADULT");
    expect(after.currentRank.code).toBe("BLUE");
    expect(after.currentStripes).toBe(0);
    // A track change is a belt award — the anchor resets to now, not the
    // old kids-belt anchor (MULTI_ACADEMY_AND_KIDS_BELTS.md: "Alliance
    // counts promotion-relevant attendance since Student.beltAwardedAt").
    expect(after.beltAwardedAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(after.beltAwardedAt.getTime()).not.toBe(oldBeltAwardedAt.getTime());

    const promotions = await promotionsFor(student.id);
    expect(promotions).toHaveLength(1);
    expect(promotions[0]).toMatchObject({
      fromRank: { code: "green_black" },
      fromStripes: 4,
      toRank: { code: "BLUE" },
      toStripes: 0,
      source: "TRACK_CHANGE",
      awardedById: admin.id,
      notes: "turned 16, moving to the adult track",
    });

    const audits = await trackChangeAuditRowsFor(student.id);
    expect(audits).toHaveLength(1);
    expect(audits[0].before).toMatchObject({ belt: "green_black", track: "KIDS" });
    expect(audits[0].after).toMatchObject({ belt: "BLUE", track: "ADULT" });
  });

  it("rejects a destination rank that belongs to the student's CURRENT track (not the other one) with invalidTarget", async () => {
    const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
    const admin = await makeStaffUser("ADMIN", "trackchange-sametrack-admin");
    const student = await makeKidsStudent(escazu.id, escazu.organizationId, {
      currentRankId: kidsRankId("orange"),
      currentStripes: 1,
      beltAwardedAt: new Date("2026-01-01T12:00:00Z"),
    });

    const result = await changeTrack(adminContext(admin), {
      studentId: student.id,
      toRankId: kidsRankId("green"), // still KIDS — not the other track
      toStripes: 0,
      note: "wrong track submitted",
    });
    expect(result).toEqual({ ok: false, error: "invalidTarget" });
    expect(await promotionsFor(student.id)).toHaveLength(0);
  });

  it("rejects toStripes beyond the destination rank's maxStripes with invalidTarget, mutating nothing", async () => {
    const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
    const admin = await makeStaffUser("ADMIN", "trackchange-overstripe-admin");
    const student = await makeKidsStudent(escazu.id, escazu.organizationId, {
      currentRankId: kidsRankId("green_black"),
      currentStripes: 0,
      beltAwardedAt: new Date("2026-01-02T12:00:00Z"),
    });

    // Adult BLUE's seeded maxStripes is 4 — 5 is one past it.
    const result = await changeTrack(adminContext(admin), {
      studentId: student.id,
      toRankId: adultRankId("BLUE"),
      toStripes: 5,
      note: "over the cap",
    });
    expect(result).toEqual({ ok: false, error: "invalidTarget" });
    expect(await promotionsFor(student.id)).toHaveLength(0);
  });

  it("rejects a non-ACTIVE student with notActive, mutating nothing", async () => {
    const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
    const admin = await makeStaffUser("ADMIN", "trackchange-archived-admin");
    const student = await makeKidsStudent(escazu.id, escazu.organizationId, {
      currentRankId: kidsRankId("green_black"),
      currentStripes: 0,
      beltAwardedAt: new Date("2026-01-03T12:00:00Z"),
      status: "ARCHIVED",
    });

    const result = await changeTrack(adminContext(admin), {
      studentId: student.id,
      toRankId: adultRankId("BLUE"),
      toStripes: 0,
      note: "student has left",
    });
    expect(result).toEqual({ ok: false, error: "notActive" });
    expect(await promotionsFor(student.id)).toHaveLength(0);
  });

  it("rejects a student outside the caller's academy scope with notFound, mutating nothing", async () => {
    const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
    const escalante = await prisma.academy.findUniqueOrThrow({ where: { slug: "escalante" } });
    const outOfScopeDirector = await makeStaffUser("DIRECTOR", "trackchange-scope-director", escalante.id);
    const student = await makeKidsStudent(escazu.id, escazu.organizationId, {
      currentRankId: kidsRankId("green_black"),
      currentStripes: 0,
      beltAwardedAt: new Date("2026-01-04T12:00:00Z"),
    });

    const scopedContext: TenantContext = {
      kind: "tenant",
      actorUserId: outOfScopeDirector.id,
      organizationId: outOfScopeDirector.organizationId,
      organizationRole: "DIRECTOR",
      academyIds: [escalante.id],
      selfStudentId: null,
    };
    const result = await changeTrack(scopedContext, {
      studentId: student.id,
      toRankId: adultRankId("BLUE"),
      toStripes: 0,
      note: "shouldn't reach this student",
    });
    expect(result).toEqual({ ok: false, error: "notFound" });
    expect(await promotionsFor(student.id)).toHaveLength(0);
  });

  it("allows a null note (unlike correctPromotion — a track change is a normal lifecycle event, not a fixed mistake)", async () => {
    const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
    const admin = await makeStaffUser("ADMIN", "trackchange-nonote-admin");
    const student = await makeKidsStudent(escazu.id, escazu.organizationId, {
      currentRankId: kidsRankId("green_black"),
      currentStripes: 0,
      beltAwardedAt: new Date("2026-01-05T12:00:00Z"),
    });

    const result = await changeTrack(adminContext(admin), {
      studentId: student.id,
      toRankId: adultRankId("BLUE"),
      toStripes: 0,
      note: null,
    });
    expect(result).toEqual({ ok: true });
    expect((await promotionsFor(student.id))[0].notes).toBeNull();
  });
});

describe("changeTrackAction (student-detail-page entry point)", () => {
  afterAll(cleanup);

  it("rejects an INSTRUCTOR session (role gate), mutating nothing", async () => {
    const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
    const instructor = await makeStaffUser("INSTRUCTOR", "trackchange-action-instructor", escazu.id);
    const student = await makeKidsStudent(escazu.id, escazu.organizationId, {
      currentRankId: kidsRankId("green_black"),
      currentStripes: 0,
      beltAwardedAt: new Date("2026-01-06T12:00:00Z"),
    });

    currentSession = { user: { id: instructor.id, role: "INSTRUCTOR" }, activeOrganizationId: instructor.organizationId };
    await expect(
      changeTrackAction(
        instructor.organizationId,
        {},
        formData({ studentId: student.id, toRankId: adultRankId("BLUE"), toStripes: "0" }),
      ),
    ).rejects.toThrow("FORBIDDEN");

    expect(await promotionsFor(student.id)).toHaveLength(0);
  });

  it("an ADMIN session delegates to the shared changeTrack — writes a TRACK_CHANGE Promotion row", async () => {
    const escazu = await prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
    const admin = await makeStaffUser("ADMIN", "trackchange-action-admin");
    const student = await makeKidsStudent(escazu.id, escazu.organizationId, {
      currentRankId: kidsRankId("green_black"),
      currentStripes: 2,
      beltAwardedAt: new Date("2026-01-07T12:00:00Z"),
    });

    currentSession = { user: { id: admin.id, role: "ADMIN" }, activeOrganizationId: admin.organizationId };
    const result = await changeTrackAction(
      admin.organizationId,
      {},
      formData({ studentId: student.id, toRankId: adultRankId("BLUE"), toStripes: "0", note: "action-layer track change" }),
    );
    expect(result.ok).toBe(true);

    const after = await prisma.student.findUniqueOrThrow({
      where: { id: student.id },
      include: { currentRank: { select: { code: true } } },
    });
    expect(after.track).toBe("ADULT");
    expect(after.currentRank.code).toBe("BLUE");

    const promotions = await promotionsFor(student.id);
    expect(promotions).toHaveLength(1);
    expect(promotions[0]).toMatchObject({ source: "TRACK_CHANGE", notes: "action-layer track change", awardedById: admin.id });
  });
});
