import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getTestPrismaClient } from "../helpers/test-db";
import { Prisma } from "../../src/generated/prisma/client";
import { makeAccountingOrg } from "../helpers/accounting-org";
import { hashSecret } from "../../src/lib/crypto";
import type { TenantContext } from "../../src/lib/tenant/types";
import { createMonthlyObligation } from "../../src/lib/dues/ledger/create-monthly-obligation";
import { recordDuesPaymentWithSubmissionIdentity } from "../../src/lib/dues/ledger/submission-identity";
import { enterExchangeRateQuote } from "../../src/lib/dues/ledger/exchange-rate";
import { resolveAwaitingRateReceipt, cancelAwaitingRateReceipt } from "../../src/lib/dues/ledger/awaiting-rate-receipt";
import { reversePayment } from "../../src/lib/dues/ledger/reverse-payment";
import { recordDuesPayment } from "../../src/lib/dues/ledger/record-payment";
import type { LedgerActivation } from "../../src/lib/dues/ledger/activation";
import type { Tx } from "../../src/lib/dues/ledger/common";

// getSubmissionOutcome calls resolveActionContext -> auth(), mocked exactly as submission-identity.test.ts does.
let currentSession: { user: { id: string; role: string } } | null = null;
vi.mock("@/auth", () => ({ auth: () => Promise.resolve(currentSession), signIn: vi.fn() }));
const { purchasePackageWithSubmissionIdentity, prepayMonthlyObligationsWithSubmissionIdentity } = await import(
  "../../src/lib/dues/ledger/purchase-submission-identity"
);
const { getSubmissionOutcome } = await import("../../src/lib/dues/ledger/submission-identity");

/**
 * Purchase-submission-identity prerequisite, proved against the REAL test database. Does not re-prove
 * `purchasePackage`/`prepayMonthlyObligations`'s own settlement logic (already proved in purchase-package.test.ts /
 * prepay-monthly.test.ts), or the DB-enforced guarantees / authorization-outcome shapes already proved generically in
 * submission-identity.test.ts (CHECK, trigger, FK, three-way auth split) — this file proves only what is NEW for this
 * prerequisite: genuine concurrency and payload-mismatch for each new writer, operation-discriminated canonical
 * payloads (including legacy-row and cross-writer compatibility), getSubmissionOutcome's operation gate, and real
 * transaction atomicity composed around `purchasePackageInTx`/`prepayMonthlyObligationsInTx`.
 */
const prisma = getTestPrismaClient();
type Fixture = Awaited<ReturnType<typeof makeAccountingOrg>>;

const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
const ACTIVE: LedgerActivation = { isActive: async () => true };
const at = (isoLocal: string) => () => new Date(`${isoLocal}-06:00`); // Costa Rica, UTC-6 all year
const deps = (extra: Record<string, unknown> = {}) => ({ activation: ACTIVE, ...extra });

let a: Fixture;
let b: Fixture;
let director: { id: string }; // DIRECTOR of org A, scoped to a.academy.id (the SAME branch every test student lives in)
let monthlyPlanId: string;
let monthlyTerms: { id: string };
let policyBase: { id: string };
let packageTerms: { id: string };
/** A second, genuinely different PACKAGE terms row (own plan, own id) — used only as a well-formed ALTERNATE
 * `planTermsId` value in the payload-mismatch field table; the losing side of an identity race never actually
 * resolves it for real, so it need not itself be a currently-valid purchase, only well-formed. */
let packageTerms2: { id: string };
let packageTermsB: { id: string };

function context(over: Partial<TenantContext> = {}): TenantContext {
  return { kind: "tenant", actorUserId: a.admin.id, organizationId: a.org.id, organizationRole: "ADMIN", academyIds: "ALL", selfStudentId: null, linkedStudentId: null, ...over };
}
function contextB(over: Partial<TenantContext> = {}): TenantContext {
  return { kind: "tenant", actorUserId: b.admin.id, organizationId: b.org.id, organizationRole: "ADMIN", academyIds: "ALL", selfStudentId: null, linkedStudentId: null, ...over };
}

let studentCounter = 0;
async function newStudent(fx: Fixture, label: string) {
  const n = ++studentCounter;
  return prisma.student.create({
    data: {
      organizationId: fx.org.id, homeAcademyId: fx.academy.id, firstName: "PurchaseSub", lastName: `${label}${n}`, phone: "00000000",
      email: `psub-${label}-${n}-${suffix}@example.com`, currentRankId: await fx.rankId("WHITE"), codeHash: `psub-${label}-${n}-${suffix}`, status: "ACTIVE",
    },
  });
}

// Descending from a range disjoint from every other suite's own date range (submission-identity.test.ts: 2090 down;
// awaiting-rate-receipt.test.ts: 2099 down; dues-currency-settlement.test.ts: 2030 fixed) — avoids cross-suite
// exchange-rate leakage via resolveEffectiveQuote's own "latest before" fallback rule.
let yearCounter = 2075;
function freshDate(day = 5, month = 7): { year: number; month: number; day: number } {
  return { year: yearCounter--, month, day };
}
const nowAt = (d: { year: number; month: number; day: number }) => at(`${d.year}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}T12:00:00`);
const nextMonth = (d: { year: number; month: number }) => (d.month === 12 ? { year: d.year + 1, month: 1 } : { year: d.year, month: d.month + 1 });

let submissionCounter = 0;
function freshSubmissionId(label: string): string {
  return `psub-${label}-${suffix}-${++submissionCounter}`;
}

const packageArgs = (studentId: string, d: { year: number; month: number; day: number }, submissionId: string, over: Record<string, unknown> = {}) => ({
  context: context(), studentId, planTermsId: packageTerms.id, requestedStartMonth: { year: d.year, month: d.month },
  receivedOn: d, tender: { currency: "USD" as const, amount: "270.00" }, method: "EFECTIVO" as const, maxBackdateDays: 5, submissionId, ...over,
});
const prepayArgs = (studentId: string, d: { year: number; month: number; day: number }, submissionId: string, over: Record<string, unknown> = {}) => ({
  context: context(), studentId, requestedMonths: [nextMonth(d)], receivedOn: d, tender: { currency: "USD" as const, amount: "100.00" }, method: "EFECTIVO" as const, maxBackdateDays: 5, submissionId, ...over,
});

async function waitUntil(predicate: () => Promise<boolean>, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}
async function findBlockedOnInsert(timeoutMs = 5000): Promise<number | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = await prisma.$queryRawUnsafe<{ pid: number }[]>(
      `SELECT pid FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE '%INSERT INTO "DuesPaymentAttempt"%'`,
    );
    if (rows.length > 0) return rows[0].pid;
    await new Promise((r) => setTimeout(r, 25));
  }
  return null;
}
async function isBlockedBy(waiterPid: number, holderPid: number): Promise<boolean> {
  const rows = await prisma.$queryRaw<{ blocked: boolean }[]>`SELECT ${holderPid} = ANY(pg_blocking_pids(${waiterPid})) AS blocked`;
  return rows[0].blocked;
}

class Rollback extends Error {}
type Db = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];
async function isolated(fn: (tx: Db) => Promise<void>) {
  try {
    await prisma.$transaction(async (tx) => {
      await fn(tx);
      throw new Rollback();
    });
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
  }
}
function dbMessage(error: unknown): string {
  const cause = (error as { meta?: { driverAdapterError?: { cause?: { originalMessage?: string; message?: string } } } } | undefined)?.meta?.driverAdapterError?.cause;
  return [cause?.originalMessage, cause?.message].filter(Boolean).join(" | ");
}
async function refused(tx: Db, op: () => Promise<unknown>, hint: string) {
  await tx.$executeRawUnsafe("SAVEPOINT refusal_probe");
  let error: unknown;
  try {
    await op();
  } catch (e) {
    error = e;
  }
  await tx.$executeRawUnsafe("ROLLBACK TO SAVEPOINT refusal_probe");
  expect(error, `the database must refuse this write (expected: ${hint})`).toBeDefined();
  expect(dbMessage(error), `the refusal must come from the expected database object (${hint})`).toContain(hint);
}

/** One MONTHLY obligation due before `d`, for combined-debt tests. */
async function oneMonth(studentId: string, d: { year: number; month: number; day: number }): Promise<string> {
  const coverage = d.month === 1 ? { year: d.year - 1, month: 12 } : { year: d.year, month: d.month - 1 };
  const r = await createMonthlyObligation({ context: context(), studentId, coverage, planTermsId: monthlyTerms.id, policyVersionId: policyBase.id }, deps({ now: nowAt(d) }));
  if (!r.ok) throw new Error(`fixture obligation failed: ${r.error}`);
  return r.obligationId;
}

beforeAll(async () => {
  a = await makeAccountingOrg("CUMULATIVE", "psub-a");
  b = await makeAccountingOrg("CUMULATIVE", "psub-b");

  const directorUser = await prisma.user.create({ data: { email: `psub-director-${suffix}@example.com`, passwordHash: await hashSecret("irrelevant-password-123"), role: "DIRECTOR" } });
  await prisma.organizationMembership.create({ data: { userId: directorUser.id, organizationId: a.org.id, role: "DIRECTOR" } });
  await prisma.staffAssignment.create({ data: { userId: directorUser.id, organizationId: a.org.id, academyId: a.academy.id, role: "DIRECTOR" } });
  director = directorUser;

  const monthlyPlan = await prisma.paymentPlan.create({ data: { organizationId: a.org.id, academyId: a.academy.id, name: `PSub monthly plan ${suffix}` } });
  monthlyPlanId = monthlyPlan.id;
  monthlyTerms = await prisma.paymentPlanTerms.create({
    data: { organizationId: a.org.id, planId: monthlyPlan.id, effectiveYear: 2000, effectiveMonth: 1, priceAmount: "100.00", currency: "USD", monthsCovered: 1, createdById: a.admin.id },
  });
  policyBase = await prisma.duesPolicyVersion.create({
    data: { organizationId: a.org.id, academyId: a.academy.id, effectiveYear: 2000, effectiveMonth: 1, dueDay: 20, graceDay: 5, lateFeeAmount: "20.00", lateFeeCurrency: "USD", maxPrepaidMonths: 600, createdById: a.admin.id },
  });
  const packagePlan = await prisma.paymentPlan.create({ data: { organizationId: a.org.id, academyId: a.academy.id, name: `PSub package plan ${suffix}` } });
  packageTerms = await prisma.paymentPlanTerms.create({
    data: { organizationId: a.org.id, planId: packagePlan.id, effectiveYear: 2000, effectiveMonth: 1, priceAmount: "270.00", currency: "USD", monthsCovered: 3, createdById: a.admin.id },
  });
  const packagePlan2 = await prisma.paymentPlan.create({ data: { organizationId: a.org.id, academyId: a.academy.id, name: `PSub package plan 2 ${suffix}` } });
  packageTerms2 = await prisma.paymentPlanTerms.create({
    data: { organizationId: a.org.id, planId: packagePlan2.id, effectiveYear: 2000, effectiveMonth: 1, priceAmount: "300.00", currency: "USD", monthsCovered: 3, createdById: a.admin.id },
  });

  // Org B needs its own policy version (validatePackageSpanInTx reads maxPrepaidMonths from it) for the
  // tenant-isolation test's package purchase to succeed — no monthly/debt fixtures needed on org B otherwise.
  await prisma.duesPolicyVersion.create({
    data: { organizationId: b.org.id, academyId: b.academy.id, effectiveYear: 2000, effectiveMonth: 1, dueDay: 20, graceDay: 5, lateFeeAmount: "20.00", lateFeeCurrency: "USD", maxPrepaidMonths: 600, createdById: b.admin.id },
  });
  const packagePlanB = await prisma.paymentPlan.create({ data: { organizationId: b.org.id, academyId: b.academy.id, name: `PSub package plan B ${suffix}` } });
  packageTermsB = await prisma.paymentPlanTerms.create({
    data: { organizationId: b.org.id, planId: packagePlanB.id, effectiveYear: 2000, effectiveMonth: 1, priceAmount: "270.00", currency: "USD", monthsCovered: 3, createdById: b.admin.id },
  });
}, 60_000);

/** Assigns a student to the shared monthly plan — prepayment resolves pricing/terms via this assignment. */
async function assign(studentId: string) {
  return prisma.studentPlanAssignment.create({ data: { organizationId: a.org.id, studentId, planId: monthlyPlanId, effectiveYear: 2000, effectiveMonth: 1, createdById: a.admin.id } });
}

afterAll(async () => {
  for (const fx of [a, b]) {
    if (!fx) continue;
    await prisma.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe("SET LOCAL session_replication_role = replica");
        for (const table of ["DuesPaymentAttempt", "DuesSettlement", "DuesPayment", "DuesLateFee", "DuesCoverage", "DuesObligation", "StudentPlanAssignment", "ExchangeRateQuote", "AwaitingRateReceipt"]) {
          await tx.$executeRawUnsafe(`DELETE FROM "${table}" WHERE "organizationId" = $1`, fx.org.id);
        }
      },
      { timeout: 60_000 },
    );
    await prisma.auditLog.deleteMany({ where: { organizationId: fx.org.id } });
    await prisma.paymentPlanTerms.deleteMany({ where: { organizationId: fx.org.id } });
    await prisma.duesPolicyVersion.deleteMany({ where: { organizationId: fx.org.id } });
    await prisma.paymentPlan.deleteMany({ where: { organizationId: fx.org.id } });
  }
  if (director) {
    await prisma.staffAssignment.deleteMany({ where: { userId: director.id } });
    await prisma.organizationMembership.deleteMany({ where: { userId: director.id } });
    await prisma.user.deleteMany({ where: { id: director.id } });
  }
  await a?.drop();
  await b?.drop();
}, 120_000);

describe("package purchase: concurrency", () => {
  it("(P1) winner-commit: the second INSERT genuinely blocks on the first's uncommitted row, then replays", async () => {
    const d = freshDate();
    const s = await newStudent(a, "pconc1");
    const submissionId = freshSubmissionId("pconc1");
    const args = () => packageArgs(s.id, d, submissionId);

    let pid1: number | undefined;
    let release1!: () => void;
    const gate1 = new Promise<void>((resolve) => { release1 = resolve; });
    const r1Promise = purchasePackageWithSubmissionIdentity(
      args(),
      deps({ now: nowAt(d), afterSubmissionIdentityInsertForTest: async (tx: Tx) => { pid1 = (await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`)[0].pid; await gate1; } }),
    );
    let r2Promise: ReturnType<typeof purchasePackageWithSubmissionIdentity> | undefined;
    try {
      expect(await waitUntil(async () => pid1 !== undefined)).toBe(true);
      r2Promise = purchasePackageWithSubmissionIdentity(args(), deps({ now: nowAt(d) }));
      const waiterPid = await findBlockedOnInsert();
      expect(waiterPid).not.toBeNull();
      expect(await isBlockedBy(waiterPid!, pid1!)).toBe(true);
    } finally {
      release1();
      await Promise.allSettled([r1Promise, r2Promise]);
    }

    const r1 = await r1Promise;
    if (!r1.ok) throw new Error(`fixture: expected success, got ${JSON.stringify(r1)}`);
    const r2 = await r2Promise!;
    expect(r2).toEqual({ ok: true, paymentId: r1.paymentId, replay: true, currentlyReversed: false });
    expect(await prisma.duesPaymentAttempt.count({ where: { organizationId: a.org.id, submissionId } })).toBe(1);
  });

  it("(P2) winner-rollback: the first genuinely refuses (coverageGap) and rolls back; the second, blocked, then wins fresh with the corrected month", async () => {
    const d = freshDate();
    const s = await newStudent(a, "pconc2");
    const submissionId = freshSubmissionId("pconc2");
    const invalidArgs = packageArgs(s.id, d, submissionId, { requestedStartMonth: nextMonth(d) }); // skips the true first-uncovered month (d's own)
    const validArgs = packageArgs(s.id, d, submissionId);

    let pid1: number | undefined;
    let release1!: () => void;
    const gate1 = new Promise<void>((resolve) => { release1 = resolve; });
    const r1Promise = purchasePackageWithSubmissionIdentity(
      invalidArgs,
      deps({ now: nowAt(d), afterSubmissionIdentityInsertForTest: async (tx: Tx) => { pid1 = (await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`)[0].pid; await gate1; } }),
    );
    let r2Promise: ReturnType<typeof purchasePackageWithSubmissionIdentity> | undefined;
    try {
      expect(await waitUntil(async () => pid1 !== undefined)).toBe(true);
      r2Promise = purchasePackageWithSubmissionIdentity(validArgs, deps({ now: nowAt(d) }));
      const waiterPid = await findBlockedOnInsert();
      expect(waiterPid).not.toBeNull();
      expect(await isBlockedBy(waiterPid!, pid1!)).toBe(true);
    } finally {
      release1();
      await Promise.allSettled([r1Promise, r2Promise]);
    }

    const r1 = await r1Promise;
    expect(r1).toMatchObject({ ok: false, error: "coverageGap" });
    const r2 = await r2Promise!;
    if (!r2.ok) throw new Error(`fixture: expected the corrected attempt to succeed, got ${JSON.stringify(r2)}`);
    const attempts = await prisma.duesPaymentAttempt.findMany({ where: { organizationId: a.org.id, submissionId } });
    expect(attempts).toHaveLength(1);
    expect(attempts[0].paymentId).toBe(r2.paymentId);
  });
});

describe("prepayment: concurrency", () => {
  it("(Q1) winner-commit: the second INSERT genuinely blocks on the first's uncommitted row, then replays", async () => {
    const d = freshDate();
    const s = await newStudent(a, "qconc1");
    await assign(s.id);
    const submissionId = freshSubmissionId("qconc1");
    const args = () => prepayArgs(s.id, d, submissionId);

    let pid1: number | undefined;
    let release1!: () => void;
    const gate1 = new Promise<void>((resolve) => { release1 = resolve; });
    const r1Promise = prepayMonthlyObligationsWithSubmissionIdentity(
      args(),
      deps({ now: nowAt(d), afterSubmissionIdentityInsertForTest: async (tx: Tx) => { pid1 = (await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`)[0].pid; await gate1; } }),
    );
    let r2Promise: ReturnType<typeof prepayMonthlyObligationsWithSubmissionIdentity> | undefined;
    try {
      expect(await waitUntil(async () => pid1 !== undefined)).toBe(true);
      r2Promise = prepayMonthlyObligationsWithSubmissionIdentity(args(), deps({ now: nowAt(d) }));
      const waiterPid = await findBlockedOnInsert();
      expect(waiterPid).not.toBeNull();
      expect(await isBlockedBy(waiterPid!, pid1!)).toBe(true);
    } finally {
      release1();
      await Promise.allSettled([r1Promise, r2Promise]);
    }

    const r1 = await r1Promise;
    if (!r1.ok) throw new Error(`fixture: expected success, got ${JSON.stringify(r1)}`);
    const r2 = await r2Promise!;
    expect(r2).toEqual({ ok: true, paymentId: r1.paymentId, replay: true, currentlyReversed: false });
    expect(await prisma.duesPaymentAttempt.count({ where: { organizationId: a.org.id, submissionId } })).toBe(1);
  });

  it("(Q2) winner-rollback: the first genuinely refuses (coverageGap) and rolls back; the second, blocked, then wins fresh with the corrected month", async () => {
    const d = freshDate();
    const s = await newStudent(a, "qconc2");
    await assign(s.id);
    const submissionId = freshSubmissionId("qconc2");
    const skipped = nextMonth(nextMonth(d)); // skips the true first-uncovered month (nextMonth(d))
    const invalidArgs = prepayArgs(s.id, d, submissionId, { requestedMonths: [skipped] });
    const validArgs = prepayArgs(s.id, d, submissionId);

    let pid1: number | undefined;
    let release1!: () => void;
    const gate1 = new Promise<void>((resolve) => { release1 = resolve; });
    const r1Promise = prepayMonthlyObligationsWithSubmissionIdentity(
      invalidArgs,
      deps({ now: nowAt(d), afterSubmissionIdentityInsertForTest: async (tx: Tx) => { pid1 = (await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`)[0].pid; await gate1; } }),
    );
    let r2Promise: ReturnType<typeof prepayMonthlyObligationsWithSubmissionIdentity> | undefined;
    try {
      expect(await waitUntil(async () => pid1 !== undefined)).toBe(true);
      r2Promise = prepayMonthlyObligationsWithSubmissionIdentity(validArgs, deps({ now: nowAt(d) }));
      const waiterPid = await findBlockedOnInsert();
      expect(waiterPid).not.toBeNull();
      expect(await isBlockedBy(waiterPid!, pid1!)).toBe(true);
    } finally {
      release1();
      await Promise.allSettled([r1Promise, r2Promise]);
    }

    const r1 = await r1Promise;
    expect(r1).toMatchObject({ ok: false, error: "coverageGap" });
    const r2 = await r2Promise!;
    if (!r2.ok) throw new Error(`fixture: expected the corrected attempt to succeed, got ${JSON.stringify(r2)}`);
    const attempts = await prisma.duesPaymentAttempt.findMany({ where: { organizationId: a.org.id, submissionId } });
    expect(attempts).toHaveLength(1);
    expect(attempts[0].paymentId).toBe(r2.paymentId);
  });
});

describe("payload identity and genuine-refusal rollback", () => {
  it("(P3) package: a differing payload under the same submissionId refuses submissionPayloadMismatch, original untouched", async () => {
    const d = freshDate();
    const s = await newStudent(a, "pmismatch");
    const submissionId = freshSubmissionId("pmismatch");
    const original = packageArgs(s.id, d, submissionId);
    const r1 = await purchasePackageWithSubmissionIdentity(original, deps({ now: nowAt(d) }));
    expect(r1).toMatchObject({ ok: true });

    const before = await prisma.duesPaymentAttempt.findFirstOrThrow({ where: { organizationId: a.org.id, submissionId } });
    const r2 = await purchasePackageWithSubmissionIdentity({ ...original, tender: { currency: "USD" as const, amount: "269.00" } }, deps({ now: nowAt(d) }));
    expect(r2).toEqual({ ok: false, error: "submissionPayloadMismatch" });
    expect(await prisma.duesPaymentAttempt.findFirstOrThrow({ where: { organizationId: a.org.id, submissionId } })).toEqual(before);
  });

  it("(P4) package: a genuine refusal (coverageGap) leaves zero rows; the same submissionId is genuinely fresh afterward", async () => {
    const d = freshDate();
    const s = await newStudent(a, "prefusal4");
    const submissionId = freshSubmissionId("prefusal4");
    const wrong = packageArgs(s.id, d, submissionId, { requestedStartMonth: nextMonth(d) });
    const refusal = await purchasePackageWithSubmissionIdentity(wrong, deps({ now: nowAt(d) }));
    expect(refusal).toMatchObject({ ok: false, error: "coverageGap" });
    expect(await prisma.duesPaymentAttempt.count({ where: { organizationId: a.org.id, submissionId } })).toBe(0);

    const fresh = await purchasePackageWithSubmissionIdentity(packageArgs(s.id, d, submissionId), deps({ now: nowAt(d) }));
    expect(fresh).toMatchObject({ ok: true });
  });

  it("(Q3) prepayment: a differing payload under the same submissionId refuses submissionPayloadMismatch, original untouched", async () => {
    const d = freshDate();
    const s = await newStudent(a, "qmismatch");
    await assign(s.id);
    const submissionId = freshSubmissionId("qmismatch");
    const original = prepayArgs(s.id, d, submissionId);
    const r1 = await prepayMonthlyObligationsWithSubmissionIdentity(original, deps({ now: nowAt(d) }));
    expect(r1).toMatchObject({ ok: true });

    const before = await prisma.duesPaymentAttempt.findFirstOrThrow({ where: { organizationId: a.org.id, submissionId } });
    const r2 = await prepayMonthlyObligationsWithSubmissionIdentity({ ...original, tender: { currency: "USD" as const, amount: "99.00" } }, deps({ now: nowAt(d) }));
    expect(r2).toEqual({ ok: false, error: "submissionPayloadMismatch" });
    expect(await prisma.duesPaymentAttempt.findFirstOrThrow({ where: { organizationId: a.org.id, submissionId } })).toEqual(before);
  });

  it("(Q4) prepayment: a genuine refusal (coverageGap) leaves zero rows; the same submissionId is genuinely fresh afterward", async () => {
    const d = freshDate();
    const s = await newStudent(a, "qrefusal4");
    await assign(s.id);
    const submissionId = freshSubmissionId("qrefusal4");
    const wrong = prepayArgs(s.id, d, submissionId, { requestedMonths: [nextMonth(nextMonth(d))] });
    const refusal = await prepayMonthlyObligationsWithSubmissionIdentity(wrong, deps({ now: nowAt(d) }));
    expect(refusal).toMatchObject({ ok: false, error: "coverageGap" });
    expect(await prisma.duesPaymentAttempt.count({ where: { organizationId: a.org.id, submissionId } })).toBe(0);

    const fresh = await prepayMonthlyObligationsWithSubmissionIdentity(prepayArgs(s.id, d, submissionId), deps({ now: nowAt(d) }));
    expect(fresh).toMatchObject({ ok: true });
  });

  it("(P12) package: every OTHER meaningful canonical field, independently varied to a genuinely different well-formed value, refuses submissionPayloadMismatch and leaves the original row untouched", async () => {
    const d = freshDate();
    const s1 = await newStudent(a, "pfield1");
    const s2 = await newStudent(a, "pfield2");
    const ob1 = await oneMonth(s1.id, d);
    const submissionId = freshSubmissionId("pfield");
    const original = packageArgs(s1.id, d, submissionId, { existingObligationIds: [ob1], tender: { currency: "USD" as const, amount: "370.00" }, notes: "original note" });
    const r1 = await purchasePackageWithSubmissionIdentity(original, deps({ now: nowAt(d) }));
    if (!r1.ok) throw new Error(`fixture: expected success, got ${JSON.stringify(r1)}`);

    const cases: Array<[string, Record<string, unknown>]> = [
      ["a different planTermsId", { planTermsId: packageTerms2.id }],
      ["a different requestedStartMonth", { requestedStartMonth: nextMonth(d) }],
      ["a genuinely different existingObligationIds set (not merely reordered)", { existingObligationIds: [] }],
      ["a different studentId", { studentId: s2.id }],
      ["a different receivedOn", { receivedOn: { ...d, day: d.day + 1 } }],
      ["a different tender.currency", { tender: { currency: "CRC" as const, amount: "370.00" } }],
      ["a different method", { method: "TARJETA" as const }],
      ["a genuinely different notes", { notes: "a completely different note" }],
    ];
    for (const [label, override] of cases) {
      const before = await prisma.duesPaymentAttempt.findFirstOrThrow({ where: { organizationId: a.org.id, submissionId } });
      const r = await purchasePackageWithSubmissionIdentity({ ...original, ...override }, deps({ now: nowAt(d) }));
      expect(r, label).toEqual({ ok: false, error: "submissionPayloadMismatch" });
      expect(await prisma.duesPaymentAttempt.findFirstOrThrow({ where: { organizationId: a.org.id, submissionId } }), label).toEqual(before);
    }
  });

  it("(Q12) prepayment: every OTHER meaningful canonical field, independently varied to a genuinely different well-formed value, refuses submissionPayloadMismatch and leaves the original row untouched", async () => {
    const d = freshDate();
    const s1 = await newStudent(a, "qfield1");
    const s2 = await newStudent(a, "qfield2");
    await assign(s1.id);
    const submissionId = freshSubmissionId("qfield");
    const original = prepayArgs(s1.id, d, submissionId, { existingObligationIds: [], notes: "original note" });
    const r1 = await prepayMonthlyObligationsWithSubmissionIdentity(original, deps({ now: nowAt(d) }));
    if (!r1.ok) throw new Error(`fixture: expected success, got ${JSON.stringify(r1)}`);

    const ob2 = await oneMonth(s1.id, { ...d, day: d.day + 1 });
    const cases: Array<[string, Record<string, unknown>]> = [
      ["a different requestedMonths run", { requestedMonths: [nextMonth(nextMonth(d))] }],
      ["a genuinely different existingObligationIds set", { existingObligationIds: [ob2] }],
      ["a different studentId", { studentId: s2.id }],
      ["a different receivedOn", { receivedOn: { ...d, day: d.day + 2 } }],
      ["a different tender.currency", { tender: { currency: "CRC" as const, amount: "100.00" } }],
      ["a different method", { method: "TARJETA" as const }],
      ["a genuinely different notes", { notes: "a completely different note" }],
    ];
    for (const [label, override] of cases) {
      const before = await prisma.duesPaymentAttempt.findFirstOrThrow({ where: { organizationId: a.org.id, submissionId } });
      const r = await prepayMonthlyObligationsWithSubmissionIdentity({ ...original, ...override }, deps({ now: nowAt(d) }));
      expect(r, label).toEqual({ ok: false, error: "submissionPayloadMismatch" });
      expect(await prisma.duesPaymentAttempt.findFirstOrThrow({ where: { organizationId: a.org.id, submissionId } }), label).toEqual(before);
    }
  });
});

describe("capture and replay", () => {
  it("(P5) package: capture-then-rate-entry replay returns the original captured receipt, never settles for real", async () => {
    const d = freshDate();
    const s = await newStudent(a, "pcapture");
    const submissionId = freshSubmissionId("pcapture");
    const args = packageArgs(s.id, d, submissionId, { tender: { currency: "CRC" as const, amount: "135000.00" } });
    const r1 = await purchasePackageWithSubmissionIdentity(args, deps({ now: nowAt(d) }));
    if (r1.ok || r1.error !== "captured") throw new Error(`fixture: expected capture, got ${JSON.stringify(r1)}`);
    const receiptId = r1.receiptId!;

    const rate = await enterExchangeRateQuote({ context: context(), quoteDate: d, value: "500.00", expectedCurrentRevision: 0 }, deps());
    expect(rate).toMatchObject({ ok: true });

    const r2 = await purchasePackageWithSubmissionIdentity(args, deps({ now: nowAt(d) }));
    expect(r2).toEqual({ ok: false, error: "captured", receiptId, replay: true, currentStatus: "PENDING" });
    expect(await prisma.duesObligation.count({ where: { organizationId: a.org.id, studentId: s.id, type: "PACKAGE" } })).toBe(0);
    expect(await prisma.duesPaymentAttempt.count({ where: { organizationId: a.org.id, submissionId } })).toBe(1);
  });

  it("(P6) package: a package-origin payment can never be reversed (reverse-payment.ts's own existing, unaffected rule); the replay still reports its real currentlyReversed:false from a fresh read", async () => {
    const d = freshDate();
    const s = await newStudent(a, "preversed");
    const submissionId = freshSubmissionId("preversed");
    const args = packageArgs(s.id, d, submissionId);
    const r1 = await purchasePackageWithSubmissionIdentity(args, deps({ now: nowAt(d) }));
    if (!r1.ok) throw new Error(`fixture: expected success, got ${JSON.stringify(r1)}`);
    const reversed = await reversePayment({ context: context(), paymentId: r1.paymentId, reversalReason: "test reversal" }, deps());
    expect(reversed).toMatchObject({ ok: false }); // a PACKAGE obligation is never MONTHLY — reverse-payment.ts's own existing unsupportedObligationType check refuses it outright

    const replay = await purchasePackageWithSubmissionIdentity(args, deps({ now: nowAt(d) }));
    expect(replay).toEqual({ ok: true, paymentId: r1.paymentId, replay: true, currentlyReversed: false });

    currentSession = { user: { id: a.admin.id, role: "ADMIN" } };
    expect(await getSubmissionOutcome(a.org.id, submissionId)).toEqual({ status: "committed", outcome: { kind: "payment", paymentId: r1.paymentId, currentlyReversed: false } });
  });

  it("(Q5) prepayment: capture-then-rate-entry replay returns the original captured receipt, never settles for real", async () => {
    const d = freshDate();
    const s = await newStudent(a, "qcapture");
    await assign(s.id);
    const submissionId = freshSubmissionId("qcapture");
    const args = prepayArgs(s.id, d, submissionId, { tender: { currency: "CRC" as const, amount: "50000.00" } });
    const r1 = await prepayMonthlyObligationsWithSubmissionIdentity(args, deps({ now: nowAt(d) }));
    if (r1.ok || r1.error !== "captured") throw new Error(`fixture: expected capture, got ${JSON.stringify(r1)}`);
    const receiptId = r1.receiptId!;

    const rate = await enterExchangeRateQuote({ context: context(), quoteDate: d, value: "500.00", expectedCurrentRevision: 0 }, deps());
    expect(rate).toMatchObject({ ok: true });

    const r2 = await prepayMonthlyObligationsWithSubmissionIdentity(args, deps({ now: nowAt(d) }));
    expect(r2).toEqual({ ok: false, error: "captured", receiptId, replay: true, currentStatus: "PENDING" });
    expect(await prisma.duesObligation.count({ where: { organizationId: a.org.id, studentId: s.id, origin: "PREPAYMENT" } })).toBe(0);
    expect(await prisma.duesPaymentAttempt.count({ where: { organizationId: a.org.id, submissionId } })).toBe(1);
  });

  it("(Q6) prepayment: a prepayment-origin payment can never be reversed (reverse-payment.ts's own existing, unaffected, permanent rule); the replay still reports its real currentlyReversed:false from a fresh read", async () => {
    const d = freshDate();
    const s = await newStudent(a, "qreversed");
    await assign(s.id);
    const submissionId = freshSubmissionId("qreversed");
    const args = prepayArgs(s.id, d, submissionId);
    const r1 = await prepayMonthlyObligationsWithSubmissionIdentity(args, deps({ now: nowAt(d) }));
    if (!r1.ok) throw new Error(`fixture: expected success, got ${JSON.stringify(r1)}`);
    const reversed = await reversePayment({ context: context(), paymentId: r1.paymentId, reversalReason: "test reversal" }, deps());
    expect(reversed).toMatchObject({ ok: false }); // any PREPAYMENT-origin obligation refuses the WHOLE payment's reversal outright, permanently

    const replay = await prepayMonthlyObligationsWithSubmissionIdentity(args, deps({ now: nowAt(d) }));
    expect(replay).toEqual({ ok: true, paymentId: r1.paymentId, replay: true, currentlyReversed: false });

    currentSession = { user: { id: a.admin.id, role: "ADMIN" } };
    expect(await getSubmissionOutcome(a.org.id, submissionId)).toEqual({ status: "committed", outcome: { kind: "payment", paymentId: r1.paymentId, currentlyReversed: false } });
  });

  it("(P10) package: a replayed capture since RESOLVED (via the REAL resolveAwaitingRateReceipt, which genuinely creates the package and settles it) reports the original receiptId with currentStatus RESOLVED; the retry itself creates nothing new", async () => {
    const d = freshDate();
    const s = await newStudent(a, "presolved");
    const submissionId = freshSubmissionId("presolved");
    const args = packageArgs(s.id, d, submissionId, { tender: { currency: "CRC" as const, amount: "135000.00" } });
    const captured = await purchasePackageWithSubmissionIdentity(args, deps({ now: nowAt(d) }));
    if (captured.ok || captured.error !== "captured") throw new Error(`fixture: expected capture, got ${JSON.stringify(captured)}`);
    const receiptId = captured.receiptId!;
    expect(await enterExchangeRateQuote({ context: context(), quoteDate: d, value: "500.00", expectedCurrentRevision: 0 }, deps())).toMatchObject({ ok: true });
    const resolved = await resolveAwaitingRateReceipt({ context: context(), receiptId }, deps({ now: nowAt(d) }));
    expect(resolved).toMatchObject({ ok: true });

    const countsBefore = {
      obligations: await prisma.duesObligation.count({ where: { organizationId: a.org.id, studentId: s.id } }),
      payments: await prisma.duesPayment.count({ where: { organizationId: a.org.id, studentId: s.id } }),
      settlements: await prisma.duesSettlement.count({ where: { organizationId: a.org.id, studentId: s.id } }),
    };
    const replay = await purchasePackageWithSubmissionIdentity(args, deps({ now: nowAt(d) }));
    expect(replay).toEqual({ ok: false, error: "captured", receiptId, replay: true, currentStatus: "RESOLVED" });
    expect({
      obligations: await prisma.duesObligation.count({ where: { organizationId: a.org.id, studentId: s.id } }),
      payments: await prisma.duesPayment.count({ where: { organizationId: a.org.id, studentId: s.id } }),
      settlements: await prisma.duesSettlement.count({ where: { organizationId: a.org.id, studentId: s.id } }),
    }).toEqual(countsBefore);
    expect(await prisma.duesPaymentAttempt.count({ where: { organizationId: a.org.id, submissionId } })).toBe(1);
  });

  it("(P11) package: a replayed capture since CANCELLED reports the original receiptId with currentStatus CANCELLED; the retry creates nothing", async () => {
    const d = freshDate();
    const s = await newStudent(a, "pcancelled");
    const submissionId = freshSubmissionId("pcancelled");
    const args = packageArgs(s.id, d, submissionId, { tender: { currency: "CRC" as const, amount: "135000.00" } });
    const captured = await purchasePackageWithSubmissionIdentity(args, deps({ now: nowAt(d) }));
    if (captured.ok || captured.error !== "captured") throw new Error(`fixture: expected capture, got ${JSON.stringify(captured)}`);
    const receiptId = captured.receiptId!;
    const cancelled = await cancelAwaitingRateReceipt({ context: context(), receiptId, reason: "owner changed their mind" }, deps());
    expect(cancelled).toMatchObject({ ok: true });

    const obligationsBefore = await prisma.duesObligation.count({ where: { organizationId: a.org.id, studentId: s.id } });
    const replay = await purchasePackageWithSubmissionIdentity(args, deps({ now: nowAt(d) }));
    expect(replay).toEqual({ ok: false, error: "captured", receiptId, replay: true, currentStatus: "CANCELLED" });
    expect(await prisma.duesObligation.count({ where: { organizationId: a.org.id, studentId: s.id } })).toBe(obligationsBefore);
    expect(await prisma.duesPaymentAttempt.count({ where: { organizationId: a.org.id, submissionId } })).toBe(1);
  });

  it("(Q10) prepayment: a replayed capture since RESOLVED (via the REAL resolveAwaitingRateReceipt, which genuinely creates the months and settles them) reports the original receiptId with currentStatus RESOLVED; the retry itself creates nothing new", async () => {
    const d = freshDate();
    const s = await newStudent(a, "qresolved");
    await assign(s.id);
    const submissionId = freshSubmissionId("qresolved");
    const args = prepayArgs(s.id, d, submissionId, { tender: { currency: "CRC" as const, amount: "50000.00" } });
    const captured = await prepayMonthlyObligationsWithSubmissionIdentity(args, deps({ now: nowAt(d) }));
    if (captured.ok || captured.error !== "captured") throw new Error(`fixture: expected capture, got ${JSON.stringify(captured)}`);
    const receiptId = captured.receiptId!;
    expect(await enterExchangeRateQuote({ context: context(), quoteDate: d, value: "500.00", expectedCurrentRevision: 0 }, deps())).toMatchObject({ ok: true });
    const resolved = await resolveAwaitingRateReceipt({ context: context(), receiptId }, deps({ now: nowAt(d) }));
    expect(resolved).toMatchObject({ ok: true });

    const countsBefore = {
      obligations: await prisma.duesObligation.count({ where: { organizationId: a.org.id, studentId: s.id } }),
      payments: await prisma.duesPayment.count({ where: { organizationId: a.org.id, studentId: s.id } }),
      settlements: await prisma.duesSettlement.count({ where: { organizationId: a.org.id, studentId: s.id } }),
    };
    const replay = await prepayMonthlyObligationsWithSubmissionIdentity(args, deps({ now: nowAt(d) }));
    expect(replay).toEqual({ ok: false, error: "captured", receiptId, replay: true, currentStatus: "RESOLVED" });
    expect({
      obligations: await prisma.duesObligation.count({ where: { organizationId: a.org.id, studentId: s.id } }),
      payments: await prisma.duesPayment.count({ where: { organizationId: a.org.id, studentId: s.id } }),
      settlements: await prisma.duesSettlement.count({ where: { organizationId: a.org.id, studentId: s.id } }),
    }).toEqual(countsBefore);
    expect(await prisma.duesPaymentAttempt.count({ where: { organizationId: a.org.id, submissionId } })).toBe(1);
  });

  it("(Q11) prepayment: a replayed capture since CANCELLED reports the original receiptId with currentStatus CANCELLED; the retry creates nothing", async () => {
    const d = freshDate();
    const s = await newStudent(a, "qcancelled");
    await assign(s.id);
    const submissionId = freshSubmissionId("qcancelled");
    const args = prepayArgs(s.id, d, submissionId, { tender: { currency: "CRC" as const, amount: "50000.00" } });
    const captured = await prepayMonthlyObligationsWithSubmissionIdentity(args, deps({ now: nowAt(d) }));
    if (captured.ok || captured.error !== "captured") throw new Error(`fixture: expected capture, got ${JSON.stringify(captured)}`);
    const receiptId = captured.receiptId!;
    const cancelled = await cancelAwaitingRateReceipt({ context: context(), receiptId, reason: "owner changed their mind" }, deps());
    expect(cancelled).toMatchObject({ ok: true });

    const obligationsBefore = await prisma.duesObligation.count({ where: { organizationId: a.org.id, studentId: s.id } });
    const replay = await prepayMonthlyObligationsWithSubmissionIdentity(args, deps({ now: nowAt(d) }));
    expect(replay).toEqual({ ok: false, error: "captured", receiptId, replay: true, currentStatus: "CANCELLED" });
    expect(await prisma.duesObligation.count({ where: { organizationId: a.org.id, studentId: s.id } })).toBe(obligationsBefore);
    expect(await prisma.duesPaymentAttempt.count({ where: { organizationId: a.org.id, submissionId } })).toBe(1);
  });
});

describe("canonical equivalence", () => {
  it("(P7) package: reordered existingObligationIds and a differently-formatted tender.amount replay as identical", async () => {
    const d = freshDate();
    const s = await newStudent(a, "pcanon");
    const ob1 = await oneMonth(s.id, d);
    const submissionId = freshSubmissionId("pcanon");
    const original = packageArgs(s.id, d, submissionId, { existingObligationIds: [ob1], tender: { currency: "USD" as const, amount: "370.00" } });
    const r1 = await purchasePackageWithSubmissionIdentity(original, deps({ now: nowAt(d) }));
    if (!r1.ok) throw new Error(`fixture: expected success, got ${JSON.stringify(r1)}`);

    const reformatted = { ...original, existingObligationIds: [ob1], tender: { currency: "USD" as const, amount: "370" } };
    const r2 = await purchasePackageWithSubmissionIdentity(reformatted, deps({ now: nowAt(d) }));
    expect(r2).toEqual({ ok: true, paymentId: r1.paymentId, replay: true, currentlyReversed: false });
    expect(await prisma.duesPaymentAttempt.count({ where: { organizationId: a.org.id, submissionId } })).toBe(1);
  });

  it("(Q7) prepayment: a differently-formatted but numerically-equal tender.amount replays as identical", async () => {
    const d = freshDate();
    const s = await newStudent(a, "qcanon");
    await assign(s.id);
    const submissionId = freshSubmissionId("qcanon");
    const original = prepayArgs(s.id, d, submissionId);
    const r1 = await prepayMonthlyObligationsWithSubmissionIdentity(original, deps({ now: nowAt(d) }));
    if (!r1.ok) throw new Error(`fixture: expected success, got ${JSON.stringify(r1)}`);

    const reformatted = { ...original, tender: { currency: "USD" as const, amount: "100" } };
    const r2 = await prepayMonthlyObligationsWithSubmissionIdentity(reformatted, deps({ now: nowAt(d) }));
    expect(r2).toEqual({ ok: true, paymentId: r1.paymentId, replay: true, currentlyReversed: false });
    expect(await prisma.duesPaymentAttempt.count({ where: { organizationId: a.org.id, submissionId } })).toBe(1);
  });
});

describe("real transaction atomicity: a forced failure deep inside ...InTx rolls back everything, including the identity row", () => {
  it("(P8) package: a forced failure right after the package obligation/coverage are written leaves zero DuesObligation and zero DuesPaymentAttempt rows", async () => {
    const d = freshDate();
    const s = await newStudent(a, "patomic");
    const submissionId = freshSubmissionId("patomic");
    await expect(
      purchasePackageWithSubmissionIdentity(
        packageArgs(s.id, d, submissionId),
        deps({ now: nowAt(d), afterPackageObligationWrittenForTest: async () => { throw new Error("forced failure for atomicity test"); } }),
      ),
    ).rejects.toThrow("forced failure for atomicity test");

    expect(await prisma.duesObligation.count({ where: { organizationId: a.org.id, studentId: s.id } })).toBe(0);
    expect(await prisma.duesCoverage.count({ where: { organizationId: a.org.id, studentId: s.id } })).toBe(0);
    expect(await prisma.duesPaymentAttempt.count({ where: { organizationId: a.org.id, submissionId } })).toBe(0);
  });

  it("(Q8) prepayment: a forced failure right after every month's obligation is written leaves zero DuesObligation and zero DuesPaymentAttempt rows", async () => {
    const d = freshDate();
    const s = await newStudent(a, "qatomic");
    await assign(s.id);
    const submissionId = freshSubmissionId("qatomic");
    await expect(
      prepayMonthlyObligationsWithSubmissionIdentity(
        prepayArgs(s.id, d, submissionId),
        deps({ now: nowAt(d), afterPrepaymentObligationsWrittenForTest: async () => { throw new Error("forced failure for atomicity test"); } }),
      ),
    ).rejects.toThrow("forced failure for atomicity test");

    expect(await prisma.duesObligation.count({ where: { organizationId: a.org.id, studentId: s.id } })).toBe(0);
    expect(await prisma.duesPaymentAttempt.count({ where: { organizationId: a.org.id, submissionId } })).toBe(0);
  });
});

describe("submissionId format validation", () => {
  it("(P9) package: a whitespace-only submissionId is refused as invalid before any lookup or write", async () => {
    const d = freshDate();
    const s = await newStudent(a, "pws");
    const before = await prisma.duesPaymentAttempt.count({ where: { organizationId: a.org.id } });
    const r = await purchasePackageWithSubmissionIdentity(packageArgs(s.id, d, "   "), deps({ now: nowAt(d) }));
    expect(r).toEqual({ ok: false, error: "invalid" });
    expect(await prisma.duesPaymentAttempt.count({ where: { organizationId: a.org.id } })).toBe(before);
  });

  it("(Q9) prepayment: a whitespace-only submissionId is refused as invalid before any lookup or write", async () => {
    const d = freshDate();
    const s = await newStudent(a, "qws");
    await assign(s.id);
    const before = await prisma.duesPaymentAttempt.count({ where: { organizationId: a.org.id } });
    const r = await prepayMonthlyObligationsWithSubmissionIdentity(prepayArgs(s.id, d, "   "), deps({ now: nowAt(d) }));
    expect(r).toEqual({ ok: false, error: "invalid" });
    expect(await prisma.duesPaymentAttempt.count({ where: { organizationId: a.org.id } })).toBe(before);
  });
});

describe("operation-aware recovery authorization (getSubmissionOutcome)", () => {
  it("(X1) ADMIN resolves a PACKAGE outcome; a genuine DIRECTOR of the SAME branch resolves notFound for the identical submissionId", async () => {
    const d = freshDate();
    const s = await newStudent(a, "xpkg");
    const submissionId = freshSubmissionId("xpkg");
    const r = await purchasePackageWithSubmissionIdentity(packageArgs(s.id, d, submissionId), deps({ now: nowAt(d) }));
    if (!r.ok) throw new Error(`fixture: expected success, got ${JSON.stringify(r)}`);

    currentSession = { user: { id: a.admin.id, role: "ADMIN" } };
    expect(await getSubmissionOutcome(a.org.id, submissionId)).toEqual({ status: "committed", outcome: { kind: "payment", paymentId: r.paymentId, currentlyReversed: false } });

    currentSession = { user: { id: director.id, role: "DIRECTOR" } };
    expect(await getSubmissionOutcome(a.org.id, submissionId)).toEqual({ status: "notFound" });
  });

  it("(X2) ADMIN resolves a PREPAYMENT outcome; a genuine DIRECTOR of the SAME branch resolves notFound for the identical submissionId", async () => {
    const d = freshDate();
    const s = await newStudent(a, "xprepay");
    await assign(s.id);
    const submissionId = freshSubmissionId("xprepay");
    const r = await prepayMonthlyObligationsWithSubmissionIdentity(prepayArgs(s.id, d, submissionId), deps({ now: nowAt(d) }));
    if (!r.ok) throw new Error(`fixture: expected success, got ${JSON.stringify(r)}`);

    currentSession = { user: { id: a.admin.id, role: "ADMIN" } };
    expect(await getSubmissionOutcome(a.org.id, submissionId)).toEqual({ status: "committed", outcome: { kind: "payment", paymentId: r.paymentId, currentlyReversed: false } });

    currentSession = { user: { id: director.id, role: "DIRECTOR" } };
    expect(await getSubmissionOutcome(a.org.id, submissionId)).toEqual({ status: "notFound" });
  });

  it("(X3) the SAME DIRECTOR still correctly resolves a genuine ORDINARY outcome for their own branch — the operation gate never over-triggers", async () => {
    const d = freshDate();
    const s = await newStudent(a, "xordinary");
    const ob = await oneMonth(s.id, d);
    const submissionId = freshSubmissionId("xordinary");
    const r = await recordDuesPaymentWithSubmissionIdentity(
      { context: context(), studentId: s.id, receivedOn: d, tender: { currency: "USD" as const, amount: "100.00" }, method: "EFECTIVO" as const, obligationIds: [ob], maxBackdateDays: 5, submissionId },
      deps({ now: nowAt(d) }),
    );
    if (!r.ok) throw new Error(`fixture: expected success, got ${JSON.stringify(r)}`);

    currentSession = { user: { id: director.id, role: "DIRECTOR" } };
    expect(await getSubmissionOutcome(a.org.id, submissionId)).toEqual({ status: "committed", outcome: { kind: "payment", paymentId: r.paymentId, currentlyReversed: false } });
  });
});

describe("tenant isolation", () => {
  it("(X4) the identical literal submissionId is independently usable by the package writer across two organizations, never crossing", async () => {
    const submissionId = `pshared-${suffix}`;
    const dA = freshDate();
    const sA = await newStudent(a, "xisoA");
    const rA = await purchasePackageWithSubmissionIdentity(packageArgs(sA.id, dA, submissionId), deps({ now: nowAt(dA) }));
    if (!rA.ok) throw new Error(`fixture: expected org A success, got ${JSON.stringify(rA)}`);

    const dB = freshDate();
    const sB = await prisma.student.create({
      data: { organizationId: b.org.id, homeAcademyId: b.academy.id, firstName: "PurchaseSub", lastName: `xisoB${++studentCounter}`, phone: "00000000", email: `psub-xisoB-${studentCounter}-${suffix}@example.com`, currentRankId: await b.rankId("WHITE"), codeHash: `psub-xisoB-${studentCounter}-${suffix}`, status: "ACTIVE" },
    });
    const rB = await purchasePackageWithSubmissionIdentity(
      { context: contextB(), studentId: sB.id, planTermsId: packageTermsB.id, requestedStartMonth: { year: dB.year, month: dB.month }, receivedOn: dB, tender: { currency: "USD" as const, amount: "270.00" }, method: "EFECTIVO" as const, maxBackdateDays: 5, submissionId },
      deps({ now: nowAt(dB) }),
    );
    if (!rB.ok) throw new Error(`fixture: expected org B success, got ${JSON.stringify(rB)}`);
    expect(rB.paymentId).not.toBe(rA.paymentId);

    currentSession = { user: { id: a.admin.id, role: "ADMIN" } };
    expect(await getSubmissionOutcome(a.org.id, submissionId)).toEqual({ status: "committed", outcome: { kind: "payment", paymentId: rA.paymentId, currentlyReversed: false } });
    currentSession = { user: { id: b.admin.id, role: "ADMIN" } };
    expect(await getSubmissionOutcome(b.org.id, submissionId)).toEqual({ status: "committed", outcome: { kind: "payment", paymentId: rB.paymentId, currentlyReversed: false } });
  });
});

describe("cross-writer payload-mismatch protection", () => {
  it("(X5) the identical submissionId, first committed as PACKAGE, refuses an ORDINARY attempt with submissionPayloadMismatch; the original PACKAGE outcome is untouched", async () => {
    const d = freshDate();
    const s = await newStudent(a, "xcross");
    const submissionId = freshSubmissionId("xcross");
    const r1 = await purchasePackageWithSubmissionIdentity(packageArgs(s.id, d, submissionId), deps({ now: nowAt(d) }));
    if (!r1.ok) throw new Error(`fixture: expected success, got ${JSON.stringify(r1)}`);

    // The ordinary writer loses the identity-insert race (the row already exists under this submissionId) and goes
    // straight to the canonicalPayload comparison — real debt resolution is never reached, so a placeholder
    // obligationId (format-valid, not a real row) is enough to prove the mismatch is caught on shape/operation alone.
    const before = await prisma.duesPaymentAttempt.findFirstOrThrow({ where: { organizationId: a.org.id, submissionId } });
    const r2 = await recordDuesPaymentWithSubmissionIdentity(
      { context: context(), studentId: s.id, receivedOn: d, tender: { currency: "USD" as const, amount: "100.00" }, method: "EFECTIVO" as const, obligationIds: ["placeholder-obligation"], maxBackdateDays: 5, submissionId },
      deps({ now: nowAt(d) }),
    );
    expect(r2).toEqual({ ok: false, error: "submissionPayloadMismatch" });
    expect(await prisma.duesPaymentAttempt.findFirstOrThrow({ where: { organizationId: a.org.id, submissionId } })).toEqual(before);

    currentSession = { user: { id: a.admin.id, role: "ADMIN" } };
    expect(await getSubmissionOutcome(a.org.id, submissionId)).toEqual({ status: "committed", outcome: { kind: "payment", paymentId: r1.paymentId, currentlyReversed: false } });
  });
});

describe("legacy database-row compatibility", () => {
  it("(X6a) a pre-existing legacy row (canonicalPayload with no operation key at all) replays correctly through the ordinary writer", async () => {
    const d = freshDate();
    const s = await newStudent(a, "xlegacy-ord");
    const ob = await oneMonth(s.id, d);
    const paid = await recordDuesPayment({ context: context(), studentId: s.id, receivedOn: d, tender: { currency: "USD", amount: "100.00" }, method: "EFECTIVO", obligationIds: [ob], maxBackdateDays: 5 }, deps({ now: nowAt(d) }));
    if (!paid.ok) throw new Error(`fixture: payment failed: ${JSON.stringify(paid)}`);
    const submissionId = freshSubmissionId("xlegacy-ord");
    const legacyPayload = { studentId: s.id, obligationIds: [ob], receivedOn: `${d.year}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`, tenderCurrency: "USD", tenderAmount: "100.00", method: "EFECTIVO", notes: "" }; // no "operation" key — simulates a row written before PR #89's own field existed
    await prisma.duesPaymentAttempt.create({ data: { organizationId: a.org.id, studentId: s.id, academyId: a.academy.id, submissionId, canonicalPayload: legacyPayload, paymentId: paid.paymentId } });
    const before = await prisma.duesPaymentAttempt.findUniqueOrThrow({ where: { organizationId_submissionId: { organizationId: a.org.id, submissionId } } });

    const replay = await recordDuesPaymentWithSubmissionIdentity(
      { context: context(), studentId: s.id, receivedOn: d, tender: { currency: "USD" as const, amount: "100.00" }, method: "EFECTIVO" as const, obligationIds: [ob], maxBackdateDays: 5, submissionId },
      deps({ now: nowAt(d) }),
    );
    expect(replay).toEqual({ ok: true, paymentId: paid.paymentId, replay: true, currentlyReversed: false });
    expect(await prisma.duesPaymentAttempt.findUniqueOrThrow({ where: { organizationId_submissionId: { organizationId: a.org.id, submissionId } } })).toEqual(before);
  });

  it("(X6b) that same legacy key, attempted as a PACKAGE purchase, refuses submissionPayloadMismatch (disjoint field shapes reject it); the original row is byte-identical before and after", async () => {
    const d = freshDate();
    const s = await newStudent(a, "xlegacy-pkg");
    const ob = await oneMonth(s.id, d);
    const paid = await recordDuesPayment({ context: context(), studentId: s.id, receivedOn: d, tender: { currency: "USD", amount: "100.00" }, method: "EFECTIVO", obligationIds: [ob], maxBackdateDays: 5 }, deps({ now: nowAt(d) }));
    if (!paid.ok) throw new Error(`fixture: payment failed: ${JSON.stringify(paid)}`);
    const submissionId = freshSubmissionId("xlegacy-pkg");
    const legacyPayload = { studentId: s.id, obligationIds: [ob], receivedOn: `${d.year}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`, tenderCurrency: "USD", tenderAmount: "100.00", method: "EFECTIVO", notes: "" };
    await prisma.duesPaymentAttempt.create({ data: { organizationId: a.org.id, studentId: s.id, academyId: a.academy.id, submissionId, canonicalPayload: legacyPayload, paymentId: paid.paymentId } });
    const before = await prisma.duesPaymentAttempt.findUniqueOrThrow({ where: { organizationId_submissionId: { organizationId: a.org.id, submissionId } } });

    const r = await purchasePackageWithSubmissionIdentity(packageArgs(s.id, d, submissionId), deps({ now: nowAt(d) }));
    expect(r).toEqual({ ok: false, error: "submissionPayloadMismatch" });
    expect(await prisma.duesPaymentAttempt.findUniqueOrThrow({ where: { organizationId_submissionId: { organizationId: a.org.id, submissionId } } })).toEqual(before);
    expect(await prisma.duesObligation.count({ where: { organizationId: a.org.id, studentId: s.id, type: "PACKAGE" } })).toBe(0);
  });

  it("(X6c) a PACKAGE row's own submissionId, attempted through the ordinary writer, refuses submissionPayloadMismatch; the original row is byte-identical before and after", async () => {
    const d = freshDate();
    const s = await newStudent(a, "xlegacy-rev");
    const submissionId = freshSubmissionId("xlegacy-rev");
    const r1 = await purchasePackageWithSubmissionIdentity(packageArgs(s.id, d, submissionId), deps({ now: nowAt(d) }));
    if (!r1.ok) throw new Error(`fixture: expected success, got ${JSON.stringify(r1)}`);
    const before = await prisma.duesPaymentAttempt.findUniqueOrThrow({ where: { organizationId_submissionId: { organizationId: a.org.id, submissionId } } });

    const r2 = await recordDuesPaymentWithSubmissionIdentity(
      { context: context(), studentId: s.id, receivedOn: d, tender: { currency: "USD" as const, amount: "100.00" }, method: "EFECTIVO" as const, obligationIds: ["placeholder-obligation"], maxBackdateDays: 5, submissionId },
      deps({ now: nowAt(d) }),
    );
    expect(r2).toEqual({ ok: false, error: "submissionPayloadMismatch" });
    expect(await prisma.duesPaymentAttempt.findUniqueOrThrow({ where: { organizationId_submissionId: { organizationId: a.org.id, submissionId } } })).toEqual(before);
  });
});

describe("readStoredOperation fails closed, never open", () => {
  it("(X10a) a genuine legacy ordinary row (operation key absent, every OTHER field genuinely valid) remains readable by an authorized DIRECTOR", async () => {
    const d = freshDate();
    const s = await newStudent(a, "x10a");
    const ob = await oneMonth(s.id, d);
    const paid = await recordDuesPayment({ context: context(), studentId: s.id, receivedOn: d, tender: { currency: "USD", amount: "100.00" }, method: "EFECTIVO", obligationIds: [ob], maxBackdateDays: 5 }, deps({ now: nowAt(d) }));
    if (!paid.ok) throw new Error(`fixture: payment failed: ${JSON.stringify(paid)}`);
    const submissionId = freshSubmissionId("x10a");
    // No "operation" key at all — a genuinely legacy-shaped row, every OTHER field valid against the full ordinary schema.
    const legacyPayload = { studentId: s.id, obligationIds: [ob], receivedOn: `${d.year}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`, tenderCurrency: "USD", tenderAmount: "100.00", method: "EFECTIVO", notes: "" };
    await prisma.duesPaymentAttempt.create({ data: { organizationId: a.org.id, studentId: s.id, academyId: a.academy.id, submissionId, canonicalPayload: legacyPayload, paymentId: paid.paymentId } });

    currentSession = { user: { id: director.id, role: "DIRECTOR" } };
    expect(await getSubmissionOutcome(a.org.id, submissionId)).toEqual({ status: "committed", outcome: { kind: "payment", paymentId: paid.paymentId, currentlyReversed: false } });
  });

  it("(X10b) an entry whose canonicalPayload is NOT cleanly classifiable as ORDINARY — an unrecognized operation value, or a missing operation key combined with another broken field — is NOT readable by a DIRECTOR (resolves notFound, never fails open); ADMIN still sees it", async () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ["an unrecognized operation value", { operation: "GARBAGE", studentId: "irrelevant", obligationIds: ["irrelevant"], receivedOn: "2000-01-01", tenderCurrency: "USD", tenderAmount: "10.00", method: "EFECTIVO", notes: "" }],
      // No "operation" key AND missing tenderAmount — fails the full ordinary schema on a field other than operation,
      // so the legacy-default rescue must NOT apply either.
      ["no operation key, and fails the full ordinary schema on another field (missing tenderAmount)", { studentId: "irrelevant", obligationIds: ["irrelevant"], receivedOn: "2000-01-01", tenderCurrency: "USD", method: "EFECTIVO", notes: "" }],
    ];
    for (const [label, canonicalPayload] of cases) {
      const s = await newStudent(a, "x10b");
      const paid = await prisma.duesPayment.create({
        data: { organizationId: a.org.id, studentId: s.id, academyId: a.academy.id, receivedOn: new Date(), tenderCurrency: "USD", tenderAmount: "10.00", method: "EFECTIVO", recordedById: a.admin.id },
      });
      const submissionId = freshSubmissionId("x10b");
      await prisma.duesPaymentAttempt.create({ data: { organizationId: a.org.id, studentId: s.id, academyId: a.academy.id, submissionId, canonicalPayload: canonicalPayload as Prisma.InputJsonValue, paymentId: paid.id } });

      currentSession = { user: { id: director.id, role: "DIRECTOR" } };
      expect(await getSubmissionOutcome(a.org.id, submissionId), label).toEqual({ status: "notFound" });

      currentSession = { user: { id: a.admin.id, role: "ADMIN" } };
      expect(await getSubmissionOutcome(a.org.id, submissionId), label).toEqual({ status: "committed", outcome: { kind: "payment", paymentId: paid.id, currentlyReversed: false } });
    }
  });
});

describe("database-enforced guarantees, re-proved against a package-shaped row", () => {
  it("(X7) setting BOTH outcome columns non-null in one statement is rejected by the CHECK constraint", async () => {
    const s = await newStudent(a, "xcheck");
    const payment = await prisma.duesPayment.create({
      data: { organizationId: a.org.id, studentId: s.id, academyId: a.academy.id, receivedOn: new Date(), tenderCurrency: "USD", tenderAmount: "10.00", method: "EFECTIVO", recordedById: a.admin.id },
    });
    const receipt = await prisma.awaitingRateReceipt.create({
      data: { organizationId: a.org.id, studentId: s.id, academyId: a.academy.id, kind: "PACKAGE", receivedOn: new Date(), tenderCurrency: "CRC", tenderAmount: "5000.00", method: "EFECTIVO", capturedAt: new Date(), capturedById: a.admin.id, snapshot: { kind: "PACKAGE", planTermsId: packageTerms.id } },
    });
    await isolated(async (tx) => {
      const row = await tx.duesPaymentAttempt.create({ data: { organizationId: a.org.id, studentId: s.id, academyId: a.academy.id, submissionId: freshSubmissionId("xcheck"), canonicalPayload: { operation: "PACKAGE" } } });
      await refused(tx, () => tx.duesPaymentAttempt.update({ where: { id: row.id }, data: { paymentId: payment.id, receiptId: receipt.id } }), "DuesPaymentAttempt_outcome_at_most_one");
    });
  });

  it("(X8) a FURTHER update changing an already-finalized outcome column is rejected by the once-marker trigger", async () => {
    const s = await newStudent(a, "xonce");
    const firstPayment = await prisma.duesPayment.create({
      data: { organizationId: a.org.id, studentId: s.id, academyId: a.academy.id, receivedOn: new Date(), tenderCurrency: "USD", tenderAmount: "10.00", method: "EFECTIVO", recordedById: a.admin.id },
    });
    const otherPayment = await prisma.duesPayment.create({
      data: { organizationId: a.org.id, studentId: s.id, academyId: a.academy.id, receivedOn: new Date(), tenderCurrency: "USD", tenderAmount: "10.00", method: "EFECTIVO", recordedById: a.admin.id },
    });
    await isolated(async (tx) => {
      const row = await tx.duesPaymentAttempt.create({ data: { organizationId: a.org.id, studentId: s.id, academyId: a.academy.id, submissionId: freshSubmissionId("xonce"), canonicalPayload: { operation: "PACKAGE" } } });
      await tx.duesPaymentAttempt.update({ where: { id: row.id }, data: { paymentId: firstPayment.id } });
      await refused(tx, () => tx.duesPaymentAttempt.update({ where: { id: row.id }, data: { paymentId: otherPayment.id } }), "only the outcome marker may be set, once");
    });
  });

  it("(X9) setting paymentId to a REAL payment belonging to a DIFFERENT organization is rejected by the composite foreign key", async () => {
    const d = freshDate();
    const sA = await newStudent(a, "xfk-a");
    const rA = await purchasePackageWithSubmissionIdentity(packageArgs(sA.id, d, freshSubmissionId("xfk-a")), deps({ now: nowAt(d) }));
    if (!rA.ok) throw new Error(`fixture: expected org A success, got ${JSON.stringify(rA)}`);

    const sB = await prisma.student.create({
      data: { organizationId: b.org.id, homeAcademyId: b.academy.id, firstName: "PurchaseSub", lastName: `xfkB${++studentCounter}`, phone: "00000000", email: `psub-xfkB-${studentCounter}-${suffix}@example.com`, currentRankId: await b.rankId("WHITE"), codeHash: `psub-xfkB-${studentCounter}-${suffix}`, status: "ACTIVE" },
    });
    // A standalone DuesPayment row, inserted directly (as test X7 above also does) — only the FK rejection below is
    // under test, so no real settlement/obligation machinery is needed to produce a genuine org-B payment id.
    const paidB = await prisma.duesPayment.create({
      data: { organizationId: b.org.id, studentId: sB.id, academyId: b.academy.id, receivedOn: new Date(), tenderCurrency: "USD", tenderAmount: "10.00", method: "EFECTIVO", recordedById: b.admin.id },
    });

    await isolated(async (tx) => {
      const row = await tx.duesPaymentAttempt.create({ data: { organizationId: a.org.id, studentId: sA.id, academyId: a.academy.id, submissionId: freshSubmissionId("xfk-a2"), canonicalPayload: { operation: "PACKAGE" } } });
      await refused(tx, () => tx.duesPaymentAttempt.update({ where: { id: row.id }, data: { paymentId: paidB.id } }), "DuesPaymentAttempt_organizationId_paymentId_studentId_fkey");
    });
  });

  it("(X11) setting paymentId to a REAL payment belonging to a DIFFERENT student in the SAME organization is rejected by the composite foreign key", async () => {
    const s1 = await newStudent(a, "xfk-student-1");
    const s2 = await newStudent(a, "xfk-student-2");
    const paid1 = await prisma.duesPayment.create({
      data: { organizationId: a.org.id, studentId: s1.id, academyId: a.academy.id, receivedOn: new Date(), tenderCurrency: "USD", tenderAmount: "10.00", method: "EFECTIVO", recordedById: a.admin.id },
    });

    await isolated(async (tx) => {
      // A fresh attempt row genuinely belonging to student 2 — student 2's own attempt pointed at student 1's real
      // payment id has no (organizationId, paymentId, studentId=s2.id) match in DuesPayment, so the FK itself rejects it.
      const row = await tx.duesPaymentAttempt.create({ data: { organizationId: a.org.id, studentId: s2.id, academyId: a.academy.id, submissionId: freshSubmissionId("xfk-student"), canonicalPayload: { operation: "PACKAGE" } } });
      await refused(tx, () => tx.duesPaymentAttempt.update({ where: { id: row.id }, data: { paymentId: paid1.id } }), "DuesPaymentAttempt_organizationId_paymentId_studentId_fkey");
    });
  });
});
