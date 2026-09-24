import { describe, expect, it } from "vitest";
import { toAttendanceDate } from "@/lib/scheduling/zone";
import {
  getCheckInWindow,
  isWithinCheckInWindow,
  nextBoundaryAfter,
  selectActiveSessionOccurrence,
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

describe("getCheckInWindow", () => {
  it("is start-30min .. start+30min and does NOT extend by the class duration", () => {
    // Monday 2026-03-09 06:00 CR = 12:00 UTC, 60-minute class.
    const window = getCheckInWindow(
      { dayOfWeek: "MONDAY", startTime: "06:00", durationMinutes: 60 },
      new Date("2026-03-09T12:00:00.000Z"),
    );
    expect(window.start.toISOString()).toBe("2026-03-09T11:30:00.000Z");
    // The old formula would have put this at 13:30Z (start + duration + 30).
    expect(window.end.toISOString()).toBe("2026-03-09T12:30:00.000Z");
  });

  it("produces the same window regardless of durationMinutes", () => {
    const short = getCheckInWindow(
      { dayOfWeek: "MONDAY", startTime: "06:00", durationMinutes: 15 },
      new Date("2026-03-09T12:00:00.000Z"),
    );
    const long = getCheckInWindow(
      { dayOfWeek: "MONDAY", startTime: "06:00", durationMinutes: 180 },
      new Date("2026-03-09T12:00:00.000Z"),
    );
    expect(short).toEqual(long);
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

  it("is true exactly 30 minutes after start (the window's closing edge)", () => {
    expect(isWithinCheckInWindow(mondaySixAm, new Date("2026-03-09T12:30:00.000Z"))).toBe(true);
  });

  it("is false 31 minutes after start — the window no longer extends by the class duration", () => {
    // Under the old start+duration+30 formula this instant (25 minutes into a
    // 60-minute class) was still inside the window.
    expect(isWithinCheckInWindow(mondaySixAm, new Date("2026-03-09T12:31:00.000Z"))).toBe(false);
  });

  it("is false on the wrong day of week even at the exact right time", () => {
    // Tuesday 2026-03-10 06:00 CR = 12:00 UTC — one day later, same clock time
    expect(isWithinCheckInWindow(mondaySixAm, new Date("2026-03-10T12:00:00.000Z"))).toBe(false);
  });

  it("accepts a check-in whose window crosses CR midnight on the tail end", () => {
    const wednesdayLateNight = { dayOfWeek: "WEDNESDAY" as const, startTime: "23:50", durationMinutes: 60 };
    // Window end = Wed 23:50 + 30min = Thu 00:20 CR = 2026-06-18T06:20:00.000Z
    expect(isWithinCheckInWindow(wednesdayLateNight, new Date("2026-06-18T06:20:00.000Z"))).toBe(true);
  });

  it("accepts a check-in whose window crosses CR midnight on the head end", () => {
    const tuesdayJustAfterMidnight = { dayOfWeek: "TUESDAY" as const, startTime: "00:05", durationMinutes: 10 };
    // 25 minutes before a Tuesday 00:05 start = Monday 23:40 CR = 2026-06-16T05:40:00.000Z
    expect(isWithinCheckInWindow(tuesdayJustAfterMidnight, new Date("2026-06-16T05:40:00.000Z"))).toBe(true);
  });

  it("still rejects a check-in on the wrong day even near a midnight-crossing session", () => {
    const wednesdayLateNight = { dayOfWeek: "WEDNESDAY" as const, startTime: "23:50", durationMinutes: 60 };
    // Well outside any window: Thu 03:00 CR, hours after the Thu 00:20 window end
    expect(isWithinCheckInWindow(wednesdayLateNight, new Date("2026-06-18T09:00:00.000Z"))).toBe(false);
  });
});

describe("selectActiveSessionOccurrence", () => {
  // Deliberately overlapping: 18:00's window is [17:30, 18:30] CR and
  // 19:00's is [18:30, 19:30], so 18:30 exactly is inside both.
  const early = {
    id: "session-early",
    dayOfWeek: "MONDAY" as const,
    startTime: "18:00",
    durationMinutes: 60,
  };
  const late = {
    id: "session-late",
    dayOfWeek: "MONDAY" as const,
    startTime: "19:00",
    durationMinutes: 60,
  };

  it("returns null when no session's window contains `now`", () => {
    // Sunday — neither session's day.
    expect(selectActiveSessionOccurrence([early, late], new Date("2026-03-08T23:00:00.000Z"))).toBeNull();
  });

  it("returns the only match when exactly one window contains `now`", () => {
    // Monday 2026-03-09 18:10 CR = 2026-03-10T00:10Z — inside `early` only.
    const match = selectActiveSessionOccurrence([early, late], new Date("2026-03-10T00:10:00.000Z"));
    expect(match?.session.id).toBe("session-early");
  });

  it("picks the session whose start is closest to `now` when two windows overlap", () => {
    // A pair whose windows genuinely overlap over a range, not just touch:
    // 18:00 → [17:30, 18:30] and 18:20 → [17:50, 18:50].
    const overlappingLate = { ...late, startTime: "18:20" };
    // Monday 18:15 CR = 2026-03-10T00:15Z: inside both ([17:30,18:30] and
    // [17:50,18:50]). Distance to 18:00 is 15min, to 18:20 is 5min.
    const match = selectActiveSessionOccurrence(
      [early, overlappingLate],
      new Date("2026-03-10T00:15:00.000Z"),
    );
    expect(match?.session.id).toBe("session-late");
    expect(match?.startsAt.toFormat("HH:mm")).toBe("18:20");
  });

  it("breaks an equidistant tie in favour of the EARLIER scheduled start", () => {
    // Monday 18:30 CR = 2026-03-10T00:30Z is exactly 30 minutes from both the
    // 18:00 and the 19:00 start — the shared boundary of two back-to-back
    // classes. The class already under way (18:00) wins.
    const match = selectActiveSessionOccurrence([late, early], new Date("2026-03-10T00:30:00.000Z"));
    expect(match?.session.id).toBe("session-early");
  });

  it("breaks a same-start tie deterministically by lowest id", () => {
    const a = { ...early, id: "aaa" };
    const b = { ...early, id: "bbb" };
    // Both orderings must agree — that's the whole point of the tie-break.
    expect(selectActiveSessionOccurrence([a, b], new Date("2026-03-10T00:00:00.000Z"))?.session.id).toBe("aaa");
    expect(selectActiveSessionOccurrence([b, a], new Date("2026-03-10T00:00:00.000Z"))?.session.id).toBe("aaa");
  });

  it("reports the matched occurrence's own anchor day, not `now`'s, across CR midnight", () => {
    const wednesdayLateNight = {
      id: "late-night",
      dayOfWeek: "WEDNESDAY" as const,
      startTime: "23:50",
      durationMinutes: 60,
    };
    // Thu 00:10 CR = 2026-06-18T06:10Z — `now` is Thursday, but the class
    // occurrence belongs to Wednesday the 17th.
    const match = selectActiveSessionOccurrence([wednesdayLateNight], new Date("2026-06-18T06:10:00.000Z"));
    expect(match?.anchorDate.toISODate()).toBe("2026-06-17");
  });
});

/**
 * `nextBoundaryAfter`: the next instant at which what a student sees in today's class list can change - a window
 * opening, a window closing (the first instant AFTER its inclusive end), or the Costa Rica calendar day rolling
 * over. The portal refreshes itself at exactly this instant, so a page left open never shows a stale state.
 * America/Costa_Rica is UTC-6 with no DST; these unit tests run with TZ=Pacific/Kiritimati, so a server-local
 * boundary would be 20 hours off.
 */
describe("nextBoundaryAfter", () => {
  const monday1900 = [{ dayOfWeek: "MONDAY" as const, startTime: "19:00", durationMinutes: 60 }];
  const at = (iso: string) => new Date(iso);

  it("before a window opens, the next boundary is its opening instant (start - 30 min)", () => {
    // Monday 2026-01-05 18:00 CR = 2026-01-06T00:00:00Z; the 19:00 class opens at 18:30 CR.
    expect(nextBoundaryAfter(monday1900, at("2026-01-06T00:00:00Z")).toISOString()).toBe("2026-01-06T00:30:00.000Z");
  });

  it("at the exact opening instant the class is already open, so the next boundary is the first instant AFTER it closes", () => {
    expect(nextBoundaryAfter(monday1900, at("2026-01-06T00:30:00Z")).toISOString()).toBe("2026-01-06T01:30:00.001Z");
    // ...and inside the window it is still that closing boundary.
    expect(nextBoundaryAfter(monday1900, at("2026-01-06T01:00:00Z")).toISOString()).toBe("2026-01-06T01:30:00.001Z");
  });

  it("once the window has closed, the next boundary is Costa Rica midnight (the day's list changes)", () => {
    // 19:30:00.001 CR -> Tuesday 00:00 CR = 2026-01-06T06:00:00Z.
    expect(nextBoundaryAfter(monday1900, at("2026-01-06T01:30:00.001Z")).toISOString()).toBe("2026-01-06T06:00:00.000Z");
  });

  it("with no classes at all the next boundary is still the next Costa Rica midnight", () => {
    expect(nextBoundaryAfter([], at("2026-01-05T18:00:00Z")).toISOString()).toBe("2026-01-06T06:00:00.000Z");
  });

  it("an adjacent-day class: a 00:10 Tuesday class opens at 23:40 Monday and that is a boundary on Monday evening", () => {
    const tuesday0010 = [{ dayOfWeek: "TUESDAY" as const, startTime: "00:10", durationMinutes: 60 }];
    expect(nextBoundaryAfter(tuesday0010, at("2026-01-06T05:00:00Z")).toISOString()).toBe("2026-01-06T05:40:00.000Z"); // Mon 23:00 CR -> 23:40 CR
    // At 23:45 the window is open but the day rolls over first (00:00), which is the boundary before it closes at 00:40.
    expect(nextBoundaryAfter(tuesday0010, at("2026-01-06T05:45:00Z")).toISOString()).toBe("2026-01-06T06:00:00.000Z");
  });

  it("a class that started the evening before and is still open after midnight closes at 00:20:00.001 (yesterday's window)", () => {
    const monday2350 = [{ dayOfWeek: "MONDAY" as const, startTime: "23:50", durationMinutes: 60 }];
    // Tuesday 00:05 CR = 2026-01-06T06:05:00Z; the 23:50 Monday class closes 00:20 CR.
    expect(nextBoundaryAfter(monday2350, at("2026-01-06T06:05:00Z")).toISOString()).toBe("2026-01-06T06:20:00.001Z");
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
