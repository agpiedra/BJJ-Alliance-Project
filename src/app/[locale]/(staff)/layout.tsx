import type { ReactNode } from "react";
import { cookies } from "next/headers";
import { getLocale } from "next-intl/server";
import { getStaffSession } from "@/lib/auth/session";
import { SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
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

  // `SidebarProvider`'s own toggle handler (src/components/ui/sidebar.tsx)
  // persists the user's collapse/expand choice to a `sidebar_state` cookie
  // but never reads it back itself — that's this layout's job, server-side,
  // via `defaultOpen`. Cookie value is the literal string "true"/"false" (see
  // that file's `document.cookie = \`${SIDEBAR_COOKIE_NAME}=${openState}\``);
  // absent (first visit) defaults to expanded, same as the component's own
  // `defaultOpen = true` default.
  const sidebarState = (await cookies()).get("sidebar_state")?.value;
  const sidebarDefaultOpen = sidebarState !== "false";

  return (
    <SidebarProvider defaultOpen={sidebarDefaultOpen}>
      <StaffSidebar locale={locale} navItems={navItems} />
      {/*
        Plain `<div>` carrying `SidebarInset`'s exact className, not
        `<SidebarInset>` itself — that vendored component hardcodes a
        `<main>` (src/components/ui/sidebar.tsx:305-316) with no `render`
        override, and every staff page below already renders its own
        `<main>`, which nested two `<main>` landmarks on every staff page.
        Do not edit sidebar.tsx (vendored shadcn primitive) — swap it out
        here instead.
      */}
      <div
        data-slot="sidebar-inset"
        className="relative flex w-full flex-1 flex-col bg-background md:peer-data-[variant=inset]:m-2 md:peer-data-[variant=inset]:ml-0 md:peer-data-[variant=inset]:rounded-xl md:peer-data-[variant=inset]:shadow-sm md:peer-data-[variant=inset]:peer-data-[state=collapsed]:ml-2"
      >
        <header className="flex h-12 items-center justify-between border-b px-4">
          <SidebarTrigger />
          <NotificationBell initialNotifications={notifications} initialUnreadCount={unreadCount} />
        </header>
        {children}
      </div>
    </SidebarProvider>
  );
}
