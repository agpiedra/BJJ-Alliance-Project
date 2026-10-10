"use client";

import { usePathname } from "next/navigation";
import { ThemeToggle } from "@/components/theme/theme-toggle";
import { PlatformMobileNav } from "./platform-mobile-nav";
import { findActivePlatformLink, type PlatformNavLink } from "./find-active-platform-link";

/**
 * Review finding 1 — the desktop nav used to hardcode `active: true` on
 * "Overview" regardless of the real route, so aria-current="page" sat on
 * Overview on every platform page, including nested organization/admin
 * routes. usePathname() + findActivePlatformLink (the same specificity rule
 * the staff shell already uses) fixes both the desktop links and the mobile
 * sheet's links from one place, since both render from this one component.
 */
export function PlatformNav({
  navLinks,
  signOutLabel,
  signOutAction,
  menuLabel,
  closeMenuLabel,
  navigationTitle,
  navigationDescription,
}: {
  navLinks: PlatformNavLink[];
  signOutLabel: string;
  signOutAction: () => Promise<void>;
  menuLabel: string;
  closeMenuLabel: string;
  navigationTitle: string;
  navigationDescription: string;
}) {
  const pathname = usePathname();
  const active = findActivePlatformLink(pathname, navLinks);
  const linksWithActive = navLinks.map((link) => ({ ...link, active: link.href === active?.href }));

  return (
    <>
      <nav className="hidden flex-1 items-center gap-4 text-sm md:flex">
        {linksWithActive.map((link) => (
          <a key={link.href} href={link.href} aria-current={link.active ? "page" : undefined} className={link.active ? "font-medium" : undefined}>
            {link.label}
          </a>
        ))}
        <ThemeToggle />
        <form action={signOutAction} className="ml-auto">
          <button type="submit" className="underline">
            {signOutLabel}
          </button>
        </form>
      </nav>
      <PlatformMobileNav
        className="md:hidden"
        navLinks={linksWithActive}
        signOutLabel={signOutLabel}
        signOutAction={signOutAction}
        menuLabel={menuLabel}
        closeMenuLabel={closeMenuLabel}
        navigationTitle={navigationTitle}
        navigationDescription={navigationDescription}
      />
    </>
  );
}
