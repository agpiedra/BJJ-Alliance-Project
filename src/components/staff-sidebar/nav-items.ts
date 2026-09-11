import { BarChart3, CalendarClock, KeyRound, LayoutDashboard, Users } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { StaffSession } from "@/lib/auth/session";

export interface StaffNavItem {
  /** Locale-less path (the sidebar prepends `/${locale}`), e.g. "/dashboard". */
  href: string;
  /** Key inside the "staffSidebar" message namespace. */
  labelKey: string;
  icon: LucideIcon;
  visible: (session: StaffSession) => boolean;
}

/**
 * Each `visible` check below is copied verbatim from the target page's own
 * existing role gate — never a new, independently-invented check:
 * - dashboard/students: every staff role already reaches these pages
 *   (`requireStaffSession()` with no role list).
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
  },
  {
    href: "/students",
    labelKey: "students",
    icon: Users,
    visible: () => true,
  },
  {
    href: "/dashboard/analytics",
    labelKey: "analytics",
    icon: BarChart3,
    visible: (session) => session.role === "ADMIN" || session.role === "DIRECTOR",
  },
  {
    href: "/admin/schedule",
    labelKey: "adminSchedule",
    icon: CalendarClock,
    visible: (session) => session.role === "ADMIN",
  },
  {
    href: "/admin/kiosk-tokens",
    labelKey: "adminKioskTokens",
    icon: KeyRound,
    visible: (session) => session.role === "ADMIN",
  },
];
