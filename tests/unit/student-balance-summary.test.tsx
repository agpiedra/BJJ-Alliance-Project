/** @vitest-environment jsdom */
import { render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it } from "vitest";
import enMessages from "../../messages/en.json";
import { StudentBalanceSummary } from "../../src/app/[locale]/(staff)/students/[id]/student-balance-summary";
import type { RosterLedgerDisplay, DuesPendingReceiptFact } from "../../src/lib/dues/roster-payment-facts-queries";

/**
 * ROSTER-STUDENT-DETAIL-INTEGRATION-BRIEF.md §3 decisions 1/2/4: currency-separated totals (fee folded exactly
 * once, with an optional labeled breakdown), "no debt"/"unavailable" as their own distinct states, and the
 * pending-receipt indicator's Component A (real existing debt) vs Component B (proposed, not-yet-created coverage)
 * distinction — neither ever rendered as settled/confirmed.
 */
function buildT() {
  return (key: string, values?: Record<string, string>) => {
    const parts = key.split(".");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let node: any = enMessages.students;
    for (const p of parts) node = node?.[p];
    let text = typeof node === "string" ? node : key;
    if (values) for (const [k, v] of Object.entries(values)) text = text.replace(`{${k}}`, v);
    return text;
  };
}

function renderSummary(display: RosterLedgerDisplay | null, pendingReceipts: DuesPendingReceiptFact[] = []) {
  const t = buildT();
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <StudentBalanceSummary display={display} pendingReceipts={pendingReceipts} locale="en" t={t} />
    </NextIntlClientProvider>,
  );
}

describe("StudentBalanceSummary", () => {
  it("shows a per-currency total with the fee folded in exactly once, plus a labeled breakdown — never a second addition", () => {
    renderSummary({ totals: [{ currency: "USD", amountMinor: 12000, feeMinor: 2000 }], flags: { debt: true, noDebt: false, monthlyPastGrace: true, signupPastDue: false, pendingConversion: false, configIssue: false } });
    // $120.00 total (not $140.00 — the fee is NOT added a second time), with the breakdown line naming the $20.00 fee separately.
    expect(screen.getByText(/\$ 120\.00/)).toBeTruthy();
    expect(screen.getByText(/includes \$ 20\.00 late fee/)).toBeTruthy();
  });

  it("never sums two different currencies into one figure", () => {
    renderSummary({
      totals: [
        { currency: "USD", amountMinor: 10000, feeMinor: null },
        { currency: "CRC", amountMinor: 5000000, feeMinor: null },
      ],
      flags: { debt: true, noDebt: false, monthlyPastGrace: false, signupPastDue: false, pendingConversion: false, configIssue: false },
    });
    expect(screen.getByText("$ 100.00")).toBeTruthy();
    expect(screen.getByText("₡ 50,000")).toBeTruthy();
    // Nothing resembling a combined/blended figure (e.g. an addition of the two raw numbers) appears anywhere.
    expect(screen.queryByText(/150/)).toBeNull();
  });

  it('"no outstanding debt" renders its own distinct state — never the word "paid" or "eligible"', () => {
    renderSummary({ totals: [], flags: { debt: false, noDebt: true, monthlyPastGrace: false, signupPastDue: false, pendingConversion: false, configIssue: false } });
    expect(screen.getByText("No outstanding debt.")).toBeTruthy();
    expect(screen.queryByText(/paid/i)).toBeNull();
    expect(screen.queryByText(/eligible/i)).toBeNull();
  });

  it("a failed read renders unavailable, never a false empty/zero balance", () => {
    renderSummary(null);
    expect(screen.getByText("Couldn't load current balance.")).toBeTruthy();
    expect(screen.queryByText(/No outstanding debt/)).toBeNull();
    expect(screen.queryByText("$ 0.00")).toBeNull();
  });

  it("renders a pending receipt's Component A (references existing debt) and Component B (proposes new coverage) distinctly, never as settled", () => {
    renderSummary(null, [
      { ok: true, receiptId: "r1", kind: "ORDINARY", tenderCurrency: "USD", tenderAmountMinor: 10000, referencedExistingObligationIds: ["ob-1"], proposedCoverage: [] },
      { ok: true, receiptId: "r2", kind: "PREPAYMENT", tenderCurrency: "USD", tenderAmountMinor: 20000, referencedExistingObligationIds: [], proposedCoverage: [{ year: 2030, month: 5 }] },
    ]);
    expect(screen.getByText("References existing debt")).toBeTruthy();
    expect(screen.getByText("Proposes new coverage")).toBeTruthy();
    expect(screen.getByText("Money was reported received and is awaiting settlement — not a completed payment.")).toBeTruthy();
    expect(screen.queryByText(/settled/i)).toBeNull();
    expect(screen.queryByText(/confirmed/i)).toBeNull();
  });
});
