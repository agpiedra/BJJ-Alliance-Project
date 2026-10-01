import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getTestPrismaClient } from "../helpers/test-db";
import { prisma as appPrisma } from "../../src/lib/prisma";
import { makeAccountingOrg } from "../helpers/accounting-org";
import type { TenantContext } from "../../src/lib/tenant/types";
import { createMonthlyObligation } from "../../src/lib/dues/ledger/create-monthly-obligation";
import { recordDuesPayment } from "../../src/lib/dues/ledger/record-payment";
import { purchasePackage } from "../../src/lib/dues/ledger/purchase-package";
import { prepayMonthlyObligations } from "../../src/lib/dues/ledger/prepay-monthly";
import { enterExchangeRateQuote } from "../../src/lib/dues/ledger/exchange-rate";
import { resolveAwaitingRateReceipt, cancelAwaitingRateReceipt } from "../../src/lib/dues/ledger/awaiting-rate-receipt";
import type { LedgerActivation } from "../../src/lib/dues/ledger/activation";

/**
 * Currency-conversion brief, PR 3: awaiting-rate receipt capture, resolution and cancellation, proved against the REAL
 * test database. Does not re-prove PR 1/2's own arithmetic, quote resolution, or shared/exclusive lock design — those
 * are already proved in `dues-currency-settlement.test.ts`. This suite proves: the capture trigger (exactly "no eligible
 * quote at all", not merely "no exact-date match"); that capture writes ONLY the receipt and its own audit row; the
 * ORDINARY/PACKAGE resolution paths end-to-end, including the PACKAGE fee-void-first fix and the approved
 * received-date-aging exception (with its required sibling "a fresh entry with the same date still refuses" proof);
 * forbidden-drift refusals; `resolvedFromReceiptId` set on the original INSERT with its cross-student FK; one-payment-
 * per-receipt (both the application guard and the DB uniqueness backstop); genuine concurrent resolve/resolve and
 * resolve/cancel races; and owner-only cancellation. PREPAYMENT gets one capture + one resolution test — its mechanism
 * is identical to ORDINARY's (both call `settleObligationsInTx` directly), and its own reordering is already proved not
 * to break `prepay-monthly.test.ts`'s existing, unmodified suite.
 */
const prisma = getTestPrismaClient();
type Fixture = Awaited<ReturnType<typeof makeAccountingOrg>>;
const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
const ACTIVE: LedgerActivation = { isActive: async () => true };
const at = (isoLocal: string) => () => new Date(`${isoLocal}-06:00`); // Costa Rica, UTC-6 all year
const OCT_5 = at("2030-10-05T12:00:00");
const deps = (extra: Record<string, unknown> = {}) => ({ activation: ACTIVE, now: OCT_5, ...extra });

let a: Fixture;
let usdTerms: { id: string };
let usdPolicy: { id: string };
let packageTerms: { id: string };
let usdPlanId: string;

function context(over: Partial<TenantContext> = {}): TenantContext {
  return { kind: "tenant", actorUserId: a.admin.id, organizationId: a.org.id, organizationRole: "ADMIN", academyIds: "ALL", selfStudentId: null, linkedStudentId: null, ...over };
}

let studentCounter = 0;
async function newStudent(label: string) {
  const n = ++studentCounter;
  return prisma.student.create({
    data: {
      organizationId: a.org.id, homeAcademyId: a.academy.id, firstName: "Receipt", lastName: `${label}${n}`, phone: "00000000",
      email: `receipt-${label}-${n}-${suffix}@example.com`, currentRankId: await a.rankId("WHITE"), codeHash: `receipt-${label}-${n}-${suffix}`, status: "ACTIVE",
    },
  });
}

/** Creates a MONTHLY obligation whose grace deadline is exactly `d` (day `graceDay`=5 of the month AFTER coverage) —
 * i.e., coverage is the month BEFORE `d`, in `d`'s own year. A payment with `receivedOn = d` (day <= 5) is therefore
 * genuinely on time, in the SAME year as every exchange-rate date this test gives `d`, never 2030 — a hardcoded 2030
 * coverage month paired with a receivedOn far from 2030 would make `lateFeeApplies` see the obligation as wildly late. */
async function oneMonth(studentId: string, d: { year: number; month: number; day: number }): Promise<string> {
  const coverage = d.month === 1 ? { year: d.year - 1, month: 12 } : { year: d.year, month: d.month - 1 };
  const r = await createMonthlyObligation({ context: context(), studentId, coverage, planTermsId: usdTerms.id, policyVersionId: usdPolicy.id }, deps({ now: nowAt(d) }));
  if (!r.ok) throw new Error(`fixture obligation failed: ${r.error}`);
  return r.obligationId;
}

async function assignPlan(studentId: string) {
  return prisma.studentPlanAssignment.create({ data: { organizationId: a.org.id, studentId, planId: usdPlanId, effectiveYear: 2027, effectiveMonth: 1, createdById: a.admin.id } });
}

// Each test gets its OWN never-reused receivedOn date — and the counter runs DESCENDING, not ascending. The reason:
// `resolveEffectiveQuote`'s own fallback rule treats ANY quote dated at-or-before a receivedOn as eligible, so an
// EARLIER-declared test's own `enterRate()` call would otherwise leak FORWARD into every LATER test's capture check
// (a later receivedOn is, by definition, "after" an earlier quote). Running the year counter downward instead inverts
// this: every test declared earlier in this file is assigned a LATER year, so whatever it enters is chronologically
// AFTER every test declared after it — and can therefore never satisfy a later-declared test's own, strictly earlier,
// capture-trigger check. Starts at 2099 so nothing here can ever collide with dues-currency-settlement.test.ts's own
// 2030 fixtures, which share the same test database.
// day 5 by default: the INCLUSIVE grace deadline this file's own `oneMonth` helper always sets up ("a payment received
// on this date is still on time" — calendar.ts's own graceDeadlineFor doc comment) — so a bare `freshDate()` is "on
// time" for its own matching obligation without each test having to reason about lateness separately.
let yearCounter = 2099;
function freshDate(day = 5, month = 7): { year: number; month: number; day: number } {
  return { year: yearCounter--, month, day };
}

/** A rate dated EXACTLY `quoteDate` (required — no auto-generated default, so a caller can never accidentally enter a
 * quote for the wrong date and have it silently satisfy a different test's capture-trigger check). */
const enterRate = (quoteDate: { year: number; month: number; day: number }, over: Partial<Parameters<typeof enterExchangeRateQuote>[0]> = {}) =>
  enterExchangeRateQuote({ context: context(), quoteDate, value: "500.00", expectedCurrentRevision: 0, ...over }, deps());

/** `deps.now` pinned to noon on calendar date `d` — the usual "now" for a capture or resolution step dated exactly `d`. */
const nowAt = (d: { year: number; month: number; day: number }) => at(`${d.year}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}T12:00:00`);

async function ledgerCounts(organizationId: string) {
  return {
    obligations: await prisma.duesObligation.count({ where: { organizationId } }),
    coverage: await prisma.duesCoverage.count({ where: { organizationId } }),
    payments: await prisma.duesPayment.count({ where: { organizationId } }),
    settlements: await prisma.duesSettlement.count({ where: { organizationId } }),
    receipts: await prisma.awaitingRateReceipt.count({ where: { organizationId } }),
  };
}

beforeAll(async () => {
  a = await makeAccountingOrg("CUMULATIVE", "receipt-a");
  const usdPlan = await prisma.paymentPlan.create({ data: { organizationId: a.org.id, academyId: a.academy.id, name: `Receipt USD plan ${suffix}` } });
  usdPlanId = usdPlan.id;
  usdTerms = await prisma.paymentPlanTerms.create({
    data: { organizationId: a.org.id, planId: usdPlan.id, effectiveYear: 2027, effectiveMonth: 1, priceAmount: "100.00", currency: "USD", monthsCovered: 1, createdById: a.admin.id },
  });
  usdPolicy = await prisma.duesPolicyVersion.create({
    data: { organizationId: a.org.id, academyId: a.academy.id, effectiveYear: 2027, effectiveMonth: 1, dueDay: 20, graceDay: 5, lateFeeAmount: "20.00", lateFeeCurrency: "USD", maxPrepaidMonths: 12, createdById: a.admin.id },
  });
  const packagePlan = await prisma.paymentPlan.create({ data: { organizationId: a.org.id, academyId: a.academy.id, name: `Receipt package plan ${suffix}` } });
  packageTerms = await prisma.paymentPlanTerms.create({
    data: { organizationId: a.org.id, planId: packagePlan.id, effectiveYear: 2027, effectiveMonth: 1, priceAmount: "270.00", currency: "USD", monthsCovered: 3, createdById: a.admin.id },
  });
}, 60_000);

afterAll(async () => {
  if (a) {
    await prisma.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe("SET LOCAL session_replication_role = replica");
        for (const table of ["DuesSettlement", "DuesPayment", "DuesLateFee", "DuesCoverage", "DuesObligation", "ExchangeRateQuote", "AwaitingRateReceipt"]) {
          await tx.$executeRawUnsafe(`DELETE FROM "${table}" WHERE "organizationId" = $1`, a.org.id);
        }
      },
      { timeout: 60_000 },
    );
    await prisma.auditLog.deleteMany({ where: { organizationId: a.org.id } });
    await prisma.studentPlanAssignment.deleteMany({ where: { organizationId: a.org.id } });
    await prisma.paymentPlanTerms.deleteMany({ where: { organizationId: a.org.id } });
    await prisma.duesPolicyVersion.deleteMany({ where: { organizationId: a.org.id } });
    await prisma.paymentPlan.deleteMany({ where: { organizationId: a.org.id } });
  }
  await a?.drop();
}, 120_000);

describe("capture trigger — exact condition (plan §2)", () => {
  it("a missing EXACT-date quote, with a valid earlier one, does NOT capture — settles via the existing fallback", async () => {
    const d = freshDate(); // day 5: on time against oneMonth's own grace deadline below
    // Strictly earlier than d by a full month (not just days) — avoids any day-of-month assumption, and keeps d itself
    // on-time for the obligation `oneMonth` creates (whose coverage month is also d.month - 1; unrelated to this quote).
    const quoteDate = d.month === 1 ? { year: d.year - 1, month: 12, day: 20 } : { year: d.year, month: d.month - 1, day: 20 };
    const quote = await enterRate(quoteDate);
    if (!quote.ok) throw new Error("fixture: rate entry failed");
    const s = await newStudent("fallback");
    const sep = await oneMonth(s.id, d);
    const before = await ledgerCounts(a.org.id);
    const r = await recordDuesPayment(
      { context: context(), studentId: s.id, receivedOn: d, tender: { currency: "CRC", amount: "50000.00" }, method: "EFECTIVO", obligationIds: [sep], maxBackdateDays: 60 },
      deps({ now: nowAt(d) }),
    );
    expect(r).toMatchObject({ ok: true });
    const after = await ledgerCounts(a.org.id);
    expect(after.receipts).toBe(before.receipts); // no capture — the earlier quote resolved it
  });

  it("no quote at all — exact-date and earlier fallback both absent — captures", async () => {
    const d = freshDate();
    const s = await newStudent("nocapture");
    const sep = await oneMonth(s.id, d);
    const before = await ledgerCounts(a.org.id);
    const r = await recordDuesPayment(
      { context: context(), studentId: s.id, receivedOn: d, tender: { currency: "CRC", amount: "50000.00" }, method: "EFECTIVO", obligationIds: [sep], maxBackdateDays: 3660 },
      deps({ now: nowAt(d) }),
    );
    expect(r).toMatchObject({ ok: false, error: "captured" });
    const after = await ledgerCounts(a.org.id);
    expect(after).toEqual({ ...before, receipts: before.receipts + 1 });
  });
});

describe("ORDINARY: capture writes only the receipt, then resolves correctly", () => {
  it("captures with the full obligation-ids snapshot, then resolves once a rate exists, settling the original obligation", async () => {
    const d = freshDate();
    const s = await newStudent("ordinary");
    const sep = await oneMonth(s.id, d);
    const before = await ledgerCounts(a.org.id);
    const captured = await recordDuesPayment(
      { context: context(), studentId: s.id, receivedOn: d, tender: { currency: "CRC", amount: "50000.00" }, method: "EFECTIVO", obligationIds: [sep], maxBackdateDays: 5 },
      deps({ now: nowAt(d) }),
    );
    expect(captured).toMatchObject({ ok: false, error: "captured" });
    if (captured.ok || captured.error !== "captured") return;
    const afterCapture = await ledgerCounts(a.org.id);
    expect(afterCapture).toEqual({ ...before, receipts: before.receipts + 1 });

    const rate = await enterRate(d);
    if (!rate.ok) throw new Error("fixture: rate entry failed");
    const resolved = await resolveAwaitingRateReceipt({ context: context(), receiptId: captured.receiptId! }, deps({ now: nowAt(d) }));
    expect(resolved).toMatchObject({ ok: true });
    if (!resolved.ok) return;
    const payment = await prisma.duesPayment.findUniqueOrThrow({ where: { id: resolved.paymentId } });
    expect(payment.resolvedFromReceiptId).toBe(captured.receiptId);
    expect(payment.studentId).toBe(s.id);
    const receipt = await prisma.awaitingRateReceipt.findUniqueOrThrow({ where: { id: captured.receiptId } });
    expect(receipt.status).toBe("RESOLVED");
    expect(receipt.resolvedById).toBe(a.admin.id);
  });

  it("owner authorization is enforced on resolution (a non-ADMIN context refuses, nothing changes)", async () => {
    const d = freshDate();
    const s = await newStudent("authz");
    const sep = await oneMonth(s.id, d);
    const captured = await recordDuesPayment(
      { context: context(), studentId: s.id, receivedOn: d, tender: { currency: "CRC", amount: "50000.00" }, method: "EFECTIVO", obligationIds: [sep], maxBackdateDays: 5 },
      deps({ now: nowAt(d) }),
    );
    if (captured.ok || captured.error !== "captured") throw new Error("fixture: expected capture");
    const before = await ledgerCounts(a.org.id);
    const r = await resolveAwaitingRateReceipt({ context: context({ organizationRole: "DIRECTOR" }), receiptId: captured.receiptId! }, deps({ now: nowAt(d) }));
    expect(r).toMatchObject({ ok: false, error: "notFound" });
    expect(await ledgerCounts(a.org.id)).toEqual(before);
  });

  it("a malformed/missing receipt id refuses cleanly, never throws", async () => {
    const r = await resolveAwaitingRateReceipt({ context: context(), receiptId: "does-not-exist" }, deps());
    expect(r).toMatchObject({ ok: false, error: "notFound" });
  });

  it("forbidden drift: a named obligation already settled by something else refuses, substitutes nothing", async () => {
    const d = freshDate();
    const s = await newStudent("drift");
    const sep = await oneMonth(s.id, d);
    const captured = await recordDuesPayment(
      { context: context(), studentId: s.id, receivedOn: d, tender: { currency: "CRC", amount: "50000.00" }, method: "EFECTIVO", obligationIds: [sep], maxBackdateDays: 5 },
      deps({ now: nowAt(d) }),
    );
    if (captured.ok || captured.error !== "captured") throw new Error("fixture: expected capture");

    // Something else settles the named obligation directly, in USD, while the receipt sits PENDING.
    const directSettle = await recordDuesPayment(
      { context: context(), studentId: s.id, receivedOn: d, tender: { currency: "USD", amount: "100.00" }, method: "EFECTIVO", obligationIds: [sep], maxBackdateDays: 5 },
      deps({ now: nowAt(d) }),
    );
    expect(directSettle).toMatchObject({ ok: true });

    const rate = await enterRate(d);
    if (!rate.ok) throw new Error("fixture: rate entry failed");
    const before = await ledgerCounts(a.org.id);
    const resolved = await resolveAwaitingRateReceipt({ context: context(), receiptId: captured.receiptId! }, deps({ now: nowAt(d) }));
    expect(resolved).toMatchObject({ ok: false, error: "alreadySettled" });
    expect(await ledgerCounts(a.org.id)).toEqual(before); // nothing committed on refusal
  });
});

describe("received-date aging (plan §8) — approved policy, end-to-end through the real composed path", () => {
  it("an ORDINARY receipt resolves after the ordinary new-entry window has closed; a fresh entry with the same date still refuses tooOld", async () => {
    const d = freshDate(5); // day 5: captured day 2, "now" at capture day 5, resolution day 18 — all safely mid-month
    const receivedOn = { ...d, day: 2 };
    const captureNow = { ...d, day: 5 };
    const resolveNow = { ...d, day: 18 };
    const s = await newStudent("aged");
    const sep = await oneMonth(s.id, d);
    // receivedOn is 3 days before "now" at capture — valid under maxBackdateDays: 5.
    const captured = await recordDuesPayment(
      { context: context(), studentId: s.id, receivedOn, tender: { currency: "CRC", amount: "50000.00" }, method: "EFECTIVO", obligationIds: [sep], maxBackdateDays: 5 },
      deps({ now: nowAt(captureNow) }),
    );
    if (captured.ok || captured.error !== "captured") throw new Error("fixture: expected capture");

    // The rate arrives 13 days after receivedOn — well past the 5-day window.
    const rate = await enterRate(receivedOn);
    if (!rate.ok) throw new Error("fixture: rate entry failed");
    const resolved = await resolveAwaitingRateReceipt({ context: context(), receiptId: captured.receiptId! }, deps({ now: nowAt(resolveNow) }));
    expect(resolved, "resolution must succeed using the original, already-validated receivedOn — no second backdating check").toMatchObject({ ok: true });

    // Sibling proof, same identical now-expired date, through the NORMAL path: a brand-new attempt still refuses tooOld.
    const s2 = await newStudent("freshsameold");
    const sep2 = await oneMonth(s2.id, receivedOn);
    const fresh = await recordDuesPayment(
      { context: context(), studentId: s2.id, receivedOn, tender: { currency: "USD", amount: "100.00" }, method: "EFECTIVO", obligationIds: [sep2], maxBackdateDays: 5 },
      deps({ now: nowAt(resolveNow) }),
    );
    expect(fresh, "the normal path must still refuse the identical date — resolution and capture are genuinely distinguished by which function is called").toMatchObject({ ok: false, error: "tooOld" });
  });
});

describe("one payment per receipt (plan §7)", () => {
  it("the application guard: resolving an already-RESOLVED receipt refuses, never double-settles", async () => {
    const d = freshDate();
    const s = await newStudent("doubleresolve");
    const sep = await oneMonth(s.id, d);
    const captured = await recordDuesPayment(
      { context: context(), studentId: s.id, receivedOn: d, tender: { currency: "CRC", amount: "50000.00" }, method: "EFECTIVO", obligationIds: [sep], maxBackdateDays: 5 },
      deps({ now: nowAt(d) }),
    );
    if (captured.ok || captured.error !== "captured") throw new Error("fixture: expected capture");
    const rate = await enterRate(d);
    if (!rate.ok) throw new Error("fixture: rate entry failed");
    const first = await resolveAwaitingRateReceipt({ context: context(), receiptId: captured.receiptId! }, deps({ now: nowAt(d) }));
    expect(first).toMatchObject({ ok: true });
    const second = await resolveAwaitingRateReceipt({ context: context(), receiptId: captured.receiptId! }, deps({ now: nowAt(d) }));
    expect(second).toMatchObject({ ok: false, error: "alreadyResolved" });
    const payments = await prisma.duesPayment.count({ where: { organizationId: a.org.id, resolvedFromReceiptId: captured.receiptId } });
    expect(payments).toBe(1);
  });

  it("the DB backstop: resolvedFromReceiptId's uniqueness rejects a second payment referencing the same receipt directly", async () => {
    const d = freshDate();
    const s = await newStudent("dbuniq");
    const sep = await oneMonth(s.id, d);
    const captured = await recordDuesPayment(
      { context: context(), studentId: s.id, receivedOn: d, tender: { currency: "CRC", amount: "50000.00" }, method: "EFECTIVO", obligationIds: [sep], maxBackdateDays: 5 },
      deps({ now: nowAt(d) }),
    );
    if (captured.ok || captured.error !== "captured") throw new Error("fixture: expected capture");
    const rate = await enterRate(d);
    if (!rate.ok) throw new Error("fixture: rate entry failed");
    const resolved = await resolveAwaitingRateReceipt({ context: context(), receiptId: captured.receiptId! }, deps({ now: nowAt(d) }));
    if (!resolved.ok) throw new Error("fixture: expected resolution to succeed");

    // Direct attempt: a second, unrelated payment claiming the SAME resolvedFromReceiptId must fail at the database.
    let threw = false;
    try {
      await prisma.duesPayment.create({
        data: {
          organizationId: a.org.id, studentId: s.id, academyId: a.academy.id, receivedOn: new Date(Date.UTC(d.year, d.month - 1, d.day)),
          tenderCurrency: "USD", tenderAmount: "100.00", method: "EFECTIVO", recordedById: a.admin.id, resolvedFromReceiptId: captured.receiptId,
        },
      });
    } catch {
      threw = true;
    }
    expect(threw, "a second DuesPayment claiming the same resolvedFromReceiptId must violate the unique constraint").toBe(true);
  });

  it("the cross-student FK: a payment cannot reference a receipt belonging to a different student", async () => {
    const d = freshDate();
    const s1 = await newStudent("fkA");
    const s2 = await newStudent("fkB");
    const sep = await oneMonth(s1.id, d);
    const captured = await recordDuesPayment(
      { context: context(), studentId: s1.id, receivedOn: d, tender: { currency: "CRC", amount: "50000.00" }, method: "EFECTIVO", obligationIds: [sep], maxBackdateDays: 5 },
      deps({ now: nowAt(d) }),
    );
    if (captured.ok || captured.error !== "captured") throw new Error("fixture: expected capture");

    let threw = false;
    try {
      await prisma.duesPayment.create({
        data: {
          organizationId: a.org.id, studentId: s2.id, academyId: a.academy.id, receivedOn: new Date(Date.UTC(d.year, d.month - 1, d.day)),
          tenderCurrency: "USD", tenderAmount: "100.00", method: "EFECTIVO", recordedById: a.admin.id, resolvedFromReceiptId: captured.receiptId,
        },
      });
    } catch {
      threw = true;
    }
    expect(threw, "a payment for student B claiming student A's receipt must fail at the foreign key itself").toBe(true);
  });
});

describe("concurrent resolve/resolve and resolve/cancel", () => {
  it("two concurrent resolution attempts for the same receipt produce exactly one payment", async () => {
    const d = freshDate();
    const s = await newStudent("concresolve");
    const sep = await oneMonth(s.id, d);
    const captured = await recordDuesPayment(
      { context: context(), studentId: s.id, receivedOn: d, tender: { currency: "CRC", amount: "50000.00" }, method: "EFECTIVO", obligationIds: [sep], maxBackdateDays: 5 },
      deps({ now: nowAt(d) }),
    );
    if (captured.ok || captured.error !== "captured") throw new Error("fixture: expected capture");
    const rate = await enterRate(d);
    if (!rate.ok) throw new Error("fixture: rate entry failed");

    const [r1, r2] = await Promise.all([
      resolveAwaitingRateReceipt({ context: context(), receiptId: captured.receiptId! }, deps({ now: nowAt(d) })),
      resolveAwaitingRateReceipt({ context: context(), receiptId: captured.receiptId! }, deps({ now: nowAt(d) })),
    ]);
    const oks = [r1, r2].filter((r) => r.ok);
    const fails = [r1, r2].filter((r) => !r.ok);
    expect(oks.length, "exactly one of the two concurrent attempts succeeds (serialized by the student lock)").toBe(1);
    expect(fails.length).toBe(1);
    expect(fails[0]).toMatchObject({ ok: false, error: "alreadyResolved" });
    const payments = await prisma.duesPayment.count({ where: { organizationId: a.org.id, resolvedFromReceiptId: captured.receiptId } });
    expect(payments).toBe(1);
  });

  it("a resolve racing a cancel: whichever commits first wins, the other refuses cleanly", async () => {
    const d = freshDate();
    const s = await newStudent("concrace");
    const sep = await oneMonth(s.id, d);
    const captured = await recordDuesPayment(
      { context: context(), studentId: s.id, receivedOn: d, tender: { currency: "CRC", amount: "50000.00" }, method: "EFECTIVO", obligationIds: [sep], maxBackdateDays: 5 },
      deps({ now: nowAt(d) }),
    );
    if (captured.ok || captured.error !== "captured") throw new Error("fixture: expected capture");
    const rate = await enterRate(d);
    if (!rate.ok) throw new Error("fixture: rate entry failed");

    const [resolveResult, cancelResult] = await Promise.all([
      resolveAwaitingRateReceipt({ context: context(), receiptId: captured.receiptId! }, deps({ now: nowAt(d) })),
      cancelAwaitingRateReceipt({ context: context(), receiptId: captured.receiptId!, reason: "owner changed their mind" }, deps({ now: nowAt(d) })),
    ]);
    // Exactly one of the two mutually-exclusive outcomes won; the receipt's own final status proves which.
    const receipt = await prisma.awaitingRateReceipt.findUniqueOrThrow({ where: { id: captured.receiptId } });
    expect(["RESOLVED", "CANCELLED"]).toContain(receipt.status);
    if (receipt.status === "RESOLVED") {
      expect(resolveResult).toMatchObject({ ok: true });
      expect(cancelResult).toMatchObject({ ok: false, error: "alreadyResolved" });
    } else {
      expect(cancelResult).toMatchObject({ ok: true });
      expect(resolveResult).toMatchObject({ ok: false, error: "alreadyCancelled" });
    }
  });
});

describe("cancellation (plan §4.3): owner-only, required reason, never touches the ledger", () => {
  it("cancels a PENDING receipt, preserving history, with no refund or settlement implied", async () => {
    const d = freshDate();
    const s = await newStudent("cancel");
    const sep = await oneMonth(s.id, d);
    const captured = await recordDuesPayment(
      { context: context(), studentId: s.id, receivedOn: d, tender: { currency: "CRC", amount: "50000.00" }, method: "EFECTIVO", obligationIds: [sep], maxBackdateDays: 5 },
      deps({ now: nowAt(d) }),
    );
    if (captured.ok || captured.error !== "captured") throw new Error("fixture: expected capture");
    const before = await ledgerCounts(a.org.id);
    const result = await cancelAwaitingRateReceipt({ context: context(), receiptId: captured.receiptId!, reason: "owner declined to pursue this receipt" }, deps({ now: nowAt(d) }));
    expect(result).toMatchObject({ ok: true });
    expect(await ledgerCounts(a.org.id)).toEqual(before); // zero ledger rows touched
    const receipt = await prisma.awaitingRateReceipt.findUniqueOrThrow({ where: { id: captured.receiptId } });
    expect(receipt.status).toBe("CANCELLED");
    expect(receipt.cancellationReason).toBe("owner declined to pursue this receipt");
    expect(receipt.cancelledById).toBe(a.admin.id);
  });

  it("refuses a blank reason, and refuses a non-ADMIN caller", async () => {
    const d = freshDate();
    const s = await newStudent("cancelauthz");
    const sep = await oneMonth(s.id, d);
    const captured = await recordDuesPayment(
      { context: context(), studentId: s.id, receivedOn: d, tender: { currency: "CRC", amount: "50000.00" }, method: "EFECTIVO", obligationIds: [sep], maxBackdateDays: 5 },
      deps({ now: nowAt(d) }),
    );
    if (captured.ok || captured.error !== "captured") throw new Error("fixture: expected capture");
    expect(await cancelAwaitingRateReceipt({ context: context(), receiptId: captured.receiptId!, reason: "   " }, deps({ now: nowAt(d) }))).toMatchObject({ ok: false, error: "invalid" });
    expect(await cancelAwaitingRateReceipt({ context: context({ organizationRole: "DIRECTOR" }), receiptId: captured.receiptId!, reason: "fine" }, deps({ now: nowAt(d) }))).toMatchObject({ ok: false, error: "notFound" });
  });
});

describe("PACKAGE: capture, fee-void-first fix, and resolution", () => {
  it("captures with the full package snapshot (terms, span, existing debt), changing nothing else", async () => {
    const d = freshDate();
    const s = await newStudent("packagecapture");
    const before = await ledgerCounts(a.org.id);
    const r = await purchasePackage(
      {
        context: context(), studentId: s.id, planTermsId: packageTerms.id, requestedStartMonth: { year: d.year, month: d.month },
        receivedOn: d, tender: { currency: "CRC", amount: "135000.00" }, method: "EFECTIVO", maxBackdateDays: 5,
      },
      deps({ now: nowAt(d) }),
    );
    expect(r).toMatchObject({ ok: false, error: "captured" });
    if (r.ok || r.error !== "captured") return;
    expect(await ledgerCounts(a.org.id)).toEqual({ ...before, receipts: before.receipts + 1 });
    const receipt = await prisma.awaitingRateReceipt.findUniqueOrThrow({ where: { id: r.receiptId } });
    expect(receipt.kind).toBe("PACKAGE");
    expect(receipt.snapshot).toMatchObject({ kind: "PACKAGE", planTermsId: packageTerms.id, priceAmount: "270.00" });
  });

  it("resolves a captured package, creating the obligation and coverage only on resolution, never at capture", async () => {
    const d = freshDate();
    const s = await newStudent("packageresolve");
    const captured = await purchasePackage(
      {
        context: context(), studentId: s.id, planTermsId: packageTerms.id, requestedStartMonth: { year: d.year, month: d.month },
        receivedOn: d, tender: { currency: "CRC", amount: "135000.00" }, method: "EFECTIVO", maxBackdateDays: 5,
      },
      deps({ now: nowAt(d) }),
    );
    if (captured.ok || captured.error !== "captured") throw new Error("fixture: expected capture");
    const rate = await enterRate(d);
    if (!rate.ok) throw new Error("fixture: rate entry failed");
    const resolved = await resolveAwaitingRateReceipt({ context: context(), receiptId: captured.receiptId! }, deps({ now: nowAt(d) }));
    expect(resolved).toMatchObject({ ok: true });
    if (!resolved.ok) return;
    const payment = await prisma.duesPayment.findUniqueOrThrow({ where: { id: resolved.paymentId } });
    expect(payment.resolvedFromReceiptId).toBe(captured.receiptId);
    const obligation = await prisma.duesObligation.findFirstOrThrow({ where: { organizationId: a.org.id, studentId: s.id, type: "PACKAGE" } });
    expect(obligation.monthsCovered).toBe(3);
    const coverageCount = await prisma.duesCoverage.count({ where: { organizationId: a.org.id, obligationId: obligation.id } });
    expect(coverageCount).toBe(3);
  });

  it("fee-void-first fix: an on-time package receipt resolves and voids a fee wrongly assessed on named existing debt while PENDING", async () => {
    const d = freshDate(5); // day 5 = the obligation's own inclusive grace deadline (month d.month, year d.year, for a coverage month of d.month - 1)
    const s = await newStudent("packagefeevoid");
    const priorMonth = await oneMonth(s.id, d); // coverage d.month - 1, grace deadline day 5 of d.month
    const captured = await purchasePackage(
      {
        context: context(), studentId: s.id, planTermsId: packageTerms.id, requestedStartMonth: { year: d.year, month: d.month },
        existingObligationIds: [priorMonth], receivedOn: d, // on time: day 5 is the inclusive grace deadline
        tender: { currency: "CRC", amount: "185000.00" }, method: "EFECTIVO", maxBackdateDays: 5,
      },
      deps({ now: nowAt(d) }),
    );
    if (captured.ok || captured.error !== "captured") throw new Error("fixture: expected capture");

    // While the receipt sits PENDING, the late-fee runner (simulated directly here) assesses a fee on `priorMonth` as of
    // a later "today" — exactly the race this fix exists for. The late-fee check is keyed on the OBLIGATION's own
    // coverage/grace deadline (d.year, d.month), not on this receipt's own (unrelated) receivedOn date.
    const { assessLateFeeInTx } = await import("../../src/lib/dues/ledger/record-payment");
    await appPrisma.$transaction((tx) => assessLateFeeInTx(tx, { context: context(), obligationId: priorMonth, asOf: { year: d.year, month: d.month, day: 20 }, actorId: a.admin.id }, deps()));
    const feeBefore = await prisma.duesLateFee.findFirstOrThrow({ where: { organizationId: a.org.id, obligationId: priorMonth } });
    expect(feeBefore.removedAt).toBeNull();

    const rate = await enterRate(d);
    if (!rate.ok) throw new Error("fixture: rate entry failed");
    const resolved = await resolveAwaitingRateReceipt({ context: context(), receiptId: captured.receiptId! }, deps({ now: nowAt(d) }));
    expect(resolved, "resolution must succeed: the wrongly-assessed fee is voided before resolveMonthlyDebtItemsInTx would otherwise refuse feeAlreadyAssessed").toMatchObject({ ok: true });
    const feeAfter = await prisma.duesLateFee.findUniqueOrThrow({ where: { id: feeBefore.id } });
    expect(feeAfter.removedAt).not.toBeNull();
    expect(feeAfter.removalKind).toBe("VOIDED");
  });

  it("forbidden drift: a changed terms price refuses staleTerms, never silently repriced", async () => {
    const d = freshDate();
    const s = await newStudent("packagedrift");
    const captured = await purchasePackage(
      {
        context: context(), studentId: s.id, planTermsId: packageTerms.id, requestedStartMonth: { year: d.year, month: d.month },
        receivedOn: d, tender: { currency: "CRC", amount: "135000.00" }, method: "EFECTIVO", maxBackdateDays: 5,
      },
      deps({ now: nowAt(d) }),
    );
    if (captured.ok || captured.error !== "captured") throw new Error("fixture: expected capture");

    // A new terms version supersedes the one this receipt snapshotted.
    const packagePlanRow = await prisma.paymentPlanTerms.findUniqueOrThrow({ where: { id: packageTerms.id } });
    await prisma.paymentPlanTerms.create({
      data: { organizationId: a.org.id, planId: packagePlanRow.planId, effectiveYear: 2030, effectiveMonth: 9, priceAmount: "300.00", currency: "USD", monthsCovered: 3, createdById: a.admin.id },
    });

    const rate = await enterRate(d);
    if (!rate.ok) throw new Error("fixture: rate entry failed");
    const before = await ledgerCounts(a.org.id);
    const resolved = await resolveAwaitingRateReceipt({ context: context(), receiptId: captured.receiptId! }, deps({ now: nowAt(d) }));
    expect(resolved).toMatchObject({ ok: false, error: "staleTerms" });
    expect(await ledgerCounts(a.org.id)).toEqual(before);
  });
});

describe("PREPAYMENT: capture and resolution (mechanism shared with ORDINARY)", () => {
  it("captures with the per-month resolved snapshot, then resolves correctly once a rate exists", async () => {
    const d = freshDate();
    const s = await newStudent("prepay");
    await assignPlan(s.id);
    const captured = await prepayMonthlyObligations(
      {
        context: context(), studentId: s.id, requestedMonths: [{ year: d.year, month: d.month + 1 }],
        receivedOn: d, tender: { currency: "CRC", amount: "50000.00" }, method: "EFECTIVO", maxBackdateDays: 5,
      },
      deps({ now: nowAt(d) }),
    );
    expect(captured).toMatchObject({ ok: false, error: "captured" });
    if (captured.ok || captured.error !== "captured") return;
    const beforeResolve = await prisma.duesObligation.count({ where: { organizationId: a.org.id, studentId: s.id } });
    expect(beforeResolve, "nothing created at capture time").toBe(0);

    const rate = await enterRate(d);
    if (!rate.ok) throw new Error("fixture: rate entry failed");
    const resolved = await resolveAwaitingRateReceipt({ context: context(), receiptId: captured.receiptId! }, deps({ now: nowAt(d) }));
    expect(resolved).toMatchObject({ ok: true });
    const obligation = await prisma.duesObligation.findFirstOrThrow({ where: { organizationId: a.org.id, studentId: s.id, type: "MONTHLY", origin: "PREPAYMENT" } });
    expect(obligation.coverageMonth).toBe(d.month + 1);
  });

  it("forbidden drift: the current month advancing past an originally-future month refuses noLongerFuture", async () => {
    const d = freshDate();
    const s = await newStudent("prepaydrift");
    await assignPlan(s.id);
    const captured = await prepayMonthlyObligations(
      {
        context: context(), studentId: s.id, requestedMonths: [{ year: d.year, month: d.month + 1 }],
        receivedOn: d, tender: { currency: "CRC", amount: "50000.00" }, method: "EFECTIVO", maxBackdateDays: 5,
      },
      deps({ now: nowAt(d) }),
    );
    if (captured.ok || captured.error !== "captured") throw new Error("fixture: expected capture");
    const rate = await enterRate(d);
    if (!rate.ok) throw new Error("fixture: rate entry failed");
    // Resolution runs after the originally-future month (d.month + 1) has itself become the current month — two months
    // past d, same year, is "no longer future". This drift check depends on the OBLIGATION's own calendar, unrelated to
    // this receipt's own (unrelated) receivedOn/quoteDate year — only `now` at resolution needs to move forward.
    const resolved = await resolveAwaitingRateReceipt(
      { context: context(), receiptId: captured.receiptId! },
      deps({ now: nowAt({ year: d.year, month: d.month + 2, day: 15 }) }),
    );
    expect(resolved).toMatchObject({ ok: false, error: "noLongerFuture" });
  });
});

describe("tenant isolation (ExchangeRateQuote's own PR 1 precedent)", () => {
  it("AwaitingRateReceipt is registered in both tenant-scoped-model registries", async () => {
    const { TENANT_SCOPED_MODELS: guardModels } = await import("../../src/lib/tenant/tenant-guard");
    const { TENANT_SCOPED_MODELS: scopedClientModels } = await import("../../src/lib/tenant/scoped-client");
    expect(guardModels.has("AwaitingRateReceipt")).toBe(true);
    expect(scopedClientModels.has("AwaitingRateReceipt")).toBe(true);
  });
});
