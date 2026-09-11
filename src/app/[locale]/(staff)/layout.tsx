import type { ReactNode } from "react";
import { cookies } from "next/headers";
import { getLocale, getTranslations } from "next-intl/server";
import { getStaffSession } from "@/lib/auth/session";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { SidebarProvider } from "@/components/ui/sidebar";
import { StaffSidebar } from "@/components/staff-sidebar/staff-sidebar";
import { StaffTopBar } from "@/components/staff-sidebar/staff-top-bar";
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

  // Academy list for the switcher: every academy for ADMIN (unscoped),
  // or only the academies this DIRECTOR/INSTRUCTOR is assigned to — same
  // split students/page.tsx already uses for its own academy select.
  const scopedAcademyIds =
    session && Array.isArray(session.academyIds) ? session.academyIds : [];
  const academies = session
    ? session.role === "ADMIN"
      ? await prisma.academy.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } })
      : await prisma.academy.findMany({
          where: { id: { in: scopedAcademyIds } },
          orderBy: { name: "asc" },
          select: { id: true, name: true },
        })
    : [];

  const cookieStore = await cookies();
  const requestedAcademyId = cookieStore.get("selected_academy")?.value ?? null;
  const selectedAcademyId =
    session?.role === "ADMIN" && academies.some((a) => a.id === requestedAcademyId)
      ? requestedAcademyId
      : null;

  const tShell = await getTranslations("staffShell");
  const academyLabel =
    session?.role === "ADMIN"
      ? (academies.find((a) => a.id === selectedAcademyId)?.name ?? tShell("academySwitcher.bothSelected"))
      : academies.map((a) => a.name).join(", ");

  // Active-student count for the "Alumnos" nav badge — same ACTIVE +
  // home-academy scoping students/page.tsx's own query already uses,
  // just narrowed to a count instead of a full roster fetch.
  const activeStudentCount = session
    ? await prisma.student.count({
        where: {
          status: "ACTIVE",
          ...(session.academyIds === "ALL" ? {} : { homeAcademyId: { in: session.academyIds } }),
        },
      })
    : 0;

  // `NAV_ITEMS`' `icon` (a component reference) and `visible` (a function)
  // can't cross the Server -> Client boundary as data — this resolves both
  // server-side into a plain, serializable shape (`StaffSidebarNavEntry`)
  // before handing it to the client `StaffSidebar`.
  const navItems = session
    ? NAV_ITEMS.filter((item) => item.visible(session)).map((item) => ({
        href: item.href,
        labelKey: item.labelKey,
        icon: <item.icon />,
        group: item.group,
        badge: item.href === "/students" ? activeStudentCount : undefined,
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
  const sidebarState = cookieStore.get("sidebar_state")?.value;
  const sidebarDefaultOpen = sidebarState !== "false";

  const authSession = await auth();

  return (
    <SidebarProvider defaultOpen={sidebarDefaultOpen}>
      <StaffSidebar
        locale={locale}
        navItems={navItems}
        academySwitcher={{
          academies,
          selectedAcademyId,
          readOnly: session?.role !== "ADMIN",
        }}
      />
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
        className="relative flex w-full min-w-0 flex-1 flex-col overflow-x-hidden bg-background md:peer-data-[variant=inset]:m-2 md:peer-data-[variant=inset]:ml-0 md:peer-data-[variant=inset]:rounded-xl md:peer-data-[variant=inset]:shadow-sm md:peer-data-[variant=inset]:peer-data-[state=collapsed]:ml-2"
      >
        {session && (
          <StaffTopBar
            locale={locale}
            navItems={navItems}
            userEmail={authSession?.user?.email ?? ""}
            role={session.role}
            academyLabel={academyLabel}
          >
            <NotificationBell initialNotifications={notifications} initialUnreadCount={unreadCount} />
          </StaffTopBar>
        )}
        {children}
      </div>
    </SidebarProvider>
  );
}
