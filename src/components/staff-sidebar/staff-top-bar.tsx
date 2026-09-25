"use client";

import { useTransition } from "react";
import { usePathname, useRouter } from "next/navigation";
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
import { PLATFORM_NAME } from "@/lib/platform";

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
  /** MULTI_ACADEMY_AND_KIDS_BELTS.md Item 2 — the organization's own
   * `displayName`, resolved server-side in `(staff)/layout.tsx`. Replaces
   * the previous hardcoded `breadcrumbPrefix` translation string
   * ("Alliance Costa Rica"), which named Alliance on every organization's
   * staff pages. Falls back to `PLATFORM_NAME` only in the defensive case
   * where this layout somehow rendered with no resolved branding at all. */
  orgName?: string;
  /** Shows a "Platform" entry in the user menu. Display only — `/platform`
   * enforces its own `requireSuperAdmin()` gate; this never grants access. */
  isSuperAdmin?: boolean;
  /** Shows "My training" — a staff member who also trains has a linked, active student
   * record, and the portal is their own page. REQUIRED (not defaulted) so a caller cannot
   * forget it: the layout passes the DATABASE-derived answer for this request, never the
   * session claim. Display only — the portal enforces its own gate. */
  hasPortal: boolean;
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
  orgName,
  isSuperAdmin = false,
  hasPortal,
  children,
}: StaffTopBarProps) {
  const pathname = usePathname();
  const router = useRouter();
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
          {orgName ?? PLATFORM_NAME}
          {activeItem ? ` · ${tSidebar(activeItem.labelKey)}` : null}
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <ThemeToggle />
        {children}
        <DropdownMenu>
          <DropdownMenuTrigger className="flex size-8 items-center justify-center rounded-full border border-input bg-sidebar text-xs font-semibold text-sidebar-foreground pointer-coarse:size-11">
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
            {hasPortal && (
              <DropdownMenuItem onClick={() => router.push(`/${locale}/portal`)}>
                {t("userMenu.myTraining")}
              </DropdownMenuItem>
            )}
            {isSuperAdmin && (
              <DropdownMenuItem onClick={() => router.push(`/${locale}/platform`)}>
                {t("userMenu.platform")}
              </DropdownMenuItem>
            )}
            <DropdownMenuItem onClick={handleSignOut} disabled={isSigningOut}>
              {t("userMenu.signOut")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
