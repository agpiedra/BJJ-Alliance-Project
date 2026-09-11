// franja-heatmap.ts also exports getFranjaHeatmap from the same module
// (matching retention.ts/class-popularity.ts's single-file layout), so
// importing it here transitively imports `@/lib/prisma` at module load —
// never actually connects for these tests (only the pure `bandForStartTime`
// below is exercised), but the env var must exist.
import "dotenv/config";
import { describe, expect, it } from "vitest";
import { bandForStartTime } from "@/lib/analytics/franja-heatmap";

describe("bandForStartTime", () => {
  it("06:00 is morning", () => {
    expect(bandForStartTime("06:00")).toBe("morning");
  });

  it("10:59 is still morning", () => {
    expect(bandForStartTime("10:59")).toBe("morning");
  });

  it("11:00 is midday, not morning", () => {
    expect(bandForStartTime("11:00")).toBe("midday");
  });

  it("12:00 is midday", () => {
    expect(bandForStartTime("12:00")).toBe("midday");
  });

  // The boundary this app's seeded schedule actually needs: 18:00 and 18:30
  // classes (Wed Competición, Fri GI Todos) must land in "afternoon", while
  // 19:00 classes land in "evening" — the mock's own "Tarde 18:00–18:30" vs.
  // "Noche 19:00" split.
  it("18:00 is afternoon", () => {
    expect(bandForStartTime("18:00")).toBe("afternoon");
  });

  it("18:30 is afternoon", () => {
    expect(bandForStartTime("18:30")).toBe("afternoon");
  });

  it("19:00 is evening", () => {
    expect(bandForStartTime("19:00")).toBe("evening");
  });

  it("21:59 is still evening", () => {
    expect(bandForStartTime("21:59")).toBe("evening");
  });

  it("22:00 and later has no band", () => {
    expect(bandForStartTime("22:00")).toBeNull();
  });

  it("before 06:00 has no band", () => {
    expect(bandForStartTime("05:59")).toBeNull();
  });
});
