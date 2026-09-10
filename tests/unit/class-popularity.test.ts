// class-popularity.ts also exports getClassPopularity from the same module
// (matching headline-tiles.ts's single-file layout), so importing it here
// transitively imports `@/lib/prisma`, which reads DATABASE_URL at module
// load — never actually connects for these tests (only the pure
// `computeTrend` below is exercised), but the env var must exist.
import "dotenv/config";
import { describe, expect, it } from "vitest";
import { computeTrend } from "@/lib/analytics/class-popularity";

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
