import "dotenv/config";
import { getTestPrismaClient } from "../helpers/test-db";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { requireEnv } from "../../src/lib/env";
import { digestLookupSecret } from "../../src/lib/crypto";
import { cleanupClassFixtures, makeClassAcademy, makeClassStudent } from "../helpers/class-fixtures";

/**
 * The two owner-approved kiosk rules, through the REAL route handlers:
 *  1. ONE check-in window everywhere: a class is open from its start - 30 minutes to its scheduled end + 30 minutes,
 *     inclusive, using its own duration (America/Costa_Rica). The kiosk has no outside-window fallback: with no class
 *     open the attempt is refused and nothing is written (a coach can record the attendance), and the student-facing
 *     "not this class" correction obeys the same window.
 *  2. Explicit selection when windows overlap: one open class -> selected automatically; several -> the student is asked
 *     BEFORE anything is written; the selection is validated again on submission and a valid selection always wins.
 * Offline recovery (a queued replay) is separate: it is evaluated at its ORIGINAL instant, is never refused, and is kept
 * for staff review as UNMATCHED (never counted) whenever it cannot be attributed unambiguously.
 *
 * Time is Costa Rica (UTC-6, no DST). Only `Date` is faked (the routes read the clock); the database is real.
 */
const { POST: checkInRoute } = await import("../../src/app/api/kiosk/check-in/route");
const { POST: reassignRoute } = await import("../../src/app/api/kiosk/reassign/route");
const { reassignAttendance } = await import("../../src/lib/kiosk/reassign-attendance");

const prisma = getTestPrismaClient();
const pepper = requireEnv("CODE_PEPPER");

const academyIds: string[] = [];

afterEach(() => vi.useRealTimers());
afterAll(async () => {
  await prisma.kioskAttempt.deleteMany({ where: { academyId: { in: academyIds } } });
  await cleanupClassFixtures();
});

/** Costa Rica Monday 2026-01-05 h:m:s.ms (UTC-6; hours past 23 roll into Tuesday). */
const mon = (h: number, m: number, s = 0, ms = 0) => new Date(Date.UTC(2026, 0, 5, h + 6, m, s, ms));

type Json = Record<string, unknown>;

/**
 * Calls a route handler with the clock frozen at `now`. The clock is NOT restored here (concurrent calls share it, and one
 * finishing must not hand a still-running request the real time); `afterEach` restores it.
 */
async function call(route: (request: Request) => Promise<Response>, url: string, body: unknown, now: Date) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now);
  const response = await route(
    new Request(`http://localhost${url}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.9" },
      body: JSON.stringify(body),
    }),
  );
  return { status: response.status, json: (await response.json()) as Json };
}

/**
 * One academy with a real kiosk token:
 *   A 18:00-19:00 -> open 17:30-19:30    B 19:00-20:00 -> open 18:30-20:30   (A and B overlap 18:30-19:30)
 *   C Mon 22:00 for 120 min -> open 21:30-00:30 next day    D Tue 00:10 for 60 min -> open Mon 23:40-Tue 01:40
 *   Z Monday 12:00 for 60 min (a lone class far from the others: open 11:30-13:30)
 */
async function fixture() {
  const { academy, sessions } = await makeClassAcademy([
    { dayOfWeek: "MONDAY", startTime: "18:00", durationMinutes: 60, name: "A", type: "GI" },
    { dayOfWeek: "MONDAY", startTime: "19:00", durationMinutes: 60, name: "B", type: "NO_GI" },
    { dayOfWeek: "MONDAY", startTime: "22:00", durationMinutes: 120, name: "C", type: "OPEN_MAT" },
    { dayOfWeek: "TUESDAY", startTime: "00:10", durationMinutes: 60, name: "D", type: "KIDS" },
    { dayOfWeek: "MONDAY", startTime: "12:00", durationMinutes: 60, name: "Z", type: "STRIKING", countsTowardPromotion: false },
  ]);
  const token = `kiosk-window-token-${academy.id}`;
  await prisma.academy.update({ where: { id: academy.id }, data: { kioskTokenHash: digestLookupSecret(token, pepper) } });
  academyIds.push(academy.id);
  const byName = Object.fromEntries(sessions.map((s) => [s.name, s]));
  const student = (label: string) => makeClassStudent(academy.id, academy.organizationId, { label });
  const checkIn = (body: Json, now: Date) => call(checkInRoute, "/api/kiosk/check-in", { academySlug: academy.slug, token, ...body }, now);
  const reassign = (body: Json, now: Date) => call(reassignRoute, "/api/kiosk/reassign", { academySlug: academy.slug, token, ...body }, now);
  const rows = (studentId: string) => prisma.attendanceRecord.findMany({ where: { studentId }, orderBy: { occurredAt: "asc" } });
  return { academy, byName, student, checkIn, reassign, rows };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

describe("rule 1: no class open -> unavailable, nothing written (there is no outside-window fallback)", () => {
  it("zero open classes: 400 no_open_class, no attendance of any kind, and a coach can still record it", async () => {
    const f = await fixture();
    const { student, code } = await f.student("zero");
    const { status, json } = await f.checkIn({ code }, mon(15, 0));
    expect(status).toBe(400);
    expect(json).toEqual({ ok: false, error: "no_open_class" });
    expect(await f.rows(student.id)).toHaveLength(0);
  });

  it("exact boundaries through the route: 1 ms before a window opens and 1 ms after it closes are refused, both edges accepted", async () => {
    const f = await fixture();
    // Z: 12:00-13:00 -> open 11:30:00.000 .. 13:30:00.000, inclusive.
    const cases: Array<[string, Date, boolean]> = [
      ["11:29:59.999", mon(11, 29, 59, 999), false],
      ["11:30:00.000", mon(11, 30), true],
      ["13:30:00.000", mon(13, 30), true],
      ["13:30:00.001", mon(13, 30, 0, 1), false],
    ];
    for (const [label, now, accepted] of cases) {
      const { student, code } = await f.student(label);
      const { status, json } = await f.checkIn({ code }, now);
      expect(status, label).toBe(accepted ? 200 : 400);
      if (!accepted) expect(json.error, label).toBe("no_open_class");
      expect(await f.rows(student.id), label).toHaveLength(accepted ? 1 : 0);
    }
  });

  it("the old fallback is gone: selecting a class that is not open (even one of today's) is refused, and nothing is written", async () => {
    const f = await fixture();
    const { student, code } = await f.student("fallback");
    const { status, json } = await f.checkIn({ code, pickedClassSessionId: f.byName.A.id }, mon(15, 0));
    expect(status).toBe(400);
    expect(json).toMatchObject({ ok: false, error: "class_not_open", openClasses: [] });
    expect(await f.rows(student.id)).toHaveLength(0);
  });

  it("a live refusal never counts as a wrong-code guess: many refusals in a row do not lock the kiosk out", async () => {
    const f = await fixture();
    const { student, code } = await f.student("no-lockout");
    for (let i = 0; i < 7; i++) {
      const { status, json } = await f.checkIn({ code }, mon(15, 0));
      expect(status).toBe(400);
      expect(json.error).toBe("no_open_class");
    }
    // Still not locked out: the very next tap at a time a class is open succeeds.
    expect((await f.checkIn({ code }, mon(12, 10))).status).toBe(200);
    expect(await f.rows(student.id)).toHaveLength(1);
  });
});

describe("rule 2: one class open -> automatic; several -> ask first, nothing written until the student chooses", () => {
  it("exactly one open class is selected automatically (AUTO) and the confirmation names it", async () => {
    const f = await fixture();
    const { student, code } = await f.student("one");
    const { status, json } = await f.checkIn({ code }, mon(17, 40)); // only A
    expect(status).toBe(200);
    expect(json.matchedClass).toMatchObject({ id: f.byName.A.id, name: "A", startTime: "18:00" });
    expect(json.canCorrect).toBe(false); // nothing else was open to correct it to
    const [row] = await f.rows(student.id);
    expect(row.classSessionId).toBe(f.byName.A.id);
    expect(row.matchSource).toBe("AUTO");
  });

  it("several open classes: 400 class_selection_required with the picker's classes (name, scheduled range, real type) and NOTHING written", async () => {
    const f = await fixture();
    const { student, code } = await f.student("many");
    const { status, json } = await f.checkIn({ code }, mon(18, 40));
    expect(status).toBe(400);
    expect(json.error).toBe("class_selection_required");
    expect(json.openClasses).toEqual([
      { id: f.byName.A.id, name: "A", startTime: "18:00", endTime: "19:00", type: "GI" },
      { id: f.byName.B.id, name: "B", startTime: "19:00", endTime: "20:00", type: "NO_GI" },
    ]);
    expect(await f.rows(student.id)).toHaveLength(0);
  });

  it("cancelling or abandoning the picker creates no attendance: the picker request can be repeated any number of times and writes nothing", async () => {
    const f = await fixture();
    const { student, code } = await f.student("cancel");
    for (let i = 0; i < 3; i++) expect((await f.checkIn({ code }, mon(18, 40 + i))).json.error).toBe("class_selection_required");
    expect(await f.rows(student.id)).toHaveLength(0);
  });

  it("the student's choice is recorded exactly as chosen (STUDENT_PICKED) - even the class that is NOT nearest - and wins over any other match", async () => {
    const f = await fixture();
    for (const name of ["A", "B"] as const) {
      const { student, code } = await f.student(`pick ${name}`);
      const { status, json } = await f.checkIn({ code, pickedClassSessionId: f.byName[name].id }, mon(18, 40)); // B is nearest, A is picked
      expect(status, name).toBe(200);
      expect(json.matchedClass, name).toMatchObject({ id: f.byName[name].id });
      const [row] = await f.rows(student.id);
      expect(row.classSessionId, name).toBe(f.byName[name].id);
      expect(row.matchSource, name).toBe("STUDENT_PICKED");
      expect(json.canCorrect, name).toBe(true); // the other class was open too
    }
  });

  it("a class that closes while the picker is open: the submission is refused, explained with FRESH choices, and nothing is written", async () => {
    const f = await fixture();
    const { student, code } = await f.student("closes");
    // The picker was shown at 19:29 (A and B open); the student taps A at 19:30:00.001, one millisecond after A closed.
    expect((await f.checkIn({ code }, mon(19, 29))).json.error).toBe("class_selection_required");
    const { status, json } = await f.checkIn({ code, pickedClassSessionId: f.byName.A.id }, mon(19, 30, 0, 1));
    expect(status).toBe(400);
    expect(json.error).toBe("class_not_open");
    expect(json.openClasses).toEqual([{ id: f.byName.B.id, name: "B", startTime: "19:00", endTime: "20:00", type: "NO_GI" }]);
    expect(await f.rows(student.id)).toHaveLength(0);
    // ...and choosing from the refreshed list works.
    expect((await f.checkIn({ code, pickedClassSessionId: f.byName.B.id }, mon(19, 30, 0, 2))).status).toBe(200);
  });

  it("the selection is validated again on submission: an unknown id and another academy's class are invalid_class", async () => {
    const f = await fixture();
    const other = await fixture();
    const { student, code } = await f.student("tamper");
    for (const id of ["nope", "", other.byName.A.id]) {
      const { status, json } = await f.checkIn({ code, pickedClassSessionId: id }, mon(18, 40));
      expect(status).toBe(400);
      expect(json).toEqual({ ok: false, error: "invalid_class" });
    }
    expect(await f.rows(student.id)).toHaveLength(0);
  });

  it("a malformed selection field is an invalid_request, not a check-in", async () => {
    const f = await fixture();
    const { student, code } = await f.student("malformed");
    expect((await f.checkIn({ code, pickedClassSessionId: 42 }, mon(18, 40))).json.error).toBe("invalid_request");
    expect(await f.rows(student.id)).toHaveLength(0);
  });

  it("duplicate submissions (a double-tap on the picker, or a retry) write one attendance; the rest are already_checked_in", async () => {
    const f = await fixture();
    const { student, code } = await f.student("dupes");
    const results = await Promise.all(Array.from({ length: 6 }, () => f.checkIn({ code, pickedClassSessionId: f.byName.B.id }, mon(18, 40))));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.json.error === "already_checked_in")).toHaveLength(5);
    expect(await f.rows(student.id)).toHaveLength(1);
  });

  it("a second class on the same day is still recorded (the one-counted-attendance-per-day rule is untouched and tested in promotion-daily-limit-channels)", async () => {
    const f = await fixture();
    const { student, code } = await f.student("daily");
    expect((await f.checkIn({ code, pickedClassSessionId: f.byName.A.id }, mon(18, 40))).status).toBe(200);
    expect((await f.checkIn({ code, pickedClassSessionId: f.byName.B.id }, mon(19, 40))).status).toBe(200);
    expect(await f.rows(student.id)).toHaveLength(2);
  });

  it("midnight crossing: at Monday 23:50 both C (22:00-00:00, open until 00:30) and D (00:10, opened 23:40) are open, so the student is asked; each is filed under its OWN day", async () => {
    const f = await fixture();
    const { student: s1, code: c1 } = await f.student("midnight C");
    const asked = await f.checkIn({ code: c1 }, mon(23, 50));
    expect(asked.json.error).toBe("class_selection_required");
    expect((asked.json.openClasses as Array<{ name: string; endTime: string }>).map((c) => [c.name, c.endTime])).toEqual([["C", "00:00"], ["D", "01:10"]]);
    expect((await f.checkIn({ code: c1, pickedClassSessionId: f.byName.C.id }, mon(23, 50))).status).toBe(200);
    const { student: s2, code: c2 } = await f.student("midnight D");
    expect((await f.checkIn({ code: c2, pickedClassSessionId: f.byName.D.id }, mon(23, 50))).status).toBe(200);
    expect((await f.rows(s1.id))[0].date.toISOString().slice(0, 10)).toBe("2026-01-05"); // Monday's class
    expect((await f.rows(s2.id))[0].date.toISOString().slice(0, 10)).toBe("2026-01-06"); // Tuesday's class, opened the evening before
    // After midnight, past C's close (00:30:00.001) only D is open: automatic, filed under Tuesday.
    const { student: s3, code: c3 } = await f.student("after C closed");
    expect((await f.checkIn({ code: c3 }, mon(24, 30, 0, 1))).json.matchedClass).toMatchObject({ name: "D" });
    expect((await f.rows(s3.id))[0].date.toISOString().slice(0, 10)).toBe("2026-01-06");
    // ...and at exactly 00:30:00 C is still open (inclusive) alongside D.
    const { code: c4 } = await f.student("at C close");
    expect((await f.checkIn({ code: c4 }, mon(24, 30))).json.error).toBe("class_selection_required");
  });
});

describe("the student's own 'not this class' correction obeys the same window", () => {
  async function recorded(f: Fixture, label: string, className: "A" | "B" | "C", now: Date) {
    const { student, code } = await f.student(label);
    const made = await f.checkIn({ code, pickedClassSessionId: f.byName[className].id }, now);
    expect(made.status, label).toBe(200);
    return { student, code, recordId: made.json.attendanceRecordId as string };
  }

  it("lists only the OTHER classes that were open when the attendance was recorded, with name, range and type", async () => {
    const f = await fixture();
    const { recordId } = await recorded(f, "list", "A", mon(18, 40));
    const { status, json } = await f.reassign({ attendanceRecordId: recordId }, mon(18, 41));
    expect(status).toBe(200);
    expect(json.picklist).toEqual([{ id: f.byName.B.id, name: "B", startTime: "19:00", endTime: "20:00", type: "NO_GI" }]);
  });

  it("moves the attendance to a class that was open at that instant, and refuses one that was not (classNotOpen), leaving the row untouched", async () => {
    const f = await fixture();
    const { student, recordId } = await recorded(f, "move", "A", mon(18, 40));
    const refused = await f.reassign({ attendanceRecordId: recordId, classSessionId: f.byName.C.id }, mon(18, 41)); // C opens 21:30
    expect(refused.status).toBe(400);
    expect(refused.json.error).toBe("classNotOpen");
    expect((await f.rows(student.id))[0].classSessionId).toBe(f.byName.A.id);

    const moved = await f.reassign({ attendanceRecordId: recordId, classSessionId: f.byName.B.id }, mon(18, 41));
    expect(moved.status).toBe(200);
    expect(moved.json.matchedClass).toMatchObject({ name: "B" });
    const [row] = await f.rows(student.id);
    expect(row.classSessionId).toBe(f.byName.B.id);
    expect(row.matchSource).toBe("STUDENT_PICKED");
    expect(row.occurredAt.toISOString()).toBe(mon(18, 40).toISOString()); // the raw instant survives
  });

  it("is judged at the RECORD's instant, not the moment of the correction: a later request cannot reach a class that was closed at tap time, nor lose one that was open", async () => {
    const f = await fixture();
    const { student, recordId } = await recorded(f, "later", "A", mon(18, 40));
    // Hours later (Tuesday 09:00) B is long closed, but it WAS open when the student tapped.
    expect((await f.reassign({ attendanceRecordId: recordId, classSessionId: f.byName.B.id }, mon(33, 0))).status).toBe(200);
    // C was not open at 18:40, and asking at 22:00 (when C is open) does not change that.
    const denied = await f.reassign({ attendanceRecordId: recordId, classSessionId: f.byName.C.id }, mon(22, 0));
    expect(denied.json.error).toBe("classNotOpen");
    expect((await f.rows(student.id))[0].classSessionId).toBe(f.byName.B.id);
  });

  it("an unknown class, or another academy's, is invalidClass; a class the student already has an attendance in is alreadyRecorded", async () => {
    const f = await fixture();
    const other = await fixture();
    const { student, code, recordId } = await recorded(f, "invalid", "A", mon(18, 40));
    expect((await f.reassign({ attendanceRecordId: recordId, classSessionId: "nope" }, mon(18, 41))).json.error).toBe("invalidClass");
    expect((await f.reassign({ attendanceRecordId: recordId, classSessionId: other.byName.B.id }, mon(18, 41))).json.error).toBe("invalidClass");
    expect((await f.checkIn({ code, pickedClassSessionId: f.byName.B.id }, mon(18, 45))).status).toBe(200);
    expect((await f.reassign({ attendanceRecordId: recordId, classSessionId: f.byName.B.id }, mon(18, 46))).json.error).toBe("alreadyRecorded");
    expect(await f.rows(student.id)).toHaveLength(2);
  });

  it("midnight crossing: correcting from C to D moves the attendance to D's own day (Tuesday), and back to Monday when moved back", async () => {
    const f = await fixture();
    const { student, recordId } = await recorded(f, "midnight move", "C", mon(23, 50));
    expect((await f.rows(student.id))[0].date.toISOString().slice(0, 10)).toBe("2026-01-05");
    expect((await f.reassign({ attendanceRecordId: recordId, classSessionId: f.byName.D.id }, mon(23, 51))).status).toBe(200);
    let [row] = await f.rows(student.id);
    expect([row.classSessionId, row.date.toISOString().slice(0, 10)]).toEqual([f.byName.D.id, "2026-01-06"]);
    expect((await f.reassign({ attendanceRecordId: recordId, classSessionId: f.byName.C.id }, mon(23, 52))).status).toBe(200);
    [row] = await f.rows(student.id);
    expect([row.classSessionId, row.date.toISOString().slice(0, 10)]).toEqual([f.byName.C.id, "2026-01-05"]);
  });

  it("a coach is different: a staff correction is NOT bound by the window and can move an attendance to any class of that day", async () => {
    const f = await fixture();
    const { student, recordId } = await recorded(f, "coach", "A", mon(18, 40));
    const result = await reassignAttendance(recordId, f.byName.C.id, {
      actorUserId: null,
      matchSource: "STAFF_CORRECTED",
      expectedAcademyId: f.academy.id,
      context: { kind: "kiosk", organizationId: f.academy.organizationId, academyId: f.academy.id },
    });
    expect(result.ok).toBe(true);
    const [row] = await f.rows(student.id);
    expect([row.classSessionId, row.matchSource]).toEqual([f.byName.C.id, "STAFF_CORRECTED"]);
  });
});

describe("offline recovery: a queued attendance is evaluated at its ORIGINAL instant and is never refused or discarded", () => {
  // Tuesday 02:00 CR: when connectivity came back. Every queued tap below is under 12 hours older, so its instant is
  // verifiable (the bound is tested separately); nothing but D is open at this moment.
  const REPLAYED_AT = mon(26, 0);
  const replay = (f: Fixture, body: Json, queuedAt: unknown, now: Date = REPLAYED_AT) => f.checkIn({ ...body, queuedAt }, now);

  it("exactly one class was open at the original instant -> attributed to it (AUTO), stamped with the ORIGINAL instant and day, not the replay time", async () => {
    const f = await fixture();
    const { student, code } = await f.student("replay one");
    const { status, json } = await replay(f, { code }, mon(17, 40).getTime());
    expect(status).toBe(200);
    expect(json.matchedClass).toMatchObject({ name: "A" });
    const [row] = await f.rows(student.id);
    expect([row.classSessionId, row.matchSource]).toEqual([f.byName.A.id, "AUTO"]);
    expect(row.occurredAt.toISOString()).toBe(mon(17, 40).toISOString());
    expect(row.date.toISOString().slice(0, 10)).toBe("2026-01-05");
  });

  it("uses the original instant, not the replay-time state: replayed while TWO classes are open now, a tap from when only one was open is still that one", async () => {
    const f = await fixture();
    const { student, code } = await f.student("replay original");
    const { status, json } = await replay(f, { code }, mon(17, 40).getTime(), mon(18, 40)); // now: A and B open; then: only A
    expect(status).toBe(200);
    expect(json.matchedClass).toMatchObject({ name: "A" });
    expect((await f.rows(student.id))[0].classSessionId).toBe(f.byName.A.id);
  });

  it("SEVERAL classes were open and no selection was recorded -> retained as UNMATCHED for staff review, never counted toward promotion", async () => {
    const f = await fixture();
    const { student, code } = await f.student("replay ambiguous");
    const { status, json } = await replay(f, { code }, mon(18, 40).getTime());
    expect(status).toBe(200); // never refused, never asked (nobody is at the tablet)
    expect(json.matchedClass).toBeNull();
    const [row] = await f.rows(student.id);
    expect([row.classSessionId, row.matchSource]).toEqual([null, "UNMATCHED"]);
    expect(row.occurredAt.toISOString()).toBe(mon(18, 40).toISOString());
    expect(row.voidedAt).toBeNull(); // kept, not voided
  });

  it("a recorded selection that was valid at the original instant is honored (STUDENT_PICKED)", async () => {
    const f = await fixture();
    const { student, code } = await f.student("replay selection");
    const { status } = await replay(f, { code, pickedClassSessionId: f.byName.B.id }, mon(18, 40).getTime());
    expect(status).toBe(200);
    const [row] = await f.rows(student.id);
    expect([row.classSessionId, row.matchSource]).toEqual([f.byName.B.id, "STUDENT_PICKED"]);
  });

  it("a recorded selection that was NOT valid at the original instant is not discarded and not forced onto the class: it is retained UNMATCHED", async () => {
    const f = await fixture();
    const { student, code } = await f.student("replay bad selection");
    // A had closed at 19:30; at 19:40 only B was open, but the recorded choice was A.
    const { status } = await replay(f, { code, pickedClassSessionId: f.byName.A.id }, mon(19, 40).getTime());
    expect(status).toBe(200);
    const [row] = await f.rows(student.id);
    expect([row.classSessionId, row.matchSource]).toEqual([null, "UNMATCHED"]);
  });

  it("NO class was open at the original instant (a legacy or unresolvable tap) -> retained UNMATCHED for staff review, not dropped", async () => {
    const f = await fixture();
    const { student, code } = await f.student("replay none");
    const { status } = await replay(f, { code }, mon(15, 0).getTime());
    expect(status).toBe(200);
    const [row] = await f.rows(student.id);
    expect([row.classSessionId, row.matchSource]).toEqual([null, "UNMATCHED"]);
    expect(row.occurredAt.toISOString()).toBe(mon(15, 0).toISOString());
  });

  it("an instant that cannot be verified (malformed, in the future, older than 12 hours) is still KEPT - as UNMATCHED at the server clock, and is not attributed to whatever class is open now", async () => {
    const f = await fixture();
    const now = mon(18, 40); // two classes are open right now
    for (const [label, queuedAt] of [
      ["malformed", "yesterday"],
      ["future", now.getTime() + 60_000],
      ["stale", now.getTime() - 13 * 60 * 60 * 1000],
    ] as const) {
      const { student, code } = await f.student(`replay ${label}`);
      const { status } = await replay(f, { code }, queuedAt, now);
      expect(status, label).toBe(200);
      const [row] = await f.rows(student.id);
      expect([row.classSessionId, row.matchSource], label).toEqual([null, "UNMATCHED"]);
      expect(row.occurredAt.toISOString(), label).toBe(now.toISOString());
    }
    // ...and with ONE class open right now, an unverifiable instant still does not pick it.
    const { student, code } = await f.student("replay stale, one open");
    expect((await replay(f, { code }, "garbage", mon(17, 40))).status).toBe(200);
    expect((await f.rows(student.id))[0].matchSource).toBe("UNMATCHED");
  });

  it("a replay is never refused for its class: it never returns no_open_class / class_selection_required / class_not_open / invalid_class", async () => {
    const f = await fixture();
    const cases: Array<[Json, unknown]> = [
      [{}, mon(15, 0).getTime()],
      [{}, mon(18, 40).getTime()],
      [{ pickedClassSessionId: "nope" }, mon(18, 40).getTime()],
      [{ pickedClassSessionId: f.byName.A.id }, mon(15, 0).getTime()],
      [{}, "garbage"],
    ];
    for (const [i, [body, queuedAt]] of cases.entries()) {
      const { student, code } = await f.student(`never refused ${i}`);
      const { status, json } = await replay(f, { code, ...body }, queuedAt, mon(18, 40));
      expect(status, `case ${i}`).toBe(200);
      expect(json.ok, `case ${i}`).toBe(true);
      expect(await f.rows(student.id), `case ${i}`).toHaveLength(1);
    }
  });

  it("one unmatched attendance per student per Costa Rica day: a second unmatched replay the same day is already_checked_in (a definitive answer, not a loss)", async () => {
    const f = await fixture();
    const { student, code } = await f.student("replay twice");
    expect((await replay(f, { code }, mon(15, 0).getTime())).status).toBe(200);
    const again = await replay(f, { code }, mon(15, 5).getTime());
    expect(again.json.error).toBe("already_checked_in");
    expect(await f.rows(student.id)).toHaveLength(1);
  });

  it("a wrong code in a replay is still invalid_code (a real verdict about the code, and the only kind that counts toward the lockout)", async () => {
    const f = await fixture();
    const { status, json } = await replay(f, { code: "not-a-code" }, mon(17, 40).getTime());
    expect(status).toBe(400);
    expect(json.error).toBe("invalid_code");
  });

  it("an UNMATCHED replay can be resolved by the student at the kiosk within the window, or by a coach", async () => {
    const f = await fixture();
    const { student, code } = await f.student("resolve");
    const { json } = await replay(f, { code }, mon(18, 40).getTime());
    const recordId = json.attendanceRecordId as string;
    // The picklist for the record offers the classes open at ITS instant (both A and B), since it has no class yet.
    const list = await f.reassign({ attendanceRecordId: recordId }, mon(33, 5));
    expect((list.json.picklist as Array<{ name: string }>).map((c) => c.name)).toEqual(["A", "B"]);
    expect((await f.reassign({ attendanceRecordId: recordId, classSessionId: f.byName.C.id }, mon(33, 6))).json.error).toBe("classNotOpen");
    expect((await f.reassign({ attendanceRecordId: recordId, classSessionId: f.byName.B.id }, mon(33, 7))).status).toBe(200);
    expect((await f.rows(student.id))[0].classSessionId).toBe(f.byName.B.id);
  });
});
