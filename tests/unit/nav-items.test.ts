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
      "/payments",
      "/dashboard/analytics",
      "/admin/schedule",
      "/admin/kiosk-tokens",
    ]);
  });

  // REDESIGN_BRIEF.md Phase 9 opened the Kiosco page to DIRECTOR for its new
  // "Marcajes de hoy" table (the page's own gate is now
  // requireStaffSession(["ADMIN", "DIRECTOR"])); /admin/schedule stays
  // ADMIN-only.
  it("DIRECTOR sees dashboard, students, payments, analytics and Kiosco — not the ADMIN-only schedule link", () => {
    expect(visibleHrefs("DIRECTOR")).toEqual([
      "/dashboard",
      "/students",
      "/payments",
      "/dashboard/analytics",
      "/admin/kiosk-tokens",
    ]);
  });

  // REDESIGN_BRIEF.md Phase 8: instructor gets a READ-ONLY Pagos view (the
  // page itself hides the Registrar-pago card and every write action for a
  // non-ADMIN/DIRECTOR session), not zero access — same "every staff role
  // reaches this page" shape as dashboard/students, matching this file's own
  // `visible` doc comment.
  it("INSTRUCTOR sees dashboard, students, and payments (read-only) — not analytics or the admin links", () => {
    expect(visibleHrefs("INSTRUCTOR")).toEqual(["/dashboard", "/students", "/payments"]);
  });
});
