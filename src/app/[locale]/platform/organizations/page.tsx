import { getTranslations } from "next-intl/server";
import { FilterBar, FilterBarSearch, FilterBarSelect } from "@/components/ui/filter-bar";
import { Pill } from "@/components/ui/pill";
import { EmptyState } from "@/components/ui/empty-state";
import {
  DataTable,
  DataTableBody,
  DataTableCell,
  DataTableHead,
  DataTableHeaderCell,
  DataTableHeaderRow,
  DataTableRow,
} from "@/components/ui/data-table";
import { listOrganizationsForPlatformAdmin } from "@/lib/tenant/platform-lookups";
import type { OrganizationStatus } from "@/generated/prisma/client";
import { RowActions } from "./row-actions";

export const dynamic = "force-dynamic";

const STATUS_PILL_VARIANT: Record<OrganizationStatus, "ok" | "warn" | "bad" | "plain"> = {
  ACTIVE: "ok",
  PENDING: "warn",
  SUSPENDED: "bad",
  CANCELLED: "plain",
};

interface OrganizationsSearchParams {
  status?: string;
  country?: string;
  q?: string;
  billing?: string;
}

export default async function PlatformOrganizationsPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<OrganizationsSearchParams>;
}) {
  const { locale } = await params;
  const query = await searchParams;
  const t = await getTranslations("platform.organizations");
  const tStatus = await getTranslations("platform.status");
  const tBillingStatus = await getTranslations("billing.status");

  const status = query.status && query.status !== "ALL" ? (query.status as OrganizationStatus) : undefined;
  const billing = query.billing && query.billing !== "ALL" ? (query.billing as "DUE" | "GRACE_EXPIRED" | "unreviewed") : undefined;
  const organizations = await listOrganizationsForPlatformAdmin({
    status,
    country: query.country || undefined,
    search: query.q || undefined,
    billing,
  });

  return (
    <>
      <header>
        <h1 className="text-2xl font-bold">{t("heading")}</h1>
      </header>

      <FilterBar>
        <form method="get" className="flex flex-wrap items-center gap-2">
          <FilterBarSearch name="q" placeholder={t("searchPlaceholder")} defaultValue={query.q ?? ""} />
          <FilterBarSelect name="status" defaultValue={query.status ?? "ALL"}>
            <option value="ALL">{t("filterAllStatuses")}</option>
            <option value="PENDING">{tStatus("PENDING")}</option>
            <option value="ACTIVE">{tStatus("ACTIVE")}</option>
            <option value="SUSPENDED">{tStatus("SUSPENDED")}</option>
            <option value="CANCELLED">{tStatus("CANCELLED")}</option>
          </FilterBarSelect>
          <FilterBarSearch name="country" placeholder={t("countryPlaceholder")} defaultValue={query.country ?? ""} />
          <FilterBarSelect name="billing" defaultValue={query.billing ?? "ALL"}>
            <option value="ALL">{t("filterAllBilling")}</option>
            <option value="DUE">{t("filterBillingDue")}</option>
            <option value="GRACE_EXPIRED">{t("filterBillingGraceExpired")}</option>
            <option value="unreviewed">{t("filterBillingUnreviewed")}</option>
          </FilterBarSelect>
          <button type="submit" className="text-sm underline">
            {t("applyFilters")}
          </button>
        </form>
      </FilterBar>

      {organizations.length === 0 ? (
        <EmptyState message={t("empty.description")} />
      ) : (
        <DataTable>
          <DataTableHead>
            <DataTableHeaderRow>
              <DataTableHeaderCell>{t("columns.name")}</DataTableHeaderCell>
              <DataTableHeaderCell>{t("columns.status")}</DataTableHeaderCell>
              <DataTableHeaderCell>{t("columns.location")}</DataTableHeaderCell>
              <DataTableHeaderCell>{t("columns.branches")}</DataTableHeaderCell>
              <DataTableHeaderCell>{t("columns.students")}</DataTableHeaderCell>
              <DataTableHeaderCell>{t("columns.attendance30d")}</DataTableHeaderCell>
              <DataTableHeaderCell>{t("columns.billing")}</DataTableHeaderCell>
              <DataTableHeaderCell>{t("columns.actions")}</DataTableHeaderCell>
            </DataTableHeaderRow>
          </DataTableHead>
          <DataTableBody>
            {organizations.map((organization) => (
              <DataTableRow key={organization.id}>
                <DataTableCell>
                  <a href={`/${locale}/platform/organizations/${organization.id}`} className="font-medium underline">
                    {organization.name}
                  </a>
                  <div className="text-xs text-muted-foreground">{organization.slug}</div>
                </DataTableCell>
                <DataTableCell>
                  <Pill variant={STATUS_PILL_VARIANT[organization.status]}>{tStatus(organization.status)}</Pill>
                </DataTableCell>
                <DataTableCell>
                  {organization.city ? `${organization.city}, ` : ""}
                  {organization.country ?? "—"}
                </DataTableCell>
                <DataTableCell>{organization.branchCount}</DataTableCell>
                <DataTableCell>
                  {organization.activeStudentCount} / {organization.studentCount}
                </DataTableCell>
                <DataTableCell>{organization.attendanceLast30Days}</DataTableCell>
                <DataTableCell>
                  {organization.billingState ? (
                    <Pill variant={organization.billingState === "GRACE_EXPIRED" ? "bad" : "warn"}>
                      {tBillingStatus(organization.billingState)}
                      {organization.billingUnreviewed ? ` · ${t("billingUnreviewedSuffix")}` : ""}
                    </Pill>
                  ) : (
                    <Pill variant="ok">{tBillingStatus("CURRENT")}</Pill>
                  )}
                </DataTableCell>
                <DataTableCell>
                  <RowActions organizationId={organization.id} status={organization.status} />
                </DataTableCell>
              </DataTableRow>
            ))}
          </DataTableBody>
        </DataTable>
      )}
    </>
  );
}
