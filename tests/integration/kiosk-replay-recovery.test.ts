import "dotenv/config";
import { getTestPrismaClient } from "../helpers/test-db";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { requireEnv } from "../../src/lib/env";
import { digestLookupSecret } from "../../src/lib/crypto";
import { cleanupClassFixtures, makeClassAcademy, makeClassStudent } from "../helpers/class-fixtures";
import { ALLIANCE_ATTENDANCE_CONFIG } from "../helpers/promotion-config";

/**
 * Offline recovery for queued check-ins that cannot be attributed (the stale-replay defect).
 *
 * Reproduced first: two distinct taps for one student on different days, both older than the 12-hour bound, replayed on
 * the same day. The first became an UNMATCHED attendance dated the REPLAY day (its original timestamp and selected class
 * gone), and the second was refused by the one-unmatched-per-day index and answered `already_checked_in`, which the
 * device queue treats as final - so a distinct attendance was deleted.
 *
 * The rule now: a queued event that cannot be attributed unambiguously is retained as UNTRUSTED EVIDENCE for staff
 * (its raw timestamp, its parsed instant, whether that instant could be verified, and the class the device says was
 * selected), never as an attendance. It never takes a day, never collides with another event, is idempotent per event, and
 * counts for nothing until a coach records it on the original day.
 *
 * Time is Costa Rica (UTC-6, no DST). Only `Date` is faked (the route reads the clock); the database is real.
 */
const { POST: checkInRoute } = await import("../../src/app/api/kiosk/check-in/route");
const { getAtBeltSummary } = await import("../../src/lib/students/attendance-summary");

const prisma = getTestPrismaClient();
const pepper = requireEnv("CODE_PEPPER");
const academyIds: string[] = [];

afterEach(() => vi.useRealTimers());
afterAll(async () => {
  await prisma.queuedCheckIn.deleteMany({ where: { academyId: { in: academyIds } } });
  await prisma.kioskAttempt.deleteMany({ where: { academyId: { in: academyIds } } });
  await cleanupClassFixtures();
});

/** Costa Rica Monday 2026-01-05 h:m:s.ms (UTC-6; hours past 23 roll into the following days). */
const mon = (h: number, m: number, s = 0, ms = 0) => new Date(Date.UTC(2026, 0, 5, h + 6, m, s, ms));
const tue = (h: number, m: number) => mon(24 + h, m);
const REPLAY_DAY = mon(3 * 24 + 10, 0); // Thursday 2026-01-08 10:00 CR: older than 12 hours for every tap below

type Json = Record<string, unknown>;

async function call(url: string, body: unknown, now: Date) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now);
  const response = await checkInRoute(
    new Request(`http://localhost${url}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.11" },
      body: JSON.stringify(body),
    }),
  );
  return { status: response.status, json: (await response.json()) as Json };
}

/**
 *   A  Monday 18:00-19:00 (open 17:30-19:30)   B  Monday 19:00-20:00 (open 18:30-20:30)   -> both open Mon 18:30-19:30
 *   T  Tuesday 18:00-19:00 (open 17:30-19:30)
 */
async function fixture() {
  const { academy, sessions } = await makeClassAcademy([
    { dayOfWeek: "MONDAY", startTime: "18:00", durationMinutes: 60, name: "A", type: "GI" },
    { dayOfWeek: "MONDAY", startTime: "19:00", durationMinutes: 60, name: "B", type: "NO_GI" },
    { dayOfWeek: "TUESDAY", startTime: "18:00", durationMinutes: 60, name: "T", type: "GI" },
  ]);
  const token = `kiosk-replay-token-${academy.id}`;
  await prisma.academy.update({ where: { id: academy.id }, data: { kioskTokenHash: digestLookupSecret(token, pepper) } });
  academyIds.push(academy.id);
  const byName = Object.fromEntries(sessions.map((s) => [s.name, s]));
  const student = (label: string) => makeClassStudent(academy.id, academy.organizationId, { label });
  const replay = (body: Json, now: Date = REPLAY_DAY) => call("/api/kiosk/check-in", { academySlug: academy.slug, token, ...body }, now);
  const attendance = (studentId: string) => prisma.attendanceRecord.findMany({ where: { studentId }, orderBy: { occurredAt: "asc" } });
  const evidence = (studentId: string) => prisma.queuedCheckIn.findMany({ where: { studentId }, orderBy: { claimedAt: "asc" } });
  return { academy, byName, student, replay, attendance, evidence };
}

describe("two distinct stale taps replayed on the same day (the reproduced defect)", () => {
  it("both are retained SEPARATELY as evidence: neither becomes an attendance on the replay day, and neither is answered already_checked_in", async () => {
    const f = await fixture();
    const { student, code } = await f.student("stale pair");
    const e1 = await f.replay({ code, pickedClassSessionId: f.byName.A.id, queuedAt: mon(18, 40).getTime(), eventId: "evt-1" });
    const e2 = await f.replay({ code, pickedClassSessionId: f.byName.T.id, queuedAt: tue(18, 40).getTime(), eventId: "evt-2" });

    expect([e1.status, e2.status]).toEqual([200, 200]); // a definitive, non-discarding answer for each
    expect([e1.json.error, e2.json.error]).toEqual([undefined, undefined]);
    expect(e1.json).toMatchObject({ ok: true, retained: true, duplicate: false });
    expect(e2.json).toMatchObject({ ok: true, retained: true, duplicate: false });
    expect(e1.json.reviewId).not.toBe(e2.json.reviewId);

    expect(await f.attendance(student.id)).toHaveLength(0); // nothing was dated the replay day, nothing was lost into one row
    expect(await f.evidence(student.id)).toHaveLength(2);
  });

  it("neither counts for anything: not toward promotion, not in the lifetime total", async () => {
    const f = await fixture();
    const { student, code } = await f.student("no credit");
    await f.replay({ code, pickedClassSessionId: f.byName.A.id, queuedAt: mon(18, 40).getTime(), eventId: "evt-1" });
    await f.replay({ code, pickedClassSessionId: f.byName.T.id, queuedAt: tue(18, 40).getTime(), eventId: "evt-2" });
    const summary = await getAtBeltSummary(student.id, student.organizationId, ALLIANCE_ATTENDANCE_CONFIG);
    expect([summary.atBeltCount, summary.lifetimeCount]).toEqual([0, 0]);
  });
});

describe("replaying each event twice", () => {
  it("the SAME event again is recognized as a retry (an idempotent 200 with duplicate: true), not stored twice and not answered already_checked_in", async () => {
    const f = await fixture();
    const { student, code } = await f.student("retry");
    const first = [
      await f.replay({ code, pickedClassSessionId: f.byName.A.id, queuedAt: mon(18, 40).getTime(), eventId: "evt-1" }),
      await f.replay({ code, pickedClassSessionId: f.byName.T.id, queuedAt: tue(18, 40).getTime(), eventId: "evt-2" }),
    ];
    const again = [
      await f.replay({ code, pickedClassSessionId: f.byName.A.id, queuedAt: mon(18, 40).getTime(), eventId: "evt-1" }),
      await f.replay({ code, pickedClassSessionId: f.byName.T.id, queuedAt: tue(18, 40).getTime(), eventId: "evt-2" }),
    ];
    expect(again.map((r) => r.status)).toEqual([200, 200]);
    expect(again.map((r) => r.json.duplicate)).toEqual([true, true]);
    expect(again.map((r) => r.json.reviewId)).toEqual(first.map((r) => r.json.reviewId)); // the same two records
    expect(await f.evidence(student.id)).toHaveLength(2);
  });

  it("entries queued before this change have no event id: the same tap replayed twice is still one event, two taps are still two", async () => {
    const f = await fixture();
    const { student, code } = await f.student("legacy");
    for (let i = 0; i < 2; i++) await f.replay({ code, queuedAt: mon(18, 40).getTime() }); // no eventId
    for (let i = 0; i < 2; i++) await f.replay({ code, queuedAt: tue(18, 40).getTime() });
    expect(await f.evidence(student.id)).toHaveLength(2);
  });

  it("an event whose timestamp is unreadable is told apart ONLY by its device id: the same id is a retry, a different id is a different event", async () => {
    const f = await fixture();
    const { student, code } = await f.student("unreadable");
    const first = await f.replay({ code, queuedAt: "garbage", eventId: "evt-a" });
    const retry = await f.replay({ code, queuedAt: "garbage", eventId: "evt-a" });
    const other = await f.replay({ code, queuedAt: "garbage", eventId: "evt-b" });
    expect([first.json.duplicate, retry.json.duplicate, other.json.duplicate]).toEqual([false, true, false]);
    expect(retry.json.reviewId).toBe(first.json.reviewId);
    expect(other.json.reviewId).not.toBe(first.json.reviewId);
    expect(await f.evidence(student.id)).toHaveLength(2);
  });

  it("a retry after a coach dealt with the event is still a retry: it neither re-opens the evidence nor records an attendance", async () => {
    const f = await fixture();
    const { student, code } = await f.student("retry after resolve");
    const first = await f.replay({ code, pickedClassSessionId: f.byName.A.id, queuedAt: mon(18, 40).getTime(), eventId: "evt-1" });
    await prisma.queuedCheckIn.update({ where: { id: first.json.reviewId as string }, data: { status: "DISMISSED", dismissReason: "test" } });
    const again = await f.replay({ code, pickedClassSessionId: f.byName.A.id, queuedAt: mon(18, 40).getTime(), eventId: "evt-1" });
    expect(again.json).toMatchObject({ ok: true, retained: true, duplicate: true });
    expect((await f.evidence(student.id))[0].status).toBe("DISMISSED");
    expect(await f.attendance(student.id)).toHaveLength(0);
  });
});

describe("a pre-existing unmatched attendance on the replay day", () => {
  it("does not make a stale replay 'already checked in': the event is still retained, and the existing row is untouched", async () => {
    const f = await fixture();
    const { student, code } = await f.student("preexisting");
    const existing = await prisma.attendanceRecord.create({
      data: {
        studentId: student.id, academyId: f.academy.id, organizationId: f.academy.organizationId, classSessionId: null,
        occurredAt: REPLAY_DAY, date: new Date(Date.UTC(2026, 0, 8)), type: "CHECKIN", delta: 1, source: "STAFF", matchSource: "UNMATCHED",
      },
    });
    const { status, json } = await f.replay({ code, pickedClassSessionId: f.byName.A.id, queuedAt: mon(18, 40).getTime(), eventId: "evt-1" });
    expect(status).toBe(200);
    expect(json).toMatchObject({ ok: true, retained: true, duplicate: false });
    expect(await f.evidence(student.id)).toHaveLength(1);
    const rows = await f.attendance(student.id);
    expect(rows.map((r) => r.id)).toEqual([existing.id]);
  });
});

describe("the original timestamp and the selected class are preserved as claimed, never replaced by the replay date", () => {
  it("a stale event keeps its raw timestamp, its parsed instant, the selected class, and is marked unverified", async () => {
    const f = await fixture();
    const { student, code } = await f.student("preserve");
    const claimed = mon(18, 40);
    const { status } = await f.replay({ code, pickedClassSessionId: f.byName.A.id, queuedAt: claimed.getTime(), eventId: "evt-1" });
    expect(status).toBe(200);
    const [row] = await f.evidence(student.id);
    expect(row).toMatchObject({
      academyId: f.academy.id, organizationId: f.academy.organizationId, status: "PENDING", reason: "TIMESTAMP_NOT_VERIFIED",
      claimedAtRaw: String(claimed.getTime()), claimedAtVerified: false, claimedClassSessionId: f.byName.A.id, eventKey: "id:evt-1",
    });
    expect(row.claimedAt?.toISOString()).toBe(claimed.toISOString()); // the claimed day (Monday), not the replay day (Thursday)
    expect(row.receivedAt.toISOString()).toBe(REPLAY_DAY.toISOString());
  });

  it("a malformed timestamp is kept as raw text with NO parsed instant (never a date), and an unknown selected class is kept as sent", async () => {
    const f = await fixture();
    const { student, code } = await f.student("malformed");
    const { status } = await f.replay({ code, pickedClassSessionId: "no-such-class", queuedAt: "yesterday evening", eventId: "evt-m" });
    expect(status).toBe(200);
    const [row] = await f.evidence(student.id);
    expect(row).toMatchObject({ claimedAtRaw: "yesterday evening", claimedAt: null, claimedAtVerified: false, claimedClassSessionId: "no-such-class", reason: "TIMESTAMP_NOT_VERIFIED" });
    expect(await f.attendance(student.id)).toHaveLength(0);
  });

  it("a timestamp in the future is kept as claimed but never verified, and never attributed to a class that is open now", async () => {
    const f = await fixture();
    const { student, code } = await f.student("future");
    const now = mon(18, 40); // A and B are open right now
    const future = now.getTime() + 60 * 60 * 1000;
    const { status } = await f.replay({ code, queuedAt: future, eventId: "evt-f" }, now);
    expect(status).toBe(200);
    const [row] = await f.evidence(student.id);
    expect(row).toMatchObject({ claimedAtVerified: false, reason: "TIMESTAMP_NOT_VERIFIED" });
    expect(row.claimedAt?.getTime()).toBe(future);
    expect(await f.attendance(student.id)).toHaveLength(0);
  });

  it("an unverified timestamp is never attributed even when exactly one class is open at replay time", async () => {
    const f = await fixture();
    const { student, code } = await f.student("stale but one open now");
    const now = mon(17, 40); // only A is open now
    const { status } = await f.replay({ code, queuedAt: now.getTime() - 20 * 60 * 60 * 1000, eventId: "evt-s" }, now);
    expect(status).toBe(200);
    expect(await f.attendance(student.id)).toHaveLength(0);
    expect(await f.evidence(student.id)).toHaveLength(1);
  });
});

describe("verified events that are still ambiguous are evidence too, and never collide on the day", () => {
  it("two distinct taps on the same original day, each with several classes open, are two evidence records (they used to collide and the second was deleted)", async () => {
    const f = await fixture();
    const { student, code } = await f.student("ambiguous pair");
    const now = mon(20, 0);
    const a = await f.replay({ code, queuedAt: mon(18, 40).getTime(), eventId: "evt-1" }, now);
    const b = await f.replay({ code, queuedAt: mon(18, 45).getTime(), eventId: "evt-2" }, now);
    expect([a.status, b.status]).toEqual([200, 200]);
    const rows = await f.evidence(student.id);
    expect(rows.map((r) => [r.reason, r.claimedAtVerified])).toEqual([["SEVERAL_CLASSES_OPEN", true], ["SEVERAL_CLASSES_OPEN", true]]);
    expect(await f.attendance(student.id)).toHaveLength(0);
  });

  it("no class was open at the claimed instant, or the recorded selection was not open then: evidence with the matching reason", async () => {
    const f = await fixture();
    const now = mon(21, 0);
    const none = await f.student("none open");
    await f.replay({ code: none.code, queuedAt: mon(15, 0).getTime(), eventId: "evt-n" }, now);
    expect((await f.evidence(none.student.id))[0]).toMatchObject({ reason: "NO_CLASS_OPEN", claimedAtVerified: true });
    const bad = await f.student("selection not open");
    await f.replay({ code: bad.code, pickedClassSessionId: f.byName.A.id, queuedAt: mon(19, 40).getTime(), eventId: "evt-b" }, now); // A closed at 19:30
    expect((await f.evidence(bad.student.id))[0]).toMatchObject({ reason: "SELECTION_NOT_OPEN", claimedClassSessionId: f.byName.A.id });
  });
});

describe("what is still attributed automatically (unchanged)", () => {
  it("a verified event with exactly one open class, or a valid recorded selection, becomes a real attendance at its original instant", async () => {
    const f = await fixture();
    const now = mon(21, 0);
    const one = await f.student("one open");
    expect((await f.replay({ code: one.code, queuedAt: mon(17, 40).getTime(), eventId: "evt-1" }, now)).status).toBe(200);
    const [row] = await f.attendance(one.student.id);
    expect([row.classSessionId, row.matchSource, row.occurredAt.toISOString()]).toEqual([f.byName.A.id, "AUTO", mon(17, 40).toISOString()]);
    const picked = await f.student("selected");
    await f.replay({ code: picked.code, pickedClassSessionId: f.byName.B.id, queuedAt: mon(18, 40).getTime(), eventId: "evt-2" }, now);
    expect((await f.attendance(picked.student.id))[0]).toMatchObject({ classSessionId: f.byName.B.id, matchSource: "STUDENT_PICKED" });
    expect(await f.evidence(one.student.id)).toHaveLength(0);
  });

  it("the same attributed event replayed twice is one attendance (the second is already_checked_in, which is correct: it IS the same attendance)", async () => {
    const f = await fixture();
    const now = mon(21, 0);
    const { student, code } = await f.student("attributed twice");
    expect((await f.replay({ code, queuedAt: mon(17, 40).getTime(), eventId: "evt-1" }, now)).status).toBe(200);
    expect((await f.replay({ code, queuedAt: mon(17, 40).getTime(), eventId: "evt-1" }, now)).json.error).toBe("already_checked_in");
    expect(await f.attendance(student.id)).toHaveLength(1);
  });
});
