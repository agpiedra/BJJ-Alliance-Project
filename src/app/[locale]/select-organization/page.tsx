import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { BrandBanner } from "@/components/brand/brand-banner";
import { Button } from "@/components/ui/button";
import { AuthCard } from "@/components/auth/auth-card";
import { signOutStaff } from "@/lib/auth/sign-out-actions";
import { selectOrganization } from "./actions";

/**
 * `requireTenantContext`'s redirect target for `NEEDS_ORGANIZATION_SELECTION`
 * — a signed-in user with 2+ active organization memberships and no
 * resolved `activeOrganizationId` selector yet (Appendix C decision 4,
 * point 6: never picked arbitrarily, never left as a silent null). This IS
 * the explicit selection screen the decision requires; Phase 5's org
 * switcher later adds in-app switching without a full-page redirect, but
 * the underlying selection-and-persistence mechanism (this page's action,
 * `unstable_update` + `User.lastActiveOrganizationId`) is what that
 * switcher will reuse, not replace.
 *
 * Checks `auth()` directly below, never `requireTenantContext()` — this
 * page IS one of that function's own redirect targets, so routing it
 * through the same gate would loop a user with no resolved org straight
 * back here. Middleware does not exclude this path from public reach
 * (only /api, /trpc, /_next, /_vercel, and files are — see
 * src/middleware.ts), so this in-page check is the only thing standing
 * between the route and an unauthenticated visitor.
 */
export default async function SelectOrganizationPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ callbackUrl?: string }>;
}) {
  const { locale } = await params;
  const { callbackUrl } = await searchParams;
  const t = await getTranslations("auth.selectOrganization");

  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    redirect(`/${locale}/login`);
  }

  const memberships = await prisma.organizationMembership.findMany({
    where: { userId, active: true, organization: { status: "ACTIVE" } },
    select: { organization: { select: { id: true, name: true } } },
    orderBy: { organization: { name: "asc" } },
  });

  return (
    <>
      <BrandBanner />
      <AuthCard title={t("heading")}>
        <p className="text-sm text-muted-foreground">{t("body")}</p>
        <div className="flex flex-col gap-2">
          {memberships.map(({ organization }) => (
            <form key={organization.id} action={selectOrganization.bind(null, locale, callbackUrl)}>
              <input type="hidden" name="organizationId" value={organization.id} />
              <Button type="submit" variant="outline" className="w-full justify-start">
                {organization.name}
              </Button>
            </form>
          ))}
        </div>
        <form action={signOutStaff.bind(null, locale)}>
          <Button type="submit" variant="ghost" size="sm">
            {t("signOut")}
          </Button>
        </form>
      </AuthCard>
    </>
  );
}
