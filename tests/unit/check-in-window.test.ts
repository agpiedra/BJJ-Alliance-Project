import { describe, expect, it } from "vitest";
import { toAttendanceDate } from "@/lib/scheduling/zone";
import {
  getCheckInWindow,
  isWithinCheckInWindow,
  nextBoundaryAfter,
  occurrencesForToday,
  openOccurrences,
} from "@/lib/scheduling/check-in-window";

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

/**
 * The owner-confirmed rule, for EVERY class: opensAt = start - 30 min; closesAt = start + the class's own configured
 * duration + 30 min; both inclusive; America/Costa_Rica (UTC-6, no DST). There is no shared evening window and no
 * fixed cutoff. These unit tests run with TZ=Pacific/Kiritimati, so a server-local calendar would be 20 hours off.
 * Monday 2026-03-09 18:00 CR = 2026-03-10T00:00:00Z.
 */
describe("getCheckInWindow", () => {
  const monday = new Date("2026-03-10T00:00:00.000Z");

  it("18:00-19:00 class -> 17:30-19:30", () => {
    const w = getCheckInWindow({ dayOfWeek: "MONDAY", startTime: "18:00", durationMinutes: 60 }, monday);
    expect(w.start.toISOString()).toBe("2026-03-09T23:30:00.000Z"); // 17:30 CR
    expect(w.end.toISOString()).toBe("2026-03-10T01:30:00.000Z"); // 19:30 CR
  });

  it("19:00-20:30 class -> 18:30-21:00", () => {
    const w = getCheckInWindow({ dayOfWeek: "MONDAY", startTime: "19:00", durationMinutes: 90 }, monday);
    expect(w.start.toISOString()).toBe("2026-03-10T00:30:00.000Z"); // 18:30 CR
    expect(w.end.toISOString()).toBe("2026-03-10T03:00:00.000Z"); // 21:00 CR
  });

  it("18:30-19:30 class -> 18:00-20:00", () => {
    const w = getCheckInWindow({ dayOfWeek: "MONDAY", startTime: "18:30", durationMinutes: 60 }, monday);
    expect(w.start.toISOString()).toBe("2026-03-10T00:00:00.000Z"); // 18:00 CR
    expect(w.end.toISOString()).toBe("2026-03-10T02:00:00.000Z"); // 20:00 CR
  });

  it("each class uses its OWN duration: a 15-minute and a 180-minute class starting together close at different times", () => {
    const short = getCheckInWindow({ dayOfWeek: "MONDAY", startTime: "18:00", durationMinutes: 15 }, monday);
    const long = getCheckInWindow({ dayOfWeek: "MONDAY", startTime: "18:00", durationMinutes: 180 }, monday);
    expect(short.start).toEqual(long.start);
    expect(short.end.toISOString()).toBe("2026-03-10T00:45:00.000Z"); // 18:45 CR
    expect(long.end.toISOString()).toBe("2026-03-10T03:30:00.000Z"); // 21:30 CR
  });
});

describe("isWithinCheckInWindow", () => {
  // Monday 06:00-07:00 CR: open 05:30 .. 07:30 CR = 11:30Z .. 13:30Z.
  const mondaySixAm = { dayOfWeek: "MONDAY" as const, startTime: "06:00", durationMinutes: 60 };

  it("is true exactly at the session start (CR time)", () => {
    expect(isWithinCheckInWindow(mondaySixAm, new Date("2026-03-09T12:00:00.000Z"))).toBe(true);
  });

  it("opens exactly 30 minutes before the start, inclusive, and not one millisecond earlier", () => {
    expect(isWithinCheckInWindow(mondaySixAm, new Date("2026-03-09T11:30:00.000Z"))).toBe(true);
    expect(isWithinCheckInWindow(mondaySixAm, new Date("2026-03-09T11:29:59.999Z"))).toBe(false);
  });

  it("stays open through the whole class and closes exactly 30 minutes after it ENDS, inclusive, and not one millisecond later", () => {
    // 06:31 CR is 31 minutes after the START; the class runs to 07:00.
    expect(isWithinCheckInWindow(mondaySixAm, new Date("2026-03-09T12:31:00.000Z"))).toBe(true);
    expect(isWithinCheckInWindow(mondaySixAm, new Date("2026-03-09T13:00:00.000Z"))).toBe(true); // the end
    expect(isWithinCheckInWindow(mondaySixAm, new Date("2026-03-09T13:30:00.000Z"))).toBe(true); // end + 30, inclusive
    expect(isWithinCheckInWindow(mondaySixAm, new Date("2026-03-09T13:30:00.001Z"))).toBe(false);
  });

  it("is false on the wrong day of week even at the exact right time", () => {
    // Tuesday 2026-03-10 06:00 CR = 12:00 UTC - one day later, same clock time
    expect(isWithinCheckInWindow(mondaySixAm, new Date("2026-03-10T12:00:00.000Z"))).toBe(false);
  });

  it("accepts a check-in whose window crosses CR midnight on the tail end (a class that runs past midnight)", () => {
    const wednesdayLateNight = { dayOfWeek: "WEDNESDAY" as const, startTime: "23:50", durationMinutes: 60 };
    // Ends Thu 00:50, closes Thu 01:20 CR = 2026-06-18T07:20:00.000Z (inclusive).
    expect(isWithinCheckInWindow(wednesdayLateNight, new Date("2026-06-18T07:20:00.000Z"))).toBe(true);
    expect(isWithinCheckInWindow(wednesdayLateNight, new Date("2026-06-18T07:20:00.001Z"))).toBe(false);
  });

  it("accepts a check-in whose window crosses CR midnight on the head end", () => {
    const tuesdayJustAfterMidnight = { dayOfWeek: "TUESDAY" as const, startTime: "00:05", durationMinutes: 10 };
    // Opens Monday 23:35 CR = 2026-06-16T05:35:00.000Z.
    expect(isWithinCheckInWindow(tuesdayJustAfterMidnight, new Date("2026-06-16T05:35:00.000Z"))).toBe(true);
    expect(isWithinCheckInWindow(tuesdayJustAfterMidnight, new Date("2026-06-16T05:34:59.999Z"))).toBe(false);
  });

  it("the longest class the schedule editor allows (600 minutes) crosses midnight and stays anchored to its own day", () => {
    // Monday 22:00 + 600 min ends Tuesday 08:00, closes 08:30 CR = 2026-01-06T14:30:00Z; a check on TUESDAY still finds it.
    const marathon = { dayOfWeek: "MONDAY" as const, startTime: "22:00", durationMinutes: 600 };
    expect(isWithinCheckInWindow(marathon, new Date("2026-01-06T14:30:00.000Z"))).toBe(true);
    expect(isWithinCheckInWindow(marathon, new Date("2026-01-06T14:30:00.001Z"))).toBe(false);
  });

  it("still rejects a check-in on the wrong day even near a midnight-crossing session", () => {
    const wednesdayLateNight = { dayOfWeek: "WEDNESDAY" as const, startTime: "23:50", durationMinutes: 60 };
    // Thu 03:00 CR, hours after the Thu 01:20 close
    expect(isWithinCheckInWindow(wednesdayLateNight, new Date("2026-06-18T09:00:00.000Z"))).toBe(false);
  });
});

describe("openOccurrences", () => {
  // Back-to-back hourly classes: 18:00-19:00 is open 17:30-19:30 CR and 19:00-20:00 is open 18:30-20:30, so they
  // OVERLAP for an hour (18:30-19:30). Overlaps are expected; the kiosk asks the student which class they attended
  // whenever more than one is open, so this only reports WHICH classes are open, in a stable order.
  const early = { id: "session-early", dayOfWeek: "MONDAY" as const, startTime: "18:00", durationMinutes: 60 };
  const late = { id: "session-late", dayOfWeek: "MONDAY" as const, startTime: "19:00", durationMinutes: 60 };
  const ids = (list: ReturnType<typeof openOccurrences>) => list.map((o) => o.session.id);

  it("is empty when no window contains the instant (the wrong day, or before/after every window)", () => {
    // Sunday - neither session's day.
    expect(openOccurrences([early, late], new Date("2026-03-08T23:00:00.000Z"))).toEqual([]);
    expect(openOccurrences([], new Date("2026-03-10T00:10:00.000Z"))).toEqual([]);
  });

  it("is empty one millisecond before the first window opens and one millisecond after the last one closes, and inclusive at both", () => {
    // Monday 17:29:59.999 CR = 2026-03-09T23:29:59.999Z; the first window opens at 17:30.
    expect(openOccurrences([early, late], new Date("2026-03-09T23:29:59.999Z"))).toEqual([]);
    expect(ids(openOccurrences([early, late], new Date("2026-03-09T23:30:00.000Z")))).toEqual(["session-early"]);
    // The last window (19:00 + 60 + 30) closes 20:30 CR = 2026-03-10T02:30:00Z, inclusive.
    expect(ids(openOccurrences([early, late], new Date("2026-03-10T02:30:00.000Z")))).toEqual(["session-late"]);
    expect(openOccurrences([early, late], new Date("2026-03-10T02:30:00.001Z"))).toEqual([]);
  });

  it("returns exactly one class when exactly one window is open", () => {
    // Monday 18:10 CR - inside `early` only (late opens 18:30). Monday 20:00 CR - `early` closed at 19:30.
    expect(ids(openOccurrences([early, late], new Date("2026-03-10T00:10:00.000Z")))).toEqual(["session-early"]);
    expect(ids(openOccurrences([early, late], new Date("2026-03-10T02:00:00.000Z")))).toEqual(["session-late"]);
  });

  it("returns EVERY open class when windows overlap, ordered by scheduled start then id, whatever the input order", () => {
    // Monday 18:30:00 CR is the first instant both are open (early until 19:30, late from 18:30), inclusive at opening.
    expect(ids(openOccurrences([early, late], new Date("2026-03-10T00:30:00.000Z")))).toEqual(["session-early", "session-late"]);
    expect(ids(openOccurrences([late, early], new Date("2026-03-10T00:30:00.000Z")))).toEqual(["session-early", "session-late"]);
    // 19:30:00 is early's last instant; 19:30:00.001 leaves only late.
    expect(ids(openOccurrences([late, early], new Date("2026-03-10T01:30:00.000Z")))).toEqual(["session-early", "session-late"]);
    expect(ids(openOccurrences([late, early], new Date("2026-03-10T01:30:00.001Z")))).toEqual(["session-late"]);
  });

  it("overlapping windows of DIFFERENT durations are all reported, each closing at its own end + 30", () => {
    // 18:00 for 120 min is open 17:30-20:30; 19:00 for 60 min 18:30-20:30; 19:30 for 10 min 19:00-20:10.
    const long = { id: "long", dayOfWeek: "MONDAY" as const, startTime: "18:00", durationMinutes: 120 };
    const hour = { id: "hour", dayOfWeek: "MONDAY" as const, startTime: "19:00", durationMinutes: 60 };
    const short = { id: "short", dayOfWeek: "MONDAY" as const, startTime: "19:30", durationMinutes: 10 };
    expect(ids(openOccurrences([short, hour, long], new Date("2026-03-10T01:20:00.000Z")))).toEqual(["long", "hour", "short"]); // 19:20
    expect(ids(openOccurrences([short, hour, long], new Date("2026-03-10T02:15:00.000Z")))).toEqual(["long", "hour"]); // 20:15: short closed at 20:10
  });

  it("orders two classes with the identical start by lowest id", () => {
    const a = { ...early, id: "aaa" };
    const b = { ...early, id: "bbb" };
    expect(ids(openOccurrences([b, a], new Date("2026-03-10T00:00:00.000Z")))).toEqual(["aaa", "bbb"]);
  });

  it("reports each occurrence's own anchor day, not `now`'s, across CR midnight (a class running past midnight)", () => {
    const wednesdayLateNight = { id: "late-night", dayOfWeek: "WEDNESDAY" as const, startTime: "23:50", durationMinutes: 60 };
    // Thu 00:10 CR = 2026-06-18T06:10Z - `now` is Thursday, but the occurrence belongs to Wednesday the 17th.
    expect(openOccurrences([wednesdayLateNight], new Date("2026-06-18T06:10:00.000Z"))[0]?.anchorDate.toISODate()).toBe("2026-06-17");
    // ...and still does at 01:20:00 (end 00:50 + 30), inclusive; gone 1 ms later.
    expect(openOccurrences([wednesdayLateNight], new Date("2026-06-18T07:20:00.000Z"))[0]?.anchorDate.toISODate()).toBe("2026-06-17");
    expect(openOccurrences([wednesdayLateNight], new Date("2026-06-18T07:20:00.001Z"))).toEqual([]);
  });

  it("lists a class that opens the evening before (00:10 Tuesday opens 23:40 Monday) together with Monday's classes", () => {
    const monday = { id: "monday-late", dayOfWeek: "MONDAY" as const, startTime: "23:00", durationMinutes: 60 }; // open until 00:30 Tue
    const tuesday = { id: "tuesday-early", dayOfWeek: "TUESDAY" as const, startTime: "00:10", durationMinutes: 60 };
    // Monday 23:45 CR = 2026-01-06T05:45Z
    expect(ids(openOccurrences([tuesday, monday], new Date("2026-01-06T05:45:00.000Z")))).toEqual(["monday-late", "tuesday-early"]);
  });
});

describe("occurrencesForToday", () => {
  it("lists yesterday's class that runs past midnight while its window is open, and drops it at its exact close", () => {
    const monday2200 = { dayOfWeek: "MONDAY" as const, startTime: "22:00", durationMinutes: 120 }; // ends 00:00, closes 00:30 Tue
    // Tuesday 00:30:00.000 CR = 2026-01-06T06:30:00Z
    expect(occurrencesForToday(monday2200, new Date("2026-01-06T06:30:00.000Z"))).toHaveLength(1);
    expect(occurrencesForToday(monday2200, new Date("2026-01-06T06:30:00.001Z"))).toHaveLength(0);
  });
});

/**
 * `nextBoundaryAfter`: the next instant at which what a student sees in today's class list can change - a window
 * opening, a window closing (the first instant AFTER its inclusive end), or the Costa Rica calendar day rolling
 * over. The portal refreshes itself at exactly this instant, so a page left open never shows a stale state.
 */
describe("nextBoundaryAfter", () => {
  const monday1900 = [{ dayOfWeek: "MONDAY" as const, startTime: "19:00", durationMinutes: 60 }]; // open 18:30-20:30 CR
  const at = (iso: string) => new Date(iso);

  it("before a window opens, the next boundary is its opening instant (start - 30 min)", () => {
    // Monday 2026-01-05 18:00 CR = 2026-01-06T00:00:00Z; the 19:00 class opens at 18:30 CR.
    expect(nextBoundaryAfter(monday1900, at("2026-01-06T00:00:00Z")).toISOString()).toBe("2026-01-06T00:30:00.000Z");
  });

  it("at the exact opening instant the class is already open, so the next boundary is the first instant AFTER it closes (end + 30 min)", () => {
    // 20:30 CR = 2026-01-06T02:30Z; +1 ms.
    expect(nextBoundaryAfter(monday1900, at("2026-01-06T00:30:00Z")).toISOString()).toBe("2026-01-06T02:30:00.001Z");
    // ...and while the class is running (19:30 CR) it is still that closing boundary.
    expect(nextBoundaryAfter(monday1900, at("2026-01-06T01:30:00Z")).toISOString()).toBe("2026-01-06T02:30:00.001Z");
  });

  it("once the window has closed, the next boundary is Costa Rica midnight (the day's list changes)", () => {
    // 20:30:00.001 CR -> Tuesday 00:00 CR = 2026-01-06T06:00:00Z.
    expect(nextBoundaryAfter(monday1900, at("2026-01-06T02:30:00.001Z")).toISOString()).toBe("2026-01-06T06:00:00.000Z");
  });

  it("the closing boundary follows each class's OWN duration (30, 60 and 90 minutes starting together)", () => {
    const at1810 = at("2026-01-06T00:10:00Z"); // Monday 18:10 CR: all three open (opened 17:30)
    const one = (durationMinutes: number) => [{ dayOfWeek: "MONDAY" as const, startTime: "18:00", durationMinutes }];
    expect(nextBoundaryAfter(one(30), at1810).toISOString()).toBe("2026-01-06T01:00:00.001Z"); // 19:00 CR
    expect(nextBoundaryAfter(one(60), at1810).toISOString()).toBe("2026-01-06T01:30:00.001Z"); // 19:30 CR
    expect(nextBoundaryAfter(one(90), at1810).toISOString()).toBe("2026-01-06T02:00:00.001Z"); // 20:00 CR
  });

  it("with no classes at all the next boundary is still the next Costa Rica midnight", () => {
    expect(nextBoundaryAfter([], at("2026-01-05T18:00:00Z")).toISOString()).toBe("2026-01-06T06:00:00.000Z");
  });

  it("an adjacent-day class: a 00:10 Tuesday class opens at 23:40 Monday and that is a boundary on Monday evening", () => {
    const tuesday0010 = [{ dayOfWeek: "TUESDAY" as const, startTime: "00:10", durationMinutes: 60 }];
    expect(nextBoundaryAfter(tuesday0010, at("2026-01-06T05:00:00Z")).toISOString()).toBe("2026-01-06T05:40:00.000Z"); // Mon 23:00 CR -> 23:40 CR
    // At 23:45 the window is open but the day rolls over first (00:00), which is the boundary before it closes at 01:40.
    expect(nextBoundaryAfter(tuesday0010, at("2026-01-06T05:45:00Z")).toISOString()).toBe("2026-01-06T06:00:00.000Z");
    // Just after midnight the class is today's (Tuesday), open until 00:10 + 60 + 30 = 01:40 CR = 07:40Z.
    expect(nextBoundaryAfter(tuesday0010, at("2026-01-06T06:00:00Z")).toISOString()).toBe("2026-01-06T07:40:00.001Z");
  });

  it("a class that started the evening before and is still open after midnight closes at end + 30 min (yesterday's window)", () => {
    const monday2350 = [{ dayOfWeek: "MONDAY" as const, startTime: "23:50", durationMinutes: 60 }]; // ends 00:50, closes 01:20 Tue
    // Tuesday 00:05 CR = 2026-01-06T06:05:00Z.
    expect(nextBoundaryAfter(monday2350, at("2026-01-06T06:05:00Z")).toISOString()).toBe("2026-01-06T07:20:00.001Z");
  });

  it("a 600-minute class from Monday 22:00 is still Monday's class, closing Tuesday 08:30 CR", () => {
    const marathon = [{ dayOfWeek: "MONDAY" as const, startTime: "22:00", durationMinutes: 600 }];
    expect(nextBoundaryAfter(marathon, at("2026-01-06T10:00:00Z")).toISOString()).toBe("2026-01-06T14:30:00.001Z"); // from Tue 04:00 CR
  });

  it("is always strictly after `now`, and picks the earliest of several classes", () => {
    const sessions = [
      { dayOfWeek: "MONDAY" as const, startTime: "19:00", durationMinutes: 60 },
      { dayOfWeek: "MONDAY" as const, startTime: "18:40", durationMinutes: 60 },
    ];
    // 18:00 CR: the 18:40 class opens first (18:10), before the 19:00 one (18:30).
    const next = nextBoundaryAfter(sessions, at("2026-01-06T00:00:00Z"));
    expect(next.toISOString()).toBe("2026-01-06T00:10:00.000Z");
    expect(next.getTime()).toBeGreaterThan(at("2026-01-06T00:00:00Z").getTime());
  });
});
