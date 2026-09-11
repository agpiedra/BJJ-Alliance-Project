import { describe, expect, it } from "vitest";
import { NAV_ITEMS } from "@/components/staff-sidebar/nav-items";
import type { StaffSession } from "@/lib/auth/session";

function session(role: StaffSession["role"]): StaffSession {
  return { userId: "u1", role, academyIds: role === "ADMIN" ? "ALL" : [] };
}

function visibleHrefs(role: StaffSession["role"]): string[] {
  const s = session(role);
  return NAV_ITEMS.filter((item) => item.visible(s)).map((item) => item.href);
}

describe("NAV_ITEMS visibility", () => {
  it("ADMIN sees every nav item", () => {
    expect(visibleHrefs("ADMIN")).toEqual([
      "/dashboard",
      "/students",
      "/dashboard/analytics",
      "/admin/schedule",
      "/admin/kiosk-tokens",
    ]);
  });

  it("DIRECTOR sees dashboard, students, and analytics — not the ADMIN-only admin links", () => {
    expect(visibleHrefs("DIRECTOR")).toEqual(["/dashboard", "/students", "/dashboard/analytics"]);
  });

  it("INSTRUCTOR sees only dashboard and students", () => {
    expect(visibleHrefs("INSTRUCTOR")).toEqual(["/dashboard", "/students"]);
  });
});
