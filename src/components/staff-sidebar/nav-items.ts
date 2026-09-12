import { BarChart3, CalendarClock, KeyRound, LayoutDashboard, Users, Wallet } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { StaffSession } from "@/lib/auth/session";

export type StaffNavGroup = "operations" | "analytics" | "academy";

export interface StaffNavItem {
  /** Locale-less path (the sidebar prepends `/${locale}`), e.g. "/dashboard". */
  href: string;
  /** Key inside the "staffSidebar" message namespace. */
  labelKey: string;
  icon: LucideIcon;
  visible: (session: StaffSession) => boolean;
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
 * - admin/schedule, admin/kiosk-tokens: ADMIN-only, matching each page's own
 *   `requireStaffSession(["ADMIN"])`.
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
    visible: (session) => session.role === "ADMIN" || session.role === "DIRECTOR",
    group: "analytics",
  },
  {
    href: "/admin/schedule",
    labelKey: "adminSchedule",
    icon: CalendarClock,
    visible: (session) => session.role === "ADMIN",
    group: "academy",
  },
  {
    href: "/admin/kiosk-tokens",
    labelKey: "adminKioskTokens",
    icon: KeyRound,
    visible: (session) => session.role === "ADMIN",
    group: "academy",
  },
];

/** Render order for section headers (REDESIGN_BRIEF.md Phase 2). */
export const NAV_GROUP_ORDER: StaffNavGroup[] = ["operations", "analytics", "academy"];
