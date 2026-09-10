// retention.ts also exports getRetentionList/getWeeklyAttendanceTrend from
// the same module (matching class-popularity.ts's single-file layout), so
// importing it here transitively imports `@/lib/prisma`, which reads
// DATABASE_URL at module load — never actually connects for these tests
// (only the pure `classifyRetentionBucket` below is exercised), but the env
// var must exist.
import "dotenv/config";
import { describe, expect, it } from "vitest";
import { classifyRetentionBucket } from "@/lib/analytics/retention";

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
