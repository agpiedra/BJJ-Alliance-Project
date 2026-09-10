// headline-tiles.ts's pure classifiers live in the same module as
// getHeadlineTiles (matching the brief's single-file layout for this task,
// unlike eligibility.ts's separate-file split from promotion-queue.ts), so
// importing it here transitively imports `@/lib/prisma`, which reads
// DATABASE_URL at module load — never actually connects for these tests
// (only the pure functions below are exercised), but the env var must exist.
import "dotenv/config";
import { describe, expect, it } from "vitest";
import { DateTime } from "luxon";
import {
  hasAttendanceInRange,
  isNewInRange,
  previousEquivalentRange,
  wasLost,
} from "@/lib/analytics/headline-tiles";

const RANGE = {
  from: DateTime.fromISO("2026-08-01"),
  to: DateTime.fromISO("2026-08-30"),
};

describe("hasAttendanceInRange", () => {
  it("a student with an attendance inside the range is active", () => {
    expect(hasAttendanceInRange([DateTime.fromISO("2026-08-15")], RANGE)).toBe(true);
  });

  it("a student whose only attendance falls outside the range is not active", () => {
    expect(hasAttendanceInRange([DateTime.fromISO("2026-07-15")], RANGE)).toBe(false);
  });

  it("a student with no attendance at all is not active", () => {
    expect(hasAttendanceInRange([], RANGE)).toBe(false);
  });
});

describe("isNewInRange", () => {
  it("a student who joined inside the range is new", () => {
    expect(isNewInRange(DateTime.fromISO("2026-08-10"), RANGE)).toBe(true);
  });

  it("a student who joined before the range is not new", () => {
    expect(isNewInRange(DateTime.fromISO("2026-01-01"), RANGE)).toBe(false);
  });
});

describe("previousEquivalentRange", () => {
  it("returns the same-length period immediately preceding the range", () => {
    const previous = previousEquivalentRange(RANGE);
    expect(previous.to.toMillis()).toBe(RANGE.from.toMillis());
    expect(previous.to.diff(previous.from).as("milliseconds")).toBe(
      RANGE.to.diff(RANGE.from).as("milliseconds"),
    );
  });
});

describe("wasLost", () => {
  it("a student with attendance in the previous period but none in the current one is lost", () => {
    const previous = previousEquivalentRange(RANGE);
    const attendance = [previous.from.plus({ days: 1 })];
    expect(wasLost(attendance, RANGE)).toBe(true);
  });

  it("a student active in both the previous and current period is not lost", () => {
    const previous = previousEquivalentRange(RANGE);
    const attendance = [previous.from.plus({ days: 1 }), RANGE.from.plus({ days: 1 })];
    expect(wasLost(attendance, RANGE)).toBe(false);
  });

  it("a student with no attendance in the previous period at all is not lost", () => {
    expect(wasLost([], RANGE)).toBe(false);
  });

  it("a student active only in the current period (never attended before) is not lost", () => {
    expect(wasLost([RANGE.from.plus({ days: 1 })], RANGE)).toBe(false);
  });
});
