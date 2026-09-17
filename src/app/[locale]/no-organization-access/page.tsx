import { getTranslations } from "next-intl/server";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { BrandBanner } from "@/components/brand/brand-banner";
import { signOutStaff } from "@/lib/auth/sign-out-actions";

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
 */
export default async function NoOrganizationAccessPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const t = await getTranslations("auth.noOrganizationAccess");

  return (
    <>
      <BrandBanner />
      <main className="flex min-h-[calc(100vh-4rem)] flex-col items-center justify-center bg-background p-6">
        <Card className="w-full max-w-sm">
          <CardHeader>
            <CardTitle className="text-2xl">{t("heading")}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <p className="text-sm text-muted-foreground">{t("body")}</p>
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
