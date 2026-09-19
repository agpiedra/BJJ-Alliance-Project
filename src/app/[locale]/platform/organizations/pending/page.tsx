import { getTranslations } from "next-intl/server";
import { EmptyState } from "@/components/ui/empty-state";
import { Card, CardContent } from "@/components/ui/card";
import { listPendingOrganizations } from "@/lib/tenant/platform-lookups";
import { PendingRowActions } from "./pending-row-actions";

export const dynamic = "force-dynamic";

/**
 * MULTI_ACADEMY_AND_KIDS_BELTS.md Phase 6 — "approval queue with the full
 * submitted form and Approve / Reject with a note." Reads directly via
 * `unscopedPrisma` (this page is gated by the parent `/platform` layout's
 * own `requireSuperAdmin()`, a genuinely platform-level read with no single
 * organization to scope by) rather than adding a one-call function to
 * platform-admin/organizations.ts for a query this simple and used nowhere
 * else.
 */
export default async function PendingOrganizationsPage() {
  const t = await getTranslations("platform.organizations.pending");

  const pending = await listPendingOrganizations();

  return (
    <>
      <header>
        <h1 className="text-2xl font-bold">{t("heading")}</h1>
      </header>

      {pending.length === 0 ? (
        <EmptyState message={t("empty.description")} />
      ) : (
        <div className="flex flex-col gap-4">
          {pending.map((organization) => (
            <Card key={organization.id}>
              <CardContent className="flex flex-col gap-2">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <h2 className="text-lg font-semibold">{organization.name}</h2>
                  <span className="text-xs text-muted-foreground">{organization.slug}</span>
                </div>
                <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-3">
                  <div>
                    <dt className="text-muted-foreground">{t("fields.location")}</dt>
                    <dd>
                      {organization.city}, {organization.country}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">{t("fields.contact")}</dt>
                    <dd>{organization.contactName}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">{t("fields.email")}</dt>
                    <dd>{organization.contactEmail}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">{t("fields.phone")}</dt>
                    <dd>{organization.contactPhone}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">{t("fields.studentCount")}</dt>
                    <dd>{organization.studentCountBand}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">{t("fields.referralSource")}</dt>
                    <dd>{organization.referralSource || "—"}</dd>
                  </div>
                </dl>
                <PendingRowActions organizationId={organization.id} />
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </>
  );
}
