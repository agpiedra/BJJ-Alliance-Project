import { describe, expect, it } from "vitest";
import { NAV_ITEMS, type StaffRole, type StaffTenantContext } from "@/components/staff-sidebar/nav-items";

function session(role: StaffRole): StaffTenantContext {
  return {
    kind: "tenant",
    actorUserId: "u1",
    organizationId: "org1",
    organizationRole: role,
    academyIds: role === "ADMIN" ? "ALL" : [],
    selfStudentId: null,
  };
}

function visibleHrefs(role: StaffRole): string[] {
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
      "/admin/branding",
      // Staff management and adding a location are Owner-only — see
      // admin/staff/page.tsx and admin/locations/page.tsx.
      "/admin/staff",
      "/admin/locations",
    ]);
  });

  // REDESIGN_BRIEF.md Phase 9 opened the Kiosco page to DIRECTOR for its new
  // "Marcajes de hoy" table (the page's own gate is now
  // requireStaffSession(["ADMIN", "DIRECTOR"])); /admin/schedule stays
  // ADMIN-only. MULTI_ACADEMY_AND_KIDS_BELTS.md Phase 4's /admin/branding
  // matches the doc's own "org ADMIN/DIRECTOR only" settings-page gate.
  it("DIRECTOR sees dashboard, students, payments, analytics, Kiosco and Branding — not the ADMIN-only schedule link", () => {
    expect(visibleHrefs("DIRECTOR")).toEqual([
      "/dashboard",
      "/students",
      "/payments",
      "/dashboard/analytics",
      "/admin/kiosk-tokens",
      "/admin/branding",
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
