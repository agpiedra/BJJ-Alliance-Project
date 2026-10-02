import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
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
import type { Tx } from "../../src/lib/dues/ledger/common";

// correctAssignment (a real server action, used by the assignment-lock race test below) calls resolveActionContext ->
// auth(), which needs a Next.js request scope that doesn't exist here — mocked exactly as prepay-monthly.test.ts already
// does, dynamically imported only after the mock is registered.
let currentSession: { user: { id: string; role: string } } | null = null;
vi.mock("@/auth", () => ({ auth: () => Promise.resolve(currentSession), signIn: vi.fn() }));
const { correctAssignment } = await import("../../src/lib/dues/assignment-actions");

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
let crcPackageTerms: { id: string };
let usdPlanId: string;

function context(over: Partial<TenantContext> = {}): TenantContext {
  return { kind: "tenant", actorUserId: a.admin.id, organizationId: a.org.id, organizationRole: "ADMIN", academyIds: "ALL", selfStudentId: null, linkedStudentId: null, ...over };
}

let studentCounter = 0;
async function newStudent(label: string, academyId = a.academy.id) {
  const n = ++studentCounter;
  return prisma.student.create({
    data: {
      organizationId: a.org.id, homeAcademyId: academyId, firstName: "Receipt", lastName: `${label}${n}`, phone: "00000000",
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

/** A SIGNUP obligation (dues-signup-settlement brief): no writer creates a bare one outside enrollment, inserted directly in
 * the shape `dues-ledger-schema.test.ts` proves the database accepts. Never fee-eligible, so unlike `oneMonth` its coverage
 * month need not line up with any grace deadline. */
async function newSignupObligation(studentId: string, coverage: { year: number; month: number }) {
  return prisma.duesObligation.create({
    data: {
      organizationId: a.org.id, studentId, academyId: a.academy.id, type: "SIGNUP", origin: "STAFF",
      coverageYear: coverage.year, coverageMonth: coverage.month, monthsCovered: 1, amount: "50.00", currency: "USD",
      lateFeeAmount: null, dueOn: new Date(Date.UTC(coverage.year, coverage.month - 1, 1)), graceDeadline: null,
      planTermsId: usdTerms.id, policyVersionId: null, createdById: a.admin.id,
    },
  });
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

// --- Genuine lock-wait evidence (second review round, finding 4): `Promise.all` alone proves two calls were INITIATED
// concurrently, never that their transactions actually OVERLAPPED — the pool or scheduler could serialize them while the
// test still passes by coincidence. These three helpers, shared by every concurrency test below, establish CONTROLLED
// overlap (one side paused mid-transaction via an injected test hook) and prove it with Postgres's own authoritative
// `pg_blocking_pids()` — the identical evidentiary bar `dues-currency-settlement.test.ts` already applies to the
// exchange-rate advisory lock.
/** Postgres's own answer to "does `waiterPid` genuinely wait on `holderPid`" — not inferred from timing or from
 * `pg_locks` rows alone. */
async function isBlockedBy(waiterPid: number, holderPid: number): Promise<boolean> {
  const rows = await prisma.$queryRaw<{ blocked: boolean }[]>`SELECT ${holderPid} = ANY(pg_blocking_pids(${waiterPid})) AS blocked`;
  return rows[0].blocked;
}
async function waitUntil(predicate: () => Promise<boolean>, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}
/** Races `promise` against a bounded timeout — a hung promise and a genuine mutation-induced deadlock must both fail an
 * assertion within a bounded interval, never rely on vitest's own test-level timeout as the proof. */
async function raceWithTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<{ kind: "resolved"; value: T } | { kind: "timedOut" }> {
  let timer!: ReturnType<typeof setTimeout>;
  const timeout = new Promise<{ kind: "timedOut" }>((resolve) => { timer = setTimeout(() => resolve({ kind: "timedOut" }), timeoutMs); });
  const result = await Promise.race([promise.then((value): { kind: "resolved"; value: T } => ({ kind: "resolved", value })), timeout]);
  clearTimeout(timer);
  return result;
}
/** The pid of a genuinely blocked SECOND transaction waiting on a ROW-level lock (`SELECT ... FOR UPDATE`/`FOR SHARE`)
 * already held by another open transaction, excluding `excludePid` (the known holder) — how this suite finds that second
 * transaction's own backend pid when it has no test hook of its own to report it directly (e.g. a real
 * `correctAssignment`/`cancelAwaitingRateReceipt` call racing a paused counterpart). Postgres represents row-lock
 * contention as the WAITER requesting a `ShareLock` on the HOLDER's own transaction id (`pg_locks.locktype =
 * 'transactionid'`) — this has no `relation` at all, so a query joined on `pg_class`/`relname` (right for a genuine
 * table-level or advisory lock) can never find it; this is the correct, lock-type-specific query for THIS kind of wait. */
async function waitForTransactionIdWaiter(excludePid: number, timeoutMs = 5000): Promise<number | undefined> {
  let found: number | undefined;
  const ok = await waitUntil(async () => {
    const waiting = await prisma.$queryRaw<{ pid: number }[]>`
      SELECT pid FROM pg_locks WHERE locktype = 'transactionid' AND granted = false AND pid <> ${excludePid}
    `;
    if (waiting.length === 0) return false;
    found = waiting[0].pid;
    return true;
  }, timeoutMs);
  return ok ? found : undefined;
}

beforeAll(async () => {
  a = await makeAccountingOrg("CUMULATIVE", "receipt-a");
  currentSession = { user: { id: a.admin.id, role: "ADMIN" } };
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
  // Reverse-direction fixture (plan priced in CRC, tendered in USD) for the PACKAGE financial-validation tests below.
  const crcPackagePlan = await prisma.paymentPlan.create({ data: { organizationId: a.org.id, academyId: a.academy.id, name: `Receipt CRC package plan ${suffix}` } });
  crcPackageTerms = await prisma.paymentPlanTerms.create({
    data: { organizationId: a.org.id, planId: crcPackagePlan.id, effectiveYear: 2027, effectiveMonth: 1, priceAmount: "135000.00", currency: "CRC", monthsCovered: 3, createdById: a.admin.id },
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

  /**
   * SIGNUP-settlement brief (D16/D17, §5): the ORDINARY branch composes `settleObligationsInTx` unchanged, so a captured
   * snapshot naming a SIGNUP resolves through the EXISTING flat `obligationIds: string[]` schema — no new discriminated-
   * union branch. Also exercises `voidWronglyAssessedFeesInTx`'s own `type: "MONTHLY"`-filtered query safely `continue`-ing
   * past the SIGNUP id (it is never fee-eligible, so no fee could ever need voiding for it) with zero code change.
   */
  it("a captured SIGNUP resolves through the unchanged ORDINARY snapshot shape, settling with no fee (dues-signup-settlement brief)", async () => {
    const d = freshDate();
    const s = await newStudent("ordinary-signup");
    const signup = await newSignupObligation(s.id, { year: d.year, month: d.month });
    const captured = await recordDuesPayment(
      { context: context(), studentId: s.id, receivedOn: d, tender: { currency: "CRC", amount: "25000.00" }, method: "EFECTIVO", obligationIds: [signup.id], maxBackdateDays: 5 },
      deps({ now: nowAt(d) }),
    );
    expect(captured).toMatchObject({ ok: false, error: "captured" });
    if (captured.ok || captured.error !== "captured") return;
    const receipt = await prisma.awaitingRateReceipt.findUniqueOrThrow({ where: { id: captured.receiptId } });
    expect(receipt.snapshot).toMatchObject({ kind: "ORDINARY", obligationIds: [signup.id] });

    const rate = await enterRate(d);
    if (!rate.ok) throw new Error("fixture: rate entry failed");
    const resolved = await resolveAwaitingRateReceipt({ context: context(), receiptId: captured.receiptId! }, deps({ now: nowAt(d) }));
    expect(resolved).toMatchObject({ ok: true });
    if (!resolved.ok) return;
    const settlement = await prisma.duesSettlement.findFirstOrThrow({ where: { obligationId: signup.id, reversedAt: null } });
    expect(settlement.lateFeeId).toBeNull();
    expect(await prisma.duesLateFee.count({ where: { obligationId: signup.id } })).toBe(0);
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
  it("two concurrent resolution attempts for the same receipt produce exactly one payment, proven by a genuine, pg_blocking_pids-verified lock wait", async () => {
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

    let pid1: number | undefined;
    let release1!: () => void;
    const gate1 = new Promise<void>((resolve) => { release1 = resolve; });
    const r1Promise = resolveAwaitingRateReceipt(
      { context: context(), receiptId: captured.receiptId! },
      deps({
        now: nowAt(d),
        afterResolveStudentLockForTest: async (tx: Tx) => {
          const rows = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
          pid1 = rows[0].pid;
          await gate1; // hold the FOR UPDATE lock open until the test releases it below
        },
      }),
    );
    expect(await waitUntil(async () => pid1 !== undefined), "the first attempt must reach the student lock").toBe(true);

    // Started concurrently, never awaited before the block below is proven.
    const r2Promise = resolveAwaitingRateReceipt({ context: context(), receiptId: captured.receiptId! }, deps({ now: nowAt(d) }));
    const pid2 = await waitForTransactionIdWaiter(pid1!);
    expect(pid2, "the second attempt must show up as a genuine, ungranted lock waiter on the Student row").toBeDefined();
    expect(await isBlockedBy(pid2!, pid1!), "the second attempt must be genuinely blocked by the first's own FOR UPDATE hold").toBe(true);

    release1();
    const [r1Outcome, r2Outcome] = await Promise.all([raceWithTimeout(r1Promise, 5000), raceWithTimeout(r2Promise, 5000)]);
    expect(r1Outcome.kind).toBe("resolved");
    expect(r2Outcome.kind).toBe("resolved");
    const results = [r1Outcome, r2Outcome].map((r) => (r.kind === "resolved" ? r.value : undefined));
    const oks = results.filter((r) => r?.ok);
    const fails = results.filter((r) => r && !r.ok);
    expect(oks.length, "exactly one of the two genuinely-overlapping attempts succeeds (serialized by the student lock)").toBe(1);
    expect(fails.length).toBe(1);
    expect(fails[0]).toMatchObject({ ok: false, error: "alreadyResolved" });
    const payments = await prisma.duesPayment.count({ where: { organizationId: a.org.id, resolvedFromReceiptId: captured.receiptId } });
    expect(payments).toBe(1);
  });

  it("a resolve racing a cancel: whichever commits first wins, the other refuses cleanly, proven by a genuine, pg_blocking_pids-verified lock wait", async () => {
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

    let resolvePid: number | undefined;
    let releaseResolve!: () => void;
    const gate = new Promise<void>((resolve) => { releaseResolve = resolve; });
    const resolvePromise = resolveAwaitingRateReceipt(
      { context: context(), receiptId: captured.receiptId! },
      deps({
        now: nowAt(d),
        afterResolveStudentLockForTest: async (tx: Tx) => {
          const rows = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
          resolvePid = rows[0].pid;
          await gate;
        },
      }),
    );
    expect(await waitUntil(async () => resolvePid !== undefined), "resolution must reach the student lock").toBe(true);

    const cancelPromise = cancelAwaitingRateReceipt({ context: context(), receiptId: captured.receiptId!, reason: "owner changed their mind" }, deps({ now: nowAt(d) }));
    const cancelPid = await waitForTransactionIdWaiter(resolvePid!);
    expect(cancelPid, "the cancel attempt must show up as a genuine, ungranted lock waiter on the Student row").toBeDefined();
    expect(await isBlockedBy(cancelPid!, resolvePid!), "cancel must be genuinely blocked by resolution's own FOR UPDATE hold").toBe(true);

    releaseResolve();
    const [resolveOutcome, cancelOutcome] = await Promise.all([raceWithTimeout(resolvePromise, 5000), raceWithTimeout(cancelPromise, 5000)]);
    expect(resolveOutcome.kind).toBe("resolved");
    expect(cancelOutcome.kind).toBe("resolved");
    // Resolution committed first (it was paused and released first, cancel only started once it was already waiting
    // behind resolution's lock) — the receipt's own final status is still the authoritative proof of which won.
    const receipt = await prisma.awaitingRateReceipt.findUniqueOrThrow({ where: { id: captured.receiptId } });
    expect(["RESOLVED", "CANCELLED"]).toContain(receipt.status);
    const resolveResult = resolveOutcome.kind === "resolved" ? resolveOutcome.value : undefined;
    const cancelResult = cancelOutcome.kind === "resolved" ? cancelOutcome.value : undefined;
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

  /**
   * SIGNUP-settlement brief (D17): the PACKAGE branch's own direct `resolveMonthlyDebtItemsInTx` call picks up SIGNUP-
   * awareness automatically — a named SIGNUP settles alongside the package with no code change here.
   */
  it("a named SIGNUP combined with the package settles automatically once a rate resolves (dues-signup-settlement brief)", async () => {
    const d = freshDate();
    const s = await newStudent("packagesignup");
    const signup = await newSignupObligation(s.id, { year: d.year, month: d.month });
    const captured = await purchasePackage(
      {
        context: context(), studentId: s.id, planTermsId: packageTerms.id, requestedStartMonth: { year: d.year, month: d.month },
        existingObligationIds: [signup.id], receivedOn: d, // 50.00 (SIGNUP) + 270.00 (package) = 320.00 USD, at 500.00 = 160000.00 CRC
        tender: { currency: "CRC", amount: "160000.00" }, method: "EFECTIVO", maxBackdateDays: 5,
      },
      deps({ now: nowAt(d) }),
    );
    if (captured.ok || captured.error !== "captured") throw new Error("fixture: expected capture");
    const rate = await enterRate(d);
    if (!rate.ok) throw new Error("fixture: rate entry failed");
    const resolved = await resolveAwaitingRateReceipt({ context: context(), receiptId: captured.receiptId! }, deps({ now: nowAt(d) }));
    expect(resolved).toMatchObject({ ok: true });
    if (!resolved.ok) return;
    const settlement = await prisma.duesSettlement.findFirstOrThrow({ where: { obligationId: signup.id, reversedAt: null } });
    expect(settlement.lateFeeId).toBeNull();
  });

  it("forbidden drift: a SIGNUP that becomes open debt while the package receipt sits PENDING, unnamed, refuses staleSelection — the same protection the brief already gave an unnamed MONTHLY", async () => {
    const d = freshDate();
    const s = await newStudent("packagesignupdrift");
    const captured = await purchasePackage(
      {
        context: context(), studentId: s.id, planTermsId: packageTerms.id, requestedStartMonth: { year: d.year, month: d.month },
        receivedOn: d, tender: { currency: "CRC", amount: "135000.00" }, method: "EFECTIVO", maxBackdateDays: 5, // no existing debt named: none exists yet
      },
      deps({ now: nowAt(d) }),
    );
    if (captured.ok || captured.error !== "captured") throw new Error("fixture: expected capture");
    // A SIGNUP obligation appears for this student while the receipt sits PENDING — never named in the original snapshot.
    const signup = await newSignupObligation(s.id, { year: d.year, month: d.month });
    const rate = await enterRate(d);
    if (!rate.ok) throw new Error("fixture: rate entry failed");
    const before = await ledgerCounts(a.org.id);
    const resolved = await resolveAwaitingRateReceipt({ context: context(), receiptId: captured.receiptId! }, deps({ now: nowAt(d) }));
    expect(resolved).toMatchObject({ ok: false, error: "staleSelection" });
    expect(await ledgerCounts(a.org.id)).toEqual(before);
    expect(await prisma.duesSettlement.count({ where: { obligationId: signup.id } })).toBe(0);
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

  // --- Second review round (confirmed real, not disputed): PACKAGE resolution originally performed NO financial
  // validation at all. `writeSettlementInTx` was called with the receipt's own, never-checked `tenderMinor`/`tender` and
  // no `rateEvidence` — the comment claiming "the actual total/currency match already happened at capture time" was
  // false by construction, since capture only ever happens when `resolveCrossCurrency` found NO rate, so no match could
  // possibly have occurred then. The tests below reproduce this directly, matching every case the round's reproduction
  // list requires, before the fix (reusing `resolveCrossCurrency`/`settleReceipt`, the same core `purchasePackage`
  // already proved correct) is exercised.

  it("resolution with still no rate at all refuses cleanly — never a crash, never an unvalidated success", async () => {
    const d = freshDate();
    const s = await newStudent("packagenorate");
    const captured = await purchasePackage(
      {
        context: context(), studentId: s.id, planTermsId: packageTerms.id, requestedStartMonth: { year: d.year, month: d.month },
        receivedOn: d, tender: { currency: "CRC", amount: "135000.00" }, method: "EFECTIVO", maxBackdateDays: 5,
      },
      deps({ now: nowAt(d) }),
    );
    if (captured.ok || captured.error !== "captured") throw new Error("fixture: expected capture");
    const before = await ledgerCounts(a.org.id);
    const resolved = await resolveAwaitingRateReceipt({ context: context(), receiptId: captured.receiptId! }, deps({ now: nowAt(d) }));
    expect(resolved).toMatchObject({ ok: false, error: "rateUnavailable" });
    expect(await ledgerCounts(a.org.id)).toEqual(before);
    const receipt = await prisma.awaitingRateReceipt.findUniqueOrThrow({ where: { id: captured.receiptId } });
    expect(receipt.status).toBe("PENDING");
  });

  it("a rate making the tendered amount insufficient refuses, rolling back any fee voided in the same attempt", async () => {
    const d = freshDate(5);
    const s = await newStudent("packageinsufficient");
    const priorMonth = await oneMonth(s.id, d);
    const captured = await purchasePackage(
      {
        context: context(), studentId: s.id, planTermsId: packageTerms.id, requestedStartMonth: { year: d.year, month: d.month },
        existingObligationIds: [priorMonth], receivedOn: d, // on time: day 5 is the inclusive grace deadline
        tender: { currency: "CRC", amount: "185000.00" }, method: "EFECTIVO", maxBackdateDays: 5,
      },
      deps({ now: nowAt(d) }),
    );
    if (captured.ok || captured.error !== "captured") throw new Error("fixture: expected capture");

    // A fee wrongly assessed on the existing debt while the receipt sat PENDING — the fee-void-first step must void it,
    // then roll it back along with everything else once the financial mismatch below refuses the whole transaction.
    const { assessLateFeeInTx } = await import("../../src/lib/dues/ledger/record-payment");
    await appPrisma.$transaction((tx) => assessLateFeeInTx(tx, { context: context(), obligationId: priorMonth, asOf: { year: d.year, month: d.month, day: 20 }, actorId: a.admin.id }, deps()));
    const feeBefore = await prisma.duesLateFee.findFirstOrThrow({ where: { organizationId: a.org.id, obligationId: priorMonth } });
    expect(feeBefore.removedAt).toBeNull();

    // Full required total: 100.00 USD debt + 270.00 USD package = 370.00 USD. At 600.00, that is 222000.00 CRC — more
    // than the original 185000.00 CRC tender.
    const rate = await enterRate(d, { value: "600.00" });
    if (!rate.ok) throw new Error("fixture: rate entry failed");
    const before = await ledgerCounts(a.org.id);
    const resolved = await resolveAwaitingRateReceipt({ context: context(), receiptId: captured.receiptId! }, deps({ now: nowAt(d) }));
    expect(resolved).toMatchObject({ ok: false, error: "notASelectableTotal" });
    expect(await ledgerCounts(a.org.id)).toEqual(before);
    const receipt = await prisma.awaitingRateReceipt.findUniqueOrThrow({ where: { id: captured.receiptId } });
    expect(receipt.status).toBe("PENDING");
    const feeAfter = await prisma.duesLateFee.findUniqueOrThrow({ where: { id: feeBefore.id } });
    expect(feeAfter.removedAt, "the fee-void performed earlier in THIS SAME resolution attempt must roll back too").toBeNull();
  });

  it("a rate making the tendered amount excessive refuses, never silently accepted", async () => {
    const d = freshDate();
    const s = await newStudent("packageexcessive");
    const captured = await purchasePackage(
      {
        context: context(), studentId: s.id, planTermsId: packageTerms.id, requestedStartMonth: { year: d.year, month: d.month },
        receivedOn: d, tender: { currency: "CRC", amount: "135000.00" }, method: "EFECTIVO", maxBackdateDays: 5,
      },
      deps({ now: nowAt(d) }),
    );
    if (captured.ok || captured.error !== "captured") throw new Error("fixture: expected capture");
    // 270.00 USD at 300.00 is 81000.00 CRC — the original 135000.00 CRC tender is now excessive.
    const rate = await enterRate(d, { value: "300.00" });
    if (!rate.ok) throw new Error("fixture: rate entry failed");
    const before = await ledgerCounts(a.org.id);
    const resolved = await resolveAwaitingRateReceipt({ context: context(), receiptId: captured.receiptId! }, deps({ now: nowAt(d) }));
    expect(resolved).toMatchObject({ ok: false, error: "notASelectableTotal" });
    expect(await ledgerCounts(a.org.id)).toEqual(before);
    const receipt = await prisma.awaitingRateReceipt.findUniqueOrThrow({ where: { id: captured.receiptId } });
    expect(receipt.status).toBe("PENDING");
  });

  it("a rate making it match exactly resolves, with appliedRate* fields asserted against the actual committed quote", async () => {
    const d = freshDate();
    const s = await newStudent("packageexactmatch");
    const captured = await purchasePackage(
      {
        context: context(), studentId: s.id, planTermsId: packageTerms.id, requestedStartMonth: { year: d.year, month: d.month },
        receivedOn: d, tender: { currency: "CRC", amount: "135000.00" }, method: "EFECTIVO", maxBackdateDays: 5,
      },
      deps({ now: nowAt(d) }),
    );
    if (captured.ok || captured.error !== "captured") throw new Error("fixture: expected capture");
    const rate = await enterRate(d, { value: "500.00" });
    if (!rate.ok) throw new Error("fixture: rate entry failed");
    const resolved = await resolveAwaitingRateReceipt({ context: context(), receiptId: captured.receiptId! }, deps({ now: nowAt(d) }));
    expect(resolved).toMatchObject({ ok: true });
    if (!resolved.ok) return;
    const quote = await prisma.exchangeRateQuote.findUniqueOrThrow({ where: { id: rate.quoteId } });
    const payment = await prisma.duesPayment.findUniqueOrThrow({ where: { id: resolved.paymentId } });
    expect(payment.appliedRateId).toBe(quote.id);
    expect(payment.appliedRateValue?.toFixed(6)).toBe(quote.value.toFixed(6));
    expect(payment.appliedRateQuoteDate?.toISOString()).toBe(quote.quoteDate.toISOString());
    expect(payment.appliedRateRevision).toBe(quote.revision);
    expect(payment.appliedRoundingRule).toBe("HALF_UP_TO_COLON");
  });

  it("the reverse direction: a CRC-priced package settled in USD validates and writes rate evidence identically", async () => {
    const d = freshDate();
    const s = await newStudent("packagereverse");
    const captured = await purchasePackage(
      {
        context: context(), studentId: s.id, planTermsId: crcPackageTerms.id, requestedStartMonth: { year: d.year, month: d.month },
        receivedOn: d, tender: { currency: "USD", amount: "270.00" }, method: "EFECTIVO", maxBackdateDays: 5,
      },
      deps({ now: nowAt(d) }),
    );
    if (captured.ok || captured.error !== "captured") throw new Error("fixture: expected capture");
    // 135000.00 CRC at 500.00 is 270.00 USD exactly.
    const rate = await enterRate(d, { value: "500.00" });
    if (!rate.ok) throw new Error("fixture: rate entry failed");
    const resolved = await resolveAwaitingRateReceipt({ context: context(), receiptId: captured.receiptId! }, deps({ now: nowAt(d) }));
    expect(resolved).toMatchObject({ ok: true });
    if (!resolved.ok) return;
    const payment = await prisma.duesPayment.findUniqueOrThrow({ where: { id: resolved.paymentId } });
    expect(payment.appliedRoundingRule).toBe("HALF_UP_TO_CENT");
    expect(payment.appliedRateId).toBe(rate.quoteId);
  });

  // --- Second review round, finding 3: PACKAGE resolution's coverage/time validation was incomplete, and checked one
  // span (the snapshotted one) while writing another (the freshly re-resolved terms' own `monthsCovered`).

  it("forbidden drift: resolving once the current month has advanced past the package's own covered span refuses staleSelection", async () => {
    const d = freshDate();
    const s = await newStudent("packagetimedrift");
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
    // The package covers d.month .. d.month + 2; resolving once the current month is past that entirely. Third review
    // round: this now goes through the shared `validatePackageSpanInTx` (the same function `purchasePackage` itself
    // calls), whose every failure mode resolution maps uniformly to `staleSelection` — not `noLongerFuture`, which this
    // branch now reserves for the horizon/unavailable-policy cases `validatePackageSpanInTx` itself cannot distinguish
    // from a plain "this selection is no longer valid" outcome.
    const resolved = await resolveAwaitingRateReceipt(
      { context: context(), receiptId: captured.receiptId! },
      deps({ now: nowAt({ year: d.year, month: d.month + 3, day: 15 }) }),
    );
    expect(resolved).toMatchObject({ ok: false, error: "staleSelection" });
  });

  // Third review round: the horizon-only check above (finalMonth hasn't passed) is a genuinely DIFFERENT case from this
  // one (startMonth hasn't passed while finalMonth is still technically future) — neither makes the other redundant.
  it("forbidden drift: the package's own START month slipping into the past (while its final month is still technically future) refuses staleSelection, never shifts the span", async () => {
    const d = freshDate();
    const s = await newStudent("packagestartdrift");
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
    const before = await ledgerCounts(a.org.id);
    // The package covers d.month..d.month+2 (startMonth = d.month). Resolving one month later: currentMonth = d.month+1,
    // so startMonth has already gone by, even though finalMonth (d.month+2) is still > currentMonth — the EXACT case a
    // last-month-only check would wrongly pass.
    const resolved = await resolveAwaitingRateReceipt(
      { context: context(), receiptId: captured.receiptId! },
      deps({ now: nowAt({ year: d.year, month: d.month + 1, day: 15 }) }),
    );
    expect(resolved).toMatchObject({ ok: false, error: "staleSelection" });
    expect(await ledgerCounts(a.org.id)).toEqual(before);
    const receipt = await prisma.awaitingRateReceipt.findUniqueOrThrow({ where: { id: captured.receiptId } });
    expect(receipt.status).toBe("PENDING");
  });

  it("forbidden drift: a month in the captured span becomes covered by something else while PENDING, refuses staleSelection", async () => {
    const d = freshDate();
    const s = await newStudent("packagecoverageoccupied");
    const captured = await purchasePackage(
      {
        context: context(), studentId: s.id, planTermsId: packageTerms.id, requestedStartMonth: { year: d.year, month: d.month },
        receivedOn: d, tender: { currency: "CRC", amount: "135000.00" }, method: "EFECTIVO", maxBackdateDays: 5,
      },
      deps({ now: nowAt(d) }),
    );
    if (captured.ok || captured.error !== "captured") throw new Error("fixture: expected capture");
    // Something else now occupies the SECOND month of the captured 3-month span — never looked at, never substituted.
    const { writeMonthlyObligationInTx } = await import("../../src/lib/dues/ledger/create-monthly-obligation");
    await appPrisma.$transaction((tx) =>
      writeMonthlyObligationInTx(
        tx,
        { context: context(), student: { id: s.id, homeAcademyId: a.academy.id }, coverage: { year: d.year, month: d.month + 1 }, planTermsId: usdTerms.id, policyVersionId: usdPolicy.id, origin: "STAFF" },
        deps(),
      ),
    );
    const rate = await enterRate(d);
    if (!rate.ok) throw new Error("fixture: rate entry failed");
    const before = await ledgerCounts(a.org.id);
    const resolved = await resolveAwaitingRateReceipt({ context: context(), receiptId: captured.receiptId! }, deps({ now: nowAt(d) }));
    expect(resolved).toMatchObject({ ok: false, error: "staleSelection" });
    expect(await ledgerCounts(a.org.id)).toEqual(before);
  });

  it("an inconsistent-but-well-formed span (coverageMonths length not matching its own terms) refuses cleanly, never throws", async () => {
    const d = freshDate();
    const s = await newStudent("packagemalformedspan");
    const receipt = await prisma.awaitingRateReceipt.create({
      data: {
        organizationId: a.org.id, studentId: s.id, academyId: a.academy.id, kind: "PACKAGE",
        receivedOn: new Date(Date.UTC(d.year, d.month - 1, d.day)), tenderCurrency: "CRC", tenderAmount: "135000.00",
        method: "EFECTIVO", capturedAt: nowAt(d)(), capturedById: a.admin.id,
        snapshot: {
          kind: "PACKAGE", planTermsId: packageTerms.id, priceAmount: "270.00",
          startMonth: { year: d.year, month: d.month },
          coverageMonths: [{ year: d.year, month: d.month }], // length 1, but packageTerms.monthsCovered is 3
          existingObligationIds: [],
        },
      },
    });
    const rate = await enterRate(d);
    if (!rate.ok) throw new Error("fixture: rate entry failed");
    const before = await ledgerCounts(a.org.id);
    let threw: unknown;
    let resolved: Awaited<ReturnType<typeof resolveAwaitingRateReceipt>> | undefined;
    try {
      resolved = await resolveAwaitingRateReceipt({ context: context(), receiptId: receipt.id }, deps({ now: nowAt(d) }));
    } catch (error) {
      threw = error;
    }
    expect(threw, "must return a typed refusal, never throw").toBeUndefined();
    expect(resolved).toMatchObject({ ok: false, error: "staleTerms" });
    expect(await ledgerCounts(a.org.id)).toEqual(before);
    const stored = await prisma.awaitingRateReceipt.findUniqueOrThrow({ where: { id: receipt.id } });
    expect(stored.status).toBe("PENDING");
  });

  it("a non-consecutive span (same length as its own terms, but with a gap) refuses cleanly, never throws", async () => {
    const d = freshDate();
    const s = await newStudent("packagenonconsecutivespan");
    const receipt = await prisma.awaitingRateReceipt.create({
      data: {
        organizationId: a.org.id, studentId: s.id, academyId: a.academy.id, kind: "PACKAGE",
        receivedOn: new Date(Date.UTC(d.year, d.month - 1, d.day)), tenderCurrency: "CRC", tenderAmount: "135000.00",
        method: "EFECTIVO", capturedAt: nowAt(d)(), capturedById: a.admin.id,
        snapshot: {
          kind: "PACKAGE", planTermsId: packageTerms.id, priceAmount: "270.00",
          startMonth: { year: d.year, month: d.month },
          // Same LENGTH (3) as packageTerms.monthsCovered, but skips d.month + 2 in favor of d.month + 3 — not the
          // consecutive span a legitimate capture would ever produce.
          coverageMonths: [{ year: d.year, month: d.month }, { year: d.year, month: d.month + 1 }, { year: d.year, month: d.month + 3 }],
          existingObligationIds: [],
        },
      },
    });
    const rate = await enterRate(d);
    if (!rate.ok) throw new Error("fixture: rate entry failed");
    const before = await ledgerCounts(a.org.id);
    let threw: unknown;
    let resolved: Awaited<ReturnType<typeof resolveAwaitingRateReceipt>> | undefined;
    try {
      resolved = await resolveAwaitingRateReceipt({ context: context(), receiptId: receipt.id }, deps({ now: nowAt(d) }));
    } catch (error) {
      threw = error;
    }
    expect(threw, "must return a typed refusal, never throw").toBeUndefined();
    expect(resolved).toMatchObject({ ok: false, error: "staleTerms" });
    expect(await ledgerCounts(a.org.id)).toEqual(before);
    const stored = await prisma.awaitingRateReceipt.findUniqueOrThrow({ where: { id: receipt.id } });
    expect(stored.status).toBe("PENDING");
  });

  // These last two tests each supersede their OWN dedicated package plan/terms with a newer-effective version — never
  // the shared `packageTerms`, so neither can ever stale-out any other test in this describe block regardless of order.

  it("forbidden drift: a changed terms price refuses staleTerms, never silently repriced", async () => {
    const d = freshDate();
    const s = await newStudent("packagedrift");
    // A dedicated, never-shared package plan/terms — superseding it below must never affect any OTHER test's own
    // `packageTerms.id` staleness check.
    const plan = await prisma.paymentPlan.create({ data: { organizationId: a.org.id, academyId: a.academy.id, name: `Receipt pricedrift package plan ${suffix}-${s.id}` } });
    const terms = await prisma.paymentPlanTerms.create({
      data: { organizationId: a.org.id, planId: plan.id, effectiveYear: 2027, effectiveMonth: 1, priceAmount: "270.00", currency: "USD", monthsCovered: 3, createdById: a.admin.id },
    });
    const captured = await purchasePackage(
      {
        context: context(), studentId: s.id, planTermsId: terms.id, requestedStartMonth: { year: d.year, month: d.month },
        receivedOn: d, tender: { currency: "CRC", amount: "135000.00" }, method: "EFECTIVO", maxBackdateDays: 5,
      },
      deps({ now: nowAt(d) }),
    );
    if (captured.ok || captured.error !== "captured") throw new Error("fixture: expected capture");

    // A new terms version supersedes the one this receipt snapshotted.
    await prisma.paymentPlanTerms.create({
      data: { organizationId: a.org.id, planId: plan.id, effectiveYear: 2030, effectiveMonth: 9, priceAmount: "300.00", currency: "USD", monthsCovered: 3, createdById: a.admin.id },
    });

    const rate = await enterRate(d);
    if (!rate.ok) throw new Error("fixture: rate entry failed");
    const before = await ledgerCounts(a.org.id);
    const resolved = await resolveAwaitingRateReceipt({ context: context(), receiptId: captured.receiptId! }, deps({ now: nowAt(d) }));
    expect(resolved).toMatchObject({ ok: false, error: "staleTerms" });
    expect(await ledgerCounts(a.org.id)).toEqual(before);
  });

  it("forbidden drift: the terms' own duration changing between capture and resolution refuses staleTerms, never a span mismatch", async () => {
    const d = freshDate();
    const s = await newStudent("packagedurationdrift");
    const plan = await prisma.paymentPlan.create({ data: { organizationId: a.org.id, academyId: a.academy.id, name: `Receipt durationdrift package plan ${suffix}-${s.id}` } });
    const terms = await prisma.paymentPlanTerms.create({
      data: { organizationId: a.org.id, planId: plan.id, effectiveYear: 2027, effectiveMonth: 1, priceAmount: "270.00", currency: "USD", monthsCovered: 3, createdById: a.admin.id },
    });
    const captured = await purchasePackage(
      {
        context: context(), studentId: s.id, planTermsId: terms.id, requestedStartMonth: { year: d.year, month: d.month },
        receivedOn: d, tender: { currency: "CRC", amount: "135000.00" }, method: "EFECTIVO", maxBackdateDays: 5,
      },
      deps({ now: nowAt(d) }),
    );
    if (captured.ok || captured.error !== "captured") throw new Error("fixture: expected capture");
    // Same price (an amount-only check would wrongly pass) but a DIFFERENT monthsCovered — a genuinely new terms version.
    await prisma.paymentPlanTerms.create({
      data: { organizationId: a.org.id, planId: plan.id, effectiveYear: 2030, effectiveMonth: 9, priceAmount: "270.00", currency: "USD", monthsCovered: 4, createdById: a.admin.id },
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

  // Second review round, finding 2: the per-month drift check compared `termsNow.id` only, never the terms row's actual
  // `priceAmount` — a future-effective terms row can be corrected IN PLACE (same id, new price) via its own
  // revision-token guard, so an id match alone does not prove the price is unchanged.
  it("forbidden drift: an in-place future-price correction on the snapshotted terms refuses staleTerms, even when the new price numerically matches the original tender", async () => {
    const d = freshDate();
    const s = await newStudent("prepaypricedrift");
    // A dedicated, never-shared plan/terms — `usdTerms` already has other obligations referencing it elsewhere in this
    // file, and `dues_config_referenced` forbids correcting a REFERENCED terms row (a real DB guard, not an oversight to
    // work around); this terms row has nothing referencing it until the resolution below actually creates an obligation.
    const plan = await prisma.paymentPlan.create({ data: { organizationId: a.org.id, academyId: a.academy.id, name: `Receipt pricedrift plan ${suffix}-${s.id}` } });
    const terms = await prisma.paymentPlanTerms.create({
      data: { organizationId: a.org.id, planId: plan.id, effectiveYear: 2027, effectiveMonth: 1, priceAmount: "100.00", currency: "USD", monthsCovered: 1, createdById: a.admin.id },
    });
    await prisma.studentPlanAssignment.create({ data: { organizationId: a.org.id, studentId: s.id, planId: plan.id, effectiveYear: 2027, effectiveMonth: 1, createdById: a.admin.id } });
    const captured = await prepayMonthlyObligations(
      {
        context: context(), studentId: s.id, requestedMonths: [{ year: d.year, month: d.month + 1 }],
        receivedOn: d, tender: { currency: "CRC", amount: "50000.00" }, method: "EFECTIVO", maxBackdateDays: 5,
      },
      deps({ now: nowAt(d) }),
    );
    if (captured.ok || captured.error !== "captured") throw new Error("fixture: expected capture");
    // In-place correction: SAME terms id, a DIFFERENT price (100.00 -> 125.00). Deliberately paired with a rate
    // (400.00) that makes 125.00 * 400.00 = 50000.00 — numerically IDENTICAL to the original tender, so an id-only
    // check would wrongly let this through. The price check must refuse anyway.
    await prisma.paymentPlanTerms.update({ where: { id: terms.id }, data: { priceAmount: "125.00" } });
    const rate = await enterRate(d, { value: "400.00" });
    if (!rate.ok) throw new Error("fixture: rate entry failed");
    const before = await ledgerCounts(a.org.id);
    const resolved = await resolveAwaitingRateReceipt({ context: context(), receiptId: captured.receiptId! }, deps({ now: nowAt(d) }));
    expect(resolved).toMatchObject({ ok: false, error: "staleTerms" });
    expect(await ledgerCounts(a.org.id)).toEqual(before);
  });

  // Third review round, finding 2: the per-month drift check compared `policyNow.id` only, never the policy row's own
  // `dueDay`/`graceDay`/`lateFeeAmount`/`lateFeeCurrency`/`maxPrepaidMonths` — a future-effective policy row can be
  // corrected in place exactly like a terms row can. Each test below gets its OWN dedicated academy/plan/terms/policy
  // (never the shared `a.academy`/`usdPolicy`) — `dues_config_referenced` forbids correcting a policy row that any
  // obligation already references, and a shared, already-referenced policy would make the in-place correction itself
  // impossible; a new policy version on the SHARED academy would also stale-out every other test relying on `usdPolicy`
  // remaining current, the same pollution class fixed for package terms in the prior round.
  it("an in-place correction to the policy's own dueDay/graceDay/lateFeeAmount refuses drift, with zero committed financial changes", async () => {
    const d = freshDate();
    const academy = await prisma.academy.create({ data: { organizationId: a.org.id, name: `Receipt policydrift academy ${suffix}`, slug: `receipt-policydrift-${suffix}`, kioskTokenHash: `receipt-policydrift-${suffix}` } });
    const plan = await prisma.paymentPlan.create({ data: { organizationId: a.org.id, academyId: academy.id, name: `Receipt policydrift plan ${suffix}` } });
    await prisma.paymentPlanTerms.create({
      data: { organizationId: a.org.id, planId: plan.id, effectiveYear: 2027, effectiveMonth: 1, priceAmount: "100.00", currency: "USD", monthsCovered: 1, createdById: a.admin.id },
    });
    const policy = await prisma.duesPolicyVersion.create({
      data: { organizationId: a.org.id, academyId: academy.id, effectiveYear: 2027, effectiveMonth: 1, dueDay: 20, graceDay: 5, lateFeeAmount: "20.00", lateFeeCurrency: "USD", maxPrepaidMonths: 12, createdById: a.admin.id },
    });
    const s = await newStudent("policydrift", academy.id);
    await prisma.studentPlanAssignment.create({ data: { organizationId: a.org.id, studentId: s.id, planId: plan.id, effectiveYear: 2027, effectiveMonth: 1, createdById: a.admin.id } });
    const captured = await prepayMonthlyObligations(
      {
        context: context(), studentId: s.id, requestedMonths: [{ year: d.year, month: d.month + 1 }],
        receivedOn: d, tender: { currency: "CRC", amount: "50000.00" }, method: "EFECTIVO", maxBackdateDays: 5,
      },
      deps({ now: nowAt(d) }),
    );
    if (captured.ok || captured.error !== "captured") throw new Error("fixture: expected capture");
    // In-place correction: SAME policy id, DIFFERENT dueDay/graceDay/lateFeeAmount — nothing references this policy yet
    // (capture creates no obligation), so the correction itself is allowed.
    await prisma.duesPolicyVersion.update({ where: { id: policy.id }, data: { dueDay: 25, graceDay: 10, lateFeeAmount: "30.00" } });
    const rate = await enterRate(d);
    if (!rate.ok) throw new Error("fixture: rate entry failed");
    const before = await ledgerCounts(a.org.id);
    const resolved = await resolveAwaitingRateReceipt({ context: context(), receiptId: captured.receiptId! }, deps({ now: nowAt(d) }));
    expect(resolved).toMatchObject({ ok: false, error: "staleTerms" });
    expect(await ledgerCounts(a.org.id), "every ledger table, queried directly, not just a rollback claim").toEqual(before);
    const receipt = await prisma.awaitingRateReceipt.findUniqueOrThrow({ where: { id: captured.receiptId } });
    expect(receipt.status).toBe("PENDING");
  });

  it("a pending receipt's selected month falling outside a horizon LOWERED after capture refuses, proving no grandfathering for an unresolved receipt", async () => {
    const d = freshDate();
    const academy = await prisma.academy.create({ data: { organizationId: a.org.id, name: `Receipt horizonlower academy ${suffix}`, slug: `receipt-horizonlower-${suffix}`, kioskTokenHash: `receipt-horizonlower-${suffix}` } });
    const plan = await prisma.paymentPlan.create({ data: { organizationId: a.org.id, academyId: academy.id, name: `Receipt horizonlower plan ${suffix}` } });
    await prisma.paymentPlanTerms.create({
      data: { organizationId: a.org.id, planId: plan.id, effectiveYear: 2027, effectiveMonth: 1, priceAmount: "100.00", currency: "USD", monthsCovered: 1, createdById: a.admin.id },
    });
    const policy = await prisma.duesPolicyVersion.create({
      data: { organizationId: a.org.id, academyId: academy.id, effectiveYear: 2027, effectiveMonth: 1, dueDay: 20, graceDay: 5, lateFeeAmount: "20.00", lateFeeCurrency: "USD", maxPrepaidMonths: 12, createdById: a.admin.id },
    });
    const s = await newStudent("horizonlower", academy.id);
    await prisma.studentPlanAssignment.create({ data: { organizationId: a.org.id, studentId: s.id, planId: plan.id, effectiveYear: 2027, effectiveMonth: 1, createdById: a.admin.id } });
    const captured = await prepayMonthlyObligations(
      {
        context: context(), studentId: s.id, requestedMonths: [{ year: d.year, month: d.month + 1 }, { year: d.year, month: d.month + 2 }],
        receivedOn: d, tender: { currency: "CRC", amount: "100000.00" }, method: "EFECTIVO", maxBackdateDays: 5,
      },
      deps({ now: nowAt(d) }),
    );
    if (captured.ok || captured.error !== "captured") throw new Error("fixture: expected capture");
    // The owner lowers the horizon to its minimum (1 — `maxPrepaidMonths` must be positive) while this receipt sits
    // PENDING: the new horizon end is d.month + 1, one month short of the already-selected d.month + 2 — it has
    // purchased nothing yet, so it gets no grandfathering (unlike a completed purchase that already created a real
    // obligation).
    await prisma.duesPolicyVersion.update({ where: { id: policy.id }, data: { maxPrepaidMonths: 1 } });
    const rate = await enterRate(d);
    if (!rate.ok) throw new Error("fixture: rate entry failed");
    const before = await ledgerCounts(a.org.id);
    const resolved = await resolveAwaitingRateReceipt({ context: context(), receiptId: captured.receiptId! }, deps({ now: nowAt(d) }));
    expect(resolved).toMatchObject({ ok: false, error: "noLongerFuture" });
    expect(await ledgerCounts(a.org.id)).toEqual(before);
    const receipt = await prisma.awaitingRateReceipt.findUniqueOrThrow({ where: { id: captured.receiptId } });
    expect(receipt.status).toBe("PENDING");
  });

  it("the received-date aging exception removes only tooOld — an aged receipt with genuine policy drift still refuses for that unrelated reason", async () => {
    const d = freshDate();
    const academy = await prisma.academy.create({ data: { organizationId: a.org.id, name: `Receipt agedpolicydrift academy ${suffix}`, slug: `receipt-agedpolicydrift-${suffix}`, kioskTokenHash: `receipt-agedpolicydrift-${suffix}` } });
    const plan = await prisma.paymentPlan.create({ data: { organizationId: a.org.id, academyId: academy.id, name: `Receipt agedpolicydrift plan ${suffix}` } });
    await prisma.paymentPlanTerms.create({
      data: { organizationId: a.org.id, planId: plan.id, effectiveYear: 2027, effectiveMonth: 1, priceAmount: "100.00", currency: "USD", monthsCovered: 1, createdById: a.admin.id },
    });
    const policy = await prisma.duesPolicyVersion.create({
      data: { organizationId: a.org.id, academyId: academy.id, effectiveYear: 2027, effectiveMonth: 1, dueDay: 20, graceDay: 5, lateFeeAmount: "20.00", lateFeeCurrency: "USD", maxPrepaidMonths: 12, createdById: a.admin.id },
    });
    const s = await newStudent("agedpolicydrift", academy.id);
    await prisma.studentPlanAssignment.create({ data: { organizationId: a.org.id, studentId: s.id, planId: plan.id, effectiveYear: 2027, effectiveMonth: 1, createdById: a.admin.id } });
    const captured = await prepayMonthlyObligations(
      {
        context: context(), studentId: s.id, requestedMonths: [{ year: d.year, month: d.month + 1 }],
        receivedOn: d, tender: { currency: "CRC", amount: "50000.00" }, method: "EFECTIVO", maxBackdateDays: 5,
      },
      deps({ now: nowAt(d) }),
    );
    if (captured.ok || captured.error !== "captured") throw new Error("fixture: expected capture");
    await prisma.duesPolicyVersion.update({ where: { id: policy.id }, data: { lateFeeAmount: "30.00" } });
    const rate = await enterRate(d);
    if (!rate.ok) throw new Error("fixture: rate entry failed");
    // Resolution runs well past the ordinary new-entry window (10 days after receivedOn, against a 5-day maxBackdateDays
    // — a fresh entry would be refused tooOld here) — but resolution has no tooOld check of its own at all, so aging is
    // irrelevant either way. Deliberately still BEFORE the requested coverage month itself (d.month + 1), so neither of
    // the new floor/ceiling horizon checks fire for an unrelated reason — isolating this to the policy fingerprint check
    // alone. The genuine drift must still refuse — not silently succeed because "enough time passed".
    const resolved = await resolveAwaitingRateReceipt(
      { context: context(), receiptId: captured.receiptId! },
      deps({ now: nowAt({ year: d.year, month: d.month, day: d.day + 10 }) }),
    );
    expect(resolved).toMatchObject({ ok: false, error: "staleTerms" });
  });
});

describe("PREPAYMENT: assignment-lock concurrency (plan's own correctAssignment race)", () => {
  it("a resolve racing a real correctAssignment call on the same assignment row genuinely blocks, proven by pg_blocking_pids", async () => {
    const d = freshDate();
    const s = await newStudent("prepayassignmentrace");
    const futureMonth = d.month + 1;
    const assignment = await prisma.studentPlanAssignment.create({
      data: { organizationId: a.org.id, studentId: s.id, planId: usdPlanId, effectiveYear: d.year, effectiveMonth: futureMonth, createdById: a.admin.id },
    });
    const captured = await prepayMonthlyObligations(
      {
        context: context(), studentId: s.id, requestedMonths: [{ year: d.year, month: futureMonth }],
        receivedOn: d, tender: { currency: "CRC", amount: "50000.00" }, method: "EFECTIVO", maxBackdateDays: 5,
      },
      deps({ now: nowAt(d) }),
    );
    if (captured.ok || captured.error !== "captured") throw new Error("fixture: expected capture");
    const rate = await enterRate(d);
    if (!rate.ok) throw new Error("fixture: rate entry failed");

    let resolvePid: number | undefined;
    let releaseResolve!: () => void;
    const gate = new Promise<void>((resolve) => { releaseResolve = resolve; });

    const resolvePromise = resolveAwaitingRateReceipt(
      { context: context(), receiptId: captured.receiptId! },
      deps({
        now: nowAt(d),
        afterResolveAssignmentLockForTest: async (tx: Tx) => {
          const rows = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
          resolvePid = rows[0].pid;
          await gate; // hold the FOR SHARE lock open until the test releases it below
        },
      }),
    );

    expect(await waitUntil(async () => resolvePid !== undefined), "resolution must reach the assignment lock").toBe(true);

    // A REAL correctAssignment call (its own FOR UPDATE on the SAME row) should now genuinely block behind resolution's
    // FOR SHARE hold — started concurrently, never awaited before the block is proven.
    const formData = new FormData();
    formData.set("assignmentId", assignment.id);
    formData.set("expectedRevision", "0");
    formData.set("planId", usdPlanId);
    const correctPromise = correctAssignment(a.org.id, {}, formData);
    // correctAssignment opens its own transaction with no test hook of its own — found instead as a genuine, ungranted
    // lock waiter on the same table, scoped to exclude resolution's own already-known pid.
    const correctPid = await waitForTransactionIdWaiter(resolvePid ?? -1);

    expect(correctPid, "a real correctAssignment attempt must show up as a genuine, ungranted lock waiter").toBeDefined();
    expect(resolvePid).toBeDefined();
    expect(await isBlockedBy(correctPid!, resolvePid!), "correctAssignment must be genuinely blocked by resolution's own FOR SHARE hold").toBe(true);

    releaseResolve();
    const resolved = await raceWithTimeout(resolvePromise, 5000);
    expect(resolved.kind).toBe("resolved");
    if (resolved.kind === "resolved") expect(resolved.value).toMatchObject({ ok: true });
    const correctResult = await raceWithTimeout(correctPromise, 5000);
    expect(correctResult.kind).toBe("resolved");
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
