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

        <Card>
          <CardHeader className="border-b">
            <CardTitle>{t("heading")}</CardTitle>
          </CardHeader>
          <CardContent className="pt-4">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="text-muted-foreground">
                    <th className="pb-2 pr-4 font-medium">{t("columns.name")}</th>
                    <th className="pb-2 pr-4 font-medium">{t("columns.address")}</th>
                    <th className="pb-2 pr-4 font-medium">{t("columns.status")}</th>
                    <th className="pb-2 font-medium">{t("columns.added")}</th>
                  </tr>
                </thead>
                <tbody>
                  {academies.map((academy) => (
                    <tr key={academy.id} className="border-t">
                      <td className="py-2 pr-4 align-top font-medium">{academy.name}</td>
                      <td className="py-2 pr-4 align-top">{academy.address ?? t("noAddress")}</td>
                      <td className="py-2 pr-4 align-top">
                        <Badge variant="outline">{academy.active ? t("status.active") : t("status.inactive")}</Badge>
                      </td>
                      <td className="py-2 align-top whitespace-nowrap">{dateFormat.format(academy.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
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
