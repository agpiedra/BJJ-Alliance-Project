import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getTestPrismaClient } from "../helpers/test-db";
import { makeAccountingOrg } from "../helpers/accounting-org";
import type { TenantContext } from "../../src/lib/tenant/types";
import { createMonthlyObligation } from "../../src/lib/dues/ledger/create-monthly-obligation";
import { recordDuesPayment } from "../../src/lib/dues/ledger/record-payment";
import { enterExchangeRateQuote } from "../../src/lib/dues/ledger/exchange-rate";
import { countPaymentsAgainstQuote } from "../../src/lib/dues/exchange-rate-queries";
import type { LedgerActivation } from "../../src/lib/dues/ledger/activation";

/**
 * Owner exchange-rate UI brief §5.1: `countPaymentsAgainstQuote` called DIRECTLY against the real test database,
 * never through the "use server" action — the same `deps.activation` injection `exchange-rate-quote.test.ts`
 * already establishes. Proves the three things this feature's own brief corrected after review: (1) the count is a
 * LIVE aggregate re-run after a correction, not a stored/frozen value — stable because no new settlement can ever
 * resolve to a superseded revision again, not because the schema marks the count immutable; (2) historical
 * `DuesPayment` evidence is genuinely unchanged by a later correction; (3) the count is scoped by BOTH
 * `organizationId` and `quoteId`, never leaking across organizations.
 */
const prisma = getTestPrismaClient();
type Fixture = Awaited<ReturnType<typeof makeAccountingOrg>>;
const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
const ACTIVE: LedgerActivation = { isActive: async () => true };
const at = (isoLocal: string) => () => new Date(`${isoLocal}-06:00`); // Costa Rica, UTC-6 all year
const DEC_2030 = at("2030-12-01T12:00:00");
const OCT_5 = at("2030-10-05T12:00:00");
const deps = (extra: Record<string, unknown> = {}) => ({ activation: ACTIVE, now: DEC_2030, ...extra });

let a: Fixture;
let b: Fixture;
let usdTerms: { id: string };
let usdPolicy: { id: string };

function context(fixture: Fixture, over: Partial<TenantContext> = {}): TenantContext {
  return { kind: "tenant", actorUserId: fixture.admin.id, organizationId: fixture.org.id, organizationRole: "ADMIN", academyIds: "ALL", selfStudentId: null, linkedStudentId: null, ...over };
}

let studentCounter = 0;
async function newStudent(fixture: Fixture, label: string) {
  const n = ++studentCounter;
  return prisma.student.create({
    data: {
      organizationId: fixture.org.id, homeAcademyId: fixture.academy.id, firstName: "Warn", lastName: `${label}${n}`, phone: "00000000",
      email: `warn-${label}-${n}-${suffix}@example.com`, currentRankId: await fixture.rankId("WHITE"), codeHash: `warn-${label}-${n}-${suffix}`, status: "ACTIVE",
    },
  });
}

async function oneMonth(studentId: string, month: number, termsId: string, policyId: string): Promise<string> {
  const r = await createMonthlyObligation({ context: context(a), studentId, coverage: { year: 2030, month }, planTermsId: termsId, policyVersionId: policyId }, deps());
  if (!r.ok) throw new Error(`fixture obligation failed: ${r.error}`);
  return r.obligationId;
}

/** Pays one obligation in CRC (cross-currency against a USD obligation) so the resulting DuesPayment carries a real
 * appliedRateId — a same-currency payment never sets one. */
async function payCrossCurrency(fixture: Fixture, studentId: string, obligationId: string): Promise<string> {
  const r = await recordDuesPayment(
    { context: context(fixture), studentId, receivedOn: { year: 2030, month: 10, day: 5 }, tender: { currency: "CRC", amount: "50000.00" }, method: "EFECTIVO", obligationIds: [obligationId], maxBackdateDays: 5 },
    deps({ now: OCT_5 }),
  );
  if (!r.ok) throw new Error(`fixture payment failed: ${JSON.stringify(r)}`);
  return r.paymentId;
}

let quoteDateCounter = 0;
function freshQuoteDate(): { year: number; month: number; day: number } {
  const day = 1 + (quoteDateCounter++ % 27);
  const month = 1 + (Math.floor(quoteDateCounter / 27) % 6);
  return { year: 2030, month, day };
}

beforeAll(async () => {
  a = await makeAccountingOrg("CUMULATIVE", "exwarn-a");
  b = await makeAccountingOrg("CUMULATIVE", "exwarn-b");

  const usdPlan = await prisma.paymentPlan.create({ data: { organizationId: a.org.id, academyId: a.academy.id, name: `Warn USD plan ${suffix}` } });
  usdTerms = await prisma.paymentPlanTerms.create({
    data: { organizationId: a.org.id, planId: usdPlan.id, effectiveYear: 2027, effectiveMonth: 1, priceAmount: "100.00", currency: "USD", monthsCovered: 1, createdById: a.admin.id },
  });
  usdPolicy = await prisma.duesPolicyVersion.create({
    data: { organizationId: a.org.id, academyId: a.academy.id, effectiveYear: 2027, effectiveMonth: 1, dueDay: 20, graceDay: 5, lateFeeAmount: "20.00", lateFeeCurrency: "USD", maxPrepaidMonths: 12, createdById: a.admin.id },
  });
}, 60_000);

afterAll(async () => {
  for (const fixture of [a, b]) {
    if (!fixture) continue;
    await prisma.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe("SET LOCAL session_replication_role = replica");
        for (const table of ["DuesSettlement", "DuesPayment", "DuesLateFee", "DuesCoverage", "DuesObligation", "ExchangeRateQuote"]) {
          await tx.$executeRawUnsafe(`DELETE FROM "${table}" WHERE "organizationId" = $1`, fixture.org.id);
        }
      },
      { timeout: 60_000 },
    );
    await prisma.auditLog.deleteMany({ where: { organizationId: fixture.org.id } });
  }
  await prisma.paymentPlanTerms.deleteMany({ where: { organizationId: a.org.id } });
  await prisma.duesPolicyVersion.deleteMany({ where: { organizationId: a.org.id } });
  await prisma.paymentPlan.deleteMany({ where: { organizationId: a.org.id } });
  await a?.drop();
  await b?.drop();
}, 120_000);

describe("countPaymentsAgainstQuote: live aggregate, keyed to quote identity, not inherently frozen", () => {
  it("counts N payments against the quote they were settled against, the count is UNCHANGED by a later correction (a live re-query, not a cached value), and the new revision starts independent", async () => {
    const quoteDate = freshQuoteDate();
    const first = await enterExchangeRateQuote({ context: context(a), quoteDate, value: "500.00", expectedCurrentRevision: 0 }, deps());
    if (!first.ok) throw new Error("fixture: rate entry failed");

    const s1 = await newStudent(a, "one");
    const ob1 = await oneMonth(s1.id, 9, usdTerms.id, usdPolicy.id);
    await payCrossCurrency(a, s1.id, ob1);

    const s2 = await newStudent(a, "two");
    const ob2 = await oneMonth(s2.id, 9, usdTerms.id, usdPolicy.id);
    await payCrossCurrency(a, s2.id, ob2);

    expect(await countPaymentsAgainstQuote(a.org.id, first.quoteId)).toBe(2);

    // Snapshot the two payments' evidence BEFORE the correction.
    const before = await prisma.duesPayment.findMany({
      where: { organizationId: a.org.id, appliedRateId: first.quoteId },
      select: { id: true, appliedRateId: true, appliedRateValue: true, appliedRateQuoteDate: true, appliedRateRevision: true },
      orderBy: { id: "asc" },
    });
    expect(before).toHaveLength(2);

    const second = await enterExchangeRateQuote({ context: context(a), quoteDate, value: "510.00", expectedCurrentRevision: 1 }, deps());
    if (!second.ok) throw new Error("fixture: correction failed");
    expect(second.revision).toBe(2);

    // Re-run the (live, uncached) query against the OLD id — proves the correction wrote no change to the existing
    // payments, not that the count is inherently frozen by the schema (see this feature's own planning brief §2.2).
    expect(await countPaymentsAgainstQuote(a.org.id, first.quoteId)).toBe(2);
    // The NEW revision's own id starts completely independent — nothing has settled against it yet.
    expect(await countPaymentsAgainstQuote(a.org.id, second.quoteId)).toBe(0);

    const after = await prisma.duesPayment.findMany({
      where: { organizationId: a.org.id, appliedRateId: first.quoteId },
      select: { id: true, appliedRateId: true, appliedRateValue: true, appliedRateQuoteDate: true, appliedRateRevision: true },
      orderBy: { id: "asc" },
    });
    expect(after).toEqual(before); // byte-for-byte: the correction did not touch any existing payment's own evidence
  });

  it("returns 0 for a quote with no settled payments, and 0 for a nonexistent or wrong-organization quoteId", async () => {
    const quoteDate = freshQuoteDate();
    const quote = await enterExchangeRateQuote({ context: context(a), quoteDate, value: "500.00", expectedCurrentRevision: 0 }, deps());
    if (!quote.ok) throw new Error("fixture: rate entry failed");
    expect(await countPaymentsAgainstQuote(a.org.id, quote.quoteId)).toBe(0);
    expect(await countPaymentsAgainstQuote(a.org.id, "nonexistent-quote-id")).toBe(0);
  });

  it("scopes by BOTH organizationId and quoteId: organization B cannot see organization A's count, even for its own quote entered the same calendar date", async () => {
    const quoteDate = freshQuoteDate();
    const aQuote = await enterExchangeRateQuote({ context: context(a), quoteDate, value: "500.00", expectedCurrentRevision: 0 }, deps());
    if (!aQuote.ok) throw new Error("fixture: org a rate entry failed");
    const s = await newStudent(a, "scope");
    const ob = await oneMonth(s.id, 9, usdTerms.id, usdPolicy.id);
    await payCrossCurrency(a, s.id, ob);
    expect(await countPaymentsAgainstQuote(a.org.id, aQuote.quoteId)).toBe(1);

    const bQuote = await enterExchangeRateQuote({ context: context(b), quoteDate, value: "512.00", expectedCurrentRevision: 0 }, deps());
    if (!bQuote.ok) throw new Error("fixture: org b rate entry failed");
    // Org B has zero payments of its own, and org A's quoteId is never even its own row for B's organization filter.
    expect(await countPaymentsAgainstQuote(b.org.id, bQuote.quoteId)).toBe(0);
    expect(await countPaymentsAgainstQuote(b.org.id, aQuote.quoteId)).toBe(0); // wrong org for this id entirely
  });
});
