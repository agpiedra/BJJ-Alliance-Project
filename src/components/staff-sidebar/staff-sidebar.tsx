"use client";

import type { ReactNode } from "react";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { BrandBanner } from "@/components/brand/brand-banner";
import { NAV_GROUP_ORDER, type StaffNavGroup } from "./nav-items";
import { AcademySwitcher, type AcademySwitcherProps } from "./academy-switcher";
import { findActiveNavItem } from "./find-active-nav-item";

/**
 * The RSC-serializable slice of `StaffNavItem` this Client Component
 * actually needs — `icon` here is a rendered element, not the component
 * reference, and `visible` isn't included at all: a function (and a bare
 * component reference used as data) can't cross the Server -> Client
 * boundary. `(staff)/layout.tsx` does the filtering + icon rendering
 * server-side and passes down only this plain-data shape. `badge` is a
 * live count (currently only "students") computed server-side too — it's
 * data, not a function, so it crosses the boundary fine.
 */
export interface StaffSidebarNavEntry {
  href: string;
  labelKey: string;
  icon: ReactNode;
  group: StaffNavGroup;
  badge?: number;
}

export interface StaffSidebarProps {
  locale: string;
  /** Already filtered to this session's visible items — see (staff)/layout.tsx. */
  navItems: StaffSidebarNavEntry[];
  academySwitcher: AcademySwitcherProps;
}

/**
 * Persistent staff nav shell (brand redesign Task 2; grouped sections +
 * academy switcher added REDESIGN_BRIEF.md Phase 2). Built on the shadcn
 * `Sidebar` primitives installed via `npx shadcn@latest add sidebar` — not
 * hand-rolled — which already provide the mobile sheet/drawer collapse.
 * Colors come entirely from the `--sidebar-*`/`--brand-gold*` tokens; no
 * color is hardcoded here.
 */
export function StaffSidebar({ locale, navItems, academySwitcher }: StaffSidebarProps) {
  const pathname = usePathname();
  const t = useTranslations("staffSidebar");
  const activeItem = findActiveNavItem(pathname, locale, navItems);

  return (
    <Sidebar>
      <SidebarHeader className="gap-0 p-0">
        <BrandBanner compact />
        <div className="border-b border-sidebar-border px-2 py-2">
          <AcademySwitcher {...academySwitcher} />
        </div>
      </SidebarHeader>
      <SidebarContent>
        {NAV_GROUP_ORDER.map((group) => {
          const items = navItems.filter((item) => item.group === group);
          if (items.length === 0) return null;
          return (
            <SidebarGroup key={group}>
              <SidebarGroupLabel className="font-mono text-[10.5px] tracking-[.11em] uppercase">
                {t(`groups.${group}`)}
              </SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu className="gap-1">
                  {items.map((item) => {
                    const fullHref = `/${locale}${item.href}`;
                    return (
                      <SidebarMenuItem key={item.href}>
                        <SidebarMenuButton
                          isActive={activeItem?.href === item.href}
                          render={<a href={fullHref} />}
                          className="data-active:bg-brand-gold data-active:text-brand-gold-foreground"
                        >
                          {item.icon}
                          <span>{t(item.labelKey)}</span>
                        </SidebarMenuButton>
                        {item.badge != null && (
                          <SidebarMenuBadge className="font-mono">{item.badge}</SidebarMenuBadge>
                        )}
                      </SidebarMenuItem>
                    );
                  })}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          );
        })}
      </SidebarContent>
    </Sidebar>
  );
}
