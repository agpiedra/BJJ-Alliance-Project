import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getTestPrismaClient } from "../helpers/test-db";
import { makeAccountingOrg } from "../helpers/accounting-org";
import type { TenantContext } from "../../src/lib/tenant/types";
import { createMonthlyObligation } from "../../src/lib/dues/ledger/create-monthly-obligation";
import { recordDuesPayment } from "../../src/lib/dues/ledger/record-payment";
import { enterExchangeRateQuote } from "../../src/lib/dues/ledger/exchange-rate";
import { countPaymentsAgainstQuote, findCurrentExchangeRateQuote } from "../../src/lib/dues/exchange-rate-queries";
import type { LedgerActivation } from "../../src/lib/dues/ledger/activation";

/**
 * Reproduces, then guards against, two real correctness bugs found in review on PR #87's head c93f77c:
 *
 * 1. `countPaymentsAgainstQuote` passed `quoteId` straight into Prisma's `where` filters. Prisma treats an
 *    `undefined` field value as "omit this filter entirely" — an `undefined`/`null`/blank `quoteId` silently turned
 *    both the `ExchangeRateQuote.findFirst` AND the `DuesPayment.count` queries into unfiltered-by-id lookups,
 *    returning the TOTAL payment count for the organization (every payment, any rate) instead of 0.
 * 2. `findCurrentExchangeRateQuote`'s `toUtcDate` called `Date.UTC(year, month - 1, day)` with no real-calendar-date
 *    check first. `Date.UTC` silently ROLLS OVER an out-of-range month/day into a different, real date instead of
 *    throwing — the exact class of bug `enterExchangeRateQuote` itself guards against with `isRealDate` at the
 *    write path, never replicated here at the read path.
 *
 * Each `it.each` case below is run once; the suite as a whole proves the fixed behavior. The bug's prior existence
 * is documented in each test's own comment (confirmed by hand against the pre-fix source before this file was
 * written) rather than kept as a second, permanently-red test — the fixed assertions ARE the regression guard.
 */
const prisma = getTestPrismaClient();
type Fixture = Awaited<ReturnType<typeof makeAccountingOrg>>;
const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
const ACTIVE: LedgerActivation = { isActive: async () => true };
const at = (isoLocal: string) => () => new Date(`${isoLocal}-06:00`);
const DEC_2030 = at("2030-12-01T12:00:00");
const OCT_5 = at("2030-10-05T12:00:00");
const deps = (extra: Record<string, unknown> = {}) => ({ activation: ACTIVE, now: DEC_2030, ...extra });

let a: Fixture;
let usdTerms: { id: string };
let usdPolicy: { id: string };

function context(over: Partial<TenantContext> = {}): TenantContext {
  return { kind: "tenant", actorUserId: a.admin.id, organizationId: a.org.id, organizationRole: "ADMIN", academyIds: "ALL", selfStudentId: null, linkedStudentId: null, ...over };
}

let quoteDateCounter = 0;
function freshQuoteDate(): { year: number; month: number; day: number } {
  const day = 1 + (quoteDateCounter++ % 27);
  const month = 1 + (Math.floor(quoteDateCounter / 27) % 6);
  return { year: 2030, month, day };
}

beforeAll(async () => {
  a = await makeAccountingOrg("CUMULATIVE", "exqval-a");
  const usdPlan = await prisma.paymentPlan.create({ data: { organizationId: a.org.id, academyId: a.academy.id, name: `Qval USD plan ${suffix}` } });
  usdTerms = await prisma.paymentPlanTerms.create({
    data: { organizationId: a.org.id, planId: usdPlan.id, effectiveYear: 2027, effectiveMonth: 1, priceAmount: "100.00", currency: "USD", monthsCovered: 1, createdById: a.admin.id },
  });
  usdPolicy = await prisma.duesPolicyVersion.create({
    data: { organizationId: a.org.id, academyId: a.academy.id, effectiveYear: 2027, effectiveMonth: 1, dueDay: 20, graceDay: 5, lateFeeAmount: "20.00", lateFeeCurrency: "USD", maxPrepaidMonths: 12, createdById: a.admin.id },
  });

  // One genuine quote and one genuine cross-currency payment against it — so an "unfiltered" query (the bug) has
  // something real to wrongly match, distinguishing it from the correct "0/null" result.
  const quote = await enterExchangeRateQuote({ context: context(), quoteDate: freshQuoteDate(), value: "500.00", expectedCurrentRevision: 0 }, deps());
  if (!quote.ok) throw new Error("fixture: rate entry failed");
  const student = await prisma.student.create({
    data: {
      organizationId: a.org.id, homeAcademyId: a.academy.id, firstName: "Qval", lastName: `one-${suffix}`, phone: "00000000",
      email: `qval-one-${suffix}@example.com`, currentRankId: await a.rankId("WHITE"), codeHash: `qval-one-${suffix}`, status: "ACTIVE",
    },
  });
  const ob = await createMonthlyObligation({ context: context(), studentId: student.id, coverage: { year: 2030, month: 9 }, planTermsId: usdTerms.id, policyVersionId: usdPolicy.id }, deps());
  if (!ob.ok) throw new Error(`fixture obligation failed: ${ob.error}`);
  const payment = await recordDuesPayment(
    { context: context(), studentId: student.id, receivedOn: { year: 2030, month: 10, day: 5 }, tender: { currency: "CRC", amount: "50000.00" }, method: "EFECTIVO", obligationIds: [ob.obligationId], maxBackdateDays: 5 },
    deps({ now: OCT_5 }),
  );
  if (!payment.ok) throw new Error(`fixture payment failed: ${JSON.stringify(payment)}`);
}, 60_000);

afterAll(async () => {
  if (a) {
    await prisma.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe("SET LOCAL session_replication_role = replica");
        for (const table of ["DuesSettlement", "DuesPayment", "DuesLateFee", "DuesCoverage", "DuesObligation", "ExchangeRateQuote"]) {
          await tx.$executeRawUnsafe(`DELETE FROM "${table}" WHERE "organizationId" = $1`, a.org.id);
        }
      },
      { timeout: 60_000 },
    );
    await prisma.auditLog.deleteMany({ where: { organizationId: a.org.id } });
    await prisma.paymentPlanTerms.deleteMany({ where: { organizationId: a.org.id } });
    await prisma.duesPolicyVersion.deleteMany({ where: { organizationId: a.org.id } });
    await prisma.paymentPlan.deleteMany({ where: { organizationId: a.org.id } });
  }
  await a?.drop();
}, 120_000);

describe("countPaymentsAgainstQuote: malformed quoteId never falls through to an unfiltered Prisma query", () => {
  it.each([
    ["undefined", undefined],
    ["null", null],
    ["empty string", ""],
    ["whitespace-only", "   "],
  ])("quoteId = %s refuses safely (0), never matching every payment in the organization (the Prisma undefined-omits-filter bug)", async (_label, badQuoteId) => {
    const result = await countPaymentsAgainstQuote(a.org.id, badQuoteId as unknown as string);
    expect(result).toBe(0);
  });

  it("the same guard applies to a malformed organizationId", async () => {
    expect(await countPaymentsAgainstQuote(undefined as unknown as string, "whatever-id")).toBe(0);
    expect(await countPaymentsAgainstQuote("", "whatever-id")).toBe(0);
  });

  it("a genuinely valid quoteId still counts correctly (the guard does not break the real path)", async () => {
    const quote = await enterExchangeRateQuote({ context: context(), quoteDate: freshQuoteDate(), value: "505.00", expectedCurrentRevision: 0 }, deps());
    if (!quote.ok) throw new Error("fixture: rate entry failed");
    expect(await countPaymentsAgainstQuote(a.org.id, quote.quoteId)).toBe(0); // real id, genuinely zero payments against it
  });
});

describe("findCurrentExchangeRateQuote: an unreal date refuses (null), never a Date.UTC rollover to a different real date", () => {
  it.each([
    ["month 13 (rolls over to next January)", { year: 2030, month: 13, day: 1 }],
    ["day 30 of February (rolls over to March)", { year: 2030, month: 2, day: 30 }],
    ["month 0", { year: 2030, month: 0, day: 1 }],
    ["day 0", { year: 2030, month: 1, day: 0 }],
  ])("an unreal date (%s) returns null, even when a real quote exists at the date Date.UTC would roll over to", async (_label, badDate) => {
    // Seed a REAL quote at the exact date the bad input would silently roll over to, so a non-null result here
    // would prove the rollover bug is still present, not merely "no quote happened to exist there."
    const rolledOverDate = new Date(Date.UTC(badDate.year, badDate.month - 1, badDate.day));
    const asCalendarDate = { year: rolledOverDate.getUTCFullYear(), month: rolledOverDate.getUTCMonth() + 1, day: rolledOverDate.getUTCDate() };
    // Avoid colliding with another case's own rolled-over date or the fixture's own entered quotes.
    const seeded = await enterExchangeRateQuote({ context: context(), quoteDate: asCalendarDate, value: "999.00", expectedCurrentRevision: 0 }, deps());
    expect(seeded.ok, "fixture: seeding the rolled-over date must itself succeed").toBe(true);

    const result = await findCurrentExchangeRateQuote(a.org.id, badDate);
    expect(result).toBeNull();
  });

  it("a genuinely valid date still resolves correctly (the guard does not break the real path)", async () => {
    const d = freshQuoteDate();
    const entered = await enterExchangeRateQuote({ context: context(), quoteDate: d, value: "512.00", expectedCurrentRevision: 0 }, deps());
    if (!entered.ok) throw new Error("fixture: rate entry failed");
    const result = await findCurrentExchangeRateQuote(a.org.id, d);
    expect(result).toMatchObject({ id: entered.quoteId, revision: 1 });
  });

  it("a malformed organizationId also refuses (null)", async () => {
    expect(await findCurrentExchangeRateQuote(undefined as unknown as string, freshQuoteDate())).toBeNull();
    expect(await findCurrentExchangeRateQuote("", freshQuoteDate())).toBeNull();
  });
});
