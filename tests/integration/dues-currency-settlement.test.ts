import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getTestPrismaClient } from "../helpers/test-db";
import { makeAccountingOrg } from "../helpers/accounting-org";
import type { TenantContext } from "../../src/lib/tenant/types";
import { createMonthlyObligation } from "../../src/lib/dues/ledger/create-monthly-obligation";
import { recordDuesPayment } from "../../src/lib/dues/ledger/record-payment";
import { purchasePackage } from "../../src/lib/dues/ledger/purchase-package";
import { enterExchangeRateQuote, EXCHANGE_RATE_LOCK_NAMESPACE } from "../../src/lib/dues/ledger/exchange-rate";
import type { LedgerActivation } from "../../src/lib/dues/ledger/activation";

/**
 * Currency-conversion brief, PR 2: settlement integration, proved against the REAL test database. Reuses PR 1's exact
 * arithmetic and quote resolver (`exchange-rate.ts`/`exchange-rate-arithmetic.ts`, already proved on their own terms) —
 * this suite proves the WIRING: both conversion directions, the missing-rate refusal, the earlier-quote fallback and its
 * distinct `quoteDate`, immutable evidence across a later correction, the oversized-candidate-must-not-block-an-earlier-
 * prefix fix, and package refusals offering only the one full total. Same-currency behavior for all four writers is
 * proved unmodified by their own, untouched existing suites (`dues-ledger-writers.test.ts`, `correct-late-fee.test.ts`,
 * `prepay-monthly.test.ts`, `purchase-package.test.ts`) — nothing here duplicates that coverage.
 *
 * CONCURRENCY (the shared/exclusive reader-writer split — `lockExchangeRateNamespaceShared`/`...Exclusive`,
 * `exchange-rate.ts`): genuine, PID/lock-scoped proofs, none sequential —
 *   1. Two DIFFERENT students' settlements (one same-currency, one cross-currency) genuinely overlap: the SHARED lock
 *      never contends with itself. `purchase-package.test.ts`'s own same-STUDENT concurrency test separately still
 *      proves the student row itself keeps serializing two settlements for the SAME student, unaffected by this split.
 *   2. A quote correction (EXCLUSIVE) genuinely waits on an open settlement's SHARED hold, then proceeds once released
 *      — proved both by `pg_locks` (mode/granted) AND by `pg_blocking_pids()` naming the specific holder PID.
 *   3. A settlement (SHARED) genuinely waits on an open correction's EXCLUSIVE hold, then proceeds using the
 *      just-committed revision (asserted on the resulting `DuesPayment`, not merely "it succeeded") — same
 *      `pg_blocking_pids()` proof as (2).
 *   4. Two DIFFERENT organizations never contend on this shared key1 namespace: (a) organization B's settlement
 *      completes, bounded, while organization A holds its own EXCLUSIVE lock (the only mode where key equality would
 *      matter); (b) organization B's own internal contention is invisible to a query scoped to organization A's key.
 *      Both are mutation-checked (see each test's own history) — a prior "two SHARED holders coexist" version of this
 *      proof was inadequate, since shared locks never conflict regardless of whether their keys actually differ.
 *   5. `exchangeRateLockRowsForKey` (the one function every lock query above builds on) correctly finds a genuinely
 *      NEGATIVE key2 (`-12345`) via `objid::int4` — the two fixture organizations' hashes alone don't prove this,
 *      since both could coincidentally be positive.
 * Lock-state assertions read `pg_locks` directly (`mode`/`granted`/`pid`), fully scoped (`locktype`, `database`,
 * `classid` as a bound parameter, `objid::int4` to an exact key2, `objsubid`), never `pg_stat_activity`'s query text —
 * `pg_advisory_xact_lock` is a literal prefix of `pg_advisory_xact_lock_shared`, so a substring match cannot reliably
 * tell the two lock MODES apart the way `pg_locks.mode` does unambiguously.
 */
const prisma = getTestPrismaClient();
type Fixture = Awaited<ReturnType<typeof makeAccountingOrg>>;
const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
const ACTIVE: LedgerActivation = { isActive: async () => true };
const at = (isoLocal: string) => () => new Date(`${isoLocal}-06:00`); // Costa Rica, UTC-6 all year
const DEC_2030 = at("2030-12-01T12:00:00"); // "now" while creating obligations, and for package-purchase tests (received Dec 1)
const OCT_5 = at("2030-10-05T12:00:00"); // "now" for payment tests received Oct 5 (September's inclusive grace deadline)
const deps = (extra: Record<string, unknown> = {}) => ({ activation: ACTIVE, now: DEC_2030, ...extra });

let a: Fixture;
let crcAcademy: { id: string };
let usdTerms: { id: string };
let usdPolicy: { id: string };
let crcTerms: { id: string };
let crcPolicy: { id: string };
let hugeTerms: { id: string }; // USD 199,000.00/month — deliberately near the column's own range, for the overflow test
let packageTerms: { id: string };

function context(over: Partial<TenantContext> = {}): TenantContext {
  return { kind: "tenant", actorUserId: a.admin.id, organizationId: a.org.id, organizationRole: "ADMIN", academyIds: "ALL", selfStudentId: null, linkedStudentId: null, ...over };
}

let studentCounter = 0;
async function newStudent(label: string, academyId = a.academy.id) {
  const n = ++studentCounter;
  return prisma.student.create({
    data: {
      organizationId: a.org.id, homeAcademyId: academyId, firstName: "Currency", lastName: `${label}${n}`, phone: "00000000",
      email: `currency-${label}-${n}-${suffix}@example.com`, currentRankId: await a.rankId("WHITE"), codeHash: `currency-${label}-${n}-${suffix}`, status: "ACTIVE",
    },
  });
}

/** One MONTHLY obligation for `month` (2030), via the real writer — never hand-built minor-unit numbers. */
async function oneMonth(studentId: string, month: number, termsId: string, policyId: string): Promise<string> {
  const r = await createMonthlyObligation({ context: context(), studentId, coverage: { year: 2030, month }, planTermsId: termsId, policyVersionId: policyId }, deps());
  if (!r.ok) throw new Error(`fixture obligation failed: ${r.error}`);
  return r.obligationId;
}

let quoteDateCounter = 0;
/** A fresh, never-reused quote date per call, always well before any obligation's grace deadline used below (day 1-27 of
 * a distinct month in the first half of 2030), so tests never contend over revision numbers or accidentally supply a
 * "future" quote relative to some other test's receivedOn. */
function freshQuoteDate(): { year: number; month: number; day: number } {
  const day = 1 + (quoteDateCounter++ % 27);
  const month = 1 + (Math.floor(quoteDateCounter / 27) % 6); // months 1-6 of 2030
  return { year: 2030, month, day };
}

const enterRate = (over: Partial<Parameters<typeof enterExchangeRateQuote>[0]> = {}) =>
  enterExchangeRateQuote({ context: context(), quoteDate: freshQuoteDate(), value: "500.00", expectedCurrentRevision: 0, ...over }, deps());

async function ledgerCounts(organizationId: string) {
  return {
    obligations: await prisma.duesObligation.count({ where: { organizationId } }),
    coverage: await prisma.duesCoverage.count({ where: { organizationId } }),
    payments: await prisma.duesPayment.count({ where: { organizationId } }),
    settlements: await prisma.duesSettlement.count({ where: { organizationId } }),
    audits: await prisma.auditLog.count({ where: { organizationId, action: { startsWith: "dues" } } }),
  };
}

type LockRow = { mode: string; granted: boolean; pid: number };

/**
 * Rows for THIS feature's own reserved advisory-lock key1 (`EXCHANGE_RATE_LOCK_NAMESPACE`, passed as a bound
 * parameter, never a hardcoded literal) and an EXACT `key2`, queried directly from `pg_locks` rather than
 * `pg_stat_activity`'s query text — `pg_advisory_xact_lock` is a literal PREFIX of `pg_advisory_xact_lock_shared`, so a
 * text-match on query content cannot reliably tell the two lock MODES this suite needs to distinguish apart.
 * `pg_locks.mode` ("ShareLock" vs "ExclusiveLock") is what Postgres itself is tracking and cannot be ambiguous this way.
 *
 * Filters completely: `locktype = 'advisory'`, `database` (advisory locks are per-database; scoping to the current one
 * is not optional), `classid` (key1), `objid::int4 = key2` (see the cast note below), `objsubid = 2` (Postgres's own
 * marker for the two-integer advisory-lock form specifically, vs. `1` for the single-bigint form every other lock in
 * this codebase uses). Together these can only ever match this one feature's own lock for this exact key2, never
 * coincide with anything else and never silently widen to another organization's row.
 *
 * This is the ONE place the query is written — `exchangeRateLockRowsForOrg`/`waitUntilExchangeRateLockForOrg` below
 * build on this exact function (never a second copy of the SQL), and the deterministic negative-key proof
 * (`exchangeRateLockRowsForKey(-12345)`, its own describe block) calls it directly too, so that proof exercises the
 * identical code path the organization-scoped tests actually run.
 *
 * `objid::int4`, not bare `objid`: `pg_locks.objid` is an `oid` (unsigned), which node-postgres returns as a string,
 * and which stores `hashtext()`'s signed int4 result by raw bit pattern — a negative `hashtext()` value round-trips
 * through `oid` as a large positive number. Casting back to int4 reinterprets those same bits with `hashtext()`'s own
 * signedness, so this column is directly comparable (by value AND by type) to a fresh `SELECT hashtext($1)` result —
 * proved for a genuinely negative key2 by the deterministic test below, not assumed from the two fixture hashes alone.
 */
async function exchangeRateLockRowsForKey(key2: number): Promise<LockRow[]> {
  return prisma.$queryRaw<LockRow[]>`
    SELECT mode, granted, pid
    FROM pg_locks
    WHERE locktype = 'advisory'
      AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
      AND classid = ${EXCHANGE_RATE_LOCK_NAMESPACE}
      AND objid::int4 = ${key2}
      AND objsubid = 2
  `;
}

/** Postgres's own `hashtext(organizationId)` value — the lock's second key. Queried directly, never assumed distinct
 * for any two organization ids (a 32-bit hash can coincidentally collide). */
async function hashtextOf(value: string): Promise<number> {
  const rows = await prisma.$queryRaw<{ h: number }[]>`SELECT hashtext(${value}) AS h`;
  return rows[0].h;
}

/** `exchangeRateLockRowsForKey`, scoped by organization id instead of a raw key2 — computes `hashtext(organizationId)`
 * once and calls the same key-level function every other helper here builds on. A caller cannot accidentally omit
 * organization scoping: there is no "unscoped" variant of this function to reach for by mistake. */
async function exchangeRateLockRowsForOrg(organizationId: string): Promise<LockRow[]> {
  return exchangeRateLockRowsForKey(await hashtextOf(organizationId));
}

async function waitUntilExchangeRateLockForOrg(organizationId: string, predicate: (rows: LockRow[]) => boolean, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate(await exchangeRateLockRowsForOrg(organizationId))) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

/** `holderPid` genuinely blocks `waiterPid`, per Postgres's own `pg_blocking_pids()` — not inferred from timing or
 * from `pg_locks` rows alone (two rows existing, one granted and one not, does not by itself prove ONE is blocking the
 * OTHER specifically; `pg_blocking_pids` is Postgres's own authoritative answer to exactly that question). */
async function isBlockedBy(waiterPid: number, holderPid: number): Promise<boolean> {
  const rows = await prisma.$queryRaw<{ blocked: boolean }[]>`SELECT ${holderPid} = ANY(pg_blocking_pids(${waiterPid})) AS blocked`;
  return rows[0].blocked;
}

/** Races `promise` against a bounded timeout — used where "eventually resolves" is not good enough evidence (a hung
 * promise and a genuine mutation-induced block must both fail an assertion within a bounded interval, never rely on
 * vitest's own test-level timeout as the proof). */
async function raceWithTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<{ kind: "resolved"; value: T } | { kind: "timedOut" }> {
  let timer!: ReturnType<typeof setTimeout>;
  const timeout = new Promise<{ kind: "timedOut" }>((resolve) => {
    timer = setTimeout(() => resolve({ kind: "timedOut" }), timeoutMs);
  });
  const result = await Promise.race([promise.then((value): { kind: "resolved"; value: T } => ({ kind: "resolved", value })), timeout]);
  clearTimeout(timer);
  return result;
}

beforeAll(async () => {
  a = await makeAccountingOrg("CUMULATIVE", "currency-a");
  crcAcademy = await prisma.academy.create({ data: { organizationId: a.org.id, name: "Currency CRC branch", slug: `currency-crc-${suffix}`, kioskTokenHash: `currency-crc-${suffix}` } });

  const usdPlan = await prisma.paymentPlan.create({ data: { organizationId: a.org.id, academyId: a.academy.id, name: `Currency USD plan ${suffix}` } });
  usdTerms = await prisma.paymentPlanTerms.create({
    data: { organizationId: a.org.id, planId: usdPlan.id, effectiveYear: 2027, effectiveMonth: 1, priceAmount: "100.00", currency: "USD", monthsCovered: 1, createdById: a.admin.id },
  });
  usdPolicy = await prisma.duesPolicyVersion.create({
    data: { organizationId: a.org.id, academyId: a.academy.id, effectiveYear: 2027, effectiveMonth: 1, dueDay: 20, graceDay: 5, lateFeeAmount: "20.00", lateFeeCurrency: "USD", maxPrepaidMonths: 12, createdById: a.admin.id },
  });

  const crcPlan = await prisma.paymentPlan.create({ data: { organizationId: a.org.id, academyId: crcAcademy.id, name: `Currency CRC plan ${suffix}` } });
  crcTerms = await prisma.paymentPlanTerms.create({
    data: { organizationId: a.org.id, planId: crcPlan.id, effectiveYear: 2027, effectiveMonth: 1, priceAmount: "50000.00", currency: "CRC", monthsCovered: 1, createdById: a.admin.id },
  });
  crcPolicy = await prisma.duesPolicyVersion.create({
    data: { organizationId: a.org.id, academyId: crcAcademy.id, effectiveYear: 2027, effectiveMonth: 1, dueDay: 20, graceDay: 5, lateFeeAmount: "10000.00", lateFeeCurrency: "CRC", createdById: a.admin.id },
  });

  const hugePlan = await prisma.paymentPlan.create({ data: { organizationId: a.org.id, academyId: a.academy.id, name: `Currency huge plan ${suffix}` } });
  hugeTerms = await prisma.paymentPlanTerms.create({
    data: { organizationId: a.org.id, planId: hugePlan.id, effectiveYear: 2027, effectiveMonth: 1, priceAmount: "199000.00", currency: "USD", monthsCovered: 1, createdById: a.admin.id },
  });

  const packagePlan = await prisma.paymentPlan.create({ data: { organizationId: a.org.id, academyId: a.academy.id, name: `Currency package plan ${suffix}` } });
  packageTerms = await prisma.paymentPlanTerms.create({
    data: { organizationId: a.org.id, planId: packagePlan.id, effectiveYear: 2027, effectiveMonth: 1, priceAmount: "270.00", currency: "USD", monthsCovered: 3, createdById: a.admin.id },
  });
}, 60_000);

afterAll(async () => {
  if (a) {
    await prisma.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe("SET LOCAL session_replication_role = replica");
        // DuesPayment now carries a composite FK to ExchangeRateQuote (this PR) — settlement tables must be cleared
        // BEFORE the quotes they reference, the reverse of no other ordering constraint in this ledger.
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
  // a.drop() deletes every Student and Academy scoped by organizationId — that already covers crcAcademy (same org), so
  // it must run AFTER the cleanup above and needs no separate academy delete of its own.
  await a?.drop();
}, 120_000);

// Runs FIRST, deliberately, before any quote is ever entered for this organization — the only point at which "no quote
// resolves at all" (as opposed to "an earlier one falls back") is genuinely true for org `a`.
describe("recordDuesPayment: rateUnavailable, before this organization has ever entered a quote", () => {
  it("a receipt in the other currency refuses rateUnavailable, with zero writes, when no quote resolves at all", async () => {
    const s = await newStudent("norate");
    const sep = await oneMonth(s.id, 9, usdTerms.id, usdPolicy.id);
    const before = await ledgerCounts(a.org.id);
    const r = await recordDuesPayment(
      { context: context(), studentId: s.id, receivedOn: { year: 2030, month: 10, day: 5 }, tender: { currency: "CRC", amount: "50000.00" }, method: "EFECTIVO", obligationIds: [sep], maxBackdateDays: 5 },
      deps({ now: OCT_5 }),
    );
    expect(r).toEqual({ ok: false, error: "rateUnavailable" });
    expect(await ledgerCounts(a.org.id)).toEqual(before);
  });
});

describe("recordDuesPayment: both conversion directions settle exactly, with full evidence snapshotted", () => {
  it("a USD obligation settled with a CRC tender (USD -> CRC, nearest whole colón)", async () => {
    const quote = await enterRate({ value: "500.00" });
    if (!quote.ok) throw new Error("fixture: rate entry failed");
    const quoteRow = await prisma.exchangeRateQuote.findUniqueOrThrow({ where: { id: quote.quoteId } });

    const s = await newStudent("usdtocrc");
    const sep = await oneMonth(s.id, 9, usdTerms.id, usdPolicy.id);
    const r = await recordDuesPayment(
      {
        context: context(), studentId: s.id, receivedOn: { year: 2030, month: 10, day: 5 }, tender: { currency: "CRC", amount: "50000.00" },
        method: "EFECTIVO", obligationIds: [sep], maxBackdateDays: 5,
      },
      deps({ now: OCT_5 }),
    );
    expect(r).toMatchObject({ ok: true, totalMinor: 5000000 }); // 50,000.00 CRC, exactly 100.00 USD * 500
    if (!r.ok) return;
    const payment = await prisma.duesPayment.findUniqueOrThrow({ where: { id: r.paymentId } });
    expect(payment.tenderCurrency).toBe("CRC");
    expect(payment.tenderAmount.toFixed(2)).toBe("50000.00");
    expect(payment.appliedRateId).toBe(quoteRow.id);
    expect(Number(payment.appliedRateValue)).toBe(500);
    expect(payment.appliedRateQuoteDate?.toISOString().slice(0, 10)).toBe(`${quoteRow.quoteDate.toISOString().slice(0, 10)}`);
    expect(payment.appliedRateRevision).toBe(1);
    expect(payment.appliedRoundingRule).toBe("HALF_UP_TO_COLON");
  });

  it("a CRC obligation settled with a USD tender (CRC -> USD, nearest cent)", async () => {
    const quote = await enterRate({ value: "500.00" });
    if (!quote.ok) throw new Error("fixture: rate entry failed");

    const s = await newStudent("crctousd", crcAcademy.id);
    const sep = await oneMonth(s.id, 9, crcTerms.id, crcPolicy.id);
    const r = await recordDuesPayment(
      {
        context: context(), studentId: s.id, receivedOn: { year: 2030, month: 10, day: 5 }, tender: { currency: "USD", amount: "100.00" },
        method: "EFECTIVO", obligationIds: [sep], maxBackdateDays: 5,
      },
      deps({ now: OCT_5 }),
    );
    expect(r).toMatchObject({ ok: true, totalMinor: 10000 }); // 100.00 USD, exactly 50,000.00 CRC / 500
    if (!r.ok) return;
    const payment = await prisma.duesPayment.findUniqueOrThrow({ where: { id: r.paymentId } });
    expect(payment.appliedRoundingRule).toBe("HALF_UP_TO_CENT");
    expect(Number(payment.appliedRateValue)).toBe(500);
  });
});

describe("recordDuesPayment: earlier-quote fallback, and immutable evidence across a later correction", () => {
  it("resolves the most recent EARLIER quote when none is dated exactly on receivedOn, preserving its own quoteDate distinctly — and a later correcting revision never changes what an already-recorded payment says it used", async () => {
    const earlierDate = freshQuoteDate();
    const first = await enterExchangeRateQuote({ context: context(), quoteDate: earlierDate, value: "500.00", expectedCurrentRevision: 0 }, deps());
    if (!first.ok) throw new Error("fixture: rate entry failed");

    const s = await newStudent("fallback");
    const sep = await oneMonth(s.id, 9, usdTerms.id, usdPolicy.id);
    // receivedOn (Oct 5) has no exact quote — only the earlier one entered above.
    const r = await recordDuesPayment(
      { context: context(), studentId: s.id, receivedOn: { year: 2030, month: 10, day: 5 }, tender: { currency: "CRC", amount: "50000.00" }, method: "EFECTIVO", obligationIds: [sep], maxBackdateDays: 5 },
      deps({ now: OCT_5 }),
    );
    expect(r).toMatchObject({ ok: true });
    if (!r.ok) return;

    const paymentBefore = await prisma.duesPayment.findUniqueOrThrow({ where: { id: r.paymentId } });
    const expectedDate = `${earlierDate.year}-${String(earlierDate.month).padStart(2, "0")}-${String(earlierDate.day).padStart(2, "0")}`;
    expect(paymentBefore.appliedRateQuoteDate?.toISOString().slice(0, 10)).toBe(expectedDate);
    expect(paymentBefore.appliedRateRevision).toBe(1);
    expect(Number(paymentBefore.appliedRateValue)).toBe(500);

    // A correction of the SAME quote date, to a materially different rate.
    const corrected = await enterExchangeRateQuote({ context: context(), quoteDate: earlierDate, value: "510.00", expectedCurrentRevision: 1 }, deps());
    expect(corrected.ok).toBe(true);

    // The already-recorded payment's evidence is a snapshot, never re-read live: unchanged by the correction above.
    const paymentAfter = await prisma.duesPayment.findUniqueOrThrow({ where: { id: r.paymentId } });
    expect(Number(paymentAfter.appliedRateValue)).toBe(500);
    expect(paymentAfter.appliedRateRevision).toBe(1);
  });
});

describe("recordDuesPayment: an oversized converted candidate never blocks payment of an earlier, still-valid prefix", () => {
  it("two obligations whose COMBINED converted total overflows the column, while the oldest alone stays in range: the oldest still settles", async () => {
    await enterRate({ value: "500.00" });
    const s = await newStudent("overflow");
    const sep = await oneMonth(s.id, 9, hugeTerms.id, usdPolicy.id); // USD 199,000.00 -> CRC 99,500,000.00 (in range)
    await oneMonth(s.id, 10, hugeTerms.id, usdPolicy.id); // together: USD 398,000.00 -> CRC 199,000,000.00 (out of range)

    // Paying ONLY September, converted: 199,000.00 * 500 = 99,500,000.00 CRC — the combined (September+October) total would
    // overflow Decimal(10,2) once converted, but that must never prevent this earlier, smaller, still-representable match
    // (the exact bug `detectAmbiguousRoundedTotals` fixed in this PR: a bare .map() over every candidate let one
    // out-of-range candidate's RangeError abort the whole comparison).
    const r = await recordDuesPayment(
      { context: context(), studentId: s.id, receivedOn: { year: 2030, month: 10, day: 5 }, tender: { currency: "CRC", amount: "99500000.00" }, method: "EFECTIVO", obligationIds: [sep], maxBackdateDays: 5 },
      deps({ now: OCT_5 }),
    );
    expect(r).toMatchObject({ ok: true, totalMinor: 9950000000 });
  });
});

describe("purchasePackage: cross-currency settlement, and refusals offer only the ONE full-purchase total", () => {
  it("a wrong amount refuses with only the full (debt + package) total, in the tender's currency, and rolls back the provisional obligation", async () => {
    await enterRate({ value: "500.00" });
    const s = await newStudent("packagewrong");
    const before = await ledgerCounts(a.org.id);
    const r = await purchasePackage(
      {
        context: context(), studentId: s.id, planTermsId: packageTerms.id, requestedStartMonth: { year: 2030, month: 12 },
        receivedOn: { year: 2030, month: 12, day: 1 }, tender: { currency: "CRC", amount: "1000.00" }, method: "EFECTIVO", maxBackdateDays: 90,
      },
      deps({ now: DEC_2030 }),
    );
    expect(r).toMatchObject({ ok: false, error: "notASelectableTotal", selectableTotals: ["135000.00"] }); // 270.00 USD * 500
    expect(await ledgerCounts(a.org.id)).toEqual(before); // the provisional PACKAGE obligation rolled back with everything else
  });

  it("the exact full total, converted, succeeds and snapshots evidence", async () => {
    const quote = await enterRate({ value: "500.00" });
    if (!quote.ok) throw new Error("fixture: rate entry failed");
    const s = await newStudent("packageright");
    const r = await purchasePackage(
      {
        context: context(), studentId: s.id, planTermsId: packageTerms.id, requestedStartMonth: { year: 2030, month: 12 },
        receivedOn: { year: 2030, month: 12, day: 1 }, tender: { currency: "CRC", amount: "135000.00" }, method: "EFECTIVO", maxBackdateDays: 90,
      },
      deps({ now: DEC_2030 }),
    );
    expect(r).toMatchObject({ ok: true, totalMinor: 13500000 });
    if (!r.ok) return;
    const payment = await prisma.duesPayment.findUniqueOrThrow({ where: { id: r.paymentId } });
    expect(payment.appliedRateId).toBe(quote.quoteId);
    expect(payment.appliedRoundingRule).toBe("HALF_UP_TO_COLON");
  });
});

/**
 * Currency-conversion brief PR 2 correction: the shared/exclusive split's WHOLE point is that settlements never contend
 * with each other on this lock — only against a genuine rate correction. Proved here with a REAL second settlement (not
 * a bystander): student A's settlement is paused mid-transaction, still holding the SHARED lock, while student B's
 * settlement — for a DIFFERENT student, same organization — is started and run to completion. `await payingB` resolving
 * (Prisma's `$transaction` only resolves after COMMIT) strictly BEFORE `releaseA()` is called is the proof that B never
 * waited on A's held lock at all: under the old, unconditionally-EXCLUSIVE design, this exact sequence would hang until
 * A released, and this test's own explicit timeout would fail it.
 */
describe("two different students' settlements genuinely overlap: the shared lock never contends with itself", () => {
  it("student B's settlement (cross-currency) completes and commits while student A's settlement (same-currency) is still open", async () => {
    const quote = await enterRate({ value: "500.00" });
    if (!quote.ok) throw new Error("fixture: rate entry failed");

    const studentA = await newStudent("overlapA");
    const sepA = await oneMonth(studentA.id, 9, usdTerms.id, usdPolicy.id);
    const studentB = await newStudent("overlapB");
    const sepB = await oneMonth(studentB.id, 9, usdTerms.id, usdPolicy.id);

    let releaseA!: () => void;
    const gateA = new Promise<void>((r) => (releaseA = r));
    let pausedAResolve!: () => void;
    const pausedA = new Promise<void>((r) => (pausedAResolve = r));
    const payingA = recordDuesPayment(
      { context: context(), studentId: studentA.id, receivedOn: { year: 2030, month: 10, day: 5 }, tender: { currency: "USD", amount: "100.00" }, method: "EFECTIVO", obligationIds: [sepA], maxBackdateDays: 5 },
      deps({ now: OCT_5, afterExchangeRateLockForTest: async () => { pausedAResolve(); await gateA; } }),
    );

    try {
      await pausedA; // A holds the SHARED lock; its transaction is still open, gated on releaseA()

      // B is same organization, DIFFERENT student, cross-currency (the other of the two settlements this pair covers) —
      // run to completion BEFORE releaseA() is ever called.
      const payingB = recordDuesPayment(
        { context: context(), studentId: studentB.id, receivedOn: { year: 2030, month: 10, day: 5 }, tender: { currency: "CRC", amount: "50000.00" }, method: "EFECTIVO", obligationIds: [sepB], maxBackdateDays: 5 },
        deps({ now: OCT_5 }),
      );
      const resultB = await payingB;
      expect(resultB, "B must complete and commit without ever waiting on A's still-open shared hold").toMatchObject({ ok: true });

      releaseA();
      expect(await payingA).toMatchObject({ ok: true });
    } finally {
      releaseA();
      await Promise.allSettled([payingA]);
    }
  }, 20_000);
});

describe("enterExchangeRateQuote: genuinely waits while a settlement holds the shared lock, then proceeds once it releases", () => {
  it("a real correction attempt blocks (EXCLUSIVE, ungranted) on a concurrently open settlement's SHARED hold, then proceeds", async () => {
    const quoteDate = freshQuoteDate();
    const first = await enterExchangeRateQuote({ context: context(), quoteDate, value: "500.00", expectedCurrentRevision: 0 }, deps());
    if (!first.ok) throw new Error("fixture: rate entry failed");

    const s = await newStudent("waitforshared");
    const sep = await oneMonth(s.id, 9, usdTerms.id, usdPolicy.id);

    let releaseSettlement!: () => void;
    const gate = new Promise<void>((r) => (releaseSettlement = r));
    let pausedResolve!: () => void;
    const paused = new Promise<void>((r) => (pausedResolve = r));
    const paying = recordDuesPayment(
      { context: context(), studentId: s.id, receivedOn: { year: 2030, month: 10, day: 5 }, tender: { currency: "USD", amount: "100.00" }, method: "EFECTIVO", obligationIds: [sep], maxBackdateDays: 5 },
      deps({ now: OCT_5, afterExchangeRateLockForTest: async () => { pausedResolve(); await gate; } }),
    );

    let correcting: ReturnType<typeof enterExchangeRateQuote> | undefined;
    try {
      await paused; // the settlement holds the SHARED lock; its transaction is still open

      let correctionDone = false;
      correcting = enterExchangeRateQuote({ context: context(), quoteDate, value: "510.00", expectedCurrentRevision: 1 }, deps()).then((r) => ((correctionDone = true), r));
      const blocked = await waitUntilExchangeRateLockForOrg(a.org.id, (rows) => rows.some((r) => r.mode === "ExclusiveLock" && !r.granted));
      expect(blocked, "the correction must genuinely be waiting (EXCLUSIVE, ungranted) while the settlement holds the SHARED lock, on organization a's own key").toBe(true);
      expect(correctionDone).toBe(false);

      // pg_locks alone (one granted row, one ungranted row) does not by itself prove ONE is blocking the OTHER
      // specifically — pg_blocking_pids() is Postgres's own authoritative answer to exactly that question.
      const rows = await exchangeRateLockRowsForOrg(a.org.id);
      const holderPid = rows.find((r) => r.mode === "ShareLock" && r.granted)?.pid;
      const waiterPid = rows.find((r) => r.mode === "ExclusiveLock" && !r.granted)?.pid;
      expect(holderPid, "the settlement's granted SHARE row must exist").not.toBeUndefined();
      expect(waiterPid, "the correction's ungranted EXCLUSIVE row must exist").not.toBeUndefined();
      expect(await isBlockedBy(waiterPid!, holderPid!), "the correction must be blocked specifically by the settlement's held lock (pg_blocking_pids)").toBe(true);

      releaseSettlement();
      expect(await paying).toMatchObject({ ok: true });
      expect(await correcting).toMatchObject({ ok: true, revision: 2 });
    } finally {
      releaseSettlement();
      await Promise.allSettled([paying, correcting].filter((p): p is NonNullable<typeof p> => p !== undefined));
    }
  }, 20_000);
});

describe("recordDuesPayment: genuinely waits while a quote correction holds the exclusive lock, then uses the committed revision", () => {
  it("a real settlement blocks (SHARED, ungranted) on a concurrently open correction's EXCLUSIVE hold, then proceeds using the JUST-COMMITTED revision", async () => {
    const quoteDate = freshQuoteDate();
    const first = await enterExchangeRateQuote({ context: context(), quoteDate, value: "500.00", expectedCurrentRevision: 0 }, deps());
    if (!first.ok) throw new Error("fixture: rate entry failed");

    const s = await newStudent("waitforexclusive");
    const sep = await oneMonth(s.id, 9, usdTerms.id, usdPolicy.id);

    let releaseCorrection!: () => void;
    const gate = new Promise<void>((r) => (releaseCorrection = r));
    let pausedResolve!: () => void;
    const paused = new Promise<void>((r) => (pausedResolve = r));
    // afterExchangeRateQuoteWrittenForTest (PR 1's own existing hook): fires after the new revision-2 row and its audit
    // entry are written, but BEFORE commit — the correction is still holding the EXCLUSIVE lock at that point.
    const correcting = enterExchangeRateQuote(
      { context: context(), quoteDate, value: "510.00", expectedCurrentRevision: 1 },
      deps({ afterExchangeRateQuoteWrittenForTest: async () => { pausedResolve(); await gate; } }),
    );

    let paying: ReturnType<typeof recordDuesPayment> | undefined;
    try {
      await paused; // the correction holds the EXCLUSIVE lock; revision 2 is written but not yet committed

      let payingDone = false;
      // Tendered to match revision 2's rate (100.00 USD * 510.00 = 51,000.00 CRC) — NOT revision 1's (500.00 -> 50,000.00),
      // so a settlement that wrongly used the stale pre-correction rate would refuse instead of silently "succeeding".
      paying = recordDuesPayment(
        { context: context(), studentId: s.id, receivedOn: { year: 2030, month: 10, day: 5 }, tender: { currency: "CRC", amount: "51000.00" }, method: "EFECTIVO", obligationIds: [sep], maxBackdateDays: 5 },
        deps({ now: OCT_5 }),
      ).then((r) => ((payingDone = true), r));
      const blocked = await waitUntilExchangeRateLockForOrg(a.org.id, (rows) => rows.some((r) => r.mode === "ShareLock" && !r.granted));
      expect(blocked, "the settlement must genuinely be waiting (SHARED, ungranted) while the correction holds the EXCLUSIVE lock, on organization a's own key").toBe(true);
      expect(payingDone).toBe(false);

      const rows = await exchangeRateLockRowsForOrg(a.org.id);
      const holderPid = rows.find((r) => r.mode === "ExclusiveLock" && r.granted)?.pid;
      const waiterPid = rows.find((r) => r.mode === "ShareLock" && !r.granted)?.pid;
      expect(holderPid, "the correction's granted EXCLUSIVE row must exist").not.toBeUndefined();
      expect(waiterPid, "the settlement's ungranted SHARE row must exist").not.toBeUndefined();
      expect(await isBlockedBy(waiterPid!, holderPid!), "the settlement must be blocked specifically by the correction's held lock (pg_blocking_pids)").toBe(true);

      releaseCorrection();
      expect(await correcting).toMatchObject({ ok: true, revision: 2 });

      const payingResult = await paying;
      expect(payingResult).toMatchObject({ ok: true });
      if (!payingResult.ok) return;
      const payment = await prisma.duesPayment.findUniqueOrThrow({ where: { id: payingResult.paymentId } });
      expect(payment.appliedRateRevision).toBe(2);
      expect(Number(payment.appliedRateValue)).toBe(510);
    } finally {
      releaseCorrection();
      await Promise.allSettled([correcting, paying].filter((p): p is NonNullable<typeof p> => p !== undefined));
    }
  }, 20_000);
});

/**
 * Scoped-lock correction, 2nd round: the FIRST correction (adding `objid` and a "two SHARED holders coexist" test)
 * was itself inadequate — two shared holders never conflict REGARDLESS of whether their keys actually differ, so that
 * test proved nothing about scoping at all. The two tests below are the actual proof, each depending on the EXCLUSIVE
 * mode specifically (the only mode where key equality vs. inequality has any observable effect): (a) a genuinely
 * different organization's settlement completes, bounded, while THIS organization holds its own EXCLUSIVE lock — if
 * the two organizations' keys ever collapsed to the same value, B would block behind A instead; (b) organization B's
 * own internal contention (a bystander holding B's EXCLUSIVE lock against B's own settlement) is invisible to a query
 * scoped to organization A's key — proving the scoping query itself discriminates, not just that two unrelated
 * settlements happened to finish.
 */
describe("two different organizations' settlements never contend on this shared key1 namespace", () => {
  let orgB: Fixture;
  let orgBTerms: { id: string };
  let orgBPolicy: { id: string };
  let orgBStudentId: string;
  let orgBObligationId: string;

  beforeAll(async () => {
    orgB = await makeAccountingOrg("CUMULATIVE", "currency-b");
    const plan = await prisma.paymentPlan.create({ data: { organizationId: orgB.org.id, academyId: orgB.academy.id, name: `Currency org-B plan ${suffix}` } });
    orgBTerms = await prisma.paymentPlanTerms.create({
      data: { organizationId: orgB.org.id, planId: plan.id, effectiveYear: 2027, effectiveMonth: 1, priceAmount: "100.00", currency: "USD", monthsCovered: 1, createdById: orgB.admin.id },
    });
    orgBPolicy = await prisma.duesPolicyVersion.create({
      data: { organizationId: orgB.org.id, academyId: orgB.academy.id, effectiveYear: 2027, effectiveMonth: 1, dueDay: 20, graceDay: 5, lateFeeAmount: "20.00", lateFeeCurrency: "USD", createdById: orgB.admin.id },
    });
    const student = await prisma.student.create({
      data: {
        organizationId: orgB.org.id, homeAcademyId: orgB.academy.id, firstName: "Currency", lastName: "OrgB", phone: "00000000",
        email: `currency-orgb-${suffix}@example.com`, currentRankId: await orgB.rankId("WHITE"), codeHash: `currency-orgb-${suffix}`, status: "ACTIVE",
      },
    });
    orgBStudentId = student.id;
    const obligation = await createMonthlyObligation(
      { context: { kind: "tenant", actorUserId: orgB.admin.id, organizationId: orgB.org.id, organizationRole: "ADMIN", academyIds: "ALL", selfStudentId: null, linkedStudentId: null }, studentId: student.id, coverage: { year: 2030, month: 9 }, planTermsId: orgBTerms.id, policyVersionId: orgBPolicy.id },
      deps(),
    );
    if (!obligation.ok) throw new Error(`fixture: org B obligation failed: ${obligation.error}`);
    orgBObligationId = obligation.obligationId;
  }, 30_000);

  afterAll(async () => {
    if (!orgB) return;
    await prisma.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe("SET LOCAL session_replication_role = replica");
        for (const table of ["DuesSettlement", "DuesPayment", "DuesLateFee", "DuesCoverage", "DuesObligation"]) {
          await tx.$executeRawUnsafe(`DELETE FROM "${table}" WHERE "organizationId" = $1`, orgB.org.id);
        }
      },
      { timeout: 30_000 },
    );
    await prisma.auditLog.deleteMany({ where: { organizationId: orgB.org.id } });
    await prisma.paymentPlanTerms.deleteMany({ where: { organizationId: orgB.org.id } });
    await prisma.duesPolicyVersion.deleteMany({ where: { organizationId: orgB.org.id } });
    await prisma.paymentPlan.deleteMany({ where: { organizationId: orgB.org.id } });
    await orgB.drop();
  }, 30_000);

  it("hashtext(organizationId) is confirmed distinct for the two fixture organizations used here (not assumed)", async () => {
    const [hashA, hashB] = await Promise.all([hashtextOf(a.org.id), hashtextOf(orgB.org.id)]);
    expect(hashA).not.toBe(hashB);
  });

  it("(a) organization B's settlement completes, bounded, while organization A holds its own EXCLUSIVE lock via a real correction", async () => {
    const [hashA, hashB] = await Promise.all([hashtextOf(a.org.id), hashtextOf(orgB.org.id)]);
    expect(hashA, "fixture precondition: the two organizations' keys must genuinely differ for this test to mean anything").not.toBe(hashB);

    const aQuoteDate = freshQuoteDate();
    const firstA = await enterExchangeRateQuote({ context: context(), quoteDate: aQuoteDate, value: "500.00", expectedCurrentRevision: 0 }, deps());
    if (!firstA.ok) throw new Error("fixture: org A rate entry failed");

    let releaseA!: () => void;
    const gateA = new Promise<void>((r) => (releaseA = r));
    let pausedAResolve!: () => void;
    const pausedA = new Promise<void>((r) => (pausedAResolve = r));
    // Organization A holds its own EXCLUSIVE lock via a REAL correction (afterExchangeRateQuoteWrittenForTest: PR 1's
    // own existing hook, fires after the new row is written but before commit — the exclusive hold is genuinely live).
    const correctingA = enterExchangeRateQuote(
      { context: context(), quoteDate: aQuoteDate, value: "510.00", expectedCurrentRevision: 1 },
      deps({ afterExchangeRateQuoteWrittenForTest: async () => { pausedAResolve(); await gateA; } }),
    );

    try {
      await pausedA; // organization A holds the EXCLUSIVE lock (key2 = hashA); still open

      const bContext: TenantContext = { kind: "tenant", actorUserId: orgB.admin.id, organizationId: orgB.org.id, organizationRole: "ADMIN", academyIds: "ALL", selfStudentId: null, linkedStudentId: null };
      const payingB = recordDuesPayment(
        { context: bContext, studentId: orgBStudentId, receivedOn: { year: 2030, month: 10, day: 5 }, tender: { currency: "USD", amount: "100.00" }, method: "EFECTIVO", obligationIds: [orgBObligationId], maxBackdateDays: 5 },
        deps({ now: OCT_5 }),
      );

      // Bounded, not a bare `await` — a hang here (e.g. under the mutation check below) must fail with a specific
      // assertion, never rely on vitest's own test-level timeout as the proof.
      const outcome = await raceWithTimeout(payingB, 4000);
      expect(outcome.kind, "organization B's settlement must complete within 4s while organization A's correction is still open — it must never contend on A's key").toBe("resolved");
      if (outcome.kind === "resolved") expect(outcome.value).toMatchObject({ ok: true });

      releaseA();
      expect(await correctingA).toMatchObject({ ok: true, revision: 2 });
    } finally {
      releaseA();
      await Promise.allSettled([correctingA]);
    }
  }, 20_000);

  it("(b) organization B's own internal contention is invisible to a query scoped to organization A's key", async () => {
    const [hashA, hashB] = await Promise.all([hashtextOf(a.org.id), hashtextOf(orgB.org.id)]);
    expect(hashA).not.toBe(hashB);

    // A fresh student/obligation for org B — test (a) already settled orgBObligationId, and re-paying it here would
    // refuse alreadySettled (a genuine, unrelated business rule), not prove or disprove anything about lock scoping.
    const bContextForFixture: TenantContext = { kind: "tenant", actorUserId: orgB.admin.id, organizationId: orgB.org.id, organizationRole: "ADMIN", academyIds: "ALL", selfStudentId: null, linkedStudentId: null };
    const bStudent = await prisma.student.create({
      data: {
        organizationId: orgB.org.id, homeAcademyId: orgB.academy.id, firstName: "Currency", lastName: "OrgBFresh", phone: "00000000",
        email: `currency-orgb-fresh-${suffix}@example.com`, currentRankId: await orgB.rankId("WHITE"), codeHash: `currency-orgb-fresh-${suffix}`, status: "ACTIVE",
      },
    });
    const bObligation = await createMonthlyObligation(
      { context: bContextForFixture, studentId: bStudent.id, coverage: { year: 2030, month: 9 }, planTermsId: orgBTerms.id, policyVersionId: orgBPolicy.id },
      deps(),
    );
    if (!bObligation.ok) throw new Error(`fixture: org B fresh obligation failed: ${bObligation.error}`);

    // A bystander holds organization B's own EXCLUSIVE lock directly (mirrors a real correction's hold without
    // needing one) — organization B's own settlement then genuinely blocks behind it.
    let releaseBystander!: () => void;
    const gate = new Promise<void>((r) => (releaseBystander = r));
    let bystanderStarted!: () => void;
    const bystanderStartedPromise = new Promise<void>((r) => (bystanderStarted = r));
    const bystander = prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${EXCHANGE_RATE_LOCK_NAMESPACE}, ${hashB})`;
        bystanderStarted();
        await gate;
      },
      { timeout: 30_000 },
    );

    let payingB: ReturnType<typeof recordDuesPayment> | undefined;
    try {
      await bystanderStartedPromise;

      payingB = recordDuesPayment(
        { context: bContextForFixture, studentId: bStudent.id, receivedOn: { year: 2030, month: 10, day: 5 }, tender: { currency: "USD", amount: "100.00" }, method: "EFECTIVO", obligationIds: [bObligation.obligationId], maxBackdateDays: 5 },
        deps({ now: OCT_5 }),
      );

      // Prove B's own request is genuinely waiting (scoped to B's own key) BEFORE checking A's predicate at all.
      const blockedOnB = await waitUntilExchangeRateLockForOrg(orgB.org.id, (rows) => rows.some((r) => r.mode === "ShareLock" && !r.granted));
      expect(blockedOnB, "organization B's own settlement must genuinely be waiting on B's own key").toBe(true);

      // The scoped predicate for organization A must find NOTHING — all the contention above is entirely on B's key.
      const blockedOnA = await waitUntilExchangeRateLockForOrg(a.org.id, (rows) => rows.some((r) => !r.granted), 500);
      expect(blockedOnA, "a query scoped to organization A's key must see none of organization B's internal contention").toBe(false);

      releaseBystander();
      expect(await payingB).toMatchObject({ ok: true });
    } finally {
      releaseBystander();
      await Promise.allSettled([bystander, payingB].filter((p): p is NonNullable<typeof p> => p !== undefined));
    }
  }, 20_000);
});

/**
 * Currency-conversion brief PR 2 correction: distinct fixture-organization hashes (above) don't by themselves prove
 * the `oid` -> `int4` cast handles a NEGATIVE key2 correctly — both fixture hashes could coincidentally be positive.
 * This test picks a key2 known to be negative and proves `exchangeRateLockRowsForKey` — the exact function every
 * organization-scoped helper in this file builds on, not a separate copy of the SQL — finds it.
 */
describe("exchangeRateLockRowsForKey: the oid -> int4 cast preserves a negative key2 exactly", () => {
  it("a raw transaction holding key2 = -12345 is found by objid::int4 = -12345, not silently misread", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let started!: () => void;
    const startedPromise = new Promise<void>((r) => (started = r));
    const held = prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(${EXCHANGE_RATE_LOCK_NAMESPACE}, -12345)`;
        started();
        await gate;
      },
      { timeout: 30_000 },
    );
    try {
      await startedPromise;
      const rows = await exchangeRateLockRowsForKey(-12345);
      expect(rows.length, "exactly one holder of key2 = -12345 should be found").toBeGreaterThan(0);
      expect(rows.some((r) => r.mode === "ShareLock" && r.granted), "the -12345 row must be found, granted, ShareLock").toBe(true);
    } finally {
      release();
      await Promise.allSettled([held]);
    }
  });
});
