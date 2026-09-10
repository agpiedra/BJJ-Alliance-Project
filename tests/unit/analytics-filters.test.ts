import { describe, expect, it } from "vitest";
import { DateTime } from "luxon";
import { resolveAnalyticsFilters, DEFAULT_RANGE_DAYS } from "@/lib/analytics/filters";
import type { StaffSession } from "@/lib/auth/session";

const TODAY = DateTime.fromISO("2026-09-10", { zone: "America/Costa_Rica" });

const admin: StaffSession = { userId: "admin-1", role: "ADMIN", academyIds: "ALL" };
const director: StaffSession = { userId: "dir-1", role: "DIRECTOR", academyIds: ["escalante-id"] };
const multiAcademyDirector: StaffSession = {
  userId: "dir-2",
  role: "DIRECTOR",
  academyIds: ["academy-a", "academy-b"],
};

describe("resolveAnalyticsFilters", () => {
  it("no params: defaults to the last 30 days ending on the caller-supplied today", () => {
    const filters = resolveAnalyticsFilters(admin, {}, TODAY);
    expect(filters.to.toISODate()).toBe("2026-09-10");
    expect(filters.from.toISODate()).toBe(TODAY.minus({ days: DEFAULT_RANGE_DAYS }).toISODate());
  });

  it("no academy param: an ADMIN session resolves to academyId null (all academies in scope)", () => {
    const filters = resolveAnalyticsFilters(admin, {}, TODAY);
    expect(filters.academyId).toBeNull();
  });

  it("academy=ambas: an ADMIN session resolves to academyId null", () => {
    const filters = resolveAnalyticsFilters(admin, { academy: "ambas" }, TODAY);
    expect(filters.academyId).toBeNull();
  });

  it("a specific academy param: an ADMIN session resolves to that value verbatim", () => {
    const filters = resolveAnalyticsFilters(admin, { academy: "escazu-id" }, TODAY);
    expect(filters.academyId).toBe("escazu-id");
  });

  it("a DIRECTOR session resolves to academyId null, ignoring any academy param they pass (their own session scope applies via academyScopeWhere instead)", () => {
    const filters = resolveAnalyticsFilters(director, { academy: "escalante" }, TODAY);
    expect(filters.academyId).toBeNull();
  });

  it("a DIRECTOR session resolves to academyId null even with no academy param", () => {
    const filters = resolveAnalyticsFilters(director, {}, TODAY);
    expect(filters.academyId).toBeNull();
  });

  it("a DIRECTOR session assigned to multiple academies resolves to academyId null (not just their first assignment)", () => {
    const filters = resolveAnalyticsFilters(multiAcademyDirector, {}, TODAY);
    expect(filters.academyId).toBeNull();
  });

  it("a malformed from/to falls back to the 30-day default rather than throwing", () => {
    const filters = resolveAnalyticsFilters(admin, { from: "not-a-date", to: "also-not-a-date" }, TODAY);
    expect(filters.to.toISODate()).toBe("2026-09-10");
    expect(filters.from.toISODate()).toBe(TODAY.minus({ days: DEFAULT_RANGE_DAYS }).toISODate());
  });

  it("a valid from/to range is used verbatim, not the default", () => {
    const filters = resolveAnalyticsFilters(admin, { from: "2026-01-01", to: "2026-01-15" }, TODAY);
    expect(filters.from.toISODate()).toBe("2026-01-01");
    expect(filters.to.toISODate()).toBe("2026-01-15");
  });
});
