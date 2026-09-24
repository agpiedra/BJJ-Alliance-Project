import "dotenv/config";
import { getTestPrismaClient } from "../helpers/test-db";
import { afterAll, describe, expect, it } from "vitest";
import { cleanupClassFixtures, makeClassAcademy, makeClassStudent } from "../helpers/class-fixtures";
import { makeAccountingOrg } from "../helpers/accounting-org";

const { performCheckIn } = await import("../../src/lib/kiosk/perform-check-in");

/**
 * Explicit class selection (PR 3). The PROPOSED shared rule (the owner's specific confirmation of these timing rules is
 * still pending; see the spec's revision 46): a class is OPEN from 30 minutes before its start until
 * 30 minutes after it, inclusive, duration ignored (the same rule automatic matching uses). A class the student
 * explicitly selects is validated FIRST in the shared core and is never overridden by a different nearest-time match.
 *  - OPEN_ONLY (the portal): only an open class of the student's own academy is accepted; otherwise the request is
 *    refused (`invalid_class` for an unknown / inactive / other-academy / other-organization id, `class_not_open`
 *    for a real class outside its window).
 *  - TODAY_ANY (the attended kiosk): the kiosk's outside-window fallback stays - any of TODAY's classes is accepted.
 * All times are Costa Rica (UTC-6, no DST). Monday 2026-01-05 18:30 CR = 2026-01-06T00:30:00Z.
 */
const prisma = getTestPrismaClient();
afterAll(cleanupClassFixtures);

const ctx = (academy: { id: string; organizationId: string }) => ({ kind: "kiosk" as const, organizationId: academy.organizationId, academyId: academy.id });
const at = (iso: string) => new Date(iso);

const MON_1829_59_999 = at("2026-01-06T00:29:59.999Z");
const MON_1830 = at("2026-01-06T00:30:00Z");
const MON_1930 = at("2026-01-06T01:30:00Z");
const MON_1930_001 = at("2026-01-06T01:30:00.001Z");
const MON_1330 = at("2026-01-05T19:30:00Z");
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
  it("19:00 class: refused 1 ms before it opens, accepted at 18:30:00, accepted at 19:30:00, refused 1 ms after it closes", async () => {
    const { academy, byName } = await scenario();
    const cases: Array<[string, Date, boolean]> = [
      ["18:29:59.999", MON_1829_59_999, false],
      ["18:30:00", MON_1830, true],
      ["19:30:00", MON_1930, true],
      ["19:30:00.001", MON_1930_001, false],
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

describe("TODAY_ANY (kiosk): the outside-window fallback is kept, exactly as before", () => {
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
      // Monday 13:30 CR: the 12:00 class is outside its window, so this is a PICKED (not automatically matched)
      // attendance - the path that reported a non-counting class as "the day had already counted".
      const picked = await pick(academy, student.id, cls.id, MON_1330, "TODAY_ANY");
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
