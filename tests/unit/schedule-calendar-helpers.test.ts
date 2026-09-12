import { describe, expect, it } from "vitest";
import { DateTime } from "luxon";
import {
  SUNDAY_FIRST_DAYS,
  DAY_OF_WEEK_BY_LUXON_WEEKDAY,
  CLASS_TYPE_COLOR_CLASS,
  addMinutesToClockTime,
  startOfSundayWeek,
} from "@/app/[locale]/(staff)/admin/schedule/calendar-helpers";
import { ClassType, DayOfWeek } from "@/generated/prisma/client";

describe("SUNDAY_FIRST_DAYS", () => {
  it("runs Sunday -> Saturday, the opposite of queries.ts's Monday-first DAY_ORDER", () => {
    expect(SUNDAY_FIRST_DAYS).toEqual([
      "SUNDAY",
      "MONDAY",
      "TUESDAY",
      "WEDNESDAY",
      "THURSDAY",
      "FRIDAY",
      "SATURDAY",
    ]);
  });
});

describe("DAY_OF_WEEK_BY_LUXON_WEEKDAY", () => {
  it("maps luxon's 1(Mon)..7(Sun) weekday to the matching DayOfWeek", () => {
    expect(DAY_OF_WEEK_BY_LUXON_WEEKDAY[1]).toBe(DayOfWeek.MONDAY);
    expect(DAY_OF_WEEK_BY_LUXON_WEEKDAY[7]).toBe(DayOfWeek.SUNDAY);
  });
});

describe("CLASS_TYPE_COLOR_CLASS", () => {
  it("has one class-* token per ClassType enum member", () => {
    for (const type of Object.values(ClassType)) {
      expect(CLASS_TYPE_COLOR_CLASS[type]).toMatch(/^bg-class-/);
    }
  });
});

describe("startOfSundayWeek", () => {
  it("rolls a Friday back to the preceding Sunday", () => {
    const friday = DateTime.fromISO("2026-09-11"); // a Friday
    expect(startOfSundayWeek(friday).toISODate()).toBe("2026-09-06");
  });

  it("leaves a Sunday unchanged", () => {
    const sunday = DateTime.fromISO("2026-09-06");
    expect(startOfSundayWeek(sunday).toISODate()).toBe("2026-09-06");
  });
});

describe("addMinutesToClockTime", () => {
  it("adds a plain 60-minute duration within the same hour boundary", () => {
    expect(addMinutesToClockTime("18:00", 60)).toEqual({ hour: 19, minute: 0, label: "19:00" });
  });

  it("handles a half-hour start crossing into the next hour", () => {
    expect(addMinutesToClockTime("18:30", 60)).toEqual({ hour: 19, minute: 30, label: "19:30" });
  });
});
