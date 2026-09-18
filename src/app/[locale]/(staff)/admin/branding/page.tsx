import { getTranslations } from "next-intl/server";
import { requireTenantContext } from "@/lib/tenant/context";
import { getScopedDb } from "@/lib/tenant/scoped-client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getOrganizationBranding } from "@/lib/branding/get-branding";
import { ThemePicker } from "@/components/branding/theme-picker";
import { LogoUploader } from "@/components/branding/logo-uploader";
import { saveBrandingTheme, uploadBrandingLogo, removeBrandingLogo } from "./actions";

// Branding changes without a redeploy — same reasoning as every other
// staff page reading live, mutable data.
export const dynamic = "force-dynamic";

/**
 * MULTI_ACADEMY_AND_KIDS_BELTS.md Phase 4 — "Configuración → Academia."
 * ADMIN/DIRECTOR, matching the doc's own page-level gate; the logo upload/
 * remove actions this page renders narrow further to ADMIN-only themselves
 * (item 2), enforced server-side, not by hiding either control here.
 *
 * Reads the RAW row directly (not through `getOrganizationBranding`'s
 * cache) because the edit form needs the true nullable override fields —
 * whether the director previously typed an explicit sidebar override, vs.
 * a value that's merely derived for display — a distinction the resolved-
 * for-rendering shape those other 3 surfaces use doesn't preserve.
 */
export default async function BrandingSettingsPage() {
  const context = await requireTenantContext(["ADMIN", "DIRECTOR"]);
  const t = await getTranslations("branding");

  const [raw, resolved] = await Promise.all([
    getScopedDb(context).organizationBranding.findUnique({
      where: { organizationId: context.organizationId },
      include: { organization: { select: { name: true } } },
    }),
    getOrganizationBranding(context),
  ]);

  const displayName = raw?.displayName ?? raw?.organization.name ?? resolved.displayName;

  return (
    <main className="flex flex-col gap-6 p-6">
      <div>
        <p className="text-sm text-muted-foreground">{t("eyebrow")}</p>
        <h1 className="text-2xl font-bold">{t("heading")}</h1>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t("logo.heading")}</CardTitle>
        </CardHeader>
        <CardContent>
          <LogoUploader
            organizationId={context.organizationId}
            logoUrl={resolved.logoUrl}
            displayName={displayName}
            previewBackground={resolved.sidebar.background}
            uploadAction={uploadBrandingLogo}
            removeAction={removeBrandingLogo}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("theme.heading")}</CardTitle>
        </CardHeader>
        <CardContent>
          <ThemePicker
            organizationId={context.organizationId}
            initial={{
              displayName,
              primaryColor: resolved.primary.background,
              sidebarBackground: resolved.sidebar.background,
              sidebarForeground: raw?.sidebarForeground ?? null,
              sidebarActiveBackground: raw?.sidebarActiveBackground ?? null,
              sidebarActiveForeground: raw?.sidebarActiveForeground ?? null,
              sidebarBorder: raw?.sidebarBorder ?? null,
            }}
            action={saveBrandingTheme}
          />
        </CardContent>
      </Card>
    </main>
  );
}
