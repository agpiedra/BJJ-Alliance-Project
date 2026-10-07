import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Pill } from "@/components/ui/pill";
import { formatMoney } from "@/lib/payments/format-money";
// Pure, prisma-free arithmetic (no DB dependency) — same exception already established for
// `package-purchase-section.tsx`'s own `decimalToMinor` import; see `dues-ledger-not-exposed.test.ts`.
import { minorToDecimal } from "@/lib/dues/ledger/minor-units";
import type { RosterLedgerDisplay, DuesPendingReceiptFact } from "@/lib/dues/roster-payment-facts-queries";

/**
 * ROSTER-STUDENT-DETAIL-INTEGRATION-BRIEF.md §2.3/§3 decision 2: a current-balance summary ALONGSIDE the existing
 * history table — new content, never a replacement. Currency-separated, fee folded once (same `RosterLedgerDisplay`
 * shape the roster uses). §3 decision 4: a read-only pending-receipt indicator for any authorized staff viewer,
 * Component A (`referencedExistingObligationIds`, real existing debt, already counted in `outstanding` above) vs
 * Component B (`proposedCoverage`, a purchase INTENT, nothing in `DuesObligation` yet) kept visibly distinct —
 * neither is ever shown as settled or confirmed debt.
 */
export function StudentBalanceSummary({
  display,
  pendingReceipts,
  locale,
  t,
}: {
  display: RosterLedgerDisplay | null;
  pendingReceipts: DuesPendingReceiptFact[];
  locale: string;
  t: (key: string, values?: Record<string, string>) => string;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("ledger.balanceSummary.heading")}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {display === null ? (
          <p className="text-muted-foreground">{t("ledger.balanceSummary.unavailable")}</p>
        ) : display.totals.length === 0 ? (
          <p className="text-muted-foreground">{t("ledger.balanceSummary.noDebt")}</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {display.totals.map((total) => {
              const amount = formatMoney(Number(minorToDecimal(total.amountMinor)), total.currency, locale);
              const label = total.feeMinor
                ? t("ledger.totalWithFee", { total: amount, fee: formatMoney(Number(minorToDecimal(total.feeMinor)), total.currency, locale) })
                : amount;
              return (
                <Pill key={total.currency} variant="bad">
                  {label}
                </Pill>
              );
            })}
          </div>
        )}

        {pendingReceipts.length > 0 && (
          <div className="flex flex-col gap-2 border-t pt-3">
            <p className="text-sm font-medium">{t("ledger.pendingReceipt.heading")}</p>
            <p className="text-sm text-muted-foreground">{t("ledger.pendingReceipt.notice")}</p>
            {pendingReceipts.map((receipt) => (
              <div key={receipt.receiptId} className="flex flex-wrap items-center gap-2 text-sm">
                {receipt.ok && receipt.referencedExistingObligationIds.length > 0 && (
                  <Pill variant="plain">{t("ledger.pendingReceipt.referencesExisting")}</Pill>
                )}
                {receipt.ok && receipt.proposedCoverage.length > 0 && <Pill variant="accent">{t("ledger.pendingReceipt.proposesCoverage")}</Pill>}
                <span>
                  {formatMoney(Number(minorToDecimal(receipt.tenderAmountMinor)), receipt.tenderCurrency, locale)}
                </span>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
