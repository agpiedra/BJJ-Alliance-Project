import { describe, expect, it } from "vitest";
import { defaultCandidateMonth, parseCandidateParam } from "../../src/lib/dues/readiness/candidate";

describe("stage 8d-1: the candidate month (?s=YYYY-MM)", () => {
  it("accepts only YYYY-MM for a real month in 2000-2100", () => {
    expect(parseCandidateParam("2026-12")).toEqual({ year: 2026, month: 12 });
    expect(parseCandidateParam("2000-01")).toEqual({ year: 2000, month: 1 });
    for (const bad of ["2026-13", "2026-00", "1999-12", "2101-01", "2026-1", "26-12", "2026/12", "2026-12-01", " 2026-12", "", "abcd-ef"]) {
      expect(parseCandidateParam(bad), bad).toBeNull();
    }
  });

  it("defaults to the month after the current one in the branch timezone (D15), not the server's or UTC", () => {
    // 2026-10-31 23:30 in Costa Rica (UTC-6) is already 2026-11-01 05:30 UTC.
    const now = new Date("2026-11-01T05:30:00Z");
    expect(defaultCandidateMonth(["America/Costa_Rica"], now)).toEqual({ month: { year: 2026, month: 11 }, branchesDisagree: false });
    expect(defaultCandidateMonth(["UTC"], now)).toEqual({ month: { year: 2026, month: 12 }, branchesDisagree: false });
  });

  it("when branches straddle a month boundary, uses the LATEST next month, so the default has begun in no branch", () => {
    const now = new Date("2026-11-01T05:30:00Z"); // Costa Rica still in October; Madrid already in November
    expect(defaultCandidateMonth(["America/Costa_Rica", "Europe/Madrid"], now)).toEqual({ month: { year: 2026, month: 12 }, branchesDisagree: true });
  });

  it("rolls over the year, and falls back to UTC with no branches", () => {
    expect(defaultCandidateMonth(["America/Costa_Rica"], new Date("2026-12-15T12:00:00Z")).month).toEqual({ year: 2027, month: 1 });
    expect(defaultCandidateMonth([], new Date("2026-12-15T12:00:00Z")).month).toEqual({ year: 2027, month: 1 });
  });
});
