import "dotenv/config";
import { getTestPrismaClient } from "../helpers/test-db";
import { afterAll, describe, expect, it } from "vitest";
import { cleanupClassFixtures, makeClassAcademy, makeClassStudent } from "../helpers/class-fixtures";

const { getAttendanceMonthTotals, getAttendanceTotals } = await import("../../src/lib/students/attendance-history");

/**
 * Phase 2.6 PR 2: the new date-ranged read Portal Attendance's this-month/last-month stat row relies on
 * (`design/matroom/verification/phase2.6-proposal/README.md` §9.3). Exact month boundaries must be computed in
 * the academy's own America/Costa_Rica zone (UTC-6), never a UTC calendar-month boundary - this is the one real
 * defect "the whole ledger, no date filter" totals could never have had, and the one this read must get right.
 */
const prisma = getTestPrismaClient();
afterAll(cleanupClassFixtures);

async function seed() {
  const { academy } = await makeClassAcademy([{ dayOfWeek: "MONDAY", startTime: "18:00", name: "Evening GI" }]);
  const { student } = await makeClassStudent(academy.id, academy.organizationId);
  const other = (await makeClassStudent(academy.id, academy.organizationId)).student;
  return { academy, student, other };
}

async function addRow(ctx: { academy: { id: string; organizationId: string } }, studentId: string, occurredAt: Date, extra: Partial<{ type: "CHECKIN" | "ADJUSTMENT"; delta: number; voided: boolean }> = {}) {
  return prisma.attendanceRecord.create({
    data: {
      studentId,
      academyId: ctx.academy.id,
      organizationId: ctx.academy.organizationId,
      occurredAt,
      date: new Date(Date.UTC(occurredAt.getUTCFullYear(), occurredAt.getUTCMonth(), occurredAt.getUTCDate())),
      type: extra.type ?? "CHECKIN",
      delta: extra.delta ?? 1,
      source: "STAFF",
      matchSource: "AUTO",
      ...(extra.voided ? { voidedAt: new Date(), voidReason: "mistake" } : {}),
    },
  });
}

describe("getAttendanceMonthTotals", () => {
  it("attributes a record to its Costa Rica calendar month, not UTC - 23:59 CR on the last day of January counts toward January, not the UTC-next-day February instant it actually is", async () => {
    const ctx = await seed();
    // 23:59 America/Costa_Rica (UTC-6) on 2026-01-31 is 2026-02-01T05:59:00Z - a UTC calendar-month boundary bug
    // would misfile this into February.
    await addRow(ctx, ctx.student.id, new Date("2026-02-01T05:59:00Z"));

    const january = await getAttendanceMonthTotals(ctx.student.id, ctx.academy.organizationId, new Date("2026-01-15T12:00:00Z"));
    const february = await getAttendanceMonthTotals(ctx.student.id, ctx.academy.organizationId, new Date("2026-02-15T12:00:00Z"));
    expect(january.total).toBe(1);
    expect(february.total).toBe(0);
  });

  it("00:01 Costa Rica on the first day of February counts toward February, not the January UTC instant one minute earlier would suggest", async () => {
    const ctx = await seed();
    // 00:01 America/Costa_Rica on 2026-02-01 is 2026-02-01T06:01:00Z.
    await addRow(ctx, ctx.student.id, new Date("2026-02-01T06:01:00Z"));

    const january = await getAttendanceMonthTotals(ctx.student.id, ctx.academy.organizationId, new Date("2026-01-15T12:00:00Z"));
    const february = await getAttendanceMonthTotals(ctx.student.id, ctx.academy.organizationId, new Date("2026-02-15T12:00:00Z"));
    expect(january.total).toBe(0);
    expect(february.total).toBe(1);
  });

  it("keeps the same three-way split as the whole-ledger getAttendanceTotals: check-ins, +1 staff days, and other signed adjustments net separately", async () => {
    const ctx = await seed();
    // Each row on its own ledger day - an unmatched check-in / adjustment is unique per (student, date).
    await addRow(ctx, ctx.student.id, new Date("2026-03-10T18:00:00Z"), { type: "CHECKIN" });
    await addRow(ctx, ctx.student.id, new Date("2026-03-11T18:00:00Z"), { type: "CHECKIN" });
    await addRow(ctx, ctx.student.id, new Date("2026-03-12T18:00:00Z"), { type: "ADJUSTMENT", delta: 1 }); // staff day
    await addRow(ctx, ctx.student.id, new Date("2026-03-13T18:00:00Z"), { type: "ADJUSTMENT", delta: -1 }); // other adjustment, negative
    await addRow(ctx, ctx.student.id, new Date("2026-02-10T18:00:00Z")); // different month, must not leak in

    const march = await getAttendanceMonthTotals(ctx.student.id, ctx.academy.organizationId, new Date("2026-03-20T12:00:00Z"));
    expect(march).toEqual({ total: 2 + 1 - 1, checkIns: 2, staffDays: 1, otherAdjustments: { count: 1, net: -1 } });
  });

  it("summed over a range covering the whole ledger, matches the whole-ledger getAttendanceTotals exactly - old and new reads agree", async () => {
    const ctx = await seed();
    await addRow(ctx, ctx.student.id, new Date("2026-01-05T18:00:00Z"));
    await addRow(ctx, ctx.student.id, new Date("2026-01-20T18:00:00Z"), { type: "ADJUSTMENT", delta: 1 });
    await addRow(ctx, ctx.student.id, new Date("2026-02-05T18:00:00Z"));
    await addRow(ctx, ctx.student.id, new Date("2026-02-20T18:00:00Z"), { type: "ADJUSTMENT", delta: -2 });
    await addRow(ctx, ctx.student.id, new Date("2026-02-01T18:00:00Z"), { voided: true }); // never counted either way

    const whole = await getAttendanceTotals(ctx.student.id, ctx.academy.organizationId);
    const january = await getAttendanceMonthTotals(ctx.student.id, ctx.academy.organizationId, new Date("2026-01-15T12:00:00Z"));
    const february = await getAttendanceMonthTotals(ctx.student.id, ctx.academy.organizationId, new Date("2026-02-15T12:00:00Z"));
    expect(january.total + february.total).toBe(whole.total);
    expect(january.checkIns + february.checkIns).toBe(whole.checkIns);
    expect(january.staffDays + february.staffDays).toBe(whole.staffDays);
    expect(january.otherAdjustments.net + february.otherAdjustments.net).toBe(whole.otherAdjustments.net);
  });

  it("only ever counts the given student's rows, never another student's, and never a voided row", async () => {
    const ctx = await seed();
    await addRow(ctx, ctx.student.id, new Date("2026-04-10T18:00:00Z"));
    await addRow(ctx, ctx.student.id, new Date("2026-04-11T18:00:00Z"), { voided: true });
    await addRow(ctx, ctx.other.id, new Date("2026-04-10T18:00:00Z"));
    await addRow(ctx, ctx.other.id, new Date("2026-04-11T18:00:00Z"));

    const stat = await getAttendanceMonthTotals(ctx.student.id, ctx.academy.organizationId, new Date("2026-04-20T12:00:00Z"));
    expect(stat.total).toBe(1);
  });
});
