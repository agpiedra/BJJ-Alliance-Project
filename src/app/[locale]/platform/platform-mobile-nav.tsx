"use client";

import { MenuIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetClose, SheetContent, SheetTrigger } from "@/components/ui/sheet";
import { MatroomWordmark } from "@/components/brand/matroom-mark";
import { ThemeToggle } from "@/components/theme/theme-toggle";

export interface PlatformMobileNavLink {
  href: string;
  label: string;
  active?: boolean;
}

/**
 * D6 (DESIGN.md) phone pattern for the platform shell, which had zero
 * responsive treatment before this phase (`platform/layout.tsx`'s own doc
 * comment). No `SidebarProvider`/academy switcher/role variation here — every
 * platform screen is superadmin-only, so this is just the top-bar + sheet
 * shape scaled down to 3 links and a sign-out form, reusing the same `Sheet`
 * primitive the staff shell's mobile sidebar uses (not a second pattern).
 */
export function PlatformMobileNav({
  className,
  navLinks,
  signOutLabel,
  signOutAction,
  menuLabel,
  closeMenuLabel,
}: {
  className?: string;
  navLinks: PlatformMobileNavLink[];
  signOutLabel: string;
  signOutAction: () => Promise<void>;
  menuLabel: string;
  closeMenuLabel: string;
}) {
  return (
    <div className={className}>
      <Sheet>
        <SheetTrigger render={<Button variant="ghost" size="icon-sm" aria-label={menuLabel} />}>
          <MenuIcon aria-hidden="true" />
        </SheetTrigger>
        <SheetContent
          side="left"
          showCloseButton={false}
          className="flex w-(--sidebar-width) flex-col gap-0 bg-sidebar p-0 text-sidebar-foreground"
          style={{ "--sidebar-width": "18rem" } as React.CSSProperties}
        >
          <div className="flex items-center justify-between border-b border-sidebar-border px-4 py-3">
            <MatroomWordmark size={16} />
            <SheetClose render={<Button variant="ghost" size="icon-sm" aria-label={closeMenuLabel} />}>
              <XIcon aria-hidden="true" />
            </SheetClose>
          </div>
          <nav className="flex flex-1 flex-col gap-1 p-2">
            {navLinks.map((link) => (
              <a
                key={link.href}
                href={link.href}
                aria-current={link.active ? "page" : undefined}
                className="flex min-h-11 items-center rounded-md px-3 text-sm text-sidebar-foreground hover:bg-sidebar-accent aria-[current=page]:bg-sidebar-primary aria-[current=page]:font-semibold aria-[current=page]:text-sidebar-primary-foreground"
              >
                {link.label}
              </a>
            ))}
          </nav>
          <div className="mt-auto flex flex-col gap-1 border-t border-sidebar-border p-2">
            <ThemeToggle />
            <form action={signOutAction}>
              <button
                type="submit"
                className="flex min-h-11 w-full items-center rounded-md px-3 text-left text-sm text-sidebar-foreground hover:bg-sidebar-accent"
              >
                {signOutLabel}
              </button>
            </form>
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}
