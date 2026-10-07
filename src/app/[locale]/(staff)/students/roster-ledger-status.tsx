import { Pill } from "@/components/ui/pill";
import { formatMoney } from "@/lib/payments/format-money";
// Pure, prisma-free arithmetic (no DB dependency) — same exception already established for
// `package-purchase-section.tsx`'s own `decimalToMinor` import; see `dues-ledger-not-exposed.test.ts`.
import { minorToDecimal } from "@/lib/dues/ledger/minor-units";
import type { RosterLedgerDisplay } from "@/lib/dues/roster-payment-facts-queries";

/**
 * ROSTER-STUDENT-DETAIL-INTEGRATION-BRIEF.md §3 decision 1: per-currency outstanding totals, fee already folded
 * into the total exactly once (never added again), with an optional labeled breakdown line. Pure presentational —
 * reuses the existing `Pill` component, no new design system. "No outstanding debt" is its own distinct state, never
 * conflated with "paid"/"eligible"/"covered" (the roster has no ledger concept of either of those).
 */
export function RosterLedgerStatus({
  display,
  locale,
  t,
}: {
  display: RosterLedgerDisplay;
  locale: string;
  t: (key: string, values?: Record<string, string>) => string;
}) {
  if (display.totals.length === 0) {
    return <Pill variant="ok">{t("ledger.filters.noDebt")}</Pill>;
  }
  return (
    <div className="flex flex-col gap-1">
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
  );
}

/** The roster's "couldn't load" fail-closed state — never "paid"/"no debt"/any other false-safe default. */
export function RosterLedgerUnavailable({ t }: { t: (key: string) => string }) {
  return <Pill variant="warn">{t("ledger.unavailable")}</Pill>;
}
