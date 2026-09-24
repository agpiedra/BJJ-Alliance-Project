import "dotenv/config";
import { getTestPrismaClient } from "../helpers/test-db";
import { afterAll, describe, expect, it } from "vitest";
import { cleanupClassFixtures, makeClassAcademy, makeClassStudent } from "../helpers/class-fixtures";
import { makeAccountingOrg } from "../helpers/accounting-org";

const { listTodaysClasses } = await import("../../src/lib/portal/todays-classes");
const { performCheckIn } = await import("../../src/lib/kiosk/perform-check-in");

/**
 * The portal's list of today's classes (PR 3). Every state is decided by the SAME window function the server uses
 * to accept a check-in (owner-confirmed, per class: start - 30 minutes to start + THAT class's duration + 30 minutes,
 * inclusive), so what the screen calls "open" is exactly what performCheckIn accepts. Days and boundaries are Costa Rica (UTC-6, no DST) - and the integration suite runs with
 * TZ=Pacific/Kiritimati (UTC+14), so a server-local calendar boundary would put the wrong weekday on screen.
 *
 * Monday 2026-01-05 18:55 CR = 2026-01-06T00:55:00Z (already TUESDAY in Kiritimati).
 */
const prisma = getTestPrismaClient();
afterAll(cleanupClassFixtures);

const at = (iso: string) => new Date(iso);
const MON_1855 = at("2026-01-06T00:55:00Z");
const MON_2350 = at("2026-01-06T05:50:00Z");
const TUE_0005 = at("2026-01-06T06:05:00Z");
const SUN_1200 = at("2026-01-04T18:00:00Z");

const ctx = (academy: { id: string; organizationId: string }) => ({ kind: "kiosk" as const, organizationId: academy.organizationId, academyId: academy.id });

async function scenario() {
  const { academy, sessions } = await makeClassAcademy([
    { dayOfWeek: "MONDAY", startTime: "06:00", name: "Morning", type: "GI" },
    { dayOfWeek: "MONDAY", startTime: "12:00", name: "Striking", type: "STRIKING", countsTowardPromotion: false },
    { dayOfWeek: "MONDAY", startTime: "18:00", name: "Early", type: "NO_GI" },
    { dayOfWeek: "MONDAY", startTime: "19:00", name: "Later", type: "GI" },
    { dayOfWeek: "MONDAY", startTime: "20:00", name: "Mat", type: "OPEN_MAT" },
    { dayOfWeek: "MONDAY", startTime: "17:00", name: "Kids", type: "KIDS" },
    { dayOfWeek: "MONDAY", startTime: "21:30", name: "Retired", type: "GI", active: false },
    { dayOfWeek: "TUESDAY", startTime: "00:10", name: "Midnight", type: "GI" },
    { dayOfWeek: "TUESDAY", startTime: "18:00", name: "TuesdayEvening", type: "GI" },
  ]);
  const byName = Object.fromEntries(sessions.map((s) => [s.name, s]));
  const { student } = await makeClassStudent(academy.id, academy.organizationId);
  return { academy, byName, student };
}

const view = (academy: { id: string; organizationId: string }, studentId: string, now: Date) =>
  listTodaysClasses({ context: ctx(academy), academyId: academy.id, studentId, now });
const list = (academy: { id: string; organizationId: string }, studentId: string, now: Date) => view(academy, studentId, now).then((v) => v.classes);
const states = (rows: Awaited<ReturnType<typeof list>>) => Object.fromEntries(rows.map((r) => [r.name, r.state.kind === "not_open_yet" ? `not_open_yet@${r.state.opensAt}` : r.state.kind]));

describe("today's classes at 18:55 Costa Rica (a Tuesday for a server on Kiritimati time)", () => {
  it("lists MONDAY's active classes in start order with an honest state each, and the 19:00 class is open", async () => {
    const { academy, student } = await scenario();
    const rows = await list(academy, student.id, MON_1855);
    expect(rows.map((r) => r.name)).toEqual(["Morning", "Striking", "Kids", "Early", "Later", "Mat"]); // no Retired (inactive), no Tuesday classes
    expect(states(rows)).toEqual({
      Morning: "closed", // 05:30 - 07:30
      Striking: "closed",
      Kids: "closed", // 17:00-18:00 class: 16:30 - 18:30 has ended
      Early: "open", // 18:00-19:00 class: 17:30 - 19:30 contains 18:55 (still running)
      Later: "open", // 19:00-20:00 class: 18:30 - 20:30 contains 18:55 (overlaps Early: overlaps are expected)
      Mat: "not_open_yet@19:30", // opens at 19:30
    });
  });

  it("shows the real modality of every class and whether it counts toward promotion (nothing is relabelled GI/No-Gi)", async () => {
    const { academy, student } = await scenario();
    const rows = await list(academy, student.id, MON_1855);
    const by = Object.fromEntries(rows.map((r) => [r.name, r]));
    expect(by.Morning.type).toBe("GI");
    expect(by.Early.type).toBe("NO_GI");
    expect(by.Striking.type).toBe("STRIKING");
    expect(by.Kids.type).toBe("KIDS");
    expect(by.Mat.type).toBe("OPEN_MAT");
    expect(by.Striking.countsTowardPromotion).toBe(false);
    expect(by.Later.countsTowardPromotion).toBe(true);
    expect([by.Later.startTime, by.Later.endTime]).toEqual(["19:00", "20:00"]);
  });
});

describe("midnight boundaries", () => {
  it("Monday 23:50: the 00:10 Tuesday class is already open (window opened 23:40) and listed; Monday's are closed", async () => {
    const { academy, student } = await scenario();
    const s = states(await list(academy, student.id, MON_2350));
    expect(s.Midnight).toBe("open");
    expect(s.Mat).toBe("closed");
    expect(s.TuesdayEvening).toBeUndefined(); // tomorrow's evening class is not today's and not open
  });

  it("Tuesday 00:05: Tuesday's classes are today's (Midnight open, evening not yet open); Monday's are gone", async () => {
    const { academy, student } = await scenario();
    const s = states(await list(academy, student.id, TUE_0005));
    expect(s).toEqual({ Midnight: "open", TuesdayEvening: "not_open_yet@17:30" });
  });

  it("one instant before the window opens is not_open_yet and the class shows its opening time; at 18:30:00.000 it is open", async () => {
    const { academy, student } = await scenario();
    expect(states(await list(academy, student.id, at("2026-01-06T00:29:59.999Z"))).Later).toBe("not_open_yet@18:30");
    expect(states(await list(academy, student.id, at("2026-01-06T00:30:00Z"))).Later).toBe("open");
    expect(states(await list(academy, student.id, at("2026-01-06T02:30:00Z"))).Later).toBe("open"); // 19:00 + 60 + 30 = 20:30, inclusive
    expect(states(await list(academy, student.id, at("2026-01-06T02:30:00.001Z"))).Later).toBe("closed");
  });
});

describe("days with no classes, isolation, and already-checked-in", () => {
  it("a day with no classes is an empty list (the page explains it)", async () => {
    const { academy, student } = await scenario();
    expect(await list(academy, student.id, SUN_1200)).toEqual([]);
  });

  it("only the student's own academy is listed, never another academy's or another organization's classes", async () => {
    const { academy, student } = await scenario();
    await makeClassAcademy([{ dayOfWeek: "MONDAY", startTime: "19:00", name: "SomebodyElse" }]);
    const otherOrg = await makeAccountingOrg("PER_INTERVAL", "todays-other");
    try {
      await makeClassAcademy([{ dayOfWeek: "MONDAY", startTime: "19:00", name: "ForeignOrg" }], otherOrg.org.id);
      const names = (await list(academy, student.id, MON_1855)).map((r) => r.name);
      expect(names).not.toContain("SomebodyElse");
      expect(names).not.toContain("ForeignOrg");
    } finally {
      await prisma.classSession.deleteMany({ where: { organizationId: otherOrg.org.id } });
      await otherOrg.drop();
    }
  });

  it("a class the student already checked in to shows checked_in; a voided check-in does not; a different day's row does not", async () => {
    const { academy, byName, student } = await scenario();
    const record = await prisma.attendanceRecord.create({
      data: { studentId: student.id, academyId: academy.id, organizationId: academy.organizationId, classSessionId: byName.Later.id, occurredAt: MON_1855, date: new Date("2026-01-05T00:00:00Z"), type: "CHECKIN", delta: 1, source: "PORTAL", matchSource: "STUDENT_PICKED" },
    });
    expect(states(await list(academy, student.id, MON_1855)).Later).toBe("checked_in");
    await prisma.attendanceRecord.update({ where: { id: record.id }, data: { voidedAt: new Date(), voidReason: "mistake" } });
    expect(states(await list(academy, student.id, MON_1855)).Later).toBe("open");
    // Last Monday's attendance at the same class is not today's.
    await prisma.attendanceRecord.create({
      data: { studentId: student.id, academyId: academy.id, organizationId: academy.organizationId, classSessionId: byName.Later.id, occurredAt: at("2025-12-30T00:55:00Z"), date: new Date("2025-12-29T00:00:00Z"), type: "CHECKIN", delta: 1, source: "PORTAL", matchSource: "STUDENT_PICKED" },
    });
    expect(states(await list(academy, student.id, MON_1855)).Later).toBe("open");
  });
});

describe("the screen and the server agree: a class is listed as open exactly when performCheckIn accepts it", () => {
  it("at each window boundary of the 19:00 class, listed state === the server's answer to an OPEN_ONLY selection", async () => {
    const { academy, byName } = await scenario();
    const instants = ["2026-01-06T00:29:59.999Z", "2026-01-06T00:30:00Z", "2026-01-06T02:30:00Z", "2026-01-06T02:30:00.001Z"].map(at);
    for (const now of instants) {
      const { student } = await makeClassStudent(academy.id, academy.organizationId);
      const listed = states(await list(academy, student.id, now)).Later === "open";
      const result = await performCheckIn({ academyId: academy.id, context: ctx(academy), studentId: student.id, source: "PORTAL", now, pickedClassSessionId: byName.Later.id });
      expect(result.ok, now.toISOString()).toBe(listed);
    }
  });
});

/**
 * Classes of DIFFERENT durations, overlapping windows and a class that runs past midnight, in one academy - the owner's
 * examples: A 18:00-19:00 (17:30-19:30), B 19:00-20:30 (18:30-21:00), C 18:30-19:30 (18:00-20:00), plus Late 23:30-00:30
 * (23:00-01:00 the next day). At EVERY boundary of every class the listed state must equal the server's answer.
 */
describe("different durations and overlapping windows: the list and the server agree at every boundary", () => {
  async function durations() {
    const { academy, sessions } = await makeClassAcademy([
      { dayOfWeek: "MONDAY", startTime: "18:00", durationMinutes: 60, name: "A" },
      { dayOfWeek: "MONDAY", startTime: "19:00", durationMinutes: 90, name: "B" },
      { dayOfWeek: "MONDAY", startTime: "18:30", durationMinutes: 60, name: "C" },
      { dayOfWeek: "MONDAY", startTime: "23:30", durationMinutes: 60, name: "Late" },
    ]);
    return { academy, byName: Object.fromEntries(sessions.map((s) => [s.name, s])) };
  }
  const mon = (h: number, m: number, s = 0, ms = 0) => new Date(Date.UTC(2026, 0, 5, h + 6, m, s, ms)); // CR Monday 2026-01-05

  it("each row shows its own end time and its own window: 18:40 has A, B and C all open at once", async () => {
    const { academy } = await durations();
    const { student } = await makeClassStudent(academy.id, academy.organizationId);
    const rows = await list(academy, student.id, mon(18, 40));
    expect(rows.map((r) => [r.name, r.startTime, r.endTime])).toEqual([
      ["A", "18:00", "19:00"],
      ["C", "18:30", "19:30"],
      ["B", "19:00", "20:30"],
      ["Late", "23:30", "00:30"],
    ]);
    expect(states(rows)).toEqual({ A: "open", C: "open", B: "open", Late: "not_open_yet@23:00" });
  });

  it("A 17:30-19:30, B 18:30-21:00, C 18:00-20:00, Late 23:00-01:00: at each window's opening, closing and 1 ms either side, listed === accepted", async () => {
    const { academy, byName } = await durations();
    const windows: Record<string, [Date, Date]> = { A: [mon(17, 30), mon(19, 30)], B: [mon(18, 30), mon(21, 0)], C: [mon(18, 0), mon(20, 0)], Late: [mon(23, 0), mon(25, 0)] };
    for (const [name, [opens, closes]] of Object.entries(windows)) {
      const cases: Array<[Date, boolean]> = [
        [new Date(opens.getTime() - 1), false],
        [opens, true],
        [closes, true],
        [new Date(closes.getTime() + 1), false],
      ];
      for (const [now, expectedOpen] of cases) {
        const { student } = await makeClassStudent(academy.id, academy.organizationId);
        const listedOpen = states(await list(academy, student.id, now))[name] === "open";
        const result = await performCheckIn({ academyId: academy.id, context: ctx(academy), studentId: student.id, source: "PORTAL", now, pickedClassSessionId: byName[name].id });
        expect(listedOpen, `${name} listed at ${now.toISOString()}`).toBe(expectedOpen);
        expect(result.ok, `${name} accepted at ${now.toISOString()}`).toBe(expectedOpen);
      }
    }
  });

  it("a class that runs past midnight is still listed (open) after Costa Rica midnight until its own close, then disappears", async () => {
    const { academy } = await durations();
    const { student } = await makeClassStudent(academy.id, academy.organizationId);
    const lateAt = async (now: Date) => states(await list(academy, student.id, now)).Late;
    expect(await lateAt(mon(23, 59, 59, 999))).toBe("open"); // Monday, before midnight
    expect(await lateAt(mon(24, 0))).toBe("open"); // Tuesday 00:00 CR: yesterday's class, still inside its window
    expect(await lateAt(mon(25, 0))).toBe("open"); // Tuesday 01:00:00 = 23:30 + 60 + 30, inclusive
    expect(await lateAt(mon(25, 0, 0, 1))).toBeUndefined(); // gone: it belongs to yesterday and has closed
  });
});

/**
 * Time-driven availability (PR 3 follow-up): a portal left open must move from "opens at" to open to closed, and
 * roll over at Costa Rica midnight, WITHOUT a submission. The server tells the page the next instant the list can
 * change (`nextChangeAt`) and its own clock (`serverNow`); the page refreshes itself at that instant. These tests
 * simulate the open tab: time advances boundary by boundary and NOTHING is submitted.
 */
describe("advancing time without submitting: the announced boundary is exactly when the list changes", () => {
  const snapshot = (rows: Awaited<ReturnType<typeof list>>) => JSON.stringify(rows.map((r) => [r.name, r.state]));

  it("reports the server clock and a boundary strictly in the future", async () => {
    const { academy, student } = await scenario();
    const v = await view(academy, student.id, MON_1855);
    expect(v.serverNow).toBe(MON_1855.toISOString());
    expect(new Date(v.nextChangeAt).getTime()).toBeGreaterThan(MON_1855.getTime());
  });

  it("walks Monday 17:00 CR through Tuesday 01:00 CR: nothing changes before each announced boundary, something changes AT it", async () => {
    const { academy, student } = await scenario();
    let now = at("2026-01-05T23:00:00Z"); // Monday 17:00 CR
    const end = at("2026-01-06T07:00:00Z").getTime(); // Tuesday 01:00 CR
    const boundaries: string[] = [];
    let previous = new Date(0);
    let guard = 0;
    while (now.getTime() < end && guard++ < 40) {
      const current = await view(academy, student.id, now);
      const next = new Date(current.nextChangeAt);
      expect(next.getTime()).toBeGreaterThan(now.getTime());
      expect(next.getTime()).toBeGreaterThan(previous.getTime());
      const justBefore = await list(academy, student.id, new Date(next.getTime() - 1));
      expect(snapshot(justBefore), `nothing may change before ${next.toISOString()}`).toBe(snapshot(current.classes));
      const atBoundary = await list(academy, student.id, next);
      expect(snapshot(atBoundary), `something must change at ${next.toISOString()}`).not.toBe(snapshot(current.classes));
      boundaries.push(next.toISOString());
      previous = next;
      now = next;
    }
    expect(guard).toBeLessThan(40);
    // Monday: Kids opens 16:30... the fixture's Monday classes plus the 00:10 Tuesday class (opens 23:40) and the
    // day rolling over at 00:00 CR must all have been announced, in order.
    expect(boundaries).toContain("2026-01-06T00:30:00.000Z"); // 18:30 CR: Later opens
    expect(boundaries).toContain("2026-01-06T02:30:00.001Z"); // 20:30:00.001 CR: Later closes (19:00 + 60 min + 30 min)
    expect(boundaries).toContain("2026-01-06T05:40:00.000Z"); // 23:40 CR: the 00:10 Tuesday class opens (adjacent day)
    expect(boundaries).toContain("2026-01-06T06:00:00.000Z"); // 00:00 CR: the day rolls over
    expect([...boundaries].sort()).toEqual(boundaries);
  });

  it("the sequence a student would watch: Later goes not-open-yet -> open -> closed, Monday's list is replaced at midnight, all with nothing submitted", async () => {
    const { academy, student } = await scenario();
    const seen: string[] = [];
    for (const iso of ["2026-01-06T00:29:59.999Z", "2026-01-06T00:30:00Z", "2026-01-06T02:30:00Z", "2026-01-06T02:30:00.001Z"]) {
      seen.push(states(await list(academy, student.id, at(iso))).Later);
    }
    expect(seen).toEqual(["not_open_yet@18:30", "open", "open", "closed"]);

    const before = await list(academy, student.id, at("2026-01-06T05:59:59.999Z")); // Monday 23:59:59.999 CR
    const after = await list(academy, student.id, at("2026-01-06T06:00:00Z")); // Tuesday 00:00:00.000 CR
    expect(before.map((r) => r.name)).toContain("Mat"); // Monday's classes are today's until the day ends
    expect(after.map((r) => r.name)).not.toContain("Mat");
    expect(after.map((r) => r.name)).toContain("TuesdayEvening");
    expect(states(after).Midnight).toBe("open"); // its window opened at 23:40 Monday and is still open
  });

  it("with no classes today the next boundary is still the next Costa Rica midnight (the empty-day message must roll over too)", async () => {
    const { academy, student } = await scenario();
    const v = await view(academy, student.id, SUN_1200);
    expect(v.classes).toEqual([]);
    // Sunday 2026-01-04 12:00 CR; the fixture has Monday classes, so the first boundary is Monday's Kids window
    // (16:30 Monday) or midnight, whichever is first: midnight Monday 00:00 CR = 2026-01-05T06:00:00Z.
    expect(v.nextChangeAt).toBe("2026-01-05T06:00:00.000Z");
  });
});
