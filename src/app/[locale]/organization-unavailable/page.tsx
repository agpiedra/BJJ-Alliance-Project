import { getTranslations } from "next-intl/server";
import { Button } from "@/components/ui/button";
import { AuthCard } from "@/components/auth/auth-card";
import { signOutStaff } from "@/lib/auth/sign-out-actions";

/**
 * `requireTenantContext`'s redirect target for `ORG_NOT_ACTIVE` (a
 * PENDING/SUSPENDED/CANCELLED organization) — spec: "Users of a PENDING,
 * SUSPENDED or CANCELLED organization ... see a clear localized message, not
 * a generic auth error." Deliberately generic about WHICH of the three
 * applies, matching the kiosk's own suspended-organization message: it must
 * not disclose billing state to whoever is looking at the screen.
 *
 * The user IS authenticated at this point (only `getTenantContext` failed,
 * not `auth()`), so this page's only action is signing them out —
 * `signOutStaff` works for a student session too (it just clears an
 * otherwise-absent `selected_academy` cookie), so one shared action covers
 * every role rather than branching on it here.
 */
export default async function OrganizationUnavailablePage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const t = await getTranslations("auth.orgUnavailable");

  return (
    <AuthCard title={t("heading")}>
      <p className="text-sm text-muted-foreground">{t("body")}</p>
      <form action={signOutStaff.bind(null, locale)}>
        <Button type="submit" variant="primary">
          {t("signOut")}
        </Button>
      </form>
    </AuthCard>
  );
}
