import { getTranslations } from "next-intl/server";
import { inactiveLedgerActivation } from "@/lib/dues/ledger/activation";
import { listRecentExchangeRateQuotes } from "@/lib/dues/exchange-rate-queries";
import { AddExchangeRateForm, CorrectExchangeRateForm } from "./exchange-rate-forms";

/**
 * Owner-only, organization-wide BCR USD/CRC sell-rate entry and correction (currency-conversion brief; this
 * feature's own planning brief). Mounted once per organization (not per academy, unlike `DuesSection` — a rate is
 * organization-wide), from `page.tsx`'s own ADMIN-only branch.
 *
 * Two independent layers, deliberately not merged (brief §2.3): `enterOrCorrectExchangeRate` itself always refuses
 * `"notActive"` when the real, unmodified `inactiveLedgerActivation` reports inactive (unconditional server-side
 * enforcement, unaffected by anything here) — this component's OWN read of the same singleton is a read-only,
 * advisory pre-check that hides the forms entirely when inactive, so the owner is never shown a submit button that
 * is guaranteed to fail. Both read the identical production singleton, so they can never disagree under real
 * conditions.
 */
export async function ExchangeRateSection({ organizationId }: { organizationId: string }) {
  const t = await getTranslations("payments.plans.exchangeRate");
  const active = await inactiveLedgerActivation.isActive(organizationId);

  if (!active) {
    return (
      <div className="flex flex-col gap-2">
        <h4 className="text-sm font-semibold">{t("heading")}</h4>
        <p className="text-sm text-muted-foreground">{t("inactive")}</p>
      </div>
    );
  }

  const quotes = await listRecentExchangeRateQuotes(organizationId, 20);
  const th = "pb-2 pr-4 font-medium";

  return (
    <div className="flex flex-col gap-3">
      <h4 className="text-sm font-semibold">{t("heading")}</h4>
      <p className="text-xs text-muted-foreground">{t("body")}</p>
      {quotes.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("none")}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="text-muted-foreground">
                <th className={th}>{t("columns.date")}</th>
                <th className={th}>{t("columns.value")}</th>
                <th className={th}>{t("columns.revision")}</th>
                <th className="pb-2 font-medium">{t("columns.actions")}</th>
              </tr>
            </thead>
            <tbody>
              {quotes.map((row) => (
                <tr key={row.id} className="border-t">
                  <td className="py-2 pr-4 align-top whitespace-nowrap">
                    {row.quoteDate.year}-{String(row.quoteDate.month).padStart(2, "0")}-{String(row.quoteDate.day).padStart(2, "0")}
                  </td>
                  <td className="py-2 pr-4 align-top whitespace-nowrap">{row.value}</td>
                  <td className="py-2 pr-4 align-top">{row.revision}</td>
                  <td className="py-2 align-top">
                    <CorrectExchangeRateForm organizationId={organizationId} row={row} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <AddExchangeRateForm organizationId={organizationId} />
    </div>
  );
}
