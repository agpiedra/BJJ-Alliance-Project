"use client";

import { useTransition } from "react";
import { useTranslations } from "next-intl";
import { BrandBanner } from "@/components/brand/brand-banner";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { signOutStudent } from "@/lib/auth/sign-out-actions";

function initialsFromName(firstName: string, lastName: string): string {
  const letters = [firstName[0], lastName[0]].filter(Boolean);
  return letters.join("").toUpperCase() || "?";
}

export interface PortalTopBarProps {
  locale: string;
  firstName: string;
  lastName: string;
  /** MULTI_ACADEMY_AND_KIDS_BELTS.md Phase 4 — see StaffSidebarProps's own
   * matching field; same shape, passed straight through to BrandBanner. */
  logo?: {
    logoUrl: string | null;
    initials: string;
    initialsBackground: string;
    initialsForeground: string;
    /** MULTI_ACADEMY_AND_KIDS_BELTS.md Item 2 — passed straight through to
     * BrandBanner's `alt`, see StaffSidebarProps's own matching field. */
    displayName: string;
  };
}

/**
 * REDESIGN_BRIEF.md Phase 8's "Top bar with the Alliance mark and the avatar
 * menu" for the student portal — the mark is `BrandBanner`, already used on
 * this page pre-restyle; the avatar menu is placed in its `children` slot
 * (documented there as "a title, a locale switcher, a nav trigger, etc.")
 * rather than building a second header row, since the student portal has no
 * rail/breadcrumb to justify `StaffTopBar`'s fuller layout — this folds in
 * Phase 7's temporary inline ghost-button sign-out exactly as that phase's
 * comment on this page said Phase 8 would, wired to the same `signOutStudent`
 * action (unchanged) via the same useTransition pattern `StaffTopBar` already
 * established for the three staff portals.
 */
export function PortalTopBar({ locale, firstName, lastName, logo }: PortalTopBarProps) {
  const t = useTranslations("portal");
  const [isSigningOut, startSignOut] = useTransition();

  function handleSignOut() {
    startSignOut(async () => {
      await signOutStudent(locale);
    });
  }

  return (
    <BrandBanner
      logoUrl={logo?.logoUrl}
      initials={logo?.initials}
      initialsBackground={logo?.initialsBackground}
      initialsForeground={logo?.initialsForeground}
      alt={logo?.displayName}
    >
      <DropdownMenu>
        <DropdownMenuTrigger className="ml-auto flex size-8 items-center justify-center rounded-full bg-sidebar-accent text-xs font-semibold text-sidebar-accent-foreground">
          {initialsFromName(firstName, lastName)}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuGroup>
            <DropdownMenuLabel className="truncate font-medium">
              {firstName} {lastName}
            </DropdownMenuLabel>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={handleSignOut} disabled={isSigningOut}>
            {t("signOut")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </BrandBanner>
  );
}
