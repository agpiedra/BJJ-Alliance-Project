import type { ReactNode } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { getTenantContext } from "@/lib/tenant/context";
import { getScopedDb } from "@/lib/tenant/scoped-client";
import { prisma } from "@/lib/prisma";
import { auth } from "@/auth";
import { SidebarProvider } from "@/components/ui/sidebar";
import { StaffSidebar } from "@/components/staff-sidebar/staff-sidebar";
import { StaffTopBar } from "@/components/staff-sidebar/staff-top-bar";
import { NAV_ITEMS, type StaffTenantContext } from "@/components/staff-sidebar/nav-items";
import { NotificationBell } from "./dashboard/notification-bell";
import { getMyNotifications, getUnreadCount } from "./dashboard/notification-actions";
import { getOrganizationBranding } from "@/lib/branding/get-branding";
import { BrandingScope } from "@/components/branding/branding-scope";
import { resolveDirectorBillingBanner } from "@/lib/billing/banner";
import { BillingBanner } from "./billing-banner";

/**
 * Persistent shell for every staff-facing page (brand redesign Task 2).
 *
 * This layout's own context read is used ONLY to decide which nav links to
 * show — it must never become a second access-control gate. Every moved
 * page (and every server action it calls) keeps enforcing access itself via
 * its own `requireTenantContext` call, exactly as before this task; if this
 * layout's `getTenantContext()` resolves to anything other than a non-STUDENT
 * `OK` tenant, nav items are simply all hidden here, while
 * `getMyNotifications`/`getUnreadCount` below (and the page underneath)
 * still self-enforce via their own `requireTenantContext` calls and redirect
 * exactly as they always have.
 *
 * `getTenantContext()` replaced `getStaffSession()` in revision 23: the old
 * function queried `Academy`/`Student` via the raw, unscoped Prisma client
 * with no organizationId filter at all (a real cross-tenant leak once a
 * second organization exists — docs/MULTI_ACADEMY_AND_KIDS_BELTS.md). A
 * STUDENT's tenant context is treated the same as "no context" here, same as
 * `getStaffSession()` returning null for a STUDENT claim before.
 */
export default async function StaffLayout({ children }: { children: ReactNode }) {
  const locale = await getLocale();
  const tenantResult = await getTenantContext();
  const resolvedContext = tenantResult.status === "OK" ? tenantResult.context : null;
  const context: StaffTenantContext | null =
    resolvedContext && resolvedContext.organizationRole !== "STUDENT"
      ? (resolvedContext as StaffTenantContext)
      : null;

  // MULTI_ACADEMY_AND_KIDS_BELTS.md Phase 5 — onboarding-wizard trigger.
  // Deliberately narrower than "a second access-control gate" (this
  // layout's own stated rule, see its doc comment): this never DENIES
  // access, it only REDIRECTS an already-authorized ADMIN/DIRECTOR to a
  // page they're equally authorized to see. Runs on every staff page load
  // (not only right after accepting an invitation) because the doc's own
  // acceptance criterion requires resuming mid-wizard after closing the
  // browser and logging back in normally through /login. `/onboarding`
  // lives outside the (staff) route group, so this layout never wraps it —
  // no self-redirect-loop risk from this check.
  if (context && (context.organizationRole === "ADMIN" || context.organizationRole === "DIRECTOR")) {
    const organization = await prisma.organization.findUnique({
      where: { id: context.organizationId },
      select: { onboardingCompletedAt: true },
    });
    if (organization && !organization.onboardingCompletedAt) {
      redirect(`/${locale}/onboarding`);
    }
  }

  // MULTI_ACADEMY_AND_KIDS_BELTS.md Phase 6 billing — "show a non-blocking
  // banner to that organization's ADMIN/DIRECTOR only — never to
  // instructors, students, or the kiosk." `context` above already excludes
  // STUDENT but still includes INSTRUCTOR, so this needs its own,
  // narrower role check rather than reusing `context`'s truthiness alone.
  const canSeeBillingBanner = context && (context.organizationRole === "ADMIN" || context.organizationRole === "DIRECTOR");
  const billingBanner = canSeeBillingBanner ? await resolveDirectorBillingBanner(context) : null;

  // Academy list for the switcher: every academy for ADMIN (org-scoped,
  // unfiltered by branch), or only the academies this DIRECTOR/INSTRUCTOR is
  // assigned to — same split students/page.tsx already uses for its own
  // academy select.
  const scopedAcademyIds = context && Array.isArray(context.academyIds) ? context.academyIds : [];
  const academies = context
    ? context.organizationRole === "ADMIN"
      ? await getScopedDb(context).academy.findMany({ where: {}, orderBy: { name: "asc" }, select: { id: true, name: true } })
      : await getScopedDb(context).academy.findMany({
          where: { id: { in: scopedAcademyIds } },
          orderBy: { name: "asc" },
          select: { id: true, name: true },
        })
    : [];

  const cookieStore = await cookies();
  const requestedAcademyId = cookieStore.get("selected_academy")?.value ?? null;
  const selectedAcademyId =
    context?.organizationRole === "ADMIN" && academies.some((a) => a.id === requestedAcademyId)
      ? requestedAcademyId
      : null;

  const tShell = await getTranslations("staffShell");
  const academyLabel =
    context?.organizationRole === "ADMIN"
      ? (academies.find((a) => a.id === selectedAcademyId)?.name ?? tShell("academySwitcher.bothSelected"))
      : academies.map((a) => a.name).join(", ");

  // Active-student count for the "Alumnos" nav badge — same ACTIVE +
  // home-academy scoping students/page.tsx's own query already uses,
  // just narrowed to a count instead of a full roster fetch.
  const activeStudentCount = context
    ? await getScopedDb(context).student.count({
        where: {
          status: "ACTIVE",
          ...(context.academyIds === "ALL" ? {} : { homeAcademyId: { in: context.academyIds } }),
        },
      })
    : 0;

  // `NAV_ITEMS`' `icon` (a component reference) and `visible` (a function)
  // can't cross the Server -> Client boundary as data — this resolves both
  // server-side into a plain, serializable shape (`StaffSidebarNavEntry`)
  // before handing it to the client `StaffSidebar`.
  const navItems = context
    ? NAV_ITEMS.filter((item) => item.visible(context)).map((item) => ({
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
  const branding = context ? await getOrganizationBranding(context) : null;

  const shell = (
    <SidebarProvider defaultOpen={sidebarDefaultOpen}>
      <StaffSidebar
        locale={locale}
        navItems={navItems}
        academySwitcher={{
          academies,
          selectedAcademyId,
          readOnly: context?.organizationRole !== "ADMIN",
        }}
        logo={
          branding
            ? {
                logoUrl: branding.logoUrl,
                initials: branding.initials,
                initialsBackground: branding.sidebar.background,
                initialsForeground: branding.sidebar.foreground,
                displayName: branding.displayName,
              }
            : null
        }
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
        {context && (
          <StaffTopBar
            locale={locale}
            navItems={navItems}
            userEmail={authSession?.user?.email ?? ""}
            role={context.organizationRole}
            academyLabel={academyLabel}
            orgName={branding?.displayName}
          >
            <NotificationBell initialNotifications={notifications} initialUnreadCount={unreadCount} />
          </StaffTopBar>
        )}
        {billingBanner && <BillingBanner state={billingBanner.state} dueOn={billingBanner.dueOn} deadline={billingBanner.deadline} />}
        {children}
      </div>
    </SidebarProvider>
  );

  // MULTI_ACADEMY_AND_KIDS_BELTS.md Phase 4 — the staff sidebar is one of
  // the 3 surfaces branding applies to. `branding` is null only when
  // `context` itself is (the layout's own "hide everything" fallback for a
  // non-staff/unauthenticated request, which each page's own
  // requireTenantContext bounces regardless) — nothing to theme there.
  return branding ? <BrandingScope branding={branding}>{shell}</BrandingScope> : shell;
}
