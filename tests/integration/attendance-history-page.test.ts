import "dotenv/config";
import { getTestPrismaClient } from "../helpers/test-db";
import { afterAll, describe, expect, it } from "vitest";
import { cleanupClassFixtures, makeClassAcademy, makeClassStudent } from "../helpers/class-fixtures";
import { resolvePromotionConfigMap } from "../../src/lib/promotion/config";

const { getAttendanceHistory, getAttendanceHistoryPage, getAttendanceTotals } = await import("../../src/lib/students/attendance-history");
const { getAtBeltSummary } = await import("../../src/lib/students/attendance-summary");

/**
 * The student's attendance history (PR 3): stable keyset pagination over older records instead of a silent cap of
 * 50, and a clearly defined total that is NOT the length of whatever page happens to be loaded.
 *
 * The total is the student's lifetime attendance and is defined as the sum of three parts that always reconcile:
 *   check-ins (physical attendances, matched to a class or not)
 *   + staff-added days (one attendance day recorded by a coach)
 *   + other signed adjustments (legacy rows that are not +1; the academy no longer creates them).
 * Voided entries count for nothing. Promotion credits are NOT attendance and are never part of it.
 */
const prisma = getTestPrismaClient();
afterAll(cleanupClassFixtures);

const DAY_MS = 86_400_000;

async function seed() {
  const { academy, sessions } = await makeClassAcademy([{ dayOfWeek: "MONDAY", startTime: "18:00", name: "Evening GI" }]);
  const { student } = await makeClassStudent(academy.id, academy.organizationId);
  const other = (await makeClassStudent(academy.id, academy.organizationId)).student;
  return { academy, session: sessions[0], student, other };
}

type Extra = Partial<{
  type: "CHECKIN" | "ADJUSTMENT";
  delta: number;
  classSessionId: string | null;
  matchSource: "AUTO" | "UNMATCHED" | "STUDENT_PICKED";
  reason: string;
  voided: boolean;
  occurredAt: Date;
}>;

/** One row, `daysAgo` days before 2026-01-31 18:00Z, on its own ledger day (so no per-day uniqueness rule is in play). */
async function addRow(ctx: { academy: { id: string; organizationId: string } }, studentId: string, daysAgo: number, extra: Extra = {}) {
  const occurredAt = extra.occurredAt ?? new Date(Date.UTC(2026, 0, 31, 18, 0, 0) - daysAgo * DAY_MS);
  return prisma.attendanceRecord.create({
    data: {
      studentId, academyId: ctx.academy.id, organizationId: ctx.academy.organizationId, occurredAt,
      date: new Date(Date.UTC(occurredAt.getUTCFullYear(), occurredAt.getUTCMonth(), occurredAt.getUTCDate())),
      type: extra.type ?? "CHECKIN", delta: extra.delta ?? 1, source: "STAFF",
      classSessionId: extra.classSessionId ?? null, matchSource: extra.matchSource ?? "AUTO", reason: extra.reason ?? null,
      ...(extra.voided ? { voidedAt: new Date(), voidReason: "mistake" } : {}),
    },
  });
}

describe("paginated history", () => {
  it("walks every valid record exactly once, newest first, across pages - including records that share the same instant", async () => {
    const ctx = await seed();
    for (let i = 0; i < 51; i++) await addRow(ctx, ctx.student.id, i + 1);
    // Six rows sharing ONE instant (on six different ledger days), placed so that the page boundary (row 20) falls
    // INSIDE the group - rows 18-23 of the newest-first list: what a time-only cursor skips at a page boundary.
    // (Row i sits at 18:00Z, i days before 2026-01-31; row 17 is Jan 14 and row 18 is Jan 13, so 20:00Z on Jan 13 is between them.)
    const tieInstant = new Date("2026-01-13T20:00:00Z");
    for (let i = 0; i < 6; i++) {
      await prisma.attendanceRecord.create({
        data: { studentId: ctx.student.id, academyId: ctx.academy.id, organizationId: ctx.academy.organizationId, occurredAt: tieInstant, date: new Date(Date.UTC(2025, 5, 1 + i)), type: "CHECKIN", delta: 1, source: "STAFF", matchSource: "AUTO" },
      });
    }
    const expected = (await prisma.attendanceRecord.findMany({ where: { studentId: ctx.student.id }, orderBy: [{ occurredAt: "desc" }, { id: "desc" }], select: { id: true } })).map((r) => r.id);
    expect(expected).toHaveLength(57);

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page: Awaited<ReturnType<typeof getAttendanceHistoryPage>> = await getAttendanceHistoryPage(ctx.student.id, ctx.academy.organizationId, { cursor, limit: 20 });
      expect(page.entries.length).toBeLessThanOrEqual(20);
      seen.push(...page.entries.map((e) => e.id));
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor && pages < 10);

    expect(pages).toBe(3);
    expect(seen).toEqual(expected); // same order, no duplicate, no gap
    expect(new Set(seen).size).toBe(57);
    // The tie group really does straddle the first page boundary (the point of this fixture).
    const tied = (await prisma.attendanceRecord.findMany({ where: { studentId: ctx.student.id, occurredAt: tieInstant }, select: { id: true } })).map((r) => r.id);
    const firstPageTied = expected.slice(0, 20).filter((id) => tied.includes(id)).length;
    expect(firstPageTied).toBeGreaterThan(0);
    expect(firstPageTied).toBeLessThan(6);
  });

  it("a newer record arriving between page loads does not shift or repeat the older pages", async () => {
    const ctx = await seed();
    for (let i = 0; i < 30; i++) await addRow(ctx, ctx.student.id, i + 1);
    const first = await getAttendanceHistoryPage(ctx.student.id, ctx.academy.organizationId, { limit: 10 });
    await addRow(ctx, ctx.student.id, 0, { occurredAt: new Date("2026-02-15T12:00:00Z") }); // newer than everything
    const second = await getAttendanceHistoryPage(ctx.student.id, ctx.academy.organizationId, { cursor: first.nextCursor, limit: 10 });
    const firstIds = new Set(first.entries.map((e) => e.id));
    expect(second.entries.some((e) => firstIds.has(e.id))).toBe(false);
    expect(second.entries).toHaveLength(10);
  });

  it("voided entries are never returned, another student's records never appear, and a garbage cursor yields an empty page", async () => {
    const ctx = await seed();
    await addRow(ctx, ctx.student.id, 1);
    const voided = await addRow(ctx, ctx.student.id, 2, { voided: true });
    await addRow(ctx, ctx.other.id, 3);
    const page = await getAttendanceHistoryPage(ctx.student.id, ctx.academy.organizationId, { limit: 50 });
    expect(page.entries).toHaveLength(1);
    expect(page.entries.map((e) => e.id)).not.toContain(voided.id);
    expect(page.nextCursor).toBeNull();
    expect(await getAttendanceHistoryPage(ctx.student.id, ctx.academy.organizationId, { cursor: "not-a-cursor", limit: 10 })).toEqual({ entries: [], nextCursor: null });
    // The legacy helper is the first page of the same data.
    expect((await getAttendanceHistory(ctx.student.id, ctx.academy.organizationId)).map((e) => e.id)).toEqual(page.entries.map((e) => e.id));
  });

  it("each entry says what it is: a class check-in, a check-in with no class, a staff-added day, or a legacy adjustment", async () => {
    const ctx = await seed();
    await addRow(ctx, ctx.student.id, 1, { classSessionId: ctx.session.id, matchSource: "STUDENT_PICKED" });
    await addRow(ctx, ctx.student.id, 2, { matchSource: "UNMATCHED" });
    await addRow(ctx, ctx.student.id, 3, { type: "ADJUSTMENT", reason: "makeup class" });
    await addRow(ctx, ctx.student.id, 4, { type: "ADJUSTMENT", delta: -1, reason: "old correction" });
    const { entries } = await getAttendanceHistoryPage(ctx.student.id, ctx.academy.organizationId, { limit: 10 });
    expect(entries.map((e) => e.kind)).toEqual(["class_checkin", "unmatched_checkin", "staff_day", "adjustment"]);
    expect(entries[0].className).toBe("Evening GI");
    expect(entries[2].reason).toBe("makeup class");
    expect(entries[3].delta).toBe(-1);
  });
});

describe("the total is defined and independent of the loaded page", () => {
  it("counts check-ins, staff-added days and other adjustments separately; voided entries and credits count for nothing; the parts reconcile with lifetime attendance", async () => {
    const ctx = await seed();
    for (let i = 0; i < 8; i++) await addRow(ctx, ctx.student.id, i + 1, { classSessionId: i < 5 ? ctx.session.id : null, matchSource: i < 5 ? "AUTO" : "UNMATCHED" });
    for (let i = 0; i < 3; i++) await addRow(ctx, ctx.student.id, 20 + i, { type: "ADJUSTMENT", reason: "staff day" });
    await addRow(ctx, ctx.student.id, 30, { type: "ADJUSTMENT", delta: 3, reason: "legacy +3" });
    await addRow(ctx, ctx.student.id, 31, { type: "ADJUSTMENT", delta: -1, reason: "legacy -1" });
    await addRow(ctx, ctx.student.id, 32, { voided: true });
    await addRow(ctx, ctx.student.id, 33, { type: "ADJUSTMENT", reason: "voided staff day", voided: true });
    await prisma.promotionCredit.create({ data: { studentId: ctx.student.id, academyId: ctx.academy.id, organizationId: ctx.academy.organizationId, beltAwardedAtAnchor: new Date("2026-01-01T00:00:00Z"), classesGranted: 45, reason: "legacy head start" } });

    const totals = await getAttendanceTotals(ctx.student.id, ctx.academy.organizationId);
    expect(totals).toEqual({ total: 8 + 3 + 2, entryCount: 8 + 3 + 2, checkIns: 8, staffDays: 3, otherAdjustments: { count: 2, net: 2 } });
    // `entryCount` is the number of valid rows behind the total (what "showing X of Y" counts); here every row is +1 except +3 and -1.
    expect(totals.total).toBe(totals.checkIns + totals.staffDays + totals.otherAdjustments.net);

    // It IS the lifetime attendance every other screen shows; credits are not in it.
    const summary = await getAtBeltSummary(ctx.student.id, ctx.academy.organizationId, await resolvePromotionConfigMap(ctx.academy.organizationId));
    expect(summary.lifetimeCount).toBe(totals.total);

    // ...and it does not depend on how many rows a page shows.
    const smallPage = await getAttendanceHistoryPage(ctx.student.id, ctx.academy.organizationId, { limit: 5 });
    expect(smallPage.entries).toHaveLength(5);
    expect((await getAttendanceTotals(ctx.student.id, ctx.academy.organizationId)).total).toBe(13);
  });

  it("a student with no attendance has an all-zero total", async () => {
    const ctx = await seed();
    expect(await getAttendanceTotals(ctx.student.id, ctx.academy.organizationId)).toEqual({ total: 0, entryCount: 0, checkIns: 0, staffDays: 0, otherAdjustments: { count: 0, net: 0 } });
  });
});
