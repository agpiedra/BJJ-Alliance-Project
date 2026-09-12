// class-popularity.ts also exports getClassPopularity from the same module
// (matching headline-tiles.ts's single-file layout), so importing it here
// transitively imports `@/lib/prisma`, which reads DATABASE_URL at module
// load — never actually connects for these tests (only the pure
// `computeTrend` below is exercised), but the env var must exist.
import "dotenv/config";
import { describe, expect, it } from "vitest";
import { DateTime } from "luxon";
import {
  computeTrend,
  computeTrendPercent,
  countWeekdayOccurrences,
  computeBiggestMovers,
  computeAtRiskClasses,
  type ClassPopularityRow,
} from "@/lib/analytics/class-popularity";

describe("computeTrend", () => {
  it("current greater than previous is up", () => {
    expect(computeTrend(10, 5)).toBe("up");
  });

  it("current less than previous is down", () => {
    expect(computeTrend(5, 10)).toBe("down");
  });

  it("current equal to previous is flat", () => {
    expect(computeTrend(7, 7)).toBe("flat");
  });

  it("previous zero, current greater than zero is up (not a divide-by-zero situation)", () => {
    expect(computeTrend(3, 0)).toBe("up");
  });

  it("both zero is flat", () => {
    expect(computeTrend(0, 0)).toBe("flat");
  });
});

describe("computeTrendPercent", () => {
  it("computes a positive signed percentage for growth", () => {
    expect(computeTrendPercent(12, 10)).toBe(20);
  });

  it("computes a negative signed percentage for decline", () => {
    expect(computeTrendPercent(8, 10)).toBe(-20);
  });

  it("rounds to the nearest whole percent", () => {
    expect(computeTrendPercent(7, 6)).toBe(17); // 16.66... -> 17
  });

  it("is 0 when current equals previous", () => {
    expect(computeTrendPercent(5, 5)).toBe(0);
  });

  it("returns null (not Infinity/NaN) when previous is 0 and current is not — 'no previous data to compare'", () => {
    expect(computeTrendPercent(3, 0)).toBeNull();
  });

  it("previous 0 and current 0 is flat (0), not 'Nuevo' — a real, reachable zero-attendance class", () => {
    expect(computeTrendPercent(0, 0)).toBe(0);
  });
});

describe("countWeekdayOccurrences", () => {
  const zone = "America/Costa_Rica";

  it("counts every Monday in a 4-week range", () => {
    // 2026-08-03 through 2026-08-31 (CR time): Mondays on 3, 10, 17, 24, 31.
    const from = DateTime.fromISO("2026-08-03", { zone });
    const to = DateTime.fromISO("2026-08-31", { zone });
    expect(countWeekdayOccurrences("MONDAY", from, to)).toBe(5);
  });

  it("a range shorter than a week counts at most one occurrence", () => {
    const from = DateTime.fromISO("2026-08-04", { zone });
    const to = DateTime.fromISO("2026-08-06", { zone });
    expect(countWeekdayOccurrences("WEDNESDAY", from, to)).toBe(1);
    expect(countWeekdayOccurrences("SUNDAY", from, to)).toBe(0);
  });

  it("an inverted range (to before from) is 0, not negative or thrown", () => {
    const from = DateTime.fromISO("2026-08-10", { zone });
    const to = DateTime.fromISO("2026-08-01", { zone });
    expect(countWeekdayOccurrences("MONDAY", from, to)).toBe(0);
  });
});

function makeRow(overrides: Partial<ClassPopularityRow>): ClassPopularityRow {
  return {
    classSessionId: "id",
    label: "label",
    dayOfWeek: "MONDAY",
    startTime: "18:00",
    type: "GI",
    attendances: 0,
    previousAttendances: 0,
    trend: "flat",
    ...overrides,
  };
}

describe("computeBiggestMovers", () => {
  it("ranks by absolute change descending, signed, excluding zero-change rows", () => {
    const rows = [
      makeRow({ classSessionId: "a", label: "A", attendances: 10, previousAttendances: 2 }), // +8
      makeRow({ classSessionId: "b", label: "B", attendances: 1, previousAttendances: 9 }), // -8
      makeRow({ classSessionId: "c", label: "C", attendances: 5, previousAttendances: 5 }), // 0, excluded
      makeRow({ classSessionId: "d", label: "D", attendances: 4, previousAttendances: 3 }), // +1
    ];
    const movers = computeBiggestMovers(rows, 5);
    expect(movers).toHaveLength(3);
    expect(movers.map((m) => m.classSessionId)).toEqual(["a", "b", "d"]);
    expect(movers[0].diff).toBe(8);
    expect(movers[1].diff).toBe(-8);
  });

  it("respects the limit", () => {
    const rows = [
      makeRow({ classSessionId: "a", attendances: 10, previousAttendances: 0 }),
      makeRow({ classSessionId: "b", attendances: 9, previousAttendances: 0 }),
      makeRow({ classSessionId: "c", attendances: 8, previousAttendances: 0 }),
    ];
    expect(computeBiggestMovers(rows, 2)).toHaveLength(2);
  });
});

describe("computeAtRiskClasses", () => {
  it("returns only classes under the threshold (default 4)", () => {
    const rows = [
      makeRow({ classSessionId: "low", attendances: 3 }),
      makeRow({ classSessionId: "zero", attendances: 0 }),
      makeRow({ classSessionId: "ok", attendances: 4 }),
      makeRow({ classSessionId: "high", attendances: 10 }),
    ];
    expect(computeAtRiskClasses(rows).map((r) => r.classSessionId)).toEqual(["low", "zero"]);
  });

  it("a custom threshold is honored", () => {
    const rows = [makeRow({ classSessionId: "a", attendances: 6 })];
    expect(computeAtRiskClasses(rows, 8)).toHaveLength(1);
    expect(computeAtRiskClasses(rows, 5)).toHaveLength(0);
  });
});
