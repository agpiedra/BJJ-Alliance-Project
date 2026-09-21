import { getLocale, getTranslations } from "next-intl/server";
import { requireTenantContext, branchScopeWhere } from "@/lib/tenant/context";
import { getScopedDb } from "@/lib/tenant/scoped-client";
import { getOrganizationBranding } from "@/lib/branding/get-branding";
import { prisma } from "@/lib/prisma";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { isCustomPromoPlanName } from "@/lib/payments/custom-promo-plan-name";
import { formatMoney } from "@/lib/payments/format-money";
import { listPlansForManagement } from "@/lib/payments/list-plans";
import { CreatePlanForm, CurrencyForm, PlanRowActions } from "./plan-forms";

// Plans change without a redeploy; never statically frozen.
export const dynamic = "force-dynamic";

/**
 * Payment plan management: list, create, edit, deactivate. ADMIN (the owner,
 * every academy) and DIRECTOR (the academies they run) — the same gate and the
 * same academy scoping the Pagos page uses. An INSTRUCTOR never reaches it.
 * The real enforcement is in `plan-actions.ts` on every write.
 */
export default async function PaymentPlansPage() {
  const context = await requireTenantContext(["ADMIN", "DIRECTOR"]);
  const t = await getTranslations("payments.plans");
  const branding = await getOrganizationBranding(context);
  const locale = await getLocale();

  const scope = branchScopeWhere(context);
  const academies = await getScopedDb(context).academy.findMany({
    where: { ...(scope.academyId ? { id: { in: scope.academyId.in } } : {}) },
    orderBy: { name: "asc" },
    select: { id: true, name: true },
  });

  const [plans, organization] = await Promise.all([
    listPlansForManagement(context.organizationId, academies.map((a) => a.id)),
    prisma.organization.findUniqueOrThrow({ where: { id: context.organizationId }, select: { currency: true, name: true } }),
  ]);
  const currency = organization.currency;

  return (
    <main className="flex flex-col gap-6 p-4 sm:p-6">
      <header className="flex flex-col gap-1">
        <p className="font-mono text-[10.5px] tracking-[.11em] text-muted-foreground uppercase">
          {t("eyebrow", { orgName: branding.displayName })}
        </p>
        <h1>{t("heading")}</h1>
        <p className="text-sm text-muted-foreground">{t("sub")}</p>
        <a href={`/${locale}/payments`} className="text-sm underline">
          {t("backToPayments")}
        </a>
      </header>

      {academies.map((academy) => {
        const academyPlans = plans.filter((plan) => plan.academyId === academy.id);
        return (
          <Card key={academy.id}>
            <CardHeader className="border-b">
              <CardTitle>{academy.name}</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-4 pt-4">
              {academyPlans.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t("empty")}</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-sm">
                    <thead>
                      <tr className="text-muted-foreground">
                        <th className="pb-2 pr-4 font-medium">{t("columns.name")}</th>
                        <th className="pb-2 pr-4 font-medium">{t("columns.defaultAmount")}</th>
                        <th className="pb-2 pr-4 font-medium">{t("columns.status")}</th>
                        <th className="pb-2 pr-4 font-medium">{t("columns.payments")}</th>
                        <th className="pb-2 font-medium">{t("columns.actions")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {academyPlans.map((plan) => (
                        <tr key={plan.id} className="border-t">
                          <td className="py-2 pr-4 align-top">
                            <div className="font-medium">{plan.name}</div>
                            {plan.description && <div className="text-xs text-muted-foreground">{plan.description}</div>}
                          </td>
                          <td className="py-2 pr-4 align-top whitespace-nowrap">
                            {plan.defaultAmount != null ? formatMoney(plan.defaultAmount, currency, locale) : "—"}
                          </td>
                          <td className="py-2 pr-4 align-top">
                            <Badge variant="outline">{plan.active ? t("status.active") : t("status.inactive")}</Badge>
                          </td>
                          <td className="py-2 pr-4 align-top">{plan.paymentCount}</td>
                          <td className="py-2 align-top">
                            <PlanRowActions
                              organizationId={context.organizationId}
                              currency={currency}
                              plan={{
                                id: plan.id,
                                name: plan.name,
                                description: plan.description,
                                defaultAmount: plan.defaultAmount,
                                active: plan.active,
                                isSystem: isCustomPromoPlanName(plan.name),
                              }}
                            />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <CreatePlanForm organizationId={context.organizationId} academyId={academy.id} currency={currency} />
            </CardContent>
          </Card>
        );
      })}

      {/* The owner (ADMIN) only: the currency is one per organization, and a
          location director must not change what the whole academy prices in.
          `changeOrganizationCurrency` re-enforces ADMIN server-side. */}
      {context.organizationRole === "ADMIN" && (
        <Card>
          <CardHeader className="border-b">
            <CardTitle>{t("currency.heading")}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4 pt-4">
            <p className="text-sm text-muted-foreground">{t("currency.body", { current: t(`currencyOption.${currency}`) })}</p>
            <CurrencyForm organizationId={context.organizationId} current={currency} />
          </CardContent>
        </Card>
      )}
    </main>
  );
}
