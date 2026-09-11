"use client";

import type { ReactNode } from "react";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { BrandBanner } from "@/components/brand/brand-banner";

/**
 * The RSC-serializable slice of `StaffNavItem` this Client Component
 * actually needs — `icon` here is a rendered element, not the component
 * reference, and `visible` isn't included at all: a function (and a bare
 * component reference used as data) can't cross the Server -> Client
 * boundary. `(staff)/layout.tsx` does the filtering + icon rendering
 * server-side and passes down only this plain-data shape.
 */
export interface StaffSidebarNavEntry {
  href: string;
  labelKey: string;
  icon: ReactNode;
}

export interface StaffSidebarProps {
  locale: string;
  /** Already filtered to this session's visible items — see (staff)/layout.tsx. */
  navItems: StaffSidebarNavEntry[];
  /** The dashboard's `<NotificationBell>`, server-rendered by the layout and slotted in here. */
  notificationBell: ReactNode;
}

/**
 * Persistent staff nav shell (brand redesign Task 2). Built on the shadcn
 * `Sidebar` primitives installed via `npx shadcn@latest add sidebar` — not
 * hand-rolled — which already provide the mobile sheet/drawer collapse.
 * Colors come entirely from the `--sidebar-*` tokens Task 1 wired into
 * globals.css; no color is hardcoded here.
 */
export function StaffSidebar({ locale, navItems, notificationBell }: StaffSidebarProps) {
  const pathname = usePathname();
  const t = useTranslations("staffSidebar");

  const fullHrefs = navItems.map((item) => `/${locale}${item.href}`);

  function isActive(fullHref: string): boolean {
    const matches = pathname === fullHref || pathname.startsWith(`${fullHref}/`);
    if (!matches) return false;
    // Prefer the most specific nav item when hrefs nest (e.g. "/dashboard"
    // vs. "/dashboard/analytics") so only one item is ever highlighted.
    return !fullHrefs.some(
      (other) =>
        other !== fullHref &&
        other.startsWith(fullHref) &&
        (pathname === other || pathname.startsWith(`${other}/`))
    );
  }

  return (
    <Sidebar>
      <SidebarHeader className="p-0">
        <BrandBanner compact />
      </SidebarHeader>
      <SidebarContent>
        <SidebarMenu className="gap-1 p-2">
          {navItems.map((item) => {
            const fullHref = `/${locale}${item.href}`;
            return (
              <SidebarMenuItem key={item.href}>
                <SidebarMenuButton isActive={isActive(fullHref)} render={<a href={fullHref} />}>
                  {item.icon}
                  <span>{t(item.labelKey)}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            );
          })}
        </SidebarMenu>
      </SidebarContent>
      <SidebarFooter className="flex-row items-center justify-between">
        {notificationBell}
      </SidebarFooter>
    </Sidebar>
  );
}
