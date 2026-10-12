import { getLocale, getTranslations } from "next-intl/server";
import { requireTenantContext } from "@/lib/tenant/context";
import { getScopedDb } from "@/lib/tenant/scoped-client";
import { getOrganizationBranding } from "@/lib/branding/get-branding";
import { prisma } from "@/lib/prisma";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { AddLocationForm, IssuedKioskTokens, LocationTokenProvider } from "./location-forms";

// Locations change without a redeploy; never statically frozen.
export const dynamic = "force-dynamic";

/**
 * Locations — the OWNER only, and add-only. An Owner has every location, so the
 * list is the organization's whole set; nobody else may even see it here. The page
 * demands `ADMIN` (anyone else gets a 404, like every unauthorized admin route);
 * the real enforcement is in `location-actions.ts`, which re-checks it on the write.
 */
export default async function LocationsPage() {
  const context = await requireTenantContext(["ADMIN"]);
  const t = await getTranslations("adminLocations");
  const locale = await getLocale();
  const branding = await getOrganizationBranding(context);

  const [academies, organization] = await Promise.all([
    getScopedDb(context).academy.findMany({
      where: {},
      orderBy: { createdAt: "asc" },
      select: { id: true, name: true, address: true, active: true, createdAt: true },
    }),
    prisma.organization.findUniqueOrThrow({ where: { id: context.organizationId }, select: { timezone: true } }),
  ]);

  const dateFormat = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: organization.timezone });

  return (
    <LocationTokenProvider>
      <main className="flex flex-col gap-6 p-4 sm:p-6">
        <header className="flex flex-col gap-1">
          <p className="font-mono text-[10.5px] tracking-[.11em] text-muted-foreground uppercase">
            {t("eyebrow", { orgName: branding.displayName })}
          </p>
          <h1>{t("heading")}</h1>
          <p className="text-sm text-muted-foreground">{t("sub")}</p>
        </header>

        {/* Phase 6 approved prototype (Option B): the reference's card grid, replacing the former <table> —
            same fields (name/address/status/added) and the same Badge component, just regrouped per location
            instead of per column. No new capability. */}
        <Card>
          <CardHeader className="border-b">
            <CardTitle>{t("heading")}</CardTitle>
          </CardHeader>
          <CardContent className="pt-4">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {academies.map((academy) => (
                <div key={academy.id} className="flex flex-col gap-2 rounded-lg border border-border p-4">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="font-medium">{academy.name}</span>
                    <Badge variant="outline">{academy.active ? t("status.active") : t("status.inactive")}</Badge>
                  </div>
                  <span className="text-sm text-muted-foreground">{academy.address ?? t("noAddress")}</span>
                  <span className="mt-1 border-t border-border pt-2 text-xs text-muted-foreground">
                    {t("columns.added")} {dateFormat.format(academy.createdAt)}
                  </span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        <div className="flex flex-col gap-4">
          <IssuedKioskTokens />
          <AddLocationForm organizationId={context.organizationId} />
        </div>
      </main>
    </LocationTokenProvider>
  );
}
