import "dotenv/config";
import { getTestPrismaClient } from "../helpers/test-db";
import { afterAll, describe, expect, it } from "vitest";
import { cleanupClassFixtures, makeClassAcademy, makeClassStudent } from "../helpers/class-fixtures";
import { makeAccountingOrg } from "../helpers/accounting-org";

const { performCheckIn } = await import("../../src/lib/kiosk/perform-check-in");

/**
 * Explicit class selection (PR 3). The owner-confirmed rule for EVERY class: open from 30 minutes before its scheduled
 * start until 30 minutes after its scheduled END (start + that class's own duration + 30), inclusive at both ends -
 * the same rule automatic matching and the portal list use. Windows of neighbouring classes overlap by design. A class
 * the student explicitly selects is validated FIRST in the shared core and is never overridden by a different
 * nearest-time match.
 *  - OPEN_ONLY (the portal): only an open class of the student's own academy is accepted; otherwise the request is
 *    refused (`invalid_class` for an unknown / inactive / other-academy / other-organization id, `class_not_open`
 *    for a real class outside its window).
 *  - TODAY_ANY (the attended kiosk): the outside-window fallback is kept as it always was; whether it stays is a
 *    SEPARATE owner decision that is still pending.
 * All times are Costa Rica (UTC-6, no DST). Monday 2026-01-05 18:30 CR = 2026-01-06T00:30:00Z.
 */
const prisma = getTestPrismaClient();
afterAll(cleanupClassFixtures);

const ctx = (academy: { id: string; organizationId: string }) => ({ kind: "kiosk" as const, organizationId: academy.organizationId, academyId: academy.id });
const at = (iso: string) => new Date(iso);

const MON_1829_59_999 = at("2026-01-06T00:29:59.999Z");
const MON_1830 = at("2026-01-06T00:30:00Z");
const MON_1930_001 = at("2026-01-06T01:30:00.001Z"); // past the OLD start+30 close: now still inside a 19:00-20:00 class's window
const MON_2030 = at("2026-01-06T02:30:00Z"); // 19:00 + 60 min + 30 min: the exact close
const MON_2030_001 = at("2026-01-06T02:30:00.001Z");
const MON_1330 = at("2026-01-05T19:30:00Z");
const MON_1400 = at("2026-01-05T20:00:00Z");
const MON_2350 = at("2026-01-06T05:50:00Z");

async function scenario() {
  const { academy, sessions } = await makeClassAcademy([
    { dayOfWeek: "MONDAY", startTime: "18:00", name: "Early" },
    { dayOfWeek: "MONDAY", startTime: "19:00", name: "Later" },
    { dayOfWeek: "TUESDAY", startTime: "00:10", name: "Midnight" },
    { dayOfWeek: "TUESDAY", startTime: "18:00", name: "TuesdayClass" },
    { dayOfWeek: "MONDAY", startTime: "21:00", name: "Retired", active: false },
  ]);
  const byName = Object.fromEntries(sessions.map((s) => [s.name, s]));
  return { academy, byName };
}

const pick = (academy: { id: string; organizationId: string }, studentId: string, classId: string, now: Date, pickPolicy: "OPEN_ONLY" | "TODAY_ANY") =>
  performCheckIn({ academyId: academy.id, context: ctx(academy), studentId, source: "PORTAL", now, pickedClassSessionId: classId, pickPolicy });

describe("an explicit selection is honored, not overridden by a nearer automatic match", () => {
  it("at 18:30 both the 18:00 and 19:00 windows are open; picking 19:00 records exactly the 19:00 class", async () => {
    const { academy, byName } = await scenario();
    const { student } = await makeClassStudent(academy.id, academy.organizationId);
    const result = await pick(academy, student.id, byName.Later.id, MON_1830, "OPEN_ONLY");
    expect(result.ok).toBe(true);
    const record = await prisma.attendanceRecord.findFirstOrThrow({ where: { studentId: student.id } });
    expect(record.classSessionId).toBe(byName.Later.id); // the reported defect: it was recorded on the 18:00 class
    expect(record.matchSource).toBe("STUDENT_PICKED");
    expect(record.date.toISOString().slice(0, 10)).toBe("2026-01-05");
    if (result.ok) expect(result.matchedClass?.id).toBe(byName.Later.id);
  });

  it("without a selection, automatic matching is unchanged (the earlier class wins the shared boundary instant)", async () => {
    const { academy, byName } = await scenario();
    const { student, code } = await makeClassStudent(academy.id, academy.organizationId);
    const result = await performCheckIn({ academyId: academy.id, context: ctx(academy), code, source: "KIOSK", now: MON_1830 });
    expect(result.ok).toBe(true);
    const record = await prisma.attendanceRecord.findFirstOrThrow({ where: { studentId: student.id } });
    expect(record.classSessionId).toBe(byName.Early.id);
    expect(record.matchSource).toBe("AUTO");
  });

  it("the kiosk policy honors the selection too (a tampered or repeated request cannot be redirected by matching)", async () => {
    const { academy, byName } = await scenario();
    const { student, code } = await makeClassStudent(academy.id, academy.organizationId);
    const result = await performCheckIn({ academyId: academy.id, context: ctx(academy), code, source: "KIOSK", now: MON_1830, pickedClassSessionId: byName.Later.id, pickPolicy: "TODAY_ANY" });
    expect(result.ok).toBe(true);
    expect((await prisma.attendanceRecord.findFirstOrThrow({ where: { studentId: student.id } })).classSessionId).toBe(byName.Later.id);
  });
});

describe("OPEN_ONLY (portal): the window is validated server-side, inclusive at both ends", () => {
  it("19:00-20:00 class: refused 1 ms before it opens, accepted at 18:30:00, still accepted after its old start+30 close, accepted at 20:30:00 (end + 30), refused 1 ms after", async () => {
    const { academy, byName } = await scenario();
    const cases: Array<[string, Date, boolean]> = [
      ["18:29:59.999", MON_1829_59_999, false],
      ["18:30:00", MON_1830, true],
      ["19:30:00.001", MON_1930_001, true],
      ["20:30:00", MON_2030, true],
      ["20:30:00.001", MON_2030_001, false],
    ];
    for (const [label, now, accepted] of cases) {
      const { student } = await makeClassStudent(academy.id, academy.organizationId, { label });
      const result = await pick(academy, student.id, byName.Later.id, now, "OPEN_ONLY");
      expect(result.ok, label).toBe(accepted);
      if (!accepted) expect(result, label).toEqual({ ok: false, error: "class_not_open" });
      expect(await prisma.attendanceRecord.count({ where: { studentId: student.id } }), label).toBe(accepted ? 1 : 0);
    }
  });

  it("midnight: a class at 00:10 Tuesday is open on Monday 23:50 and is filed under ITS OWN day (Tuesday)", async () => {
    const { academy, byName } = await scenario();
    const { student } = await makeClassStudent(academy.id, academy.organizationId);
    const result = await pick(academy, student.id, byName.Midnight.id, MON_2350, "OPEN_ONLY");
    expect(result.ok).toBe(true);
    const record = await prisma.attendanceRecord.findFirstOrThrow({ where: { studentId: student.id } });
    expect(record.date.toISOString().slice(0, 10)).toBe("2026-01-06");
    expect(record.classSessionId).toBe(byName.Midnight.id);
  });

  it("a real class that is not open right now (Monday 13:30, nothing open) is refused as class_not_open, nothing is written", async () => {
    const { academy, byName } = await scenario();
    const { student } = await makeClassStudent(academy.id, academy.organizationId);
    expect(await pick(academy, student.id, byName.Later.id, MON_1330, "OPEN_ONLY")).toEqual({ ok: false, error: "class_not_open" });
    // A class scheduled for a different weekday is not open either.
    expect(await pick(academy, student.id, byName.TuesdayClass.id, MON_1830, "OPEN_ONLY")).toEqual({ ok: false, error: "class_not_open" });
    expect(await prisma.attendanceRecord.count({ where: { studentId: student.id } })).toBe(0);
  });

  it("tampered selections are refused as invalid_class: unknown id, empty id, inactive class, another academy's class, another organization's class", async () => {
    const { academy, byName } = await scenario();
    const { sessions: otherSessions } = await makeClassAcademy([{ dayOfWeek: "MONDAY", startTime: "19:00", name: "Elsewhere" }]);
    const otherOrg = await makeAccountingOrg("PER_INTERVAL", "explicit-other");
    try {
      const { sessions: foreignSessions } = await makeClassAcademy([{ dayOfWeek: "MONDAY", startTime: "19:00", name: "Foreign" }], otherOrg.org.id);
      const { student } = await makeClassStudent(academy.id, academy.organizationId);
      const ids = ["does-not-exist", "", byName.Retired.id, otherSessions[0].id, foreignSessions[0].id];
      for (const id of ids) {
        expect(await pick(academy, student.id, id, MON_1830, "OPEN_ONLY"), `id "${id}"`).toEqual({ ok: false, error: "invalid_class" });
      }
      expect(await prisma.attendanceRecord.count({ where: { studentId: student.id } })).toBe(0);
    } finally {
      await prisma.classSession.deleteMany({ where: { organizationId: otherOrg.org.id } });
      await otherOrg.drop();
    }
  });
});

/**
 * The owner's examples, all in ONE academy so their windows overlap (overlaps are expected):
 *   A 18:00-19:00 -> open 17:30-19:30;  B 19:00-20:30 -> open 18:30-21:00;  C 18:30-19:30 -> open 18:00-20:00.
 * `mon(h, m)` is the instant of Costa Rica Monday 2026-01-05 h:m (UTC-6; hours past 23 roll into Tuesday).
 */
const mon = (h: number, m: number, s = 0, ms = 0) => new Date(Date.UTC(2026, 0, 5, h + 6, m, s, ms));

describe("every class has its own window: start - 30 .. start + ITS duration + 30, inclusive (the owner's examples)", () => {
  async function ownersExamples() {
    const { academy, sessions } = await makeClassAcademy([
      { dayOfWeek: "MONDAY", startTime: "18:00", durationMinutes: 60, name: "A" },
      { dayOfWeek: "MONDAY", startTime: "19:00", durationMinutes: 90, name: "B" },
      { dayOfWeek: "MONDAY", startTime: "18:30", durationMinutes: 60, name: "C" },
    ]);
    return { academy, byName: Object.fromEntries(sessions.map((s) => [s.name, s])) };
  }

  it("A 17:30-19:30, B 18:30-21:00, C 18:00-20:00: refused 1 ms before opening, accepted at opening and at closing, refused 1 ms after closing", async () => {
    const { academy, byName } = await ownersExamples();
    const expected: Record<string, [Date, Date]> = { A: [mon(17, 30), mon(19, 30)], B: [mon(18, 30), mon(21, 0)], C: [mon(18, 0), mon(20, 0)] };
    for (const [name, [opens, closes]] of Object.entries(expected)) {
      const cases: Array<[string, Date, boolean]> = [
        ["1 ms before opening", new Date(opens.getTime() - 1), false],
        ["at opening", opens, true],
        ["at closing", closes, true],
        ["1 ms after closing", new Date(closes.getTime() + 1), false],
      ];
      for (const [label, now, accepted] of cases) {
        const { student } = await makeClassStudent(academy.id, academy.organizationId, { label: `${name} ${label}` });
        const result = await pick(academy, student.id, byName[name].id, now, "OPEN_ONLY");
        expect(result.ok, `${name} ${label}`).toBe(accepted);
        if (!accepted) expect(result, `${name} ${label}`).toEqual({ ok: false, error: "class_not_open" });
        expect(await prisma.attendanceRecord.count({ where: { studentId: student.id } }), `${name} ${label}`).toBe(accepted ? 1 : 0);
      }
    }
  });

  it("overlap: at 18:40 all three windows are open and each explicit selection records exactly the class the student picked", async () => {
    const { academy, byName } = await ownersExamples();
    for (const name of ["A", "B", "C"]) {
      const { student } = await makeClassStudent(academy.id, academy.organizationId, { label: `pick ${name}` });
      const result = await pick(academy, student.id, byName[name].id, mon(18, 40), "OPEN_ONLY");
      expect(result.ok, name).toBe(true);
      const record = await prisma.attendanceRecord.findFirstOrThrow({ where: { studentId: student.id } });
      expect(record.classSessionId, name).toBe(byName[name].id);
      expect(record.matchSource, name).toBe("STUDENT_PICKED");
    }
  });

  it("overlap: with NO selection the automatic match is deterministic (nearest scheduled start), the same on every request", async () => {
    const { academy, byName } = await ownersExamples();
    // 18:40: C starts 10 min away, B 20, A 40 -> C. 19:40: A has closed; B is 40 away, C 70 -> B.
    for (const [now, expectedName] of [[mon(18, 40), "C"], [mon(19, 40), "B"]] as const) {
      for (let attempt = 0; attempt < 2; attempt++) {
        const { student, code } = await makeClassStudent(academy.id, academy.organizationId, { label: `auto ${expectedName} ${attempt}` });
        const result = await performCheckIn({ academyId: academy.id, context: ctx(academy), code, source: "KIOSK", now });
        expect(result.ok, `${expectedName} #${attempt}`).toBe(true);
        const record = await prisma.attendanceRecord.findFirstOrThrow({ where: { studentId: student.id } });
        expect(record.classSessionId, `${expectedName} #${attempt}`).toBe(byName[expectedName].id);
        expect(record.matchSource).toBe("AUTO");
      }
    }
  });

  it("a selected class that has closed is refused even though ANOTHER class is open at that instant (A closed at 19:30; B and C are open at 19:40)", async () => {
    const { academy, byName } = await ownersExamples();
    const { student } = await makeClassStudent(academy.id, academy.organizationId);
    expect(await pick(academy, student.id, byName.A.id, mon(19, 40), "OPEN_ONLY")).toEqual({ ok: false, error: "class_not_open" });
    expect(await prisma.attendanceRecord.count({ where: { studentId: student.id } })).toBe(0);
  });

  it("automatic matching reads the same window: a lone 18:00-19:00 class matches at 19:30:00 and not at 19:30:00.001", async () => {
    const { academy } = await makeClassAcademy([{ dayOfWeek: "MONDAY", startTime: "18:00", durationMinutes: 60, name: "Only" }]);
    const inside = await makeClassStudent(academy.id, academy.organizationId, { label: "inside" });
    expect((await performCheckIn({ academyId: academy.id, context: ctx(academy), code: inside.code, source: "KIOSK", now: mon(19, 30) })).ok).toBe(true);
    expect((await prisma.attendanceRecord.findFirstOrThrow({ where: { studentId: inside.student.id } })).matchSource).toBe("AUTO");
    const after = await makeClassStudent(academy.id, academy.organizationId, { label: "after" });
    const late = await performCheckIn({ academyId: academy.id, context: ctx(academy), code: after.code, source: "KIOSK", now: mon(19, 30, 0, 1) });
    expect(late.ok).toBe(false);
    if (!late.ok) expect(late.error).toBe("no_active_class"); // no window contains this instant: the attended kiosk offers the picker
  });

  it("a class that runs past midnight stays open until its own close on the NEXT day and is filed under ITS day", async () => {
    // Monday 23:30 for 60 minutes ends Tuesday 00:30 and closes Tuesday 01:00; it opens Monday 23:00.
    const { academy, sessions } = await makeClassAcademy([{ dayOfWeek: "MONDAY", startTime: "23:30", durationMinutes: 60, name: "Late" }]);
    const cases: Array<[string, Date, boolean]> = [
      ["Mon 22:59:59.999", mon(22, 59, 59, 999), false],
      ["Mon 23:00:00", mon(23, 0), true],
      ["Tue 00:45 (the class ended at 00:30, still inside its +30)", mon(24, 45), true],
      ["Tue 01:00:00", mon(25, 0), true],
      ["Tue 01:00:00.001", mon(25, 0, 0, 1), false],
    ];
    for (const [label, now, accepted] of cases) {
      const { student } = await makeClassStudent(academy.id, academy.organizationId, { label });
      const result = await pick(academy, student.id, sessions[0].id, now, "OPEN_ONLY");
      expect(result.ok, label).toBe(accepted);
      if (accepted) {
        const record = await prisma.attendanceRecord.findFirstOrThrow({ where: { studentId: student.id } });
        expect(record.date.toISOString().slice(0, 10), label).toBe("2026-01-05"); // Monday's class, even at Tuesday 01:00
      }
    }
  });

  it("the longest class the schedule editor allows (600 minutes, Monday 22:00) is open until Tuesday 08:30 and refused 1 ms later", async () => {
    const { academy, sessions } = await makeClassAcademy([{ dayOfWeek: "MONDAY", startTime: "22:00", durationMinutes: 600, name: "Marathon" }]);
    const inside = await makeClassStudent(academy.id, academy.organizationId, { label: "inside" });
    expect((await pick(academy, inside.student.id, sessions[0].id, mon(32, 30), "OPEN_ONLY")).ok).toBe(true);
    const outside = await makeClassStudent(academy.id, academy.organizationId, { label: "outside" });
    expect(await pick(academy, outside.student.id, sessions[0].id, mon(32, 30, 0, 1), "OPEN_ONLY")).toEqual({ ok: false, error: "class_not_open" });
  });
});

describe("TODAY_ANY (kiosk): the outside-window fallback is kept, exactly as before (a separate owner decision is pending)", () => {
  it("a class of today that is not open is still accepted and recorded as picked, on today's date", async () => {
    const { academy, byName } = await scenario();
    const { student } = await makeClassStudent(academy.id, academy.organizationId);
    const result = await pick(academy, student.id, byName.Later.id, MON_1330, "TODAY_ANY");
    expect(result.ok).toBe(true);
    const record = await prisma.attendanceRecord.findFirstOrThrow({ where: { studentId: student.id } });
    expect(record.classSessionId).toBe(byName.Later.id);
    expect(record.matchSource).toBe("STUDENT_PICKED");
    expect(record.date.toISOString().slice(0, 10)).toBe("2026-01-05");
  });

  it("a pick that is not one of today's classes falls back to the picker, as before", async () => {
    const { academy, byName } = await scenario();
    const { student } = await makeClassStudent(academy.id, academy.organizationId);
    const result = await pick(academy, student.id, byName.TuesdayClass.id, MON_1330, "TODAY_ANY");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("no_active_class");
      expect(result.picklist?.map((p) => p.name)).toEqual(["Early", "Later"]);
    }
    expect(await prisma.attendanceRecord.count({ where: { studentId: student.id } })).toBe(0);
  });
});

describe("duplicates are refused server-side, including concurrent attempts", () => {
  it("six concurrent attempts at the same explicit class write exactly one row", async () => {
    const { academy, byName } = await scenario();
    const { student } = await makeClassStudent(academy.id, academy.organizationId);
    const results = await Promise.all(Array.from({ length: 6 }, () => pick(academy, student.id, byName.Later.id, MON_1830, "OPEN_ONLY")));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok && r.error === "already_checked_in")).toHaveLength(5);
    expect(await prisma.attendanceRecord.count({ where: { studentId: student.id } })).toBe(1);
  });

  it("concurrent taps on a day with NO classes (unmatched) also write exactly one row; the database itself refuses a second", async () => {
    const { academy: emptyDay } = await makeClassAcademy([{ dayOfWeek: "TUESDAY", startTime: "18:00", name: "Tuesday only" }]);
    const { student } = await makeClassStudent(emptyDay.id, emptyDay.organizationId);
    const tap = () => performCheckIn({ academyId: emptyDay.id, context: ctx(emptyDay), studentId: student.id, source: "PORTAL", now: MON_1330 });
    const results = await Promise.all(Array.from({ length: 8 }, tap));
    expect(results.filter((r) => r.ok)).toHaveLength(1); // the reported defect: 8 were accepted and 8 rows written
    expect(results.filter((r) => !r.ok && r.error === "already_checked_in")).toHaveLength(7);
    const rows = await prisma.attendanceRecord.findMany({ where: { studentId: student.id } });
    expect(rows).toHaveLength(1);
    await expect(
      prisma.attendanceRecord.create({
        data: { studentId: student.id, academyId: emptyDay.id, organizationId: emptyDay.organizationId, occurredAt: MON_1330, date: rows[0].date, type: "CHECKIN", delta: 1, source: "PORTAL", matchSource: "UNMATCHED" },
      }),
    ).rejects.toMatchObject({ code: "P2002" });
  });
});

describe("what the check-in did for progress is reported truthfully for a PICKED class", () => {
  it("a picked class that does not count toward promotion says so (it used to say the day had already counted)", async () => {
    const fx = await makeAccountingOrg("PER_INTERVAL", "explicit-progress");
    try {
      const { academy } = await makeClassAcademy([{ dayOfWeek: "MONDAY", startTime: "12:00", name: "Striking", type: "STRIKING", countsTowardPromotion: false }], fx.org.id);
      const { student } = await makeClassStudent(academy.id, fx.org.id, { rankId: await fx.rankId("WHITE") });
      const cls = await prisma.classSession.findFirstOrThrow({ where: { academyId: academy.id } });
      await prisma.student.update({ where: { id: student.id }, data: { progressBaselineAt: new Date("2026-01-01T00:00:00Z") } });
      // Monday 14:00 CR: the 12:00 class closed at 13:30, so this is a PICKED (not automatically matched)
      // attendance - the path that reported a non-counting class as "the day had already counted".
      const picked = await pick(academy, student.id, cls.id, MON_1400, "TODAY_ANY");
      expect(picked.ok).toBe(true);
      if (picked.ok) expect(picked.progressOutcome).toBe("not_promotion_class");
      // And an open, explicitly selected non-counting class (Monday 12:00 CR) says the same.
      const { student: other } = await makeClassStudent(academy.id, fx.org.id, { rankId: await fx.rankId("WHITE") });
      await prisma.student.update({ where: { id: other.id }, data: { progressBaselineAt: new Date("2026-01-01T00:00:00Z") } });
      const open = await pick(academy, other.id, cls.id, at("2026-01-05T18:00:00Z"), "OPEN_ONLY");
      expect(open.ok).toBe(true);
      if (open.ok) expect(open.progressOutcome).toBe("not_promotion_class");
    } finally {
      await prisma.attendanceRecord.deleteMany({ where: { organizationId: fx.org.id } });
      await prisma.classSession.deleteMany({ where: { organizationId: fx.org.id } });
      await fx.drop();
    }
  });
});
