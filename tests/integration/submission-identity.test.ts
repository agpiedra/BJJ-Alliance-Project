import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getTestPrismaClient } from "../helpers/test-db";
import { makeAccountingOrg } from "../helpers/accounting-org";
import { hashSecret } from "../../src/lib/crypto";
import type { TenantContext } from "../../src/lib/tenant/types";
import { createMonthlyObligation } from "../../src/lib/dues/ledger/create-monthly-obligation";
import { recordDuesPayment } from "../../src/lib/dues/ledger/record-payment";
import { enterExchangeRateQuote } from "../../src/lib/dues/ledger/exchange-rate";
import { resolveAwaitingRateReceipt, cancelAwaitingRateReceipt } from "../../src/lib/dues/ledger/awaiting-rate-receipt";
import { reversePayment } from "../../src/lib/dues/ledger/reverse-payment";
import type { LedgerActivation } from "../../src/lib/dues/ledger/activation";
import type { Tx } from "../../src/lib/dues/ledger/common";

// getSubmissionOutcome calls resolveActionContext -> auth(), which needs a Next.js request scope that doesn't exist
// here — mocked exactly as awaiting-rate-receipt.test.ts already does for correctAssignment, dynamically imported
// only after the mock is registered.
let currentSession: { user: { id: string; role: string } } | null = null;
vi.mock("@/auth", () => ({ auth: () => Promise.resolve(currentSession), signIn: vi.fn() }));
const { recordDuesPaymentWithSubmissionIdentity, getSubmissionOutcome } = await import("../../src/lib/dues/ledger/submission-identity");

/**
 * Payment-submission-identity prerequisite, proved against the REAL test database. Does not re-prove
 * recordDuesPayment's own settlement/cross-currency/capture logic — that is already proved in
 * dues-ledger-writers.test.ts, dues-currency-settlement.test.ts and awaiting-rate-receipt.test.ts; this file proves
 * only the identity layer wrapped around it: genuine concurrent-overlap arbitration (winner-commit and
 * winner-rollback), payload-mismatch refusal, rollback leaving no row, capture/resolution/cancellation/reversal
 * replay semantics, getSubmissionOutcome's three distinct authorization outcomes, tenant isolation, and the two
 * database-enforced guarantees (payload immutability from the first UPDATE onward, unconditional delete rejection).
 */
const prisma = getTestPrismaClient();
type Fixture = Awaited<ReturnType<typeof makeAccountingOrg>>;
type Db = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
const ACTIVE: LedgerActivation = { isActive: async () => true };
const at = (isoLocal: string) => () => new Date(`${isoLocal}-06:00`); // Costa Rica, UTC-6 all year
const deps = (extra: Record<string, unknown> = {}) => ({ activation: ACTIVE, ...extra });

let a: Fixture;
let b: Fixture;
let academy2: { id: string }; // a second branch of org A
let director: { id: string }; // DIRECTOR of org A, scoped ONLY to academy2
let instructor: { id: string }; // INSTRUCTOR of org A
let usdTerms: { id: string };
let usdPolicy: { id: string };
let usdTermsB: { id: string };
let usdPolicyB: { id: string };

function context(over: Partial<TenantContext> = {}): TenantContext {
  return { kind: "tenant", actorUserId: a.admin.id, organizationId: a.org.id, organizationRole: "ADMIN", academyIds: "ALL", selfStudentId: null, linkedStudentId: null, ...over };
}
function contextB(over: Partial<TenantContext> = {}): TenantContext {
  return { kind: "tenant", actorUserId: b.admin.id, organizationId: b.org.id, organizationRole: "ADMIN", academyIds: "ALL", selfStudentId: null, linkedStudentId: null, ...over };
}

let studentCounter = 0;
async function newStudent(fx: Fixture, academyId: string, label: string) {
  const n = ++studentCounter;
  return prisma.student.create({
    data: {
      organizationId: fx.org.id, homeAcademyId: academyId, firstName: "Submission", lastName: `${label}${n}`, phone: "00000000",
      email: `sub-${label}-${n}-${suffix}@example.com`, currentRankId: await fx.rankId("WHITE"), codeHash: `sub-${label}-${n}-${suffix}`, status: "ACTIVE",
    },
  });
}

// Each test gets its own never-reused receivedOn, running DESCENDING (resolveEffectiveQuote's own fallback rule
// means an earlier-declared test's own entered rate would otherwise leak forward into a later-declared test's
// capture check — the identical technique awaiting-rate-receipt.test.ts already uses, starting from a year range
// that cannot collide with either that file's 2099-downward range or dues-currency-settlement.test.ts's own 2030).
let yearCounter = 2090;
function freshDate(day = 5, month = 7): { year: number; month: number; day: number } {
  return { year: yearCounter--, month, day };
}
const nowAt = (d: { year: number; month: number; day: number }) => at(`${d.year}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}T12:00:00`);

let submissionCounter = 0;
function freshSubmissionId(label: string): string {
  return `sub-${label}-${suffix}-${++submissionCounter}`;
}

/** A MONTHLY obligation, coverage = the month before `d`, due day 20 / grace day 5 — on time for a payment received on `d` (day <= 5). */
async function oneMonth(ctx: TenantContext, studentId: string, d: { year: number; month: number; day: number }, terms: { id: string }, policy: { id: string }): Promise<string> {
  const coverage = d.month === 1 ? { year: d.year - 1, month: 12 } : { year: d.year, month: d.month - 1 };
  const r = await createMonthlyObligation({ context: ctx, studentId, coverage, planTermsId: terms.id, policyVersionId: policy.id }, deps({ now: nowAt(d) }));
  if (!r.ok) throw new Error(`fixture obligation failed: ${r.error}`);
  return r.obligationId;
}

/** Two USD 100.00 obligations outstanding for one student as of `d`: [older, newer]. Presenting them as [newer, older]
 * to recordDuesPaymentWithSubmissionIdentity is a genuine, reachable notOldestFirst refusal. */
async function twoOutstandingMonths(studentId: string, d: { year: number; month: number; day: number }): Promise<[string, string]> {
  const newer = await oneMonth(context(), studentId, d, usdTerms, usdPolicy);
  const olderCoverage = d.month <= 2 ? { year: d.year - 1, month: d.month + 10 } : { year: d.year, month: d.month - 2 };
  const r = await createMonthlyObligation({ context: context(), studentId, coverage: olderCoverage, planTermsId: usdTerms.id, policyVersionId: usdPolicy.id }, deps({ now: nowAt(d) }));
  if (!r.ok) throw new Error(`fixture: older obligation failed: ${r.error}`);
  return [r.obligationId, newer];
}

// --- Genuine lock-wait evidence: a second, genuinely concurrent INSERT ... ON CONFLICT DO NOTHING against the same
// (organizationId, submissionId) key BLOCKS on the first's still-open, uncommitted row — it does not merely lose a
// `Promise.all` timing race. Proven with Postgres's own authoritative pg_blocking_pids(), never inferred from timing.
async function waitUntil(predicate: () => Promise<boolean>, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}
/** The backend pid of a session currently blocked on a lock while executing a `DuesPaymentAttempt` INSERT — Prisma's
 * raw queries are parameterized, so no bound value ever appears in the query text this matches against. */
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

// --- DB-constraint probes (tests 10/11): an isolated transaction, always rolled back, with a SAVEPOINT around each
// refusal probe so the refusal doesn't abort the surrounding transaction. The identical pattern dues-ledger-schema.test.ts
// already establishes for this exact class of proof.
class Rollback extends Error {}
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

beforeAll(async () => {
  a = await makeAccountingOrg("CUMULATIVE", "subid-a");
  b = await makeAccountingOrg("CUMULATIVE", "subid-b");
  academy2 = await prisma.academy.create({ data: { organizationId: a.org.id, name: "Submission A2", slug: `subid-a2-${suffix}`, kioskTokenHash: `subid-a2-${suffix}` } });

  const directorUser = await prisma.user.create({ data: { email: `subid-director-${suffix}@example.com`, passwordHash: await hashSecret("irrelevant-password-123"), role: "DIRECTOR" } });
  await prisma.organizationMembership.create({ data: { userId: directorUser.id, organizationId: a.org.id, role: "DIRECTOR" } });
  await prisma.staffAssignment.create({ data: { userId: directorUser.id, organizationId: a.org.id, academyId: academy2.id, role: "DIRECTOR" } });
  director = directorUser;

  const instructorUser = await prisma.user.create({ data: { email: `subid-instructor-${suffix}@example.com`, passwordHash: await hashSecret("irrelevant-password-123"), role: "INSTRUCTOR" } });
  await prisma.organizationMembership.create({ data: { userId: instructorUser.id, organizationId: a.org.id, role: "INSTRUCTOR" } });
  instructor = instructorUser;

  const planA = await prisma.paymentPlan.create({ data: { organizationId: a.org.id, academyId: a.academy.id, name: `Submission USD plan ${suffix}` } });
  usdTerms = await prisma.paymentPlanTerms.create({
    data: { organizationId: a.org.id, planId: planA.id, effectiveYear: 2027, effectiveMonth: 1, priceAmount: "100.00", currency: "USD", monthsCovered: 1, createdById: a.admin.id },
  });
  usdPolicy = await prisma.duesPolicyVersion.create({
    data: { organizationId: a.org.id, academyId: a.academy.id, effectiveYear: 2027, effectiveMonth: 1, dueDay: 20, graceDay: 5, lateFeeAmount: "20.00", lateFeeCurrency: "USD", createdById: a.admin.id },
  });

  const planB = await prisma.paymentPlan.create({ data: { organizationId: b.org.id, academyId: b.academy.id, name: `Submission USD plan B ${suffix}` } });
  usdTermsB = await prisma.paymentPlanTerms.create({
    data: { organizationId: b.org.id, planId: planB.id, effectiveYear: 2027, effectiveMonth: 1, priceAmount: "100.00", currency: "USD", monthsCovered: 1, createdById: b.admin.id },
  });
  usdPolicyB = await prisma.duesPolicyVersion.create({
    data: { organizationId: b.org.id, academyId: b.academy.id, effectiveYear: 2027, effectiveMonth: 1, dueDay: 20, graceDay: 5, lateFeeAmount: "20.00", lateFeeCurrency: "USD", createdById: b.admin.id },
  });
}, 60_000);

afterAll(async () => {
  for (const fx of [a, b]) {
    if (!fx) continue;
    await prisma.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe("SET LOCAL session_replication_role = replica");
        for (const table of ["DuesPaymentAttempt", "DuesSettlement", "DuesPayment", "DuesLateFee", "DuesCoverage", "DuesObligation", "ExchangeRateQuote", "AwaitingRateReceipt"]) {
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
  if (director) await prisma.staffAssignment.deleteMany({ where: { userId: director.id } });
  if (director || instructor) {
    await prisma.organizationMembership.deleteMany({ where: { userId: { in: [director?.id, instructor?.id].filter((x): x is string => !!x) } } });
    await prisma.user.deleteMany({ where: { id: { in: [director?.id, instructor?.id].filter((x): x is string => !!x) } } });
  }
  if (academy2) await prisma.academy.deleteMany({ where: { id: academy2.id } });
  await a?.drop();
  await b?.drop();
}, 120_000);

describe("concurrency: genuine overlap on the identity row", () => {
  it("(1) winner-commit: the second INSERT genuinely blocks on the first's uncommitted row, then replays the committed outcome without a second write", async () => {
    const d = freshDate();
    const s = await newStudent(a, a.academy.id, "conc1");
    const ob = await oneMonth(context(), s.id, d, usdTerms, usdPolicy);
    const submissionId = freshSubmissionId("conc1");
    const argsFor = () => ({ context: context(), studentId: s.id, receivedOn: d, tender: { currency: "USD" as const, amount: "100.00" }, method: "EFECTIVO" as const, obligationIds: [ob], maxBackdateDays: 5, submissionId });

    let pid1: number | undefined;
    let release1!: () => void;
    const gate1 = new Promise<void>((resolve) => { release1 = resolve; });
    const r1Promise = recordDuesPaymentWithSubmissionIdentity(
      argsFor(),
      deps({
        now: nowAt(d),
        afterSubmissionIdentityInsertForTest: async (tx: Tx) => {
          const rows = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
          pid1 = rows[0].pid;
          await gate1;
        },
      }),
    );
    expect(await waitUntil(async () => pid1 !== undefined), "the first attempt must reach the identity insert").toBe(true);

    const r2Promise = recordDuesPaymentWithSubmissionIdentity(argsFor(), deps({ now: nowAt(d) }));
    const waiterPid = await findBlockedOnInsert();
    expect(waiterPid, "the second attempt's INSERT must genuinely block, not merely lose a timing race").not.toBeNull();
    expect(await isBlockedBy(waiterPid!, pid1!)).toBe(true);

    release1();
    const [r1, r2] = await Promise.all([r1Promise, r2Promise]);
    if (!r1.ok) throw new Error(`fixture: expected the first attempt to succeed, got ${JSON.stringify(r1)}`);
    expect(r2).toEqual({ ok: true, paymentId: r1.paymentId, replay: true });

    expect(await prisma.duesPaymentAttempt.count({ where: { organizationId: a.org.id, submissionId } })).toBe(1);
    expect(await prisma.duesPayment.count({ where: { organizationId: a.org.id, studentId: s.id } })).toBe(1);
  });

  it("(2) winner-rollback: the first genuinely refuses and rolls back; the second's blocked INSERT then succeeds as a genuinely fresh attempt", async () => {
    const d = freshDate();
    const s = await newStudent(a, a.academy.id, "conc2");
    const [, newer] = await twoOutstandingMonths(s.id, d);
    const submissionId = freshSubmissionId("conc2");
    // Choosing only the NEWER obligation while an OLDER one remains unselected is the genuine oldest-first violation
    // (resolveMonthlyDebtItemsInTx compares the CHOSEN set against the true oldest-first prefix, not array order).
    const wrongOrderArgs = { context: context(), studentId: s.id, receivedOn: d, tender: { currency: "USD" as const, amount: "100.00" }, method: "EFECTIVO" as const, obligationIds: [newer], maxBackdateDays: 5, submissionId };

    let pid1: number | undefined;
    let release1!: () => void;
    const gate1 = new Promise<void>((resolve) => { release1 = resolve; });
    const r1Promise = recordDuesPaymentWithSubmissionIdentity(
      wrongOrderArgs,
      deps({
        now: nowAt(d),
        afterSubmissionIdentityInsertForTest: async (tx: Tx) => {
          const rows = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
          pid1 = rows[0].pid;
          await gate1;
        },
      }),
    );
    expect(await waitUntil(async () => pid1 !== undefined), "the first attempt must reach the identity insert").toBe(true);

    const r2Promise = recordDuesPaymentWithSubmissionIdentity(wrongOrderArgs, deps({ now: nowAt(d) }));
    const waiterPid = await findBlockedOnInsert();
    expect(waiterPid, "the second attempt's INSERT must genuinely block on the first's uncommitted row").not.toBeNull();
    expect(await isBlockedBy(waiterPid!, pid1!)).toBe(true);

    release1();
    const [r1, r2] = await Promise.all([r1Promise, r2Promise]);
    expect(r1).toMatchObject({ ok: false, error: "notOldestFirst" });
    // Having waited for the first's genuine rollback, the second's own insert wins fresh — refused identically (the
    // same skipped-older selection), never a replay of a nonexistent row.
    expect(r2).toMatchObject({ ok: false, error: "notOldestFirst" });
    expect(await prisma.duesPaymentAttempt.count({ where: { organizationId: a.org.id, submissionId } })).toBe(0);
  });
});

describe("payload identity", () => {
  it("(3) a differing payload under the same submissionId refuses submissionPayloadMismatch, writes nothing, doesn't disturb the original row", async () => {
    const d = freshDate();
    const s = await newStudent(a, a.academy.id, "mismatch");
    const ob = await oneMonth(context(), s.id, d, usdTerms, usdPolicy);
    const submissionId = freshSubmissionId("mismatch");
    const original = { context: context(), studentId: s.id, receivedOn: d, tender: { currency: "USD" as const, amount: "100.00" }, method: "EFECTIVO" as const, obligationIds: [ob], maxBackdateDays: 5, submissionId };
    const r1 = await recordDuesPaymentWithSubmissionIdentity(original, deps({ now: nowAt(d) }));
    expect(r1).toMatchObject({ ok: true });

    const before = await prisma.duesPaymentAttempt.findFirstOrThrow({ where: { organizationId: a.org.id, submissionId } });
    const differing = { ...original, tender: { currency: "USD" as const, amount: "99.00" } };
    const r2 = await recordDuesPaymentWithSubmissionIdentity(differing, deps({ now: nowAt(d) }));
    expect(r2).toEqual({ ok: false, error: "submissionPayloadMismatch" });

    const after = await prisma.duesPaymentAttempt.findFirstOrThrow({ where: { organizationId: a.org.id, submissionId } });
    expect(after).toEqual(before);
    expect(await prisma.duesPaymentAttempt.count({ where: { organizationId: a.org.id, submissionId } })).toBe(1);
  });

  it("(4) a genuine refusal leaves zero DuesPaymentAttempt rows; the same submissionId is accepted as genuinely fresh afterward", async () => {
    const d = freshDate();
    const s = await newStudent(a, a.academy.id, "refusal4");
    const [older, newer] = await twoOutstandingMonths(s.id, d);
    const submissionId = freshSubmissionId("refusal4");
    // Skipping the OLDER obligation while choosing only the newer one is the genuine oldest-first violation.
    const skippingOlder = { context: context(), studentId: s.id, receivedOn: d, tender: { currency: "USD" as const, amount: "100.00" }, method: "EFECTIVO" as const, obligationIds: [newer], maxBackdateDays: 5, submissionId };
    const refusal = await recordDuesPaymentWithSubmissionIdentity(skippingOlder, deps({ now: nowAt(d) }));
    expect(refusal).toMatchObject({ ok: false, error: "notOldestFirst" });
    expect(await prisma.duesPaymentAttempt.count({ where: { organizationId: a.org.id, submissionId } })).toBe(0);

    // older is now two months stale as of `d` (its grace deadline, fixed to day 5 of the month after its own
    // coverage month, has already passed) — its own late fee (20.00) is genuinely owed alongside both tuitions.
    const bothOldestFirst = { ...skippingOlder, obligationIds: [older, newer], tender: { currency: "USD" as const, amount: "220.00" } };
    const fresh = await recordDuesPaymentWithSubmissionIdentity(bothOldestFirst, deps({ now: nowAt(d) }));
    expect(fresh).toMatchObject({ ok: true });
  });
});

describe("capture, resolution, cancellation and reversal replay", () => {
  it("(5) capture-then-rate-entry replay: a replayed submission after a rate is entered still returns the original captured receipt, never settles for real", async () => {
    const d = freshDate();
    const s = await newStudent(a, a.academy.id, "capture");
    const ob = await oneMonth(context(), s.id, d, usdTerms, usdPolicy);
    const submissionId = freshSubmissionId("capture");
    const args = { context: context(), studentId: s.id, receivedOn: d, tender: { currency: "CRC" as const, amount: "50000.00" }, method: "EFECTIVO" as const, obligationIds: [ob], maxBackdateDays: 5, submissionId };
    const r1 = await recordDuesPaymentWithSubmissionIdentity(args, deps({ now: nowAt(d) }));
    if (r1.ok || r1.error !== "captured") throw new Error(`fixture: expected capture, got ${JSON.stringify(r1)}`);
    const receiptId = r1.receiptId!;

    const rate = await enterExchangeRateQuote({ context: context(), quoteDate: d, value: "500.00", expectedCurrentRevision: 0 }, deps());
    expect(rate).toMatchObject({ ok: true });

    const r2 = await recordDuesPaymentWithSubmissionIdentity(args, deps({ now: nowAt(d) }));
    expect(r2).toEqual({ ok: false, error: "captured", receiptId });

    expect(await prisma.duesPayment.count({ where: { organizationId: a.org.id, resolvedFromReceiptId: receiptId } })).toBe(0);
    expect(await prisma.duesPaymentAttempt.count({ where: { organizationId: a.org.id, submissionId } })).toBe(1);
  });

  it("(6a) a replayed receipt since RESOLVED reports its real current status via getSubmissionOutcome, never implying still-pending", async () => {
    const d = freshDate();
    const s = await newStudent(a, a.academy.id, "resolved6a");
    const ob = await oneMonth(context(), s.id, d, usdTerms, usdPolicy);
    const submissionId = freshSubmissionId("resolved6a");
    const args = { context: context(), studentId: s.id, receivedOn: d, tender: { currency: "CRC" as const, amount: "50000.00" }, method: "EFECTIVO" as const, obligationIds: [ob], maxBackdateDays: 5, submissionId };
    const captured = await recordDuesPaymentWithSubmissionIdentity(args, deps({ now: nowAt(d) }));
    if (captured.ok || captured.error !== "captured") throw new Error(`fixture: expected capture, got ${JSON.stringify(captured)}`);
    await enterExchangeRateQuote({ context: context(), quoteDate: d, value: "500.00", expectedCurrentRevision: 0 }, deps());
    const resolved = await resolveAwaitingRateReceipt({ context: context(), receiptId: captured.receiptId! }, deps({ now: nowAt(d) }));
    expect(resolved).toMatchObject({ ok: true });

    currentSession = { user: { id: a.admin.id, role: "ADMIN" } };
    expect(await getSubmissionOutcome(a.org.id, submissionId)).toEqual({ status: "committed", outcome: { kind: "receipt", receiptId: captured.receiptId, currentStatus: "RESOLVED" } });

    const replay = await recordDuesPaymentWithSubmissionIdentity(args, deps({ now: nowAt(d) }));
    expect(replay).toEqual({ ok: false, error: "captured", receiptId: captured.receiptId });
  });

  it("(6b) a replayed receipt since CANCELLED reports that via getSubmissionOutcome", async () => {
    const d = freshDate();
    const s = await newStudent(a, a.academy.id, "cancelled6b");
    const ob = await oneMonth(context(), s.id, d, usdTerms, usdPolicy);
    const submissionId = freshSubmissionId("cancelled6b");
    const args = { context: context(), studentId: s.id, receivedOn: d, tender: { currency: "CRC" as const, amount: "50000.00" }, method: "EFECTIVO" as const, obligationIds: [ob], maxBackdateDays: 5, submissionId };
    const captured = await recordDuesPaymentWithSubmissionIdentity(args, deps({ now: nowAt(d) }));
    if (captured.ok || captured.error !== "captured") throw new Error(`fixture: expected capture, got ${JSON.stringify(captured)}`);
    const cancelled = await cancelAwaitingRateReceipt({ context: context(), receiptId: captured.receiptId!, reason: "owner changed their mind" }, deps());
    expect(cancelled).toMatchObject({ ok: true });

    currentSession = { user: { id: a.admin.id, role: "ADMIN" } };
    expect(await getSubmissionOutcome(a.org.id, submissionId)).toEqual({ status: "committed", outcome: { kind: "receipt", receiptId: captured.receiptId, currentStatus: "CANCELLED" } });
  });

  it("(6c / 7) a replayed payment since reversed reports currentlyReversed:true, and the now-outstanding-again obligation is NOT re-settled", async () => {
    const d = freshDate();
    const s = await newStudent(a, a.academy.id, "reversed7");
    const ob = await oneMonth(context(), s.id, d, usdTerms, usdPolicy);
    const submissionId = freshSubmissionId("reversed7");
    const args = { context: context(), studentId: s.id, receivedOn: d, tender: { currency: "USD" as const, amount: "100.00" }, method: "EFECTIVO" as const, obligationIds: [ob], maxBackdateDays: 5, submissionId };
    const r1 = await recordDuesPaymentWithSubmissionIdentity(args, deps({ now: nowAt(d) }));
    if (!r1.ok) throw new Error(`fixture: expected success, got ${JSON.stringify(r1)}`);
    const reversed = await reversePayment({ context: context(), paymentId: r1.paymentId, reversalReason: "test reversal" }, deps());
    expect(reversed).toMatchObject({ ok: true });

    const settlementsBefore = await prisma.duesSettlement.count({ where: { organizationId: a.org.id, obligationId: ob } });
    const replay = await recordDuesPaymentWithSubmissionIdentity(args, deps({ now: nowAt(d) }));
    expect(replay).toEqual({ ok: true, paymentId: r1.paymentId, replay: true });
    expect(await prisma.duesSettlement.count({ where: { organizationId: a.org.id, obligationId: ob } })).toBe(settlementsBefore);

    currentSession = { user: { id: a.admin.id, role: "ADMIN" } };
    expect(await getSubmissionOutcome(a.org.id, submissionId)).toEqual({ status: "committed", outcome: { kind: "payment", paymentId: r1.paymentId, currentlyReversed: true } });
  });
});

describe("getSubmissionOutcome authorization — three deliberately distinct outcomes", () => {
  it("(8a) no session resolves notFound, never throws", async () => {
    currentSession = null;
    expect(await getSubmissionOutcome(a.org.id, "whatever-no-session")).toEqual({ status: "notFound" });
  });

  it("(8b) a genuine member whose role is neither ADMIN nor DIRECTOR (INSTRUCTOR) is REJECTED, never resolves to any status", async () => {
    currentSession = { user: { id: instructor.id, role: "INSTRUCTOR" } };
    await expect(getSubmissionOutcome(a.org.id, "whatever-wrong-role")).rejects.toThrow("FORBIDDEN");
  });

  it("(8c) a genuine DIRECTOR of a DIFFERENT branch than the attempt's own RESOLVES notFound — a failed scope check, not a rejection", async () => {
    const d = freshDate();
    const s = await newStudent(a, a.academy.id, "scope8c"); // attempt's academyId = a.academy.id, not academy2
    const ob = await oneMonth(context(), s.id, d, usdTerms, usdPolicy);
    const submissionId = freshSubmissionId("scope8c");
    const r = await recordDuesPaymentWithSubmissionIdentity(
      { context: context(), studentId: s.id, receivedOn: d, tender: { currency: "USD" as const, amount: "100.00" }, method: "EFECTIVO" as const, obligationIds: [ob], maxBackdateDays: 5, submissionId },
      deps({ now: nowAt(d) }),
    );
    expect(r).toMatchObject({ ok: true });

    currentSession = { user: { id: director.id, role: "DIRECTOR" } }; // scoped only to academy2
    expect(await getSubmissionOutcome(a.org.id, submissionId)).toEqual({ status: "notFound" });
  });
});

describe("tenant isolation", () => {
  it("(9) the identical literal submissionId is independently usable by two organizations, never crossing", async () => {
    const submissionId = `shared-${suffix}`;

    const dA = freshDate();
    const sA = await newStudent(a, a.academy.id, "isoA");
    const obA = await oneMonth(context(), sA.id, dA, usdTerms, usdPolicy);
    const rA = await recordDuesPaymentWithSubmissionIdentity(
      { context: context(), studentId: sA.id, receivedOn: dA, tender: { currency: "USD" as const, amount: "100.00" }, method: "EFECTIVO" as const, obligationIds: [obA], maxBackdateDays: 5, submissionId },
      deps({ now: nowAt(dA) }),
    );
    if (!rA.ok) throw new Error(`fixture: expected org A success, got ${JSON.stringify(rA)}`);

    const dB = freshDate();
    const sB = await newStudent(b, b.academy.id, "isoB");
    const obB = await oneMonth(contextB(), sB.id, dB, usdTermsB, usdPolicyB);
    const rB = await recordDuesPaymentWithSubmissionIdentity(
      { context: contextB(), studentId: sB.id, receivedOn: dB, tender: { currency: "USD" as const, amount: "100.00" }, method: "EFECTIVO" as const, obligationIds: [obB], maxBackdateDays: 5, submissionId },
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

describe("database-enforced guarantees", () => {
  it("(10) canonicalPayload is immutable from the very first UPDATE onward; the one legitimate finalizing UPDATE still succeeds", async () => {
    const d = freshDate();
    const s = await newStudent(a, a.academy.id, "immut10");
    const ob = await oneMonth(context(), s.id, d, usdTerms, usdPolicy);
    const paid = await recordDuesPayment({ context: context(), studentId: s.id, receivedOn: d, tender: { currency: "USD", amount: "100.00" }, method: "EFECTIVO", obligationIds: [ob], maxBackdateDays: 5 }, deps({ now: nowAt(d) }));
    if (!paid.ok) throw new Error(`fixture: payment failed: ${JSON.stringify(paid)}`);

    await isolated(async (tx) => {
      const row = await tx.duesPaymentAttempt.create({
        data: { organizationId: a.org.id, studentId: s.id, academyId: a.academy.id, submissionId: freshSubmissionId("immut10"), canonicalPayload: { probe: true } },
      });
      await refused(
        tx,
        () => tx.duesPaymentAttempt.update({ where: { id: row.id }, data: { canonicalPayload: { probe: false } } }),
        "only the outcome marker may be set, once",
      );
      await tx.duesPaymentAttempt.update({ where: { id: row.id }, data: { paymentId: paid.paymentId } });
      const after = await tx.duesPaymentAttempt.findUniqueOrThrow({ where: { id: row.id } });
      expect(after.paymentId).toBe(paid.paymentId);
    });
  });

  it("(11) deletion is refused unconditionally, even once finalized; the referenced payment is untouched", async () => {
    const d = freshDate();
    const s = await newStudent(a, a.academy.id, "nodelete11");
    const ob = await oneMonth(context(), s.id, d, usdTerms, usdPolicy);
    const paid = await recordDuesPayment({ context: context(), studentId: s.id, receivedOn: d, tender: { currency: "USD", amount: "100.00" }, method: "EFECTIVO", obligationIds: [ob], maxBackdateDays: 5 }, deps({ now: nowAt(d) }));
    if (!paid.ok) throw new Error(`fixture: payment failed: ${JSON.stringify(paid)}`);
    const beforePayment = JSON.stringify(await prisma.duesPayment.findUniqueOrThrow({ where: { id: paid.paymentId } }));

    await isolated(async (tx) => {
      const row = await tx.duesPaymentAttempt.create({
        data: { organizationId: a.org.id, studentId: s.id, academyId: a.academy.id, submissionId: freshSubmissionId("nodelete11"), canonicalPayload: { probe: true } },
      });
      await tx.duesPaymentAttempt.update({ where: { id: row.id }, data: { paymentId: paid.paymentId } });
      await refused(tx, () => tx.duesPaymentAttempt.delete({ where: { id: row.id } }), "rows are never deleted");
    });

    expect(JSON.stringify(await prisma.duesPayment.findUniqueOrThrow({ where: { id: paid.paymentId } }))).toBe(beforePayment);
  });
});
