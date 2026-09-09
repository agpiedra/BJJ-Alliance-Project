import { describe, expect, it } from "vitest";
import { MAX_QUEUED_AGE_MS, resolveAttendanceInstant } from "@/lib/kiosk/queued-at";

const NOW = Date.UTC(2026, 0, 5, 12, 0, 0);

describe("resolveAttendanceInstant", () => {
  it("honors a recent queuedAt so the ledger records when the student actually tapped", () => {
    const queuedAt = NOW - 70 * 60 * 1000; // 70 minutes ago: queued during class, replayed after
    expect(resolveAttendanceInstant(queuedAt, NOW)).toEqual(new Date(queuedAt));
  });

  it("honors a queuedAt right at the age bound", () => {
    const queuedAt = NOW - MAX_QUEUED_AGE_MS;
    expect(resolveAttendanceInstant(queuedAt, NOW)).toEqual(new Date(queuedAt));
  });

  it("falls back to server time for a queuedAt older than the bound", () => {
    expect(resolveAttendanceInstant(NOW - MAX_QUEUED_AGE_MS - 1, NOW)).toBeUndefined();
  });

  it("falls back to server time for a queuedAt in the future (a badly-set device clock)", () => {
    expect(resolveAttendanceInstant(NOW + 1, NOW)).toBeUndefined();
  });

  it("falls back to server time when queuedAt is absent or malformed", () => {
    expect(resolveAttendanceInstant(undefined, NOW)).toBeUndefined();
    expect(resolveAttendanceInstant(null, NOW)).toBeUndefined();
    expect(resolveAttendanceInstant("1767614400000", NOW)).toBeUndefined();
    expect(resolveAttendanceInstant(Number.NaN, NOW)).toBeUndefined();
    expect(resolveAttendanceInstant(Number.POSITIVE_INFINITY, NOW)).toBeUndefined();
  });
});
