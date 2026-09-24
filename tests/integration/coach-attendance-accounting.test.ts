import "dotenv/config";
import { getTestPrismaClient } from "../helpers/test-db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { requireEnv } from "../../src/lib/env";
import { digestLookupSecret } from "../../src/lib/crypto";
import { makeAccountingOrg } from "../helpers/accounting-org";

let currentSession: { user: { id: string; role: string } | null; activeOrganizationId?: string } | null = null;
vi.mock("@/auth", () => ({ auth: () => Promise.resolve(currentSession) }));

const { addAttendanceAdjustment } = await import("../../src/app/[locale]/(staff)/students/[id]/adjustment-actions");
const { getAtBeltSummary } = await import("../../src/lib/students/attendance-summary");
const { resolvePromotionConfigMap } = await import("../../src/lib/promotion/config");

/**
 * The coach's "add an attendance day" feedback must describe what the student's OWN track accounting does with the
 * entry. PER_INTERVAL (the decided rule): one contribution per Costa Rica day, and the day of a promotion is history
 * only. CUMULATIVE (the pre-activation rule, still what an existing organization runs): every qualifying row counts
 * since the belt date, there is no daily limit and no history-only concept - so none of those messages may appear,
 * and legacy counting must not change merely to make a message true.
 */
const prisma = getTestPrismaClient();
const pepper = requireEnv("CODE_PEPPER");

type Fixture = Awaited<ReturnType<typeof makeAccountingOrg>>;

// Awarded at 14:00 CR on Tue 2026-03-10 (20:00Z); the belt itself dates from 2026-03-01.
const AWARD = new Date("2026-03-10T20:00:00Z");
const BELT_DATE = new Date("2026-03-01T12:00:00Z");

const form = (fields: Record<string, string>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
};

async function makeStudent(fx: Fixture, label: string, opts: { baselineKind: "AWARD" | "SYSTEM_BASELINE" }) {
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
  const student = await prisma.student.create({
    data: {
      homeAcademyId: fx.academy.id, organizationId: fx.org.id, firstName: label, lastName: "CoachAccounting", phone: "88880033",
      email: `${label}-${suffix}@example.com`, status: "ACTIVE", currentRankId: await fx.rankId("WHITE"), currentStripes: 1,
      beltAwardedAt: BELT_DATE, progressBaselineAt: AWARD, progressBaselineKind: opts.baselineKind,
      codeHash: digestLookupSecret(`${label}-${suffix}`, pepper),
    },
  });
  currentSession = { user: { id: fx.admin.id, role: "ADMIN" }, activeOrganizationId: fx.org.id };
  return student;
}

const coach = (fx: Fixture, studentId: string, date: string, reason = "coach entry") =>
  addAttendanceAdjustment(fx.org.id, {}, form({ studentId, date, reason }));

/** The progress count through the REAL configuration of the organization, not a hand-passed one. */
async function summary(fx: Fixture, studentId: string) {
  return getAtBeltSummary(studentId, fx.org.id, await resolvePromotionConfigMap(fx.org.id));
}
const rows = (studentId: string) => prisma.attendanceRecord.findMany({ where: { studentId }, orderBy: { createdAt: "asc" } });

describe("coach attendance feedback follows the student's accounting: PER_INTERVAL", () => {
  let fx: Fixture;
  beforeAll(async () => { fx = await makeAccountingOrg("PER_INTERVAL", "coach-per"); });
  afterAll(async () => { await fx?.drop(); });

  it("the organization really is PER_INTERVAL", async () => {
    const student = await makeStudent(fx, "per-sanity", { baselineKind: "AWARD" });
    expect((await summary(fx, student.id)).accounting).toBe("PER_INTERVAL");
  });

  it("the day of a promotion: the first AND an additional coach entry are history only, add nothing, and say why", async () => {
    const student = await makeStudent(fx, "per-promoday", { baselineKind: "AWARD" });
    expect(await coach(fx, student.id, "2026-03-10", "ceremony class")).toEqual({ ok: true, info: "promotionDayHistoryOnly" });
    expect(await coach(fx, student.id, "2026-03-10", "recorded again")).toEqual({ ok: true, info: "promotionDayHistoryOnly" });
    const after = await summary(fx, student.id);
    expect(after.atBeltCount).toBe(0);
    expect(after.lifetimeCount).toBe(2); // still real attendance
    const stored = await rows(student.id);
    expect(stored.every((r) => r.historyOnly)).toBe(true);
    expect(stored.every((r) => r.occurredAt.getTime() < AWARD.getTime())).toBe(true);
  });

  it("a day after the promotion counts once; an additional entry the same day is kept, adds nothing, and the coach is told", async () => {
    const student = await makeStudent(fx, "per-sameday", { baselineKind: "AWARD" });
    expect(await coach(fx, student.id, "2026-03-11")).toEqual({ ok: true });
    expect(await coach(fx, student.id, "2026-03-11", "again")).toEqual({ ok: true, info: "alreadyCountedThatDay" });
    const after = await summary(fx, student.id);
    expect(after.atBeltCount).toBe(1);
    expect((await rows(student.id)).every((r) => !r.historyOnly)).toBe(true);
  });

  it("a day before the promotion belongs to the completed interval and says so", async () => {
    const student = await makeStudent(fx, "per-before", { baselineKind: "AWARD" });
    expect(await coach(fx, student.id, "2026-03-09")).toEqual({ ok: true, info: "beforeLastPromotion" });
    expect((await summary(fx, student.id)).atBeltCount).toBe(0);
  });

  it("a day before progress TRACKING started (a system baseline, no promotion involved) says so, not 'before the last promotion'", async () => {
    const student = await makeStudent(fx, "per-beforetracking", { baselineKind: "SYSTEM_BASELINE" });
    expect(await coach(fx, student.id, "2026-03-09")).toEqual({ ok: true, info: "beforeTrackingStart" });
    expect((await summary(fx, student.id)).atBeltCount).toBe(0);
  });

  it("the tracking-start day (a system baseline, not an award) is history only with its own message", async () => {
    const student = await makeStudent(fx, "per-trackstart", { baselineKind: "SYSTEM_BASELINE" });
    expect(await coach(fx, student.id, "2026-03-10")).toEqual({ ok: true, info: "trackingStartDayHistoryOnly" });
    expect((await summary(fx, student.id)).atBeltCount).toBe(0);
  });

  it("a real class BEFORE the award stays in the completed interval: a coach entry for the promotion day never pulls it forward", async () => {
    const student = await makeStudent(fx, "per-realbefore", { baselineKind: "AWARD" });
    await prisma.attendanceRecord.create({
      data: {
        studentId: student.id, academyId: fx.academy.id, organizationId: fx.org.id, occurredAt: new Date("2026-03-10T12:00:00Z"),
        date: new Date("2026-03-10T00:00:00Z"), type: "CHECKIN", delta: 1, source: "KIOSK",
      },
    });
    expect((await summary(fx, student.id)).atBeltCount).toBe(0);
    await coach(fx, student.id, "2026-03-10", "second class that day");
    expect((await summary(fx, student.id)).atBeltCount).toBe(0);
  });

  it("on a tracking-start day a coach entry never displaces a real class that already counted", async () => {
    const student = await makeStudent(fx, "per-trackreal", { baselineKind: "SYSTEM_BASELINE" });
    await prisma.attendanceRecord.create({
      data: {
        studentId: student.id, academyId: fx.academy.id, organizationId: fx.org.id, occurredAt: new Date("2026-03-11T00:00:00Z"),
        date: new Date("2026-03-10T00:00:00Z"), type: "CHECKIN", delta: 1, source: "KIOSK",
      },
    });
    expect((await summary(fx, student.id)).atBeltCount).toBe(1);
    expect(await coach(fx, student.id, "2026-03-10", "recorded next morning")).toEqual({ ok: true, info: "trackingStartDayHistoryOnly" });
    expect((await summary(fx, student.id)).atBeltCount).toBe(1);
  });

  it("a real class after the award stays the day's contribution beside a coach entry for the promotion day", async () => {
    const student = await makeStudent(fx, "per-realclass", { baselineKind: "AWARD" });
    await prisma.attendanceRecord.create({
      data: {
        studentId: student.id, academyId: fx.academy.id, organizationId: fx.org.id, occurredAt: new Date("2026-03-11T00:00:00Z"),
        date: new Date("2026-03-10T00:00:00Z"), type: "CHECKIN", delta: 1, source: "KIOSK",
      },
    });
    expect((await summary(fx, student.id)).atBeltCount).toBe(1);
    await coach(fx, student.id, "2026-03-10", "late entry");
    expect((await summary(fx, student.id)).atBeltCount).toBe(1);
  });
});

describe("coach attendance feedback follows the student's accounting: CUMULATIVE", () => {
  let fx: Fixture;
  beforeAll(async () => { fx = await makeAccountingOrg("CUMULATIVE", "coach-cum"); });
  afterAll(async () => { await fx?.drop(); });

  it("the organization really is CUMULATIVE", async () => {
    const student = await makeStudent(fx, "cum-sanity", { baselineKind: "AWARD" });
    expect((await summary(fx, student.id)).accounting).toBe("CUMULATIVE");
  });

  it("the day of a promotion is NOT history only: the entry counts under the legacy rule and no PER_INTERVAL message is shown", async () => {
    const student = await makeStudent(fx, "cum-promoday", { baselineKind: "AWARD" });
    const before = (await summary(fx, student.id)).atBeltCount;
    expect(await coach(fx, student.id, "2026-03-10", "ceremony class")).toEqual({ ok: true });
    expect((await summary(fx, student.id)).atBeltCount).toBe(before + 1);
    const [stored] = await rows(student.id);
    expect(stored.historyOnly).toBe(false);
    expect(stored.occurredAt.toISOString()).toBe("2026-03-10T18:00:00.000Z"); // midday CR, exactly the legacy stamping
  });

  it("an additional entry the same day ALSO counts (there is no daily limit under the legacy rule) and no daily-limit message is shown", async () => {
    const student = await makeStudent(fx, "cum-sameday", { baselineKind: "AWARD" });
    const before = (await summary(fx, student.id)).atBeltCount;
    expect(await coach(fx, student.id, "2026-03-11", "first")).toEqual({ ok: true });
    expect(await coach(fx, student.id, "2026-03-11", "again")).toEqual({ ok: true });
    expect((await summary(fx, student.id)).atBeltCount).toBe(before + 2);
  });

  it("an additional entry on the promotion day counts too", async () => {
    const student = await makeStudent(fx, "cum-promoday-twice", { baselineKind: "AWARD" });
    const before = (await summary(fx, student.id)).atBeltCount;
    expect(await coach(fx, student.id, "2026-03-10", "first")).toEqual({ ok: true });
    expect(await coach(fx, student.id, "2026-03-10", "again")).toEqual({ ok: true });
    expect((await summary(fx, student.id)).atBeltCount).toBe(before + 2);
  });

  it("a day dated before the belt was awarded is kept but does not count, and the message says exactly that", async () => {
    const student = await makeStudent(fx, "cum-beforebelt", { baselineKind: "AWARD" });
    const before = await summary(fx, student.id);
    expect(await coach(fx, student.id, "2026-02-20")).toEqual({ ok: true, info: "beforeBeltDate" });
    const after = await summary(fx, student.id);
    expect(after.atBeltCount).toBe(before.atBeltCount);
    expect(after.lifetimeCount).toBe(before.lifetimeCount + 1); // still real attendance, in the history
  });

  it("a system tracking-start baseline does not trigger the tracking-start message either", async () => {
    const student = await makeStudent(fx, "cum-trackstart", { baselineKind: "SYSTEM_BASELINE" });
    const before = (await summary(fx, student.id)).atBeltCount;
    expect(await coach(fx, student.id, "2026-03-10")).toEqual({ ok: true });
    expect((await summary(fx, student.id)).atBeltCount).toBe(before + 1);
  });
});
