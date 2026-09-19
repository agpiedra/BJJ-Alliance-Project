import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { Card, CardContent } from "@/components/ui/card";
import { Pill } from "@/components/ui/pill";
import { resolveOrganizationAuditTrail, resolveOrganizationDetailForPlatformAdmin } from "@/lib/tenant/platform-lookups";
import { DangerZone } from "./danger-zone";

export const dynamic = "force-dynamic";

const STATUS_PILL_VARIANT = { ACTIVE: "ok", PENDING: "warn", SUSPENDED: "bad", CANCELLED: "plain" } as const;

/**
 * MULTI_ACADEMY_AND_KIDS_BELTS.md Phase 6 — "detail: overview and internal
 * notes, branding, promotion rules, branches, members..., audit trail,
 * danger zone." Every read here is either a direct `unscopedPrisma` read
 * (this page is gated by the parent `/platform` layout's own
 * `requireSuperAdmin()`) or the one named cross-tenant audit reader,
 * `resolveOrganizationAuditTrail`.
 */
export default async function OrganizationDetailPage({ params }: { params: Promise<{ locale: string; id: string }> }) {
  const { id } = await params;
  const t = await getTranslations("platform.organizations.detail");
  const tStatus = await getTranslations("platform.status");

  const organization = await resolveOrganizationDetailForPlatformAdmin(id);
  if (!organization) notFound();

  const auditTrail = await resolveOrganizationAuditTrail(id);

  return (
    <>
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-2xl font-bold">{organization.name}</h1>
          <p className="text-sm text-muted-foreground">{organization.slug}</p>
        </div>
        <Pill variant={STATUS_PILL_VARIANT[organization.status]}>{tStatus(organization.status)}</Pill>
      </header>

      <Card>
        <CardContent className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
          <div>
            <div className="text-muted-foreground">{t("fields.location")}</div>
            <div>
              {organization.city}, {organization.country}
            </div>
          </div>
          <div>
            <div className="text-muted-foreground">{t("fields.contact")}</div>
            <div>{organization.contactName}</div>
            <div>{organization.contactEmail}</div>
          </div>
          <div>
            <div className="text-muted-foreground">{t("fields.created")}</div>
            <div>{organization.createdAt.toISOString().slice(0, 10)}</div>
          </div>
          <div>
            <div className="text-muted-foreground">{t("fields.approved")}</div>
            <div>{organization.approvedAt ? organization.approvedAt.toISOString().slice(0, 10) : "—"}</div>
          </div>
          {organization.internalNotes && (
            <div className="col-span-2 sm:col-span-3">
              <div className="text-muted-foreground">{t("fields.internalNotes")}</div>
              <div>{organization.internalNotes}</div>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent>
          <h2 className="mb-2 text-sm font-semibold">{t("branding.heading")}</h2>
          <p className="text-sm">
            {t("branding.displayName")}: {organization.branding?.displayName || organization.name}
          </p>
          <p className="text-sm text-muted-foreground">
            {organization.branding?.logoUrl ? t("branding.hasLogo") : t("branding.noLogo")}
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardContent>
          <h2 className="mb-2 text-sm font-semibold">{t("branches.heading", { count: organization.academies.length })}</h2>
          <ul className="flex flex-col gap-1 text-sm">
            {organization.academies.map((academy) => (
              <li key={academy.id}>
                {academy.name} ({academy.slug}) — {academy.active ? t("branches.active") : t("branches.inactive")}
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      <Card>
        <CardContent>
          <h2 className="mb-2 text-sm font-semibold">{t("members.heading", { count: organization.memberships.length })}</h2>
          <ul className="flex flex-col gap-1 text-sm">
            {organization.memberships.map((membership) => (
              <li key={membership.id}>
                {membership.user.email} — {membership.role} {!membership.user.active && `(${t("members.inactive")})`}
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      <Card>
        <CardContent>
          <h2 className="mb-2 text-sm font-semibold">{t("promotionRules.heading")}</h2>
          <ul className="flex flex-col gap-1 text-sm">
            {organization.promotionConfigs.map((config) => (
              <li key={config.id}>
                {config.track}: {config.mode}
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      <Card>
        <CardContent>
          <h2 className="mb-2 text-sm font-semibold">{t("auditTrail.heading")}</h2>
          {auditTrail.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("auditTrail.empty")}</p>
          ) : (
            <ul className="flex flex-col gap-1 text-sm">
              {auditTrail.map((entry) => (
                <li key={entry.id} className="border-b border-border pb-1">
                  <span className="text-muted-foreground">{entry.createdAt.toISOString().slice(0, 16).replace("T", " ")}</span>{" "}
                  — {entry.action} {entry.actorEmail ? `(${entry.actorEmail})` : ""}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent>
          <h2 className="mb-2 text-sm font-semibold text-destructive">{t("dangerZone.heading")}</h2>
          <DangerZone organizationId={organization.id} status={organization.status} />
        </CardContent>
      </Card>
    </>
  );
}
