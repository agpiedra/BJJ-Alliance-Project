"use client";

import { useEffect, useState } from "react";
import { MenuIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetClose, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { MatroomWordmark } from "@/components/brand/matroom-mark";
import { ThemeToggle } from "@/components/theme/theme-toggle";
import { useIsMobile } from "@/hooks/use-mobile";

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
  navigationTitle,
  navigationDescription,
}: {
  className?: string;
  navLinks: PlatformMobileNavLink[];
  signOutLabel: string;
  signOutAction: () => Promise<void>;
  menuLabel: string;
  closeMenuLabel: string;
  navigationTitle: string;
  navigationDescription: string;
}) {
  // Review finding 3 — this sheet is uncontrolled-by-default, but its own
  // trigger button lives inside `className="md:hidden"`: resizing past the
  // md breakpoint while open hid the trigger without closing the already-
  // portaled, modal sheet (stuck focus trap + scroll lock, nothing left to
  // close it with). Mirrors `SidebarProvider`'s own `isMobile` check so the
  // sheet closes the moment the viewport crosses into desktop, and — since
  // this effect only ever closes, never opens — resizing back down to
  // mobile afterward never reopens it on its own.
  const isMobile = useIsMobile();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!isMobile) setOpen(false);
  }, [isMobile]);

  return (
    <div className={className}>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetTrigger render={<Button variant="ghost" size="icon-sm" aria-label={menuLabel} />}>
          <MenuIcon aria-hidden="true" />
        </SheetTrigger>
        <SheetContent
          side="left"
          showCloseButton={false}
          className="flex w-(--sidebar-width) flex-col gap-0 bg-sidebar p-0 text-sidebar-foreground"
          style={{ "--sidebar-width": "18rem" } as React.CSSProperties}
        >
          {/* Review finding 2 — Base UI's Dialog has no accessible name without
              a Title; the visible wordmark below is decorative chrome, not
              wired to aria-labelledby. Same sr-only SheetHeader pattern every
              other real Sheet caller in this codebase already uses. */}
          <SheetHeader className="sr-only">
            <SheetTitle>{navigationTitle}</SheetTitle>
            <SheetDescription>{navigationDescription}</SheetDescription>
          </SheetHeader>
          <div className="flex items-center justify-between border-b border-sidebar-border px-4 py-3">
            <MatroomWordmark size={16} />
            <SheetClose render={<Button variant="ghost" size="icon-sm" aria-label={closeMenuLabel} />}>
              <XIcon aria-hidden="true" />
            </SheetClose>
          </div>
          {/* Review finding 3 — overflow-y-auto: on a short viewport, 3 links
              plus the footer could previously overflow with no scroll
              container, pushing Theme/Sign out out of reach. */}
          <nav className="flex flex-1 flex-col gap-1 overflow-y-auto p-2">
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
