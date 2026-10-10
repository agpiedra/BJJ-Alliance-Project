import type { ReactNode } from "react";
import { getTranslations } from "next-intl/server";
import { requireSuperAdmin } from "@/lib/auth/require-super-admin";
import { BrandBanner } from "@/components/brand/brand-banner";
import { PlatformNav } from "./platform-nav";
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
    { href: `/${locale}/platform`, label: t("overview") },
    { href: `/${locale}/platform/organizations`, label: t("organizations") },
    { href: `/${locale}/platform/admins`, label: t("admins") },
  ];

  return (
    <>
      <BrandBanner>
        {/* D6 (DESIGN.md) — this shell had zero responsive treatment before this
            phase. PlatformNav renders both the desktop inline links (hidden
            below md) and the phone top-bar + sheet pattern the staff shell
            uses, deriving which link is active from the real pathname (review
            finding 1) instead of hardcoding "Overview". */}
        <PlatformNav
          navLinks={navLinks}
          signOutLabel={t("signOut")}
          signOutAction={signOutAction}
          menuLabel={t("menu")}
          closeMenuLabel={t("closeMenu")}
          navigationTitle={t("navigationTitle")}
          navigationDescription={t("navigationDescription")}
        />
      </BrandBanner>
      <main className="flex flex-col gap-6 p-4 sm:p-6">{children}</main>
    </>
  );
}
