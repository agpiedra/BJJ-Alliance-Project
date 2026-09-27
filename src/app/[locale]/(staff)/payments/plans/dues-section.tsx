import { getTranslations } from "next-intl/server";
import type { Currency, DuesPolicyVersion, PaymentPlanTerms } from "@/generated/prisma/client";
import { Badge } from "@/components/ui/badge";
import { compareYearMonth, type YearMonth } from "@/lib/dues/calendar";
import { currentMonthIn, nextMonthIn, policyRevision, termsRevision } from "@/lib/dues/config-input";
import { currencySymbol } from "@/lib/payments/format-money";
import type { ManagedPlan } from "@/lib/payments/list-plans";
import { AddPolicyForm, AddTermsForm, CorrectPolicyForm, CorrectTermsForm, CreatePackageForm } from "./dues-config-forms";

type VersionState = "current" | "scheduled" | "past";

/** Oldest first. The latest version that has taken effect is "current", earlier ones are "past", later ones are "scheduled" (correctable). */
function versionStates<T extends { effectiveYear: number; effectiveMonth: number }>(rows: T[], now: YearMonth): Map<T, VersionState> {
  const states = new Map<T, VersionState>();
  let current: T | null = null;
  for (const row of rows) {
    const cmp = compareYearMonth({ year: row.effectiveYear, month: row.effectiveMonth }, now);
    if (cmp > 0) states.set(row, "scheduled");
    else {
      states.set(row, "past");
      current = row;
    }
  }
  if (current) states.set(current, "current");
  return states;
}

/**
 * A saved price or fee at its exact two decimals. `formatMoney` shows colones as whole units, which would display ₡25,000.50 as ₡25,001:
 * fine for a payment list, wrong for the configuration an owner is checking. Values are `Decimal(10,2)`, so `toFixed(2)` is exact.
 */
const exactMoney = (amount: { toFixed(digits: number): string }, currency: Currency, locale: string) =>
  `${currencySymbol(currency)} ${new Intl.NumberFormat(locale === "es" ? "es-CR" : "en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(amount.toFixed(2)))}`;

const monthLabel =(row: { effectiveYear: number; effectiveMonth: number }, locale: string) =>
  new Intl.DateTimeFormat(locale, { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(row.effectiveYear, row.effectiveMonth - 1, 1)));

/**
 * One location's dues configuration, owner only (the page does not render this for a director; the actions enforce it regardless).
 * Everything here is configuration. Nothing on it starts billing, and it says so.
 */
export async function DuesSection({
  organizationId,
  academy,
  plans,
  terms,
  policies,
  organizationCurrency,
  locale,
}: {
  organizationId: string;
  academy: { id: string; timezone: string };
  plans: ManagedPlan[];
  terms: PaymentPlanTerms[];
  policies: DuesPolicyVersion[];
  organizationCurrency: Currency;
  locale: string;
}) {
  const t = await getTranslations("payments.plans.dues");
  const tPlans = await getTranslations("payments.plans");
  const now = currentMonthIn(academy.timezone);
  const defaults = nextMonthIn(academy.timezone);
  // A location prices everything in one currency; until it has saved anything it follows the organization's currency.
  const branchCurrency = terms[0]?.currency ?? policies[0]?.lateFeeCurrency ?? organizationCurrency;
  const policyStates = versionStates(policies, now);
  const stateLabel = (state: VersionState) => t(`state.${state}`);
  const th = "pb-2 pr-4 font-medium";

  return (
    <section className="flex flex-col gap-4 border-t pt-4">
      <h3 className="text-base font-semibold">{t("heading")}</h3>
      <p className="rounded-lg border border-border bg-muted/30 p-3 text-sm">{t("notice")}</p>

      <div className="flex flex-col gap-3">
        <h4 className="text-sm font-semibold">{t("terms.heading")}</h4>
        <p className="text-xs text-muted-foreground">{t("terms.body")}</p>
        {plans.map((plan) => {
          const planTerms = terms.filter((row) => row.planId === plan.id);
          const states = versionStates(planTerms, now);
          return (
            <div key={plan.id} className="flex flex-col gap-3 rounded-lg border border-border p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{plan.name}</span>
                {plan.isPackage && <Badge variant="outline">{t("package.badge")}</Badge>}
                {!plan.active && <Badge variant="outline">{tPlans("status.inactive")}</Badge>}
              </div>
              {planTerms.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t("terms.none")}</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-sm">
                    <thead>
                      <tr className="text-muted-foreground">
                        <th className={th}>{t("terms.columns.from")}</th>
                        <th className={th}>{t("terms.columns.price")}</th>
                        <th className={th}>{t("terms.columns.months")}</th>
                        <th className={th}>{t("terms.columns.state")}</th>
                        <th className="pb-2 font-medium">{t("terms.columns.actions")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {planTerms.map((row) => {
                        const state = states.get(row) ?? "past";
                        return (
                          <tr key={row.id} className="border-t">
                            <td className="py-2 pr-4 align-top whitespace-nowrap">{monthLabel(row, locale)}</td>
                            <td className="py-2 pr-4 align-top whitespace-nowrap">{exactMoney(row.priceAmount, row.currency, locale)}</td>
                            <td className="py-2 pr-4 align-top whitespace-nowrap">{t("terms.duration", { count: row.monthsCovered })}</td>
                            <td className="py-2 pr-4 align-top">
                              <Badge variant="outline">{stateLabel(state)}</Badge>
                            </td>
                            <td className="py-2 align-top">
                              {state === "scheduled" && (
                                <CorrectTermsForm
                                  organizationId={organizationId}
                                  row={{
                                    id: row.id,
                                    revision: termsRevision(row),
                                    priceAmount: row.priceAmount.toFixed(2),
                                    currency: row.currency,
                                    monthsCovered: row.monthsCovered,
                                  }}
                                />
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
              <AddTermsForm organizationId={organizationId} planId={plan.id} isPackage={plan.isPackage} defaults={defaults} defaultCurrency={branchCurrency} />
            </div>
          );
        })}
        <CreatePackageForm organizationId={organizationId} academyId={academy.id} defaults={defaults} defaultCurrency={branchCurrency} />
      </div>

      <div className="flex flex-col gap-3">
        <h4 className="text-sm font-semibold">{t("policy.heading")}</h4>
        <p className="text-xs text-muted-foreground">{t("policy.body")}</p>
        {policies.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("policy.none")}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="text-muted-foreground">
                  <th className={th}>{t("policy.columns.from")}</th>
                  <th className={th}>{t("policy.columns.dueDay")}</th>
                  <th className={th}>{t("policy.columns.graceDay")}</th>
                  <th className={th}>{t("policy.columns.lateFee")}</th>
                  <th className={th}>{t("policy.columns.limit")}</th>
                  <th className={th}>{t("policy.columns.state")}</th>
                  <th className="pb-2 font-medium">{t("policy.columns.actions")}</th>
                </tr>
              </thead>
              <tbody>
                {policies.map((row) => {
                  const state = policyStates.get(row) ?? "past";
                  return (
                    <tr key={row.id} className="border-t">
                      <td className="py-2 pr-4 align-top whitespace-nowrap">{monthLabel(row, locale)}</td>
                      <td className="py-2 pr-4 align-top">{row.dueDay}</td>
                      <td className="py-2 pr-4 align-top">{row.graceDay}</td>
                      <td className="py-2 pr-4 align-top whitespace-nowrap">{exactMoney(row.lateFeeAmount, row.lateFeeCurrency, locale)}</td>
                      <td className="py-2 pr-4 align-top">
                        {row.maxPrepaidMonths === null ? t("policy.limitNotEntered") : t("terms.duration", { count: row.maxPrepaidMonths })}
                      </td>
                      <td className="py-2 pr-4 align-top">
                        <Badge variant="outline">{stateLabel(state)}</Badge>
                      </td>
                      <td className="py-2 align-top">
                        {state === "scheduled" && (
                          <CorrectPolicyForm
                            organizationId={organizationId}
                            row={{
                              id: row.id,
                              revision: policyRevision(row),
                              dueDay: String(row.dueDay),
                              graceDay: String(row.graceDay),
                              lateFeeAmount: row.lateFeeAmount.toFixed(2),
                              lateFeeCurrency: row.lateFeeCurrency,
                              maxPrepaidMonths: row.maxPrepaidMonths === null ? "" : String(row.maxPrepaidMonths),
                            }}
                          />
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <AddPolicyForm organizationId={organizationId} academyId={academy.id} defaults={defaults} defaultCurrency={branchCurrency} />
      </div>
    </section>
  );
}
