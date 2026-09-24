import "dotenv/config";
import { getTestPrismaClient } from "../helpers/test-db";
import { afterAll, describe, expect, it } from "vitest";
import { cleanupClassFixtures, makeClassAcademy, makeClassStudent } from "../helpers/class-fixtures";
import { makeAccountingOrg } from "../helpers/accounting-org";

const { listTodaysClasses } = await import("../../src/lib/portal/todays-classes");
const { performCheckIn } = await import("../../src/lib/kiosk/perform-check-in");

/**
 * The portal's list of today's classes (PR 3). Every state is decided by the SAME window function the server uses
 * to accept a check-in (start -30 to start +30 minutes, inclusive), so what the screen calls "open" is exactly what
 * performCheckIn accepts. Days and boundaries are Costa Rica (UTC-6, no DST) - and the integration suite runs with
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

const list = (academy: { id: string; organizationId: string }, studentId: string, now: Date) =>
  listTodaysClasses({ context: ctx(academy), academyId: academy.id, studentId, now });
const states = (rows: Awaited<ReturnType<typeof list>>) => Object.fromEntries(rows.map((r) => [r.name, r.state.kind === "not_open_yet" ? `not_open_yet@${r.state.opensAt}` : r.state.kind]));

describe("today's classes at 18:55 Costa Rica (a Tuesday for a server on Kiritimati time)", () => {
  it("lists MONDAY's active classes in start order with an honest state each, and the 19:00 class is open", async () => {
    const { academy, student } = await scenario();
    const rows = await list(academy, student.id, MON_1855);
    expect(rows.map((r) => r.name)).toEqual(["Morning", "Striking", "Kids", "Early", "Later", "Mat"]); // no Retired (inactive), no Tuesday classes
    expect(states(rows)).toEqual({
      Morning: "closed", // 05:30 - 06:30
      Striking: "closed",
      Kids: "closed", // 16:30 - 17:30
      Early: "closed", // 17:30 - 18:30 has ended
      Later: "open", // 18:30 - 19:30 contains 18:55
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
    expect(states(await list(academy, student.id, at("2026-01-06T01:30:00Z"))).Later).toBe("open");
    expect(states(await list(academy, student.id, at("2026-01-06T01:30:00.001Z"))).Later).toBe("closed");
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
    const instants = ["2026-01-06T00:29:59.999Z", "2026-01-06T00:30:00Z", "2026-01-06T01:30:00Z", "2026-01-06T01:30:00.001Z"].map(at);
    for (const now of instants) {
      const { student } = await makeClassStudent(academy.id, academy.organizationId);
      const listed = states(await list(academy, student.id, now)).Later === "open";
      const result = await performCheckIn({ academyId: academy.id, context: ctx(academy), studentId: student.id, source: "PORTAL", now, pickedClassSessionId: byName.Later.id, pickPolicy: "OPEN_ONLY" });
      expect(result.ok, now.toISOString()).toBe(listed);
    }
  });
});
