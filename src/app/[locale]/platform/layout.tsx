import type { ReactNode } from "react";
import { getTranslations } from "next-intl/server";
import { requireSuperAdmin } from "@/lib/auth/require-super-admin";
import { BrandBanner } from "@/components/brand/brand-banner";
import { ThemeToggle } from "@/components/theme/theme-toggle";
import { PlatformMobileNav } from "./platform-mobile-nav";
import { signOutPlatformAdmin } from "./sign-out-action";

/**
 * MULTI_ACADEMY_AND_KIDS_BELTS.md Phase 6 — `/platform/**`, not `/admin/**`
 * (the doc's own literal text): `/admin/branding`, `/admin/kiosk-tokens`,
 * and `/admin/schedule` already exist at that prefix, gated by the
 * ORGANIZATION role `ADMIN` (`requireTenantContext(["ADMIN"])`), a
 * completely different authorization domain from the platform-wide
 * `isSuperAdmin` flag this route group gates. Sharing a URL prefix between
 * two unrelated authorization meanings is the exact ambiguity that produced
 * every real tenant-isolation bug this project has found — see this same
 * doc's revision 23 and the layout-leak/unauthenticated-signup findings.
 * `/platform/**` keeps the two domains visually and structurally distinct
 * everywhere, at zero cost to the three existing pages.
 *
 * This surface has no organization to brand with — `BrandBanner` renders
 * with zero props, the platform's own wordmark (`PLATFORM_NAME`), same as
 * every genuinely pre-tenant page.
 */
export default async function PlatformLayout({ children, params }: { children: ReactNode; params: Promise<{ locale: string }> }) {
  await requireSuperAdmin();
  const { locale } = await params;
  const t = await getTranslations("platform.nav");
  const signOutAction = signOutPlatformAdmin.bind(null, locale);
  const navLinks = [
    { href: `/${locale}/platform`, label: t("overview"), active: true },
    { href: `/${locale}/platform/organizations`, label: t("organizations") },
    { href: `/${locale}/platform/admins`, label: t("admins") },
  ];

  return (
    <>
      <BrandBanner>
        {/* D6 (DESIGN.md) — this shell had zero responsive treatment before this
            phase. Desktop keeps the inline links exactly as they were, just
            hidden below md; phone gets the same top-bar + sheet pattern the
            staff shell uses (PlatformMobileNav), not a second design. */}
        <nav className="hidden flex-1 items-center gap-4 text-sm md:flex">
          {navLinks.map((link) => (
            <a key={link.href} href={link.href} className={link.active ? "font-medium" : undefined}>
              {link.label}
            </a>
          ))}
          <ThemeToggle />
          <form action={signOutAction} className="ml-auto">
            <button type="submit" className="underline">
              {t("signOut")}
            </button>
          </form>
        </nav>
        <PlatformMobileNav
          className="md:hidden"
          navLinks={navLinks}
          signOutLabel={t("signOut")}
          signOutAction={signOutAction}
          menuLabel={t("menu")}
          closeMenuLabel={t("closeMenu")}
        />
      </BrandBanner>
      <main className="flex flex-col gap-6 p-4 sm:p-6">{children}</main>
    </>
  );
}
