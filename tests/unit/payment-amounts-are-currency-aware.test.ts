import { describe, expect, it } from "vitest";
import { productionSourceFiles } from "../helpers/source-files";

/**
 * `PaymentPeriod.amount` is a bare decimal. 45 (USD) and 45 (CRC) are not the
 * same number, and an organization can change currency — so any total,
 * average or threshold over amounts must group by (or filter to one)
 * `PaymentPeriod.currency`. A single un-grouped sum is silently wrong the day
 * an organization changes currency, and nothing errors. The rule is written at
 * the column itself (prisma/schema.prisma); this makes it enforced.
 *
 * Deliberately a text scan, like the other structural guards: it cannot prove
 * a query is correct, only that no file touching PaymentPeriod aggregates
 * amounts without so much as mentioning currency — which is exactly the
 * mistake this design invites, made by whoever builds the first revenue total.
 */
const AGGREGATES_AMOUNTS = new RegExp(
  [
    String.raw`paymentPeriod\s*\.\s*(aggregate|groupBy)\b`, // Prisma aggregate / groupBy on payments
    // Summing the AMOUNT column specifically. Not any `_sum`: a file may sum
    // attendance deltas (alliance-baseline.ts does) and merely READ payments.
    String.raw`_(sum|avg|min|max)\s*:\s*\{[^}]*\bamount\b`,
    String.raw`\bsum\s*\(\s*"?amount`, // raw SQL
    String.raw`\.reduce\([\s\S]{0,80}?\bamount\b`, // a JS fold over amounts
  ].join("|"),
  "i",
);

export function sumsPaymentAmountsWithoutCurrency(text: string): boolean {
  const touchesPayments = /paymentPeriod/i.test(text);
  return touchesPayments && AGGREGATES_AMOUNTS.test(text) && !/currency/i.test(text);
}

describe("payment amounts are never aggregated without regard to currency", () => {
  it("REQUIRED: no production file sums PaymentPeriod amounts without mentioning currency", () => {
    const offenders = productionSourceFiles()
      .filter(({ text }) => sumsPaymentAmountsWithoutCurrency(text))
      .map(({ file }) => file);

    expect(
      offenders,
      "group by PaymentPeriod.currency (or filter to one) before summing — see the comment on the column in prisma/schema.prisma",
    ).toEqual([]);
  });

  describe("the scanner can actually flag the mistake (positive controls)", () => {
    it("flags a Prisma aggregate over amounts with no currency", () => {
      expect(sumsPaymentAmountsWithoutCurrency("await prisma.paymentPeriod.aggregate({ _sum: { amount: true } });")).toBe(true);
    });

    it("flags a raw SQL sum and a JS fold over amounts", () => {
      expect(sumsPaymentAmountsWithoutCurrency('prisma.$queryRaw`select sum(amount) from "PaymentPeriod"`; // paymentPeriod')).toBe(true);
      expect(sumsPaymentAmountsWithoutCurrency("const periods = await prisma.paymentPeriod.findMany(); periods.reduce((s, p) => s + p.amount, 0);")).toBe(true);
    });

    it("does NOT flag the same aggregate once it groups by currency", () => {
      expect(
        sumsPaymentAmountsWithoutCurrency('await prisma.paymentPeriod.groupBy({ by: ["currency"], _sum: { amount: true } });'),
      ).toBe(false);
    });

    it("does NOT flag a file that never touches payments", () => {
      expect(sumsPaymentAmountsWithoutCurrency("await prisma.attendanceRecord.aggregate({ _sum: { delta: true } });")).toBe(false);
    });
  });
});
