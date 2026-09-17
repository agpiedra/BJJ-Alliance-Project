"use client";

import { useTransition } from "react";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { SidebarTrigger } from "@/components/ui/sidebar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ThemeToggle } from "@/components/theme/theme-toggle";
import { findActiveNavItem } from "./find-active-nav-item";
import type { StaffSidebarNavEntry } from "./staff-sidebar";
import type { StaffRole } from "./nav-items";
import { signOutStaff } from "@/lib/auth/sign-out-actions";

function initialsFromEmail(email: string): string {
  const local = email.split("@")[0] ?? "";
  const segments = local.split(/[._-]+/).filter(Boolean);
  const letters =
    segments.length >= 2
      ? [segments[0]![0], segments[1]![0]]
      : [local[0], local[1] ?? local[0]];
  return letters.filter(Boolean).join("").toUpperCase() || "?";
}

export interface StaffTopBarProps {
  locale: string;
  navItems: StaffSidebarNavEntry[];
  userEmail: string;
  role: StaffRole;
  academyLabel: string;
  /** The rest of the header's right side (notification bell) — kept as a
   * passthrough slot rather than imported directly, since NotificationBell
   * carries its own server-fetched props from (staff)/layout.tsx. */
  children?: React.ReactNode;
}

/**
 * REDESIGN_BRIEF.md Phase 2 top bar: breadcrumb (mono, page name from the
 * same active-nav match the sidebar uses), theme toggle, and an avatar menu
 * showing identity/role/academy. Phase 7 adds "Cerrar sesión" to this menu
 * (and to the rail footer) across all four portals.
 */
export function StaffTopBar({
  locale,
  navItems,
  userEmail,
  role,
  academyLabel,
  children,
}: StaffTopBarProps) {
  const pathname = usePathname();
  const t = useTranslations("staffShell");
  const tSidebar = useTranslations("staffSidebar");
  const activeItem = findActiveNavItem(pathname, locale, navItems);
  const [isSigningOut, startSignOut] = useTransition();

  function handleSignOut() {
    startSignOut(async () => {
      await signOutStaff(locale);
    });
  }

  return (
    <header className="flex h-12 items-center justify-between gap-3 border-b px-4">
      <div className="flex min-w-0 items-center gap-3">
        <SidebarTrigger />
        <span className="truncate font-mono text-[10.5px] tracking-[.11em] text-muted-foreground uppercase">
          {t("breadcrumbPrefix")}
          {activeItem ? ` · ${tSidebar(activeItem.labelKey)}` : null}
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <ThemeToggle />
        {children}
        <DropdownMenu>
          <DropdownMenuTrigger className="flex size-8 items-center justify-center rounded-full bg-sidebar text-xs font-semibold text-sidebar-foreground">
            {initialsFromEmail(userEmail)}
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuGroup>
              <DropdownMenuLabel className="flex flex-col gap-0.5">
                <span className="truncate font-medium">{userEmail}</span>
                <span className="text-xs font-normal text-muted-foreground">
                  {t(`userMenu.role.${role}`)} · {academyLabel}
                </span>
              </DropdownMenuLabel>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={handleSignOut} disabled={isSigningOut}>
              {t("userMenu.signOut")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
