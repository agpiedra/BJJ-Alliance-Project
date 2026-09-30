import type { Currency } from "@/generated/prisma/client";
import type { CalendarDate } from "@/lib/dues/calendar";
import { runningTotalsMinor, type CrossCurrencyCandidates, type SettlementItem } from "@/lib/dues/settlement";
import { detectAmbiguousRoundedTotals } from "@/lib/dues/ledger/exchange-rate-arithmetic";
import { resolveEffectiveQuote } from "@/lib/dues/ledger/exchange-rate";
import type { Tx } from "@/lib/dues/ledger/common";

/**
 * Currency-conversion brief, PR 2: the ONE place `recordDuesPaymentInTx` and `purchasePackage` both build `settleReceipt`'s own
 * `crossCurrency` argument from a resolved quote — neither duplicates this wiring. Only two currencies exist in this schema
 * (USD, CRC — `prisma/schema.prisma`'s own `Currency` enum), so any mismatch between `itemCurrency` and `receiptCurrency` is
 * exactly this one supported pair; there is no third currency to reject here.
 */
export type RoundingRule = "HALF_UP_TO_CENT" | "HALF_UP_TO_COLON";

export type RateEvidence = {
  appliedRateId: string;
  appliedRateValue: string;
  appliedRateQuoteDate: CalendarDate;
  appliedRateRevision: number;
  appliedRoundingRule: RoundingRule;
};

export type CrossCurrencyResolution = { ok: true; candidates: CrossCurrencyCandidates; evidence: RateEvidence } | { ok: false; error: "rateUnavailable" };

/**
 * Resolves the quote effective for `receivedOn` (`exchange-rate.ts`'s own fallback rule) and converts `items`' own running totals
 * into the receipt's currency (`exchange-rate-arithmetic.ts`'s exact BigInt rounding, excluding any candidate that would overflow
 * rather than letting it abort the whole comparison). `rateUnavailable` when no quote resolves — zero writes; the caller decides
 * what "zero writes" means for its own transaction (nothing has been written yet at either of this PR's two call sites).
 *
 * CALLER MUST ALREADY HOLD `lockExchangeRateNamespace` as its own outermost transaction's first statement — this function takes
 * no lock itself, mirroring `resolveEffectiveQuote`'s own contract exactly.
 */
export async function resolveCrossCurrency(
  tx: Tx,
  args: { organizationId: string; items: readonly SettlementItem[]; itemCurrency: Currency; receiptCurrency: Currency; receivedOn: CalendarDate },
): Promise<CrossCurrencyResolution> {
  const { organizationId, items, itemCurrency, receiptCurrency, receivedOn } = args;
  const quote = await resolveEffectiveQuote(tx, { organizationId, receivedOn });
  if (!quote) return { ok: false, error: "rateUnavailable" };

  const direction: "toCrc" | "toUsd" = itemCurrency === "USD" && receiptCurrency === "CRC" ? "toCrc" : "toUsd";
  const roundingRule: RoundingRule = direction === "toCrc" ? "HALF_UP_TO_COLON" : "HALF_UP_TO_CENT";
  const { totals, ambiguousRequiredMinors } = detectAmbiguousRoundedTotals(runningTotalsMinor(items), quote.value, direction);
  return {
    ok: true,
    candidates: { totals, ambiguousRequiredMinors },
    evidence: {
      appliedRateId: quote.id,
      appliedRateValue: quote.value,
      appliedRateQuoteDate: quote.quoteDate,
      appliedRateRevision: quote.revision,
      appliedRoundingRule: roundingRule,
    },
  };
}
