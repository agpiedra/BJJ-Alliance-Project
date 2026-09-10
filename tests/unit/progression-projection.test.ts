// progression.ts also exports the DB-backed query functions from the same
// module (matching headline-tiles.ts/class-popularity.ts's single-file
// layout), so importing it here transitively imports `@/lib/prisma`, which
// reads DATABASE_URL at module load — never actually connects for these
// tests (only the pure `projectThresholdDate` below is exercised), but the
// env var must exist.
import "dotenv/config";
import { describe, expect, it } from "vitest";
import { DateTime } from "luxon";
import { projectThresholdDate } from "@/lib/analytics/progression";

const TODAY = DateTime.fromISO("2026-09-10", { zone: "America/Costa_Rica" });

describe("projectThresholdDate", () => {
  it("a real positive rate + remaining count projects a future date at the expected week-count out", () => {
    // 5 remaining, 2.5/week => 2 weeks out.
    const projected = projectThresholdDate(5, 2.5, TODAY);
    expect(projected).not.toBeNull();
    expect(projected!.toISODate()).toBe(TODAY.plus({ weeks: 2 }).toISODate());
  });

  it("a zero rate returns null (no attendance, nothing to project from)", () => {
    expect(projectThresholdDate(5, 0, TODAY)).toBeNull();
  });

  it("a negative rate returns null (defensive — should never happen, but never a nonsense date)", () => {
    expect(projectThresholdDate(5, -1, TODAY)).toBeNull();
  });

  it("remainingToNextStripe: null (exam-eligible, already past every stripe threshold) returns null", () => {
    expect(projectThresholdDate(null, 3, TODAY)).toBeNull();
  });
});
