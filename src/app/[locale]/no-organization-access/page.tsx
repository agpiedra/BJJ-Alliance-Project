import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { BrandBanner } from "@/components/brand/brand-banner";
import { signOutStaff } from "@/lib/auth/sign-out-actions";
import { resolvePendingApplication } from "@/lib/tenant/platform-lookups";

/**
 * `requireTenantContext`'s redirect target for `NO_MEMBERSHIP` — a
 * genuinely different fact from `organization-unavailable`'s
 * `ORG_NOT_ACTIVE`: there, a specific organization exists but its status
 * isn't ACTIVE; here, the signed-in user has zero active memberships in
 * ANY organization at all (a deactivated member, or an account stuck
 * mid-onboarding). Reusing `organization-unavailable`'s "your organization
 * isn't available" copy would be actively wrong — there is no "your
 * organization" to refer to. Same shell, same sign-out action, distinct
 * copy under its own `auth.noOrganizationAccess` i18n namespace.
 *
 * Deliberately checks `auth()` directly, never `requireTenantContext()` —
 * this page IS one of that function's own redirect targets, so routing it
 * through the same gate would loop. Middleware's matcher does not exclude
 * this path from public reach (only /api, /trpc, /_next, /_vercel, and
 * files are excluded — see src/middleware.ts), so the page's own auth
 * check is the only thing standing between this route and an
 * unauthenticated visitor; skipping it here left the page (and its
 * sign-out action) reachable by anyone.
 */
export default async function NoOrganizationAccessPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const session = await auth();
  if (!session?.user?.id) {
    redirect(`/${locale}/login`);
  }

  // A platform super-admin belongs to no organization by design — `isSuperAdmin`
  // is orthogonal to every membership — so every sign-in, resumed session and
  // deep link that finds no membership lands HERE, on a page whose only button
  // is "sign out". Their home is /platform. Re-read fresh from the database,
  // exactly like `requireSuperAdmin()`, never trusted from the session, so a
  // revoked flag stops redirecting on the very next request.
  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { isSuperAdmin: true, active: true },
  });
  if (user?.isSuperAdmin && user.active) {
    redirect(`/${locale}/platform`);
  }

  const t = await getTranslations("auth.noOrganizationAccess");

  // A self-registered student whose application staff have not approved yet has no
  // membership — that is what approval creates — so they land here too. Tell them
  // what is actually true (awaiting approval, and by whom) rather than what reads
  // as an error. Driven by THEIR OWN Student record only.
  const pending = await resolvePendingApplication(session.user.id);

  return (
    <>
      <BrandBanner />
      <main className="flex min-h-[calc(100vh-4rem)] flex-col items-center justify-center bg-background p-6">
        <Card className="w-full max-w-sm">
          <CardHeader>
            <CardTitle className="text-2xl">{pending ? t("pendingHeading") : t("heading")}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <p className="text-sm text-muted-foreground">
              {pending ? t("pendingBody", { organization: pending.organizationName }) : t("body")}
            </p>
            <form action={signOutStaff.bind(null, locale)}>
              <Button type="submit" variant="primary">
                {t("signOut")}
              </Button>
            </form>
          </CardContent>
        </Card>
      </main>
    </>
  );
}
