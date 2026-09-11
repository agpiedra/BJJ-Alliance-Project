import type { ReactNode } from "react";
import { getLocale } from "next-intl/server";
import { getStaffSession } from "@/lib/auth/session";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { StaffSidebar } from "@/components/staff-sidebar/staff-sidebar";
import { NAV_ITEMS } from "@/components/staff-sidebar/nav-items";
import { NotificationBell } from "./dashboard/notification-bell";
import { getMyNotifications, getUnreadCount } from "./dashboard/notification-actions";

/**
 * Persistent shell for every staff-facing page (brand redesign Task 2).
 *
 * This layout's own session read is used ONLY to decide which nav links to
 * show — it must never become a second access-control gate. Every moved
 * page (and every server action it calls) keeps enforcing access itself via
 * its own `requireStaffSession` call, exactly as before this task; if this
 * layout's `getStaffSession()` finds no session, nav items are simply all
 * hidden here, while `getMyNotifications`/`getUnreadCount` below (and the
 * page underneath) still self-enforce via their own `requireStaffSession`
 * calls and redirect to `/login` exactly as they always have.
 */
export default async function StaffLayout({ children }: { children: ReactNode }) {
  const locale = await getLocale();
  const session = await getStaffSession();
  // `NAV_ITEMS`' `icon` (a component reference) and `visible` (a function)
  // can't cross the Server -> Client boundary as data — this resolves both
  // server-side into a plain, serializable shape (`StaffSidebarNavEntry`)
  // before handing it to the client `StaffSidebar`.
  const navItems = session
    ? NAV_ITEMS.filter((item) => item.visible(session)).map((item) => ({
        href: item.href,
        labelKey: item.labelKey,
        icon: <item.icon />,
      }))
    : [];

  // Moved here from dashboard/page.tsx (Phase 8's NotificationBell) — the
  // bell is now part of the persistent shell, not one page's own header, so
  // every staff page shows it, not just /dashboard.
  const [notifications, unreadCount] = await Promise.all([getMyNotifications(), getUnreadCount()]);

  return (
    <SidebarProvider>
      <StaffSidebar
        locale={locale}
        navItems={navItems}
        notificationBell={
          <NotificationBell initialNotifications={notifications} initialUnreadCount={unreadCount} />
        }
      />
      <SidebarInset>
        <header className="flex h-12 items-center border-b px-4">
          <SidebarTrigger />
        </header>
        {children}
      </SidebarInset>
    </SidebarProvider>
  );
}
