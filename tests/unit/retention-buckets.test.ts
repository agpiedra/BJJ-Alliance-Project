// retention.ts also exports getRetentionList/getWeeklyAttendanceTrend from
// the same module (matching class-popularity.ts's single-file layout), so
// importing it here transitively imports `@/lib/prisma`, which reads
// DATABASE_URL at module load — never actually connects for these tests
// (only the pure `classifyRetentionBucket` below is exercised), but the env
// var must exist.
import "dotenv/config";
import { describe, expect, it } from "vitest";
import { DateTime } from "luxon";
import { classifyRetentionBucket, resolveRetentionDaysSince } from "@/lib/analytics/retention";

describe("classifyRetentionBucket", () => {
  it("fewer than 30 days is not a retention concern (null)", () => {
    expect(classifyRetentionBucket(15)).toBeNull();
  });

  it("35 days is bucket 30", () => {
    expect(classifyRetentionBucket(35)).toBe("30");
  });

  it("65 days is bucket 60", () => {
    expect(classifyRetentionBucket(65)).toBe("60");
  });

  it("95 days is bucket 90", () => {
    expect(classifyRetentionBucket(95)).toBe("90");
  });

  // Buckets are closed-open on the low end: a boundary value falls into the
  // bucket it NAMES, not the one below it.
  it("exactly 30 days falls into bucket 30, not null", () => {
    expect(classifyRetentionBucket(30)).toBe("30");
  });

  it("exactly 60 days falls into bucket 60, not 30", () => {
    expect(classifyRetentionBucket(60)).toBe("60");
  });

  it("exactly 90 days falls into bucket 90, not 60", () => {
    expect(classifyRetentionBucket(90)).toBe("90");
  });

  it("null (never attended) buckets into 90 — at least as concerning as 90+ days quiet", () => {
    expect(classifyRetentionBucket(null)).toBe("90");
  });
});

describe("resolveRetentionDaysSince — Phase 3d follow-up (onboarding credit grace)", () => {
  const asOf = DateTime.fromISO("2026-06-01T12:00:00", { zone: "America/Costa_Rica" });

  it("a real last attendance always wins, credited or not", () => {
    const lastAttendance = asOf.minus({ days: 40 }).toJSDate();
    expect(resolveRetentionDaysSince(lastAttendance, true, asOf.minus({ years: 1 }).toJSDate(), asOf)).toBe(40);
    expect(resolveRetentionDaysSince(lastAttendance, false, asOf.minus({ years: 1 }).toJSDate(), asOf)).toBe(40);
  });

  it("uncredited, never attended: null (unchanged pre-3d behavior — classifyRetentionBucket buckets this into 90)", () => {
    expect(resolveRetentionDaysSince(null, false, asOf.minus({ days: 1 }).toJSDate(), asOf)).toBeNull();
  });

  it("credited, never attended, joined 10 days ago: clock starts at joinedAt, well inside the 30-day grace", () => {
    const joinedAt = asOf.minus({ days: 10 }).toJSDate();
    expect(resolveRetentionDaysSince(null, true, joinedAt, asOf)).toBe(10);
    expect(classifyRetentionBucket(resolveRetentionDaysSince(null, true, joinedAt, asOf))).toBeNull();
  });

  it("credited, never attended, joined exactly 30 days ago: grace has just ended, falls into bucket 30 (not straight to 90)", () => {
    const joinedAt = asOf.minus({ days: 30 }).toJSDate();
    expect(resolveRetentionDaysSince(null, true, joinedAt, asOf)).toBe(30);
    expect(classifyRetentionBucket(resolveRetentionDaysSince(null, true, joinedAt, asOf))).toBe("30");
  });

  it("credited, never attended, joined 95 days ago: escalates all the way to 90, same as a genuine lapse would", () => {
    const joinedAt = asOf.minus({ days: 95 }).toJSDate();
    expect(resolveRetentionDaysSince(null, true, joinedAt, asOf)).toBe(95);
    expect(classifyRetentionBucket(resolveRetentionDaysSince(null, true, joinedAt, asOf))).toBe("90");
  });
});
