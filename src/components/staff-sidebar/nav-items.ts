import { BarChart3, CalendarClock, KeyRound, LayoutDashboard, Palette, Users, Wallet } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { MembershipRole, TenantContext } from "@/lib/tenant/types";

/** A `TenantContext` whose role is never STUDENT — the set `(staff)/layout.tsx` treats as staff. */
export type StaffRole = Exclude<MembershipRole, "STUDENT">;
export type StaffTenantContext = TenantContext & { organizationRole: StaffRole };

export type StaffNavGroup = "operations" | "analytics" | "academy";

export interface StaffNavItem {
  /** Locale-less path (the sidebar prepends `/${locale}`), e.g. "/dashboard". */
  href: string;
  /** Key inside the "staffSidebar" message namespace. */
  labelKey: string;
  icon: LucideIcon;
  visible: (context: StaffTenantContext) => boolean;
  /** Section this item renders under (REDESIGN_BRIEF.md Phase 2) — label text
   * comes from "staffSidebar.groups.<group>". */
  group: StaffNavGroup;
}

/**
 * Each `visible` check below is copied verbatim from the target page's own
 * existing role gate — never a new, independently-invented check:
 * - dashboard/students/payments: every staff role already reaches these
 *   pages (`requireStaffSession()` with no role list) — Pagos per
 *   REDESIGN_BRIEF.md Phase 8's "instructor: admin layout minus Pagos WRITE
 *   access" (a read-only view, not zero access; the page itself hides the
 *   Registrar-pago card and write buttons from non-ADMIN/DIRECTOR sessions,
 *   and `recordPayment`/`markPaymentPaid` re-enforce that gate server-side).
 * - analytics: the exact `session.role === "ADMIN" || session.role ===
 *   "DIRECTOR"` condition `dashboard/page.tsx`'s own `canViewOverduePayments`
 *   uses, which matches `dashboard/analytics/page.tsx`'s own
 *   `requireStaffSession(["ADMIN", "DIRECTOR"])`.
 * - admin/schedule: ADMIN-only, matching that page's own
 *   `requireStaffSession(["ADMIN"])`.
 * - admin/kiosk-tokens: ADMIN or DIRECTOR, matching that page's own
 *   `requireStaffSession(["ADMIN", "DIRECTOR"])` since REDESIGN_BRIEF.md
 *   Phase 9 added the "Marcajes de hoy" table a director needs to review. The
 *   token-regeneration button inside the page stays ADMIN-only on its own.
 * This is navigation convenience only — the real access control stays where
 * it already lives, in each page/action's own `requireStaffSession` call.
 */
export const NAV_ITEMS: StaffNavItem[] = [
  {
    href: "/dashboard",
    labelKey: "dashboard",
    icon: LayoutDashboard,
    visible: () => true,
    group: "operations",
  },
  {
    href: "/students",
    labelKey: "students",
    icon: Users,
    visible: () => true,
    group: "operations",
  },
  {
    href: "/payments",
    labelKey: "payments",
    icon: Wallet,
    visible: () => true,
    group: "operations",
  },
  {
    href: "/dashboard/analytics",
    labelKey: "analytics",
    icon: BarChart3,
    visible: (context) => context.organizationRole === "ADMIN" || context.organizationRole === "DIRECTOR",
    group: "analytics",
  },
  {
    href: "/admin/schedule",
    labelKey: "adminSchedule",
    icon: CalendarClock,
    visible: (context) => context.organizationRole === "ADMIN",
    group: "academy",
  },
  {
    href: "/admin/kiosk-tokens",
    labelKey: "adminKioskTokens",
    icon: KeyRound,
    visible: (context) => context.organizationRole === "ADMIN" || context.organizationRole === "DIRECTOR",
    group: "academy",
  },
  {
    // MULTI_ACADEMY_AND_KIDS_BELTS.md Phase 4 — matches
    // admin/branding/page.tsx's own requireTenantContext(["ADMIN",
    // "DIRECTOR"]) gate exactly, same convention as every other item here.
    href: "/admin/branding",
    labelKey: "adminBranding",
    icon: Palette,
    visible: (context) => context.organizationRole === "ADMIN" || context.organizationRole === "DIRECTOR",
    group: "academy",
  },
];

/** Render order for section headers (REDESIGN_BRIEF.md Phase 2). */
export const NAV_GROUP_ORDER: StaffNavGroup[] = ["operations", "analytics", "academy"];
