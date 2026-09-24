import "dotenv/config";
import { getTestPrismaClient } from "../helpers/test-db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { makeAccountingOrg } from "../helpers/accounting-org";
import { requireEnv } from "../../src/lib/env";
import { digestLookupSecret, hashSecret } from "../../src/lib/crypto";
import { adultRankId } from "../helpers/belt-ranks";
import { ALLIANCE_ATTENDANCE_CONFIG, ALLIANCE_PER_INTERVAL_CONFIG } from "../helpers/promotion-config";

let currentSession: { user: { id: string; role: string } | null; activeOrganizationId?: string } | null = null;
vi.mock("@/auth", () => ({ auth: () => Promise.resolve(currentSession) }));

const { voidAttendanceEntry } = await import("../../src/app/[locale]/(staff)/students/[id]/attendance-void-actions");
const { addAttendanceAdjustment } = await import("../../src/app/[locale]/(staff)/students/[id]/adjustment-actions");
const { getAtBeltSummary } = await import("../../src/lib/students/attendance-summary");
const { getAttendanceHistory } = await import("../../src/lib/students/attendance-history");

/**
 * "No arbitrary credit" never meant "a mistaken entry cannot be corrected"
 * (docs/PROMOTION_PROGRESS_PROPOSAL.md). An ADMIN/DIRECTOR can void ONE entry with a reason: the row stays in
 * the history (never deleted, no number to type), the day's contribution is recomputed from the remaining valid
 * rows, and no promotion is ever revoked by it.
 */
const prisma = getTestPrismaClient();
const pepper = requireEnv("CODE_PEPPER");

const cleanupUserIds: string[] = [];
const cleanupStudentIds: string[] = [];

afterAll(async () => {
  await prisma.auditLog.deleteMany({ where: { OR: [{ actorId: { in: cleanupUserIds } }, { entityId: { in: cleanupStudentIds } }] } });
  await prisma.promotion.deleteMany({ where: { studentId: { in: cleanupStudentIds } } });
  await prisma.attendanceRecord.deleteMany({ where: { studentId: { in: cleanupStudentIds } } });
  await prisma.student.deleteMany({ where: { id: { in: cleanupStudentIds } } });
  await prisma.organizationMembership.deleteMany({ where: { userId: { in: cleanupUserIds } } });
  await prisma.staffAssignment.deleteMany({ where: { userId: { in: cleanupUserIds } } });
  await prisma.user.deleteMany({ where: { id: { in: cleanupUserIds } } });
});

let orgIdPromise: Promise<string> | null = null;
const allianceOrgId = () => (orgIdPromise ??= prisma.organization.findUniqueOrThrow({ where: { slug: "alliance-cr" } }).then((o) => o.id));

async function makeStaff(role: "ADMIN" | "DIRECTOR" | "INSTRUCTOR", label: string, academyId?: string) {
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
  const user = await prisma.user.create({ data: { email: `${label}-${suffix}@example.com`, passwordHash: await hashSecret("irrelevant-password-123"), role } });
  cleanupUserIds.push(user.id);
  const organizationId = academyId
    ? (await prisma.academy.findUniqueOrThrow({ where: { id: academyId }, select: { organizationId: true } })).organizationId
    : await allianceOrgId();
  await prisma.organizationMembership.create({ data: { userId: user.id, organizationId, role } });
  if (academyId && role !== "ADMIN") {
    await prisma.staffAssignment.create({ data: { userId: user.id, academyId, organizationId, role: role === "DIRECTOR" ? "DIRECTOR" : "INSTRUCTOR" } });
  }
  currentSession = { user: { id: user.id, role }, activeOrganizationId: organizationId };
  return { ...user, organizationId };
}

async function makeStudent(academyId: string, organizationId: string, opts: { baseline?: Date; kind?: "AWARD" | "SYSTEM_BASELINE"; stripes?: number } = {}) {
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
  const student = await prisma.student.create({
    data: {
      homeAcademyId: academyId, organizationId, firstName: "VoidTest", lastName: "Student", phone: "88880011",
      email: `void-test-${suffix}@example.com`, status: "ACTIVE", currentRankId: adultRankId("WHITE"), currentStripes: opts.stripes ?? 0,
      progressBaselineAt: opts.baseline ?? new Date("2026-03-01T00:00:00Z"), progressBaselineKind: opts.kind ?? "SYSTEM_BASELINE",
      codeHash: digestLookupSecret(`void-test-${suffix}`, pepper),
    },
  });
  cleanupStudentIds.push(student.id);
  return student;
}

// `type` defaults to a check-in. Only ONE class-less check-in can exist per student per day (a database rule), so a
// second same-day entry in these fixtures is a staff-added day (ADJUSTMENT) - the realistic way two entries share a day.
const entry = (studentId: string, academyId: string, organizationId: string, occurredAt: string, day = "2026-03-10", type: "CHECKIN" | "ADJUSTMENT" = "CHECKIN") =>
  prisma.attendanceRecord.create({
    data: { studentId, academyId, organizationId, occurredAt: new Date(occurredAt), date: new Date(`${day}T00:00:00Z`), type, delta: 1, source: type === "ADJUSTMENT" ? "STAFF" : "KIOSK" },
  });

const form = (fields: Record<string, string>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
};
const perInterval = (s: { id: string; organizationId: string }) => getAtBeltSummary(s.id, s.organizationId, ALLIANCE_PER_INTERVAL_CONFIG);

async function escazu() {
  return prisma.academy.findUniqueOrThrow({ where: { slug: "escazu" } });
}

describe("voiding a mistaken attendance entry", () => {
  it("keeps the row in the history, marks who/when/why, audits it, and removes it from progress and lifetime attendance", async () => {
    const ac = await escazu();
    const admin = await makeStaff("ADMIN", "void-admin");
    const student = await makeStudent(ac.id, ac.organizationId);
    const row = await entry(student.id, ac.id, ac.organizationId, "2026-03-10T18:00:00Z");
    expect((await perInterval(student)).atBeltCount).toBe(1);

    const result = await voidAttendanceEntry(admin.organizationId, {}, form({ recordId: row.id, reason: "tapped for the wrong student" }));
    expect(result).toEqual({ ok: true });

    const after = await prisma.attendanceRecord.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.voidedAt).not.toBeNull();
    expect(after.voidedById).toBe(admin.id);
    expect(after.voidReason).toBe("tapped for the wrong student");
    expect(after.delta).toBe(1); // not edited, not deleted
    const summary = await perInterval(student);
    expect(summary.atBeltCount).toBe(0);
    expect(summary.lifetimeCount).toBe(0);
    // ...and the legacy accounting ignores it too.
    expect((await getAtBeltSummary(student.id, student.organizationId, ALLIANCE_ATTENDANCE_CONFIG)).lifetimeCount).toBe(0);
    expect(await getAttendanceHistory(student.id, student.organizationId)).toHaveLength(0);

    const audit = await prisma.auditLog.findFirstOrThrow({ where: { entityId: row.id, action: "attendance.void" } });
    expect(audit.actorId).toBe(admin.id);
    expect(audit.after).toMatchObject({ voided: true, reason: "tapped for the wrong student", studentId: student.id, day: "2026-03-10" });
  });

  it("recomputes the day's contribution from the remaining valid rows, not from the voided one", async () => {
    const ac = await escazu();
    const admin = await makeStaff("ADMIN", "void-recompute-admin");
    // Awarded at 10:00 CR (16:00Z) on Mar 10: the 06:00 class is before it, the 18:00 class after it.
    const student = await makeStudent(ac.id, ac.organizationId, { baseline: new Date("2026-03-10T16:00:00Z"), kind: "AWARD" });
    const early = await entry(student.id, ac.id, ac.organizationId, "2026-03-10T12:00:00Z");
    const late = await entry(student.id, ac.id, ac.organizationId, "2026-03-11T00:00:00Z", "2026-03-10", "ADJUSTMENT");
    expect((await perInterval(student)).atBeltCount).toBe(0); // the day belongs to the completed interval (its first row is before the award)

    // The 06:00 tap was a mistake: the day's contribution becomes the valid 18:00 class, which is after the award.
    await voidAttendanceEntry(admin.organizationId, {}, form({ recordId: early.id, reason: "wrong student" }));
    expect((await perInterval(student)).atBeltCount).toBe(1);

    // Voiding the last valid row of the day stops the day counting altogether.
    await voidAttendanceEntry(admin.organizationId, {}, form({ recordId: late.id, reason: "also a mistake" }));
    expect((await perInterval(student)).atBeltCount).toBe(0);
    expect(await prisma.attendanceRecord.count({ where: { studentId: student.id } })).toBe(2); // nothing deleted
  });

  it("voiding one of two same-day entries leaves the day counted by the other", async () => {
    const ac = await escazu();
    const admin = await makeStaff("ADMIN", "void-sameday-admin");
    const student = await makeStudent(ac.id, ac.organizationId);
    const first = await entry(student.id, ac.id, ac.organizationId, "2026-03-10T12:00:00Z");
    await entry(student.id, ac.id, ac.organizationId, "2026-03-11T00:00:00Z", "2026-03-10", "ADJUSTMENT");
    await voidAttendanceEntry(admin.organizationId, {}, form({ recordId: first.id, reason: "duplicate tap" }));
    expect((await perInterval(student)).atBeltCount).toBe(1);
  });

  it("never revokes a promotion: the award and the student's rank stand even if the voided entry made them eligible", async () => {
    const ac = await escazu();
    const admin = await makeStaff("DIRECTOR", "void-award-director", ac.id);
    const student = await makeStudent(ac.id, ac.organizationId, { stripes: 1, baseline: new Date("2026-03-10T16:00:00Z"), kind: "AWARD" });
    await prisma.promotion.create({
      data: { studentId: student.id, academyId: ac.id, organizationId: ac.organizationId, fromRankId: adultRankId("WHITE"), toRankId: adultRankId("WHITE"), fromStripes: 0, toStripes: 1, source: "MANUAL", awardedAt: new Date("2026-03-10T16:00:00Z") },
    });
    const row = await entry(student.id, ac.id, ac.organizationId, "2026-03-09T12:00:00Z", "2026-03-09");
    const result = await voidAttendanceEntry(admin.organizationId, {}, form({ recordId: row.id, reason: "not his class" }));
    expect(result).toEqual({ ok: true });
    const after = await prisma.student.findUniqueOrThrow({ where: { id: student.id } });
    expect(after).toMatchObject({ currentStripes: 1, currentRankId: adultRankId("WHITE") });
    expect(after.progressBaselineAt.toISOString()).toBe("2026-03-10T16:00:00.000Z");
    expect(await prisma.promotion.count({ where: { studentId: student.id } })).toBe(1);
  });

  it("is authorized: an INSTRUCTOR and an out-of-scope DIRECTOR cannot void, and nothing changes", async () => {
    const ac = await escazu();
    const escalante = await prisma.academy.findUniqueOrThrow({ where: { slug: "escalante" } });
    const student = await makeStudent(ac.id, ac.organizationId);
    const row = await entry(student.id, ac.id, ac.organizationId, "2026-03-10T18:00:00Z");

    const instructor = await makeStaff("INSTRUCTOR", "void-instructor", ac.id);
    // A genuine member with the wrong role hits resolveActionContext's bare FORBIDDEN, exactly like every other
    // ADMIN/DIRECTOR-only action in this app (the UI never offers the control to an instructor).
    await expect(voidAttendanceEntry(instructor.organizationId, {}, form({ recordId: row.id, reason: "x" }))).rejects.toThrow("FORBIDDEN");
    const outOfScope = await makeStaff("DIRECTOR", "void-otherdirector", escalante.id);
    expect(await voidAttendanceEntry(outOfScope.organizationId, {}, form({ recordId: row.id, reason: "x" }))).toEqual({ error: "notFound" });

    expect((await prisma.attendanceRecord.findUniqueOrThrow({ where: { id: row.id } })).voidedAt).toBeNull();
    expect(await prisma.auditLog.count({ where: { entityId: row.id, action: "attendance.void" } })).toBe(0);
  });

  it("needs a reason, and a second void of the same entry is refused - even when two coaches race", async () => {
    const ac = await escazu();
    const admin = await makeStaff("ADMIN", "void-race-admin");
    const student = await makeStudent(ac.id, ac.organizationId);
    const row = await entry(student.id, ac.id, ac.organizationId, "2026-03-10T18:00:00Z");

    const noReason = await voidAttendanceEntry(admin.organizationId, {}, form({ recordId: row.id, reason: "   " }));
    expect(noReason.error).toBe("invalid");
    expect((await prisma.attendanceRecord.findUniqueOrThrow({ where: { id: row.id } })).voidedAt).toBeNull();

    const results = await Promise.all([
      voidAttendanceEntry(admin.organizationId, {}, form({ recordId: row.id, reason: "first" })),
      voidAttendanceEntry(admin.organizationId, {}, form({ recordId: row.id, reason: "second" })),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => r.error === "alreadyVoided")).toHaveLength(1);
    expect(await prisma.auditLog.count({ where: { entityId: row.id, action: "attendance.void" } })).toBe(1);
  });

  describe("history-only entries for the day of a promotion survive voids and recomputation", () => {
    // Awarded at 14:00 CR on Tue 2026-03-10 (20:00Z). A coach only supplies the DAY, so an entry for it is history
    // only: it must never become a progress contribution, whatever else is voided later.
    const AWARD = new Date("2026-03-10T20:00:00Z");
    const coachEntry = (organizationId: string, studentId: string, reason: string) =>
      addAttendanceAdjustment(organizationId, {}, form({ studentId, date: "2026-03-10", reason }));

    // The history-only rule belongs to PER_INTERVAL accounting; Alliance is CUMULATIVE in the test database, so these
    // scenarios run in a private organization that really is PER_INTERVAL (the coach action reads the real mode).
    let fx: Awaited<ReturnType<typeof makeAccountingOrg>>;
    beforeAll(async () => { fx = await makeAccountingOrg("PER_INTERVAL", "void-per"); });
    afterAll(async () => { await fx?.drop(); });

    async function awarded(label: string) {
      const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
      const student = await prisma.student.create({
        data: {
          homeAcademyId: fx.academy.id, organizationId: fx.org.id, firstName: "VoidPromoDay", lastName: label, phone: "88880044",
          email: `void-promoday-${label}-${suffix}@example.com`, status: "ACTIVE", currentRankId: await fx.rankId("WHITE"), currentStripes: 1,
          progressBaselineAt: AWARD, progressBaselineKind: "AWARD", codeHash: digestLookupSecret(`void-promoday-${label}-${suffix}`, pepper),
        },
      });
      currentSession = { user: { id: fx.admin.id, role: "ADMIN" }, activeOrganizationId: fx.org.id };
      return { ac: fx.academy, admin: { organizationId: fx.org.id }, student };
    }
    const valid = (studentId: string) => prisma.attendanceRecord.findMany({ where: { studentId, voidedAt: null }, orderBy: { occurredAt: "asc" } });

    it("two coach entries on the promotion day, then the first is voided: the second does NOT start contributing", async () => {
      const { admin, student } = await awarded("two-entries");
      const first = await coachEntry(admin.organizationId, student.id, "ceremony class");
      const second = await coachEntry(admin.organizationId, student.id, "recorded again by another coach");
      expect(first).toEqual({ ok: true, info: "promotionDayHistoryOnly" });
      expect(second).toEqual({ ok: true, info: "promotionDayHistoryOnly" });
      expect((await perInterval(student)).atBeltCount).toBe(0);

      const rows = await prisma.attendanceRecord.findMany({ where: { studentId: student.id }, orderBy: { createdAt: "asc" } });
      expect(rows).toHaveLength(2);
      expect(await voidAttendanceEntry(admin.organizationId, {}, form({ recordId: rows[0].id, reason: "duplicate" }))).toEqual({ ok: true });

      // The remaining valid entry is still history only.
      expect((await perInterval(student)).atBeltCount).toBe(0);
      expect((await valid(student.id)).map((r) => r.id)).toEqual([rows[1].id]);
      // ...and it still counts as attendance that happened.
      expect((await perInterval(student)).lifetimeCount).toBe(1);
    });

    it("a real class after the award stays the day's contribution while coach entries come and go, and the coach entries never take over if it is voided", async () => {
      const { ac, admin, student } = await awarded("real-after");
      const real = await entry(student.id, ac.id, ac.organizationId, "2026-03-11T00:00:00Z", "2026-03-10"); // 18:00 CR, after the award
      expect((await perInterval(student)).atBeltCount).toBe(1);

      await coachEntry(admin.organizationId, student.id, "late entry one");
      await coachEntry(admin.organizationId, student.id, "late entry two");
      expect((await perInterval(student)).atBeltCount).toBe(1);

      // The real class was the mistake: with it gone the day has NO progress contribution - the history-only
      // coach entries do not inherit it.
      await voidAttendanceEntry(admin.organizationId, {}, form({ recordId: real.id, reason: "wrong student" }));
      expect((await perInterval(student)).atBeltCount).toBe(0);
    });

    it("a real class before the award stays in the completed interval whatever happens to the coach entries", async () => {
      const { ac, admin, student } = await awarded("real-before");
      const real = await entry(student.id, ac.id, ac.organizationId, "2026-03-10T12:00:00Z", "2026-03-10"); // 06:00 CR, before the award
      await coachEntry(admin.organizationId, student.id, "second class that day");
      expect((await perInterval(student)).atBeltCount).toBe(0);
      await voidAttendanceEntry(admin.organizationId, {}, form({ recordId: real.id, reason: "wrong student" }));
      expect((await perInterval(student)).atBeltCount).toBe(0);
    });
  });

  it("a framework-shaped form post (with $ACTION_* fields) works", async () => {
    const ac = await escazu();
    const admin = await makeStaff("ADMIN", "void-framework-admin");
    const student = await makeStudent(ac.id, ac.organizationId);
    const row = await entry(student.id, ac.id, ac.organizationId, "2026-03-10T18:00:00Z");
    const result = await voidAttendanceEntry(admin.organizationId, {}, form({ "$ACTION_REF_3": "", "$ACTION_KEY": "k", recordId: row.id, reason: "posted from the browser" }));
    expect(result).toEqual({ ok: true });
  });
});
