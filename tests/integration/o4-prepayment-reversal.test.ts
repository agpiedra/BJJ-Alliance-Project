import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getTestPrismaClient } from "../helpers/test-db";
import { makeAccountingOrg } from "../helpers/accounting-org";
import type { SystemJobContext, TenantContext } from "../../src/lib/tenant/types";
import type { YearMonth } from "../../src/lib/dues/calendar";
import type { LedgerActivation } from "../../src/lib/dues/ledger/activation";
import type { Tx } from "../../src/lib/dues/ledger/common";
import { versionRevision } from "../../src/lib/dues/config-input";
import { createMonthlyObligation } from "../../src/lib/dues/ledger/create-monthly-obligation";
import { recordDuesPayment } from "../../src/lib/dues/ledger/record-payment";
import { prepayMonthlyObligations } from "../../src/lib/dues/ledger/prepay-monthly";
import { reversePayment } from "../../src/lib/dues/ledger/reverse-payment";
import { waiveLateFee } from "../../src/lib/dues/ledger/waive-late-fee";
import { assessLateFeesForStudent } from "../../src/lib/dues/late-fee-assessment";
import { enterExchangeRateQuote } from "../../src/lib/dues/ledger/exchange-rate";
import { resolveAwaitingRateReceipt } from "../../src/lib/dues/ledger/awaiting-rate-receipt";
import { generateMonthlyObligationForStudent } from "../../src/lib/dues/monthly-generation";
import { listReversiblePayments, previewPaymentReversal } from "../../src/lib/dues/financial-corrections-queries";

/**
 * O4 — prepaid-payment reversal (owner decisions B1–B10, 2026-11-09; docs/dues/O4-PREPAYMENT-REVERSAL-PLAN.md), against the
 * REAL test database:
 *  - the database's own enforcement (migration 20261110120000): cancellation ⇔ release consistency, provenance, I1, set-once
 *    markers, no settlement/fee on a cancelled obligation, a started month never cancellable — each refusal leaving NOTHING;
 *  - the writer's rules end to end (R1/R2/R3, Decision A, B2, B4, B6, B7, B9) and repeats;
 *  - a forced late failure and a database refusal both roll back every financial change;
 *  - the stated races, both orderings, with genuine overlap shown by Postgres's own `pg_blocking_pids()`. Each asserts a
 *    consistent final state for the orderings exercised; none of this proves deadlock freedom in general.
 */
const prisma = getTestPrismaClient();
type Fixture = Awaited<ReturnType<typeof makeAccountingOrg>>;
const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
const ACTIVE: LedgerActivation = { isActive: async () => true };
const at = (isoLocal: string) => () => new Date(`${isoLocal}-06:00`); // Costa Rica, UTC-6 all year
const deps = (now: string, extra: Record<string, unknown> = {}) => ({ activation: ACTIVE, now: at(now), ...extra });

let a: Fixture;
let plan: { id: string };
let terms: { id: string };
let policy: { id: string };
let tzAcademy: { id: string };
let tzPlan: { id: string };

function context(over: Partial<TenantContext> = {}): TenantContext {
  return { kind: "tenant", actorUserId: a.admin.id, organizationId: a.org.id, organizationRole: "ADMIN", academyIds: "ALL", selfStudentId: null, linkedStudentId: null, ...over };
}
const jobContext = (): SystemJobContext => ({ kind: "system-job", organizationId: a.org.id, jobName: "o4-test" });

let n = 0;
async function newStudent(label: string, academyId = a.academy.id) {
  const i = ++n;
  const s = await prisma.student.create({
    data: {
      organizationId: a.org.id, homeAcademyId: academyId, firstName: "O4", lastName: `${label}${i}`, phone: "00000000",
      email: `o4-${label}-${i}-${suffix}@example.com`, currentRankId: await a.rankId("WHITE"), codeHash: `o4-${label}-${i}-${suffix}`, status: "ACTIVE",
    },
  });
  await prisma.studentStatusChange.create({ data: { organizationId: a.org.id, studentId: s.id, status: "ACTIVE", effectiveOn: new Date(Date.UTC(2020, 0, 1)), sequence: 1, source: "BASELINE", actorId: a.admin.id } });
  const planId = academyId === a.academy.id ? plan.id : tzPlan.id; // a plan belongs to one branch
  await prisma.studentPlanAssignment.create({ data: { organizationId: a.org.id, studentId: s.id, planId, effectiveYear: 2020, effectiveMonth: 1, createdById: a.admin.id } });
  return s;
}

const ym = (year: number, month: number): YearMonth => ({ year, month });
const day = (iso: string) => {
  const [y, m, d] = iso.split("-").map(Number);
  return { year: y, month: m, day: d };
};

async function prepay(studentId: string, months: YearMonth[], now: string, existingObligationIds: string[] = []) {
  const r = await prepayMonthlyObligations(
    {
      context: context(), studentId, requestedMonths: months, existingObligationIds, receivedOn: day(now.slice(0, 10)),
      tender: { currency: "USD", amount: `${(months.length + existingObligationIds.length) * 100}.00` }, method: "EFECTIVO", maxBackdateDays: 90,
    },
    deps(now),
  );
  if (!r.ok) throw new Error(`fixture prepay failed: ${r.error}`);
  return r;
}

async function monthly(studentId: string, coverage: YearMonth, now: string) {
  const r = await createMonthlyObligation({ context: context(), studentId, coverage, planTermsId: terms.id, policyVersionId: policy.id }, deps(now));
  if (!r.ok) throw new Error(`fixture obligation failed: ${r.error}`);
  return r.obligationId;
}

const reverse = (paymentId: string, now: string, expected: string[] = [], extra: Record<string, unknown> = {}, over: Partial<Parameters<typeof reversePayment>[0]> = {}) =>
  reversePayment({ context: context(), paymentId, reasonCategory: "RECORDED_IN_ERROR", reversalReason: "o4 test", expectedCancelledObligationIds: expected, ...over }, deps(now, extra));

/** Every financial fact about one student, for "nothing changed" assertions. */
async function snapshot(studentId: string) {
  const [obligations, coverage, payments, settlements, fees, audits] = await Promise.all([
    prisma.duesObligation.findMany({ where: { studentId }, orderBy: { id: "asc" }, select: { id: true, cancelledAt: true } }),
    prisma.duesCoverage.findMany({ where: { studentId }, orderBy: { id: "asc" }, select: { id: true, releasedAt: true } }),
    prisma.duesPayment.findMany({ where: { studentId }, orderBy: { id: "asc" }, select: { id: true, reversedAt: true } }),
    prisma.duesSettlement.findMany({ where: { studentId }, orderBy: { id: "asc" }, select: { id: true, reversedAt: true } }),
    prisma.duesLateFee.findMany({ where: { obligation: { studentId } }, orderBy: { id: "asc" }, select: { id: true, removedAt: true } }),
    prisma.auditLog.count({ where: { organizationId: a.org.id, action: "duesPayment.reverse" } }),
  ]);
  return { obligations, coverage, payments, settlements, fees, audits };
}

/** The error's message plus the database's own message, wherever the driver adapter put it. */
function errorText(error: unknown): string {
  const cause = (error as { meta?: { driverAdapterError?: { cause?: { originalMessage?: string; message?: string } } } } | undefined)?.meta?.driverAdapterError?.cause;
  return [error instanceof Error ? error.message : String(error), cause?.originalMessage ?? "", cause?.message ?? ""].join(" | ");
}

/** Runs `body` in its own transaction and expects the transaction (a statement or the COMMIT) to fail with `text`. */
async function refusedTx(text: string, body: (tx: Tx) => Promise<unknown>) {
  let error: unknown = null;
  try {
    await prisma.$transaction(async (tx) => {
      await body(tx as unknown as Tx);
    });
  } catch (e) {
    error = e;
  }
  expect(error, `expected a refusal containing: ${text}`).not.toBeNull();
  expect(errorText(error)).toContain(text);
}

/** Polls until `query` reports a waiting session. */
async function waitFor(query: () => Promise<{ n: bigint }[]>, what: string, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (Number((await query())[0].n) > 0) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for: ${what}`);
}
/** Some session is genuinely waiting on `holderPid` (Postgres's own pg_blocking_pids), not inferred from timing. */
const waitUntilBlockedBy = (holderPid: number) =>
  waitFor(() => prisma.$queryRaw`SELECT count(*) AS n FROM pg_stat_activity WHERE ${holderPid}::int = ANY(pg_blocking_pids(pid))`, `a session blocked by ${holderPid}`);
/** For holders whose pause point has no transaction handle: some session in this database is genuinely blocked. This file's
 * tests run serially (fileParallelism: false), so the only candidate is the operation the test just started. */
const waitUntilAnyBlocked = () =>
  waitFor(() => prisma.$queryRaw`SELECT count(*) AS n FROM pg_stat_activity WHERE datname = current_database() AND cardinality(pg_blocking_pids(pid)) > 0`, "any blocked session");

/** A test-held pause point: resolves `pid` with the holder's backend pid, then waits for `release()`. */
function hold() {
  let pidResolve!: (pid: number) => void;
  const pid = new Promise<number>((r) => (pidResolve = r));
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const pause = async (tx: Tx) => {
    const rows = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
    pidResolve(rows[0].pid);
    await gate;
  };
  return { pid, release, pause };
}
/** A test-held pause point with no transaction handle: resolves `reached`, then waits for `release()`. */
function gateOnly() {
  let reachedResolve!: () => void;
  const reached = new Promise<void>((r) => (reachedResolve = r));
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  return { reached, release, pause: async () => { reachedResolve(); await gate; } };
}

beforeAll(async () => {
  a = await makeAccountingOrg("CUMULATIVE", "o4-reversal");
  plan = await prisma.paymentPlan.create({ data: { organizationId: a.org.id, academyId: a.academy.id, name: `O4 plan ${suffix}` } });
  terms = await prisma.paymentPlanTerms.create({
    data: { organizationId: a.org.id, planId: plan.id, effectiveYear: 2020, effectiveMonth: 1, priceAmount: "100.00", currency: "USD", monthsCovered: 1, createdById: a.admin.id },
  });
  policy = await prisma.duesPolicyVersion.create({
    data: { organizationId: a.org.id, academyId: a.academy.id, effectiveYear: 2020, effectiveMonth: 1, dueDay: 20, graceDay: 5, lateFeeAmount: "20.00", lateFeeCurrency: "USD", maxPrepaidMonths: 3, createdById: a.admin.id },
  });
  // A second branch used only by the timezone race and the branch-move test, so editing its timezone touches no other test.
  tzAcademy = await prisma.academy.create({ data: { organizationId: a.org.id, name: `O4 tz ${suffix}`, slug: `o4-tz-${suffix}`, kioskTokenHash: `o4-tz-${suffix}`, timezone: "America/Costa_Rica" } });
  await prisma.duesPolicyVersion.create({
    data: { organizationId: a.org.id, academyId: tzAcademy.id, effectiveYear: 2020, effectiveMonth: 1, dueDay: 20, graceDay: 5, lateFeeAmount: "20.00", lateFeeCurrency: "USD", maxPrepaidMonths: 3, createdById: a.admin.id },
  });
  tzPlan = await prisma.paymentPlan.create({ data: { organizationId: a.org.id, academyId: tzAcademy.id, name: `O4 tz plan ${suffix}` } });
  await prisma.paymentPlanTerms.create({
    data: { organizationId: a.org.id, planId: tzPlan.id, effectiveYear: 2020, effectiveMonth: 1, priceAmount: "100.00", currency: "USD", monthsCovered: 1, createdById: a.admin.id },
  });
}, 60_000);

afterAll(async () => {
  // Ledger rows are undeletable by design (triggers); bypassed for test cleanup only, exactly as the other ledger suites do.
  await prisma.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL session_replication_role = replica");
      for (const table of ["DuesSettlement", "DuesPayment", "DuesLateFee", "DuesCoverage", "DuesObligation", "AwaitingRateReceipt", "ExchangeRateQuote", "DuesPolicyVersion", "PaymentPlanTerms", "StudentPlanAssignment"]) {
        await tx.$executeRawUnsafe(`DELETE FROM "${table}" WHERE "organizationId" = $1`, a.org.id);
      }
    },
    { timeout: 60_000 },
  );
  await prisma.paymentPlan.deleteMany({ where: { organizationId: a.org.id } });
  await a.drop();
}, 60_000);

// --------------------------------------------------------------------------------------------------------------------------
describe("database enforcement (migration 20261110120000) — every refusal leaves nothing behind", () => {
  // One prepayment of Jan+Feb 2031 (both future for the database clock, which is real time).
  let s: { id: string };
  let p: { paymentId: string; obligationIds: string[] };

  beforeAll(async () => {
    s = await newStudent("db");
    p = await prepay(s.id, [ym(2031, 1), ym(2031, 2)], "2030-12-15T12:00:00");
  });

  const reverseMarkers = async (tx: Tx, paymentId: string) => {
    await tx.duesPayment.update({ where: { id: paymentId }, data: { reversedAt: new Date(), reversedById: a.admin.id, reversalReason: "x" } });
    await tx.duesSettlement.updateMany({ where: { paymentId, reversedAt: null }, data: { reversedAt: new Date(), reversedById: a.admin.id, reversalReason: "x" } });
  };
  const cancelData = (paymentId: string) => ({ cancelledAt: new Date(), cancelledById: a.admin.id, cancellationReason: "x", cancelledByReversalOfPaymentId: paymentId });
  const staffRow = (studentId: string, year: number, month: number, extra: Record<string, unknown> = {}) => ({
    organizationId: a.org.id, studentId, academyId: a.academy.id, type: "MONTHLY" as const, origin: "STAFF" as const, coverageYear: year, coverageMonth: month, monthsCovered: 1,
    amount: "100.00", currency: "USD" as const, lateFeeAmount: "20.00", dueOn: new Date(Date.UTC(year, month - 1, 20)), graceDeadline: new Date(Date.UTC(year, month, 5)),
    planTermsId: terms.id, policyVersionId: policy.id, createdById: a.admin.id, ...extra,
  });

  it("refuses: cancelling while the obligation still has an active settlement (immediate)", async () => {
    const before = await snapshot(s.id);
    await refusedTx("an obligation with an active settlement cannot be cancelled", (tx) => tx.duesObligation.update({ where: { id: p.obligationIds[1] }, data: cancelData(p.paymentId) }));
    expect(await snapshot(s.id)).toEqual(before);
  });

  it("refuses at COMMIT: a cancellation whose coverage is not released — the payment and settlement markers roll back too", async () => {
    const before = await snapshot(s.id);
    await refusedTx("must release all its coverage in the same transaction", async (tx) => {
      await reverseMarkers(tx, p.paymentId);
      await tx.duesObligation.update({ where: { id: p.obligationIds[1] }, data: cancelData(p.paymentId) });
    });
    expect(await snapshot(s.id)).toEqual(before);
  });

  it("refuses at COMMIT: releasing coverage without cancelling its obligation", async () => {
    const before = await snapshot(s.id);
    await refusedTx("coverage may be released only together with its obligation's cancellation", (tx) =>
      tx.duesCoverage.updateMany({ where: { obligationId: p.obligationIds[1] }, data: { releasedAt: new Date() } }),
    );
    expect(await snapshot(s.id)).toEqual(before);
  });

  it("refuses at COMMIT: a cancellation naming a payment that is not reversed", async () => {
    const before = await snapshot(s.id);
    await refusedTx("payment not reversed", async (tx) => {
      await tx.duesSettlement.updateMany({ where: { paymentId: p.paymentId, reversedAt: null }, data: { reversedAt: new Date(), reversedById: a.admin.id, reversalReason: "x" } });
      await tx.duesObligation.update({ where: { id: p.obligationIds[1] }, data: cancelData(p.paymentId) });
      await tx.duesCoverage.updateMany({ where: { obligationId: p.obligationIds[1] }, data: { releasedAt: new Date() } });
    });
    expect(await snapshot(s.id)).toEqual(before);
  });

  it("refuses: a partial marker, a non-PREPAYMENT obligation, any snapshot change, and a row born cancelled or released", async () => {
    const staffId = await monthly(s.id, ym(2030, 12), "2030-12-10T12:00:00");
    const before = await snapshot(s.id);
    await refusedTx("DuesObligation_cancellation_marker_complete", (tx) => tx.duesObligation.update({ where: { id: p.obligationIds[1] }, data: { cancelledAt: new Date() } }));
    await refusedTx("DuesObligation_cancellation_marker_complete", (tx) => tx.duesObligation.update({ where: { id: staffId }, data: cancelData(p.paymentId) }));
    await refusedTx("obligation rows are immutable", (tx) => tx.duesObligation.update({ where: { id: p.obligationIds[1] }, data: { amount: "1.00" } }));
    await refusedTx("coverage rows are never updated", (tx) => tx.duesCoverage.updateMany({ where: { obligationId: p.obligationIds[1] }, data: { month: 12 } }));
    await refusedTx("the cancellation marker cannot be set on insert", (tx) => tx.duesObligation.create({ data: staffRow(s.id, 2032, 6, cancelData(p.paymentId)) }));
    await refusedTx("the release marker cannot be set on insert", (tx) =>
      tx.duesCoverage.create({ data: { organizationId: a.org.id, studentId: s.id, obligationId: staffId, year: 2032, month: 7, releasedAt: new Date() } }),
    );
    expect(await snapshot(s.id)).toEqual(before);
  });

  it("I1 refuses at COMMIT: a PREPAYMENT obligation not settled in the transaction that creates it", async () => {
    const before = await snapshot(s.id);
    await refusedTx("must be settled in the transaction that creates it", (tx) => tx.duesObligation.create({ data: staffRow(s.id, 2032, 8, { origin: "PREPAYMENT" }) }));
    expect(await snapshot(s.id)).toEqual(before);
  });

  it("accepts a complete cancellation; then markers are set once, a cancelled obligation takes no settlement or fee, nothing is deletable, one live per month", async () => {
    await prisma.$transaction(async (tx) => {
      await reverseMarkers(tx as unknown as Tx, p.paymentId);
      for (const id of p.obligationIds) {
        await tx.duesObligation.update({ where: { id }, data: cancelData(p.paymentId) });
        await tx.duesCoverage.updateMany({ where: { obligationId: id }, data: { releasedAt: new Date() } });
      }
    });
    const [jan] = p.obligationIds;
    await refusedTx("only the cancellation marker may be set, once", (tx) => tx.duesObligation.update({ where: { id: jan }, data: { cancellationReason: "changed" } }));
    await refusedTx("only the release marker may be set, once", (tx) => tx.duesCoverage.updateMany({ where: { obligationId: jan }, data: { releasedAt: new Date(0) } }));
    const other = await prisma.duesPayment.create({
      data: { organizationId: a.org.id, studentId: s.id, academyId: a.academy.id, receivedOn: new Date(Date.UTC(2030, 11, 20)), tenderCurrency: "USD", tenderAmount: "100.00", method: "EFECTIVO", recordedById: a.admin.id },
    });
    await refusedTx("a cancelled obligation cannot be settled or charged a fee (DuesSettlement)", (tx) =>
      tx.duesSettlement.create({ data: { organizationId: a.org.id, studentId: s.id, paymentId: other.id, obligationId: jan } }),
    );
    await refusedTx("a cancelled obligation cannot be settled or charged a fee (DuesLateFee)", (tx) =>
      tx.duesLateFee.create({ data: { organizationId: a.org.id, obligationId: jan, assessableFrom: new Date(Date.UTC(2031, 1, 6)) } }),
    );
    await refusedTx("rows are never deleted", (tx) => tx.duesObligation.delete({ where: { id: jan } }));
    await refusedTx("rows are never deleted", (tx) => tx.duesCoverage.deleteMany({ where: { obligationId: jan } }));
    const live = await monthly(s.id, ym(2031, 1), "2031-01-02T12:00:00");
    expect(live).not.toBe(jan);
    await refusedTx("DuesObligation_student_month_monthly_key", (tx) => tx.duesObligation.create({ data: staffRow(s.id, 2031, 1) }));
  });

  it("refuses: cancelling a month that has already started by the DATABASE clock (B3 enforced independently)", async () => {
    const t = await newStudent("dbstarted");
    const local = new Date(Date.now() - 6 * 3600_000); // Costa Rica
    const year = local.getUTCFullYear();
    const month = local.getUTCMonth() + 1;
    // Built directly (valid under I1) so the month is the REAL current month regardless of any app clock.
    const ids = await prisma.$transaction(async (tx) => {
      const o = await tx.duesObligation.create({ data: staffRow(t.id, year, month, { origin: "PREPAYMENT" }) });
      await tx.duesCoverage.create({ data: { organizationId: a.org.id, studentId: t.id, obligationId: o.id, year, month } });
      const pay = await tx.duesPayment.create({
        data: { organizationId: a.org.id, studentId: t.id, academyId: a.academy.id, receivedOn: new Date(Date.UTC(year, month - 1, 1)), tenderCurrency: "USD", tenderAmount: "100.00", method: "EFECTIVO", recordedById: a.admin.id },
      });
      await tx.duesSettlement.create({ data: { organizationId: a.org.id, studentId: t.id, paymentId: pay.id, obligationId: o.id } });
      return { o: o.id, pay: pay.id };
    });
    const before = await snapshot(t.id);
    await refusedTx("a month that has already started cannot be cancelled", async (tx) => {
      await reverseMarkers(tx, ids.pay);
      await tx.duesObligation.update({ where: { id: ids.o }, data: cancelData(ids.pay) });
    });
    expect(await snapshot(t.id)).toEqual(before);
  });
});

// --------------------------------------------------------------------------------------------------------------------------
describe("the writer's rules end to end (R1/R2/R3, Decision A, B2, B4, B6, B7, B9) and repeats", () => {
  let s: { id: string };
  let dec: string;
  let p: { paymentId: string; obligationIds: string[] };

  beforeAll(async () => {
    s = await newStudent("rules");
    dec = await monthly(s.id, ym(2030, 12), "2030-12-10T12:00:00");
    // One payment: December's ordinary charge + prepaid January, February and March 2031.
    p = await prepay(s.id, [ym(2031, 1), ym(2031, 2), ym(2031, 3)], "2030-12-15T12:00:00", [dec]);
  });

  it("B6/B7: a non-owner, an unknown category and a blank reason are refused with nothing written", async () => {
    const before = await snapshot(s.id);
    expect(await reverse(p.paymentId, "2031-01-20T12:00:00", [], {}, { context: context({ organizationRole: "DIRECTOR" }) })).toEqual({ ok: false, error: "notFound" });
    expect(await reverse(p.paymentId, "2031-01-20T12:00:00", [], {}, { reasonCategory: "REFUND" as never })).toEqual({ ok: false, error: "invalid" });
    expect(await reverse(p.paymentId, "2031-01-20T12:00:00", [], {}, { reversalReason: "   " })).toEqual({ ok: false, error: "invalid" });
    expect(await snapshot(s.id)).toEqual(before);
  });

  it("the preview and the writer agree; any other confirmation is changedSinceReview with nothing written", async () => {
    const [jan, feb, mar] = p.obligationIds;
    const preview = await previewPaymentReversal(context(), p.paymentId, at("2031-01-20T12:00:00")());
    expect(preview!.cancel.map((l) => l.obligationId).sort()).toEqual([feb, mar].sort());
    expect(preview!.owedStarted.map((l) => l.obligationId)).toEqual([jan]);
    expect(preview!.owedIndependent.map((l) => l.obligationId)).toEqual([dec]);
    const before = await snapshot(s.id);
    expect(await reverse(p.paymentId, "2031-01-20T12:00:00", [feb])).toEqual({ ok: false, error: "changedSinceReview" });
    expect(await reverse(p.paymentId, "2031-01-20T12:00:00", [jan, feb, mar])).toEqual({ ok: false, error: "changedSinceReview" });
    expect(await reverse(p.paymentId, "2031-01-20T12:00:00", [])).toEqual({ ok: false, error: "changedSinceReview" });
    expect(await snapshot(s.id)).toEqual(before);
  });

  it("a forced failure after every marker is written rolls ALL of them back (no partial financial change)", async () => {
    const [, feb, mar] = p.obligationIds;
    const before = await snapshot(s.id);
    await expect(
      reverse(p.paymentId, "2031-01-20T12:00:00", [feb, mar], { afterReversalMarkersForTest: async () => { throw new Error("forced late failure"); } }),
    ).rejects.toThrow("forced late failure");
    expect(await snapshot(s.id)).toEqual(before);
  });

  it("mixed payment: Dec (independent) and Jan (started) owed again; Feb and Mar cancelled and released, in one transaction", async () => {
    const [jan, feb, mar] = p.obligationIds;
    const r = await reverse(p.paymentId, "2031-01-20T12:00:00", [mar, feb], {}, { reasonCategory: "NOT_RECEIVED", reversalReason: "transfer bounced" });
    expect(r).toMatchObject({ ok: true, paymentId: p.paymentId });
    if (!r.ok) return;
    expect([...r.cancelledObligationIds].sort()).toEqual([feb, mar].sort());
    expect([...r.owedAgainObligationIds].sort()).toEqual([dec, jan].sort());

    const payment = await prisma.duesPayment.findUniqueOrThrow({ where: { id: p.paymentId } });
    expect(payment.reversalReason).toBe("[NOT_RECEIVED] transfer bounced");
    expect(await prisma.duesSettlement.count({ where: { paymentId: p.paymentId, reversedAt: null } })).toBe(0);
    for (const id of [dec, jan]) {
      expect((await prisma.duesObligation.findUniqueOrThrow({ where: { id } })).cancelledAt).toBeNull();
      expect(await prisma.duesCoverage.count({ where: { obligationId: id, releasedAt: null } })).toBe(1);
    }
    for (const id of [feb, mar]) {
      const o = await prisma.duesObligation.findUniqueOrThrow({ where: { id } });
      expect(o.cancelledAt).toEqual(payment.reversedAt);
      expect(o.cancelledById).toBe(a.admin.id);
      expect(o.cancellationReason).toBe("[NOT_RECEIVED] transfer bounced");
      expect(o.cancelledByReversalOfPaymentId).toBe(p.paymentId);
      expect(await prisma.duesCoverage.count({ where: { obligationId: id, releasedAt: null } })).toBe(0);
    }
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { entityId: p.paymentId, action: "duesPayment.reverse" } });
    expect([...(audit.after as { cancelledObligationIds: string[] }).cancelledObligationIds].sort()).toEqual([feb, mar].sort());
  });

  it("again: alreadyReversed, nothing written", async () => {
    const before = await snapshot(s.id);
    expect(await reverse(p.paymentId, "2031-01-21T12:00:00")).toEqual({ ok: false, error: "alreadyReversed" });
    expect(await snapshot(s.id)).toEqual(before);
  });

  it("a cancelled charge is not debt (naming it is notFound); Dec+Jan are paid oldest-first and Dec's late fee follows the ordinary rule (B4)", async () => {
    const [jan, feb] = p.obligationIds;
    const named = await recordDuesPayment(
      { context: context(), studentId: s.id, receivedOn: day("2031-01-22"), tender: { currency: "USD", amount: "100.00" }, method: "EFECTIVO", obligationIds: [feb], maxBackdateDays: 90 },
      deps("2031-01-22T12:00:00"),
    );
    expect(named).toEqual({ ok: false, error: "notFound" });
    // December: due Dec 20, grace Jan 5 → paid Jan 22 is late, so its fee is owed with it (ordinary rule, B4).
    const paid = await recordDuesPayment(
      { context: context(), studentId: s.id, receivedOn: day("2031-01-22"), tender: { currency: "USD", amount: "220.00" }, method: "EFECTIVO", obligationIds: [dec, jan], maxBackdateDays: 90 },
      deps("2031-01-22T12:00:00"),
    );
    expect(paid).toMatchObject({ ok: true });
    expect(await prisma.duesLateFee.count({ where: { obligationId: dec } })).toBe(1);
    expect(await prisma.duesLateFee.count({ where: { obligationId: jan } })).toBe(0);
  });

  it("repeats: prepay the cancelled month again, reverse again → two cancelled February obligations, none live", async () => {
    const again = await prepay(s.id, [ym(2031, 2)], "2031-01-23T12:00:00");
    const r = await reverse(again.paymentId, "2031-01-24T12:00:00", again.obligationIds);
    expect(r).toMatchObject({ ok: true, cancelledObligationIds: again.obligationIds });
    expect(await prisma.duesObligation.count({ where: { studentId: s.id, coverageYear: 2031, coverageMonth: 2, cancelledAt: { not: null } } })).toBe(2);
    expect(await prisma.duesObligation.count({ where: { studentId: s.id, coverageYear: 2031, coverageMonth: 2, cancelledAt: null } })).toBe(0);
  });

  it("B2: cancelled months are billed normally when they open — by the writer and by the monthly job itself", async () => {
    const febNew = await createMonthlyObligation({ context: context(), studentId: s.id, coverage: ym(2031, 2), planTermsId: terms.id, policyVersionId: policy.id }, deps("2031-02-02T12:00:00"));
    expect(febNew).toMatchObject({ ok: true, created: true });
    const marJob = await generateMonthlyObligationForStudent(jobContext(), s.id, ym(2031, 3), { activation: ACTIVE, now: at("2031-03-02T12:00:00") });
    expect(marJob).toMatchObject({ category: "created" });
    expect(await prisma.duesObligation.count({ where: { studentId: s.id, coverageYear: 2031, coverageMonth: 3, cancelledAt: null, origin: "SCHEDULED_JOB" } })).toBe(1);
  });

  it("B9: a payment from a branch the student has since left is refused (notFound) and flagged in the list", async () => {
    const t = await newStudent("moved");
    const q = await prepay(t.id, [ym(2031, 1)], "2030-12-15T12:00:00");
    await prisma.student.update({ where: { id: t.id }, data: { homeAcademyId: tzAcademy.id } });
    const before = await snapshot(t.id);
    expect(await reverse(q.paymentId, "2030-12-20T12:00:00", q.obligationIds)).toEqual({ ok: false, error: "notFound" });
    expect(await snapshot(t.id)).toEqual(before);
    const list = await listReversiblePayments(context(), t.id);
    expect(list.rows.find((row) => row.id === q.paymentId)!.restrictions.branchMoved).toBe(true);
  });

  it("clock skew: the app says the month is future but the database says it started → changedSinceReview, nothing written", async () => {
    const t = await newStudent("skew");
    const local = new Date(Date.now() - 6 * 3600_000); // Costa Rica now
    const real = ym(local.getUTCFullYear(), local.getUTCMonth() + 1);
    const prev = real.month === 1 ? ym(real.year - 1, 12) : ym(real.year, real.month - 1);
    const appNow = `${prev.year}-${String(prev.month).padStart(2, "0")}-15T12:00:00`;
    const q = await prepay(t.id, [real], appNow); // future for an app clock one month behind
    const before = await snapshot(t.id);
    expect(await reverse(q.paymentId, appNow, q.obligationIds)).toEqual({ ok: false, error: "changedSinceReview" });
    expect(await snapshot(t.id)).toEqual(before);
  });
});

// --------------------------------------------------------------------------------------------------------------------------
describe("races (genuine overlap via pg_blocking_pids; final state asserted for each ordering)", () => {
  /** A fresh student with one payment prepaying Jan+Feb 2031, recorded 2030-12-15. */
  async function prepaid(label: string, academyId = a.academy.id) {
    const s = await newStudent(label, academyId);
    const p = await prepay(s.id, [ym(2031, 1), ym(2031, 2)], "2030-12-15T12:00:00");
    return { s, p };
  }

  /** Starts a reversal that pauses right after its locks; returns its pid and result. */
  function heldReversal(paymentId: string, now: string, expected: string[]) {
    const h = hold();
    const result = reverse(paymentId, now, expected, { afterReversalLocksForTest: h.pause });
    return { ...h, result };
  }

  it("reversal vs the same reversal: exactly one succeeds, the other is alreadyReversed", async () => {
    const { s, p } = await prepaid("r-r");
    const first = heldReversal(p.paymentId, "2030-12-20T12:00:00", p.obligationIds);
    const holder = await first.pid;
    const second = reverse(p.paymentId, "2030-12-20T12:00:00", p.obligationIds);
    await waitUntilBlockedBy(holder);
    first.release();
    expect(await first.result).toMatchObject({ ok: true });
    expect(await second).toEqual({ ok: false, error: "alreadyReversed" });
    expect(await prisma.duesObligation.count({ where: { studentId: s.id, cancelledAt: { not: null } } })).toBe(2);
  });

  it("reversal vs an ordinary payment naming a charge being cancelled: the payment waits, then refuses; no settlement on a cancelled charge", async () => {
    const { s, p } = await prepaid("r-pay");
    const [, feb] = p.obligationIds;
    const rev = heldReversal(p.paymentId, "2030-12-20T12:00:00", p.obligationIds);
    const holder = await rev.pid;
    const pay = recordDuesPayment(
      { context: context(), studentId: s.id, receivedOn: day("2030-12-20"), tender: { currency: "USD", amount: "100.00" }, method: "EFECTIVO", obligationIds: [feb], maxBackdateDays: 90 },
      deps("2030-12-20T12:00:00"),
    );
    await waitUntilBlockedBy(holder);
    rev.release();
    expect(await rev.result).toMatchObject({ ok: true });
    expect(await pay).toEqual({ ok: false, error: "notFound" });
    expect(await prisma.duesSettlement.count({ where: { obligationId: feb, reversedAt: null } })).toBe(0);
  });

  it("reversal first vs the monthly job across midnight: Feb is cancelled at 23:30, then the job bills Feb normally at 00:30", async () => {
    const { s, p } = await prepaid("r-gen1");
    const [jan, feb] = p.obligationIds;
    const rev = heldReversal(p.paymentId, "2031-01-31T23:30:00", [feb]);
    const holder = await rev.pid;
    const job = generateMonthlyObligationForStudent(jobContext(), s.id, ym(2031, 2), { activation: ACTIVE, now: at("2031-02-01T00:30:00") });
    await waitUntilBlockedBy(holder);
    rev.release();
    expect(await rev.result).toMatchObject({ ok: true, cancelledObligationIds: [feb], owedAgainObligationIds: [jan] });
    expect(await job).toMatchObject({ category: "created" });
    expect(await prisma.duesObligation.count({ where: { studentId: s.id, coverageYear: 2031, coverageMonth: 2, cancelledAt: null } })).toBe(1);
  });

  it("monthly job first across midnight: the job sees Feb covered; the reversal waits, then treats Feb as started (owed, never cancelled)", async () => {
    const { s, p } = await prepaid("r-gen2");
    const [jan, feb] = p.obligationIds;
    const h = hold();
    const job = generateMonthlyObligationForStudent(jobContext(), s.id, ym(2031, 2), { activation: ACTIVE, now: at("2031-02-01T00:30:00") }, { beforeRecordForTest: h.pause });
    const holder = await h.pid;
    const rev = reverse(p.paymentId, "2031-02-01T00:40:00", []);
    await waitUntilBlockedBy(holder);
    h.release();
    expect(await job).toMatchObject({ category: "alreadyCovered", obligationId: feb });
    const r = await rev;
    expect(r).toMatchObject({ ok: true, cancelledObligationIds: [] });
    if (r.ok) expect([...r.owedAgainObligationIds].sort()).toEqual([jan, feb].sort());
    expect(await prisma.duesObligation.count({ where: { studentId: s.id, cancelledAt: { not: null } } })).toBe(0);
  });

  it("reversal first vs prepaying the same month: the prepayment waits, then succeeds on the freed month", async () => {
    const { s, p } = await prepaid("r-pre1");
    const rev = heldReversal(p.paymentId, "2030-12-20T12:00:00", p.obligationIds);
    const holder = await rev.pid;
    const again = prepayMonthlyObligations(
      { context: context(), studentId: s.id, requestedMonths: [ym(2031, 1)], receivedOn: day("2030-12-20"), tender: { currency: "USD", amount: "100.00" }, method: "EFECTIVO", maxBackdateDays: 90 },
      deps("2030-12-20T12:00:00"),
    );
    await waitUntilBlockedBy(holder);
    rev.release();
    expect(await rev.result).toMatchObject({ ok: true });
    expect(await again).toMatchObject({ ok: true });
    expect(await prisma.duesObligation.count({ where: { studentId: s.id, coverageYear: 2031, coverageMonth: 1, cancelledAt: null } })).toBe(1);
  });

  it("prepaying first: the prepayment of an already covered month refuses cleanly; the reversal waits, then succeeds", async () => {
    const { s, p } = await prepaid("r-pre2");
    const g = gateOnly();
    const again = prepayMonthlyObligations(
      { context: context(), studentId: s.id, requestedMonths: [ym(2031, 1)], receivedOn: day("2030-12-20"), tender: { currency: "USD", amount: "100.00" }, method: "EFECTIVO", maxBackdateDays: 90 },
      deps("2030-12-20T12:00:00", { afterPrepaymentInstantCapturedForTest: g.pause }),
    );
    await g.reached;
    const rev = reverse(p.paymentId, "2030-12-20T12:00:00", p.obligationIds);
    await waitUntilAnyBlocked();
    g.release();
    expect((await again).ok).toBe(false);
    expect(await rev).toMatchObject({ ok: true });
    expect(await prisma.duesObligation.count({ where: { studentId: s.id, coverageYear: 2031, coverageMonth: 1 } })).toBe(1);
  });

  it("reversal vs a late-fee waiver for the same student (both orderings): both succeed, serialized", async () => {
    for (const order of ["reversalFirst", "waiverFirst"] as const) {
      // P prepays Jan+Feb (no older debt yet, so oldest-first allows it); December's ordinary charge is created afterwards and
      // becomes late (grace Jan 5), giving the same student an unpaid fee to waive while P is reversed on Jan 10:
      // January has started (owed again), February is cancelled.
      const s = await newStudent(`r-waive-${order}`);
      const p = await prepay(s.id, [ym(2031, 1), ym(2031, 2)], "2030-12-15T12:00:00");
      const [, feb] = p.obligationIds;
      const dec = await monthly(s.id, ym(2030, 12), "2030-12-16T12:00:00");
      await assessLateFeesForStudent(context(), s.id, deps("2031-01-10T12:00:00"));
      const fee = await prisma.duesLateFee.findFirstOrThrow({ where: { obligationId: dec } });
      const waive = (extra: Record<string, unknown> = {}) =>
        waiveLateFee({ context: context(), lateFeeId: fee.id, expectedRevision: versionRevision({ removedAt: null, removalKind: null }), removalReason: "o4 race" }, deps("2031-01-10T12:00:00", extra));
      if (order === "reversalFirst") {
        const rev = heldReversal(p.paymentId, "2031-01-10T12:00:00", [feb]);
        const holder = await rev.pid;
        const w = waive();
        await waitUntilBlockedBy(holder);
        rev.release();
        expect(await rev.result).toMatchObject({ ok: true });
        expect(await w).toMatchObject({ ok: true });
      } else {
        const g = gateOnly();
        const w = waive({ afterWaiveMarkersForTest: g.pause });
        await g.reached;
        const rev = reverse(p.paymentId, "2031-01-10T12:00:00", [feb]);
        await waitUntilAnyBlocked();
        g.release();
        expect(await w).toMatchObject({ ok: true });
        expect(await rev).toMatchObject({ ok: true });
      }
      expect((await prisma.duesLateFee.findUniqueOrThrow({ where: { id: fee.id } })).removalKind).toBe("WAIVED");
      expect(await prisma.duesObligation.count({ where: { studentId: s.id, cancelledAt: { not: null } } })).toBe(1);
    }
  });

  it("reversal vs resolving a captured prepayment receipt for the next month (both orderings): both succeed, serialized", async () => {
    for (const [i, order] of (["reversalFirst", "resolutionFirst"] as const).entries()) {
      const s = await newStudent(`r-receipt-${order}`);
      const p = await prepay(s.id, [ym(2031, 1)], "2030-12-15T12:00:00");
      // Descending dates: a quote dated at or before a receipt is eligible for it, so each iteration's rate must be dated
      // AFTER every later iteration's capture date, or the later capture would find a rate and not capture at all.
      const receivedIso = `2030-12-${18 - 2 * i}`;
      const captured = await prepayMonthlyObligations(
        { context: context(), studentId: s.id, requestedMonths: [ym(2031, 2)], receivedOn: day(receivedIso), tender: { currency: "CRC", amount: "50000.00" }, method: "EFECTIVO", maxBackdateDays: 90 },
        deps(`${receivedIso}T12:00:00`),
      );
      expect(captured).toMatchObject({ ok: false, error: "captured" });
      if (captured.ok || captured.error !== "captured") return;
      const rate = await enterExchangeRateQuote({ context: context(), quoteDate: day(receivedIso), value: "500.00", expectedCurrentRevision: 0 }, { activation: ACTIVE });
      expect(rate).toMatchObject({ ok: true });
      const resolve = (extra: Record<string, unknown> = {}) => resolveAwaitingRateReceipt({ context: context(), receiptId: captured.receiptId! }, deps("2030-12-20T12:00:00", extra));
      if (order === "reversalFirst") {
        const rev = heldReversal(p.paymentId, "2030-12-20T12:00:00", p.obligationIds);
        const holder = await rev.pid;
        const res = resolve();
        await waitUntilBlockedBy(holder);
        rev.release();
        expect(await rev.result).toMatchObject({ ok: true, cancelledObligationIds: p.obligationIds });
        expect(await res).toMatchObject({ ok: true });
      } else {
        const h = hold();
        const res = resolve({ afterResolveStudentLockForTest: h.pause });
        const holder = await h.pid;
        const rev = reverse(p.paymentId, "2030-12-20T12:00:00", p.obligationIds);
        await waitUntilBlockedBy(holder);
        h.release();
        expect(await res).toMatchObject({ ok: true });
        expect(await rev).toMatchObject({ ok: true, cancelledObligationIds: p.obligationIds });
      }
      expect(await prisma.duesObligation.count({ where: { studentId: s.id, coverageYear: 2031, coverageMonth: 2, cancelledAt: null } })).toBe(1);
      expect(await prisma.duesObligation.count({ where: { studentId: s.id, coverageYear: 2031, coverageMonth: 1, cancelledAt: { not: null } } })).toBe(1);
    }
  });

  it("reversal vs a branch timezone save (both orderings): the decision always uses one committed timezone", async () => {
    // 2030-12-31 23:00 in Costa Rica is already January 1 in Kiritimati (UTC+14).
    const NOW = "2030-12-31T23:00:00";
    const setTz = (tz: string) => prisma.academy.update({ where: { id: tzAcademy.id }, data: { timezone: tz } });
    try {
      // Reversal first: decided in Costa Rica time (January still future) → January and February cancelled; the save waits.
      const one = await prepaid("r-tz1", tzAcademy.id);
      const rev = heldReversal(one.p.paymentId, NOW, one.p.obligationIds);
      const holder = await rev.pid;
      const save = prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "Academy" WHERE "id" = ${tzAcademy.id} FOR UPDATE`;
        await tx.academy.update({ where: { id: tzAcademy.id }, data: { timezone: "Pacific/Kiritimati" } });
      });
      await waitUntilBlockedBy(holder);
      rev.release();
      expect(await rev.result).toMatchObject({ ok: true, cancelledObligationIds: one.p.obligationIds });
      await save;
      await setTz("America/Costa_Rica");

      // Save first: the reversal waits for the committed Kiritimati timezone, in which January has started — the owner's
      // confirmation (Jan+Feb) no longer matches → changedSinceReview, nothing written.
      const two = await prepaid("r-tz2", tzAcademy.id);
      const before = await snapshot(two.s.id);
      const h = hold();
      const save2 = prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "Academy" WHERE "id" = ${tzAcademy.id} FOR UPDATE`;
        await tx.academy.update({ where: { id: tzAcademy.id }, data: { timezone: "Pacific/Kiritimati" } });
        await h.pause(tx as unknown as Tx);
      });
      const holder2 = await h.pid;
      const rev2 = reverse(two.p.paymentId, NOW, two.p.obligationIds);
      await waitUntilBlockedBy(holder2);
      h.release();
      await save2;
      expect(await rev2).toEqual({ ok: false, error: "changedSinceReview" });
      expect(await snapshot(two.s.id)).toEqual(before);
    } finally {
      await setTz("America/Costa_Rica");
    }
  });
});
