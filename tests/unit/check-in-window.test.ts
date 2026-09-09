import { describe, expect, it } from "vitest";
import { toAttendanceDate } from "@/lib/scheduling/zone";
import { isWithinCheckInWindow, getCheckInWindow } from "@/lib/scheduling/check-in-window";

describe("toAttendanceDate", () => {
  it("keeps a morning CR check-in on the same UTC calendar day", () => {
    // 08:00 CR (UTC-6) = 14:00 UTC, same day
    const occurredAt = new Date("2026-03-10T14:00:00.000Z");
    expect(toAttendanceDate(occurredAt).toISOString().slice(0, 10)).toBe("2026-03-10");
  });

  it("rolls an evening CR check-in back to the CR day, even though it's already tomorrow in UTC", () => {
    // 19:00 CR (UTC-6) on March 10 = 01:00 UTC on March 11
    const occurredAt = new Date("2026-03-11T01:00:00.000Z");
    expect(toAttendanceDate(occurredAt).toISOString().slice(0, 10)).toBe("2026-03-10");
  });
});

describe("isWithinCheckInWindow", () => {
  const mondaySixAm = { dayOfWeek: "MONDAY" as const, startTime: "06:00", durationMinutes: 60 };

  it("is true exactly at the session start (CR time)", () => {
    // Monday 2026-03-09 06:00 CR = 12:00 UTC
    expect(isWithinCheckInWindow(mondaySixAm, new Date("2026-03-09T12:00:00.000Z"))).toBe(true);
  });

  it("is true 29 minutes before start", () => {
    expect(isWithinCheckInWindow(mondaySixAm, new Date("2026-03-09T11:31:00.000Z"))).toBe(true);
  });

  it("is false 31 minutes before start", () => {
    expect(isWithinCheckInWindow(mondaySixAm, new Date("2026-03-09T11:29:00.000Z"))).toBe(false);
  });

  it("is true 30 minutes after the session's end (start + duration + 30)", () => {
    // start 12:00 UTC + 60 min duration + 30 min window = 13:30 UTC
    expect(isWithinCheckInWindow(mondaySixAm, new Date("2026-03-09T13:30:00.000Z"))).toBe(true);
  });

  it("is false 31 minutes after the session's end", () => {
    expect(isWithinCheckInWindow(mondaySixAm, new Date("2026-03-09T13:32:00.000Z"))).toBe(false);
  });

  it("is false on the wrong day of week even at the exact right time", () => {
    // Tuesday 2026-03-10 06:00 CR = 12:00 UTC — one day later, same clock time
    expect(isWithinCheckInWindow(mondaySixAm, new Date("2026-03-10T12:00:00.000Z"))).toBe(false);
  });

  it("accepts a check-in whose window crosses CR midnight on the tail end", () => {
    const wednesdayLateNight = { dayOfWeek: "WEDNESDAY" as const, startTime: "23:50", durationMinutes: 60 };
    // Window end = Wed 23:50 + 60min + 30min = Thu 01:20 CR = 2026-06-18T07:20:00.000Z
    expect(isWithinCheckInWindow(wednesdayLateNight, new Date("2026-06-18T07:20:00.000Z"))).toBe(true);
  });

  it("accepts a check-in whose window crosses CR midnight on the head end", () => {
    const tuesdayJustAfterMidnight = { dayOfWeek: "TUESDAY" as const, startTime: "00:05", durationMinutes: 10 };
    // 25 minutes before a Tuesday 00:05 start = Monday 23:40 CR = 2026-06-16T05:40:00.000Z
    expect(isWithinCheckInWindow(tuesdayJustAfterMidnight, new Date("2026-06-16T05:40:00.000Z"))).toBe(true);
  });

  it("still rejects a check-in on the wrong day even near a midnight-crossing session", () => {
    const wednesdayLateNight = { dayOfWeek: "WEDNESDAY" as const, startTime: "23:50", durationMinutes: 60 };
    // Well outside any window: Thu 03:00 CR, more than an hour after the Thu 01:20 window end
    expect(isWithinCheckInWindow(wednesdayLateNight, new Date("2026-06-18T09:00:00.000Z"))).toBe(false);
  });
});
