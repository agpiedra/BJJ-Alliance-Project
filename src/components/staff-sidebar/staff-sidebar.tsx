"use client";

import type { ReactNode } from "react";
import { useTransition } from "react";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
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
import { signOutStaff } from "@/lib/auth/sign-out-actions";

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
  /** MULTI_ACADEMY_AND_KIDS_BELTS.md Phase 4 — resolved server-side in
   * (staff)/layout.tsx, passed straight through to BrandBanner. Optional
   * (null when the layout has no context to theme at all). */
  logo?: {
    logoUrl: string | null;
    initials: string;
    initialsBackground: string;
    initialsForeground: string;
    /** MULTI_ACADEMY_AND_KIDS_BELTS.md Item 2 — passed straight through to
     * BrandBanner's `alt`, so a real logo is never announced under
     * another organization's name. */
    displayName: string;
  } | null;
}

/**
 * Persistent staff nav shell (brand redesign Task 2; grouped sections +
 * academy switcher added REDESIGN_BRIEF.md Phase 2). Built on the shadcn
 * `Sidebar` primitives installed via `npx shadcn@latest add sidebar` — not
 * hand-rolled — which already provide the mobile sheet/drawer collapse.
 * Colors come entirely from the `--sidebar-*`/`--brand-gold*` tokens; no
 * color is hardcoded here.
 */
export function StaffSidebar({ locale, navItems, academySwitcher, logo }: StaffSidebarProps) {
  const pathname = usePathname();
  const t = useTranslations("staffSidebar");
  const activeItem = findActiveNavItem(pathname, locale, navItems);
  const [isSigningOut, startSignOut] = useTransition();

  function handleSignOut() {
    startSignOut(async () => {
      await signOutStaff(locale);
    });
  }

  return (
    <Sidebar>
      <SidebarHeader className="gap-0 p-0">
        <BrandBanner
          compact
          logoUrl={logo?.logoUrl}
          initials={logo?.initials}
          initialsBackground={logo?.initialsBackground}
          initialsForeground={logo?.initialsForeground}
          alt={logo?.displayName}
        />
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
                          // MULTI_ACADEMY_AND_KIDS_BELTS.md Phase 4: was
                          // hardcoded to `bg-brand-gold`/`text-brand-gold-
                          // foreground` — the SAME token `primaryColor`
                          // overrides for buttons/banners/stat-tiles
                          // elsewhere, which would have silently defeated
                          // "the sidebar's active-item color is chosen
                          // independently of primaryColor" (a director
                          // could never set them differently; this one
                          // token would always win in both places at once).
                          // `--sidebar-primary`/`--sidebar-primary-
                          // foreground` were already declared in
                          // globals.css (defaulting to `var(--brand-gold)`,
                          // so an unbranded org's look is byte-for-byte
                          // unchanged) but never actually consumed by any
                          // component until now — this is that wiring.
                          className="data-active:bg-sidebar-primary data-active:text-sidebar-primary-foreground"
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
      {/*
        REDESIGN_BRIEF.md Phase 7 rail footer. The mock also shows a
        "Configuración" item here, but no settings page exists anywhere in
        this brief's scope (all 9 phases) — adding it would be a dead link,
        so this footer carries sign-out only.
      */}
      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton onClick={handleSignOut} disabled={isSigningOut}>
              {t("signOut")}
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
}
