import "dotenv/config";
import { getTestPrismaClient } from "../helpers/test-db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { requireEnv } from "../../src/lib/env";
import { digestLookupSecret } from "../../src/lib/crypto";
import { adultRankId } from "../helpers/belt-ranks";
import { ALLIANCE_PER_INTERVAL_CONFIG } from "../helpers/promotion-config";
import type { KioskContext } from "../../src/lib/tenant/types";

const { performCheckIn } = await import("../../src/lib/kiosk/perform-check-in");
const { getAtBeltSummary } = await import("../../src/lib/students/attendance-summary");

/**
 * docs/PROMOTION_PROGRESS_PROPOSAL.md - the daily limit is enforced on the server
 * for EVERY entry channel: kiosk, student portal, coach-added day, offline replay.
 * These drive the real `performCheckIn` (the one core all channels share) and a
 * coach-added row concurrently, and assert one contribution per Costa Rica day.
 *
 * 2026-03-10 is a Tuesday. Costa Rica is UTC-6 with no DST:
 *   06:05 CR = 12:05Z Mar 10        20:05 CR = 02:05Z Mar 11 (a different UTC date, the same CR day)
 */
const prisma = getTestPrismaClient();
const pepper = requireEnv("CODE_PEPPER");

const TUE_0605 = new Date("2026-03-10T12:05:00Z");
const TUE_2005 = new Date("2026-03-11T02:05:00Z");
const TUE_1205 = new Date("2026-03-10T18:05:00Z");
const WED_0605 = new Date("2026-03-11T12:05:00Z");

let organizationId: string;
let academyId: string;
let kiosk: KioskContext;
const studentIds: string[] = [];
const academyIds: string[] = [];

async function makeStudent(baseline = new Date("2026-03-01T00:00:00Z")) {
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
  const student = await prisma.student.create({
    data: {
      homeAcademyId: academyId,
      organizationId,
      firstName: "DailyLimit",
      lastName: "Student",
      phone: "88881111",
      email: `daily-limit-${suffix}@example.com`,
      currentRankId: adultRankId("WHITE"),
      status: "ACTIVE",
      progressBaselineAt: baseline,
      codeHash: digestLookupSecret(`daily-limit-${suffix}`, pepper),
    },
  });
  studentIds.push(student.id);
  return student;
}

function checkIn(studentId: string, source: "KIOSK" | "PORTAL", now: Date, unattended = false) {
  return performCheckIn({ studentId, academyId, context: kiosk, source, now, ...(unattended ? { replay: { timestampVerified: true, event: { key: `evt-${now.getTime()}`, claimedAtRaw: String(now.getTime()), claimedAt: now } } } : {}) });
}

async function contributions(studentId: string) {
  return (await getAtBeltSummary(studentId, organizationId, ALLIANCE_PER_INTERVAL_CONFIG)).atBeltCount;
}

beforeAll(async () => {
  const org = await prisma.organization.findUniqueOrThrow({ where: { slug: "alliance-cr" } });
  organizationId = org.id;
  await prisma.promotionConfig.updateMany({ where: { organizationId }, data: { stripeAccounting: "PER_INTERVAL" } });
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
  const academy = await prisma.academy.create({
    data: { name: `Daily Limit ${suffix}`, slug: `daily-limit-${suffix}`, kioskTokenHash: `dl-hash-${suffix}`, organizationId },
  });
  academyId = academy.id;
  academyIds.push(academy.id);
  kiosk = { kind: "kiosk", organizationId, academyId };
  const make = (dayOfWeek: "TUESDAY" | "WEDNESDAY", startTime: string, name: string, counts = true) =>
    prisma.classSession.create({
      data: { academyId, organizationId, dayOfWeek, startTime, durationMinutes: 60, name, type: "GI", countsTowardPromotion: counts },
    });
  await make("TUESDAY", "06:00", "Tue Morning");
  await make("TUESDAY", "12:00", "Tue Striking", false);
  await make("TUESDAY", "20:00", "Tue Evening");
  await make("WEDNESDAY", "06:00", "Wed Morning");
});

afterAll(async () => {
  await prisma.promotionConfig.updateMany({ where: { organizationId }, data: { stripeAccounting: "CUMULATIVE" } });
  if (studentIds.length > 0) {
    await prisma.attendanceRecord.deleteMany({ where: { studentId: { in: studentIds } } });
    await prisma.student.deleteMany({ where: { id: { in: studentIds } } });
  }
  await prisma.classSession.deleteMany({ where: { academyId: { in: academyIds } } });
  await prisma.academy.deleteMany({ where: { id: { in: academyIds } } });
});

describe("the daily limit holds across every entry channel", () => {
  it("simultaneous kiosk, portal, second-class, offline-replay and coach-added entries for one day yield ONE contribution and keep every row", async () => {
    const student = await makeStudent();
    const outcomes = await Promise.all([
      checkIn(student.id, "KIOSK", TUE_0605), // the morning class at the kiosk
      checkIn(student.id, "PORTAL", TUE_0605), // the same class, from the phone, at the same moment
      checkIn(student.id, "KIOSK", TUE_2005), // the evening class (its window crosses UTC midnight)
      checkIn(student.id, "KIOSK", TUE_0605, true), // an offline replay of the morning tap
      prisma.attendanceRecord.create({
        // a coach adding the same CR day
        data: {
          studentId: student.id,
          academyId,
          organizationId,
          occurredAt: TUE_1205,
          date: new Date("2026-03-10T00:00:00Z"),
          type: "ADJUSTMENT",
          delta: 1,
          reason: "coach-added",
          source: "STAFF",
        },
      }),
    ]);
    // Nothing threw, and the duplicate of one class was refused by the existing per-class constraint, not lost silently.
    expect(outcomes).toHaveLength(5);

    expect(await contributions(student.id)).toBe(1);
    // History is preserved: the two distinct classes plus the coach entry are all recorded.
    const rows = await prisma.attendanceRecord.findMany({ where: { studentId: student.id } });
    expect(rows.length).toBeGreaterThanOrEqual(3);
    expect(new Set(rows.map((r) => r.date.toISOString().slice(0, 10)))).toEqual(new Set(["2026-03-10"]));
  });

  it("the evening class is on the same CR day as the morning one although its instant is on the next UTC date", async () => {
    const student = await makeStudent();
    await checkIn(student.id, "KIOSK", TUE_0605);
    const evening = await checkIn(student.id, "KIOSK", TUE_2005);
    expect(evening.ok).toBe(true);
    const record = await prisma.attendanceRecord.findFirstOrThrow({ where: { studentId: student.id }, orderBy: { occurredAt: "desc" } });
    expect(record.occurredAt.toISOString()).toBe("2026-03-11T02:05:00.000Z");
    expect(record.date.toISOString().slice(0, 10)).toBe("2026-03-10");
    expect(await contributions(student.id)).toBe(1);
  });

  it("tells the student truthfully what each check-in did for progress", async () => {
    const student = await makeStudent();
    const first = await checkIn(student.id, "KIOSK", TUE_0605);
    const second = await checkIn(student.id, "PORTAL", TUE_2005);
    const striking = await checkIn(student.id, "KIOSK", TUE_1205);
    expect(first.ok && first.progressOutcome).toBe("counted");
    expect(second.ok && second.progressOutcome).toBe("already_counted_today");
    expect(striking.ok && striking.progressOutcome).toBe("not_promotion_class");
    // ...and a check-in on the next day is a new contribution.
    const next = await checkIn(student.id, "KIOSK", WED_0605);
    expect(next.ok && next.progressOutcome).toBe("counted");
    expect(await contributions(student.id)).toBe(2);
  });

  it("a replay from before the last award is recorded and told so: it belongs to the completed interval and adds nothing", async () => {
    // Awarded at 07:00 CR (13:00Z) on Tue Mar 10; the tablet's 06:05 tap only arrives afterwards.
    const student = await makeStudent(new Date("2026-03-10T13:00:00Z"));
    const replay = await checkIn(student.id, "KIOSK", TUE_0605, true);
    expect(replay.ok && replay.progressOutcome).toBe("before_last_promotion");
    expect(await contributions(student.id)).toBe(0);
    expect(await prisma.attendanceRecord.count({ where: { studentId: student.id } })).toBe(1); // history kept
  });

  it("an offline replay is dated by the class it belonged to, not by when it arrives: a Tuesday tap replayed after Wednesday still adds Tuesday, once", async () => {
    const student = await makeStudent();
    await checkIn(student.id, "KIOSK", WED_0605); // Wednesday, live
    const replay = await checkIn(student.id, "KIOSK", TUE_0605, true); // Tuesday's tap, flushed later
    expect(replay.ok).toBe(true);
    const days = await prisma.attendanceRecord.findMany({ where: { studentId: student.id }, orderBy: { date: "asc" } });
    expect(days.map((r) => r.date.toISOString().slice(0, 10))).toEqual(["2026-03-10", "2026-03-11"]);
    expect(await contributions(student.id)).toBe(2);
    // The same replay flushed twice (a retry) cannot add a second contribution or a second row.
    const again = await checkIn(student.id, "KIOSK", TUE_0605, true);
    expect(again).toMatchObject({ ok: false, error: "already_checked_in" });
    expect(await contributions(student.id)).toBe(2);
  });
});
