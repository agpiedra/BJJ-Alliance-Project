import Link from "next/link";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { auth } from "@/auth";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { BrandBanner } from "@/components/brand/brand-banner";
import { signOutStaff } from "@/lib/auth/sign-out-actions";
import { accessFromContext } from "@/lib/auth/derive-access";
import { landingFor } from "@/lib/auth/route-access";
import { getTenantContext } from "@/lib/tenant/context";
import { cn } from "cn";

/**
 * Where the access refresh route (`/api/access/refresh`) lands someone whose access
 * to a route tree the DATABASE also denies — a student opening the staff app, an
 * Owner who does not train opening the portal. The point of this page is that a
 * refusal is never silent and never a bounce to the login page: it says plainly
 * what happened and offers where they CAN go.
 *
 * Deliberately not behind the middleware gate and not behind `requireTenantContext`
 * (which would redirect a tenant-less visitor away from the very page that explains
 * a refusal): it checks `auth()` directly and asks for the tenant context only to
 * know which side of the app to offer.
 */
export default async function NoAccessPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const session = await auth();
  if (!session?.user?.id) {
    redirect(`/${locale}/login`);
  }

  const t = await getTranslations("auth.noAccess");
  const result = await getTenantContext();
  const landing = result.status === "OK" ? landingFor(accessFromContext(result.context)) : null;

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
            {landing && (
              <Link href={`/${locale}${landing}`} className={cn(buttonVariants({ variant: "primary" }))}>
                {landing === "/dashboard" ? t("goStaff") : t("goPortal")}
              </Link>
            )}
            <form action={signOutStaff.bind(null, locale)}>
              <Button type="submit" variant="outline">
                {t("signOut")}
              </Button>
            </form>
          </CardContent>
        </Card>
      </main>
    </>
  );
}
