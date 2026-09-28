import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getTestPrismaClient } from "../helpers/test-db";
import { prisma as appPrisma } from "../../src/lib/prisma";
import { makeAccountingOrg } from "../helpers/accounting-org";
import type { TenantContext } from "../../src/lib/tenant/types";
import { createMonthlyObligation } from "../../src/lib/dues/ledger/create-monthly-obligation";
import { recordDuesPayment, recordDuesPaymentInTx } from "../../src/lib/dues/ledger/record-payment";
import { assessLateFeesForStudent } from "../../src/lib/dues/late-fee-assessment";
import { correctLateFeeAndSettle } from "../../src/lib/dues/ledger/correct-late-fee";
import type { LedgerActivation } from "../../src/lib/dues/ledger/activation";
import { versionRevision } from "../../src/lib/dues/config-input";

/**
 * Late-fee-correction brief, proved against the REAL test database, following the exact fixture/concurrency conventions
 * `late-fee-assessment.test.ts` already established. The brief's corrections are verification requirements, not proven claims:
 * every refusal-after-provisional-void case is checked to leave the fee row genuinely untouched, and the rollback mechanism
 * itself is proven by forcing a failure late in the transaction, not assumed from Prisma's own semantics.
 */
const prisma = getTestPrismaClient();
type Fixture = Awaited<ReturnType<typeof makeAccountingOrg>>;
const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
const ACTIVE: LedgerActivation = { isActive: async () => true };
const at = (isoLocal: string) => () => new Date(`${isoLocal}-06:00`); // Costa Rica, UTC-6 all year
const DEC_2030 = at("2030-12-01T12:00:00");
const deps = (extra: Record<string, unknown> = {}) => ({ activation: ACTIVE, now: DEC_2030, ...extra });

let a: Fixture;
let terms: { id: string };
let feePolicy: { id: string };

function context(over: Partial<TenantContext> = {}): TenantContext {
  return { kind: "tenant", actorUserId: a.admin.id, organizationId: a.org.id, organizationRole: "ADMIN", academyIds: "ALL", selfStudentId: null, linkedStudentId: null, ...over };
}

let studentCounter = 0;
async function newStudent(label: string) {
  const n = ++studentCounter;
  return prisma.student.create({
    data: {
      organizationId: a.org.id, homeAcademyId: a.academy.id, firstName: "Correct", lastName: `${label}${n}`, phone: "00000000",
      email: `correct-${label}-${n}-${suffix}@example.com`, currentRankId: await a.rankId("WHITE"), codeHash: `correct-${label}-${n}-${suffix}`, status: "ACTIVE",
    },
  });
}

/** A MONTHLY obligation (due the 20th, grace to the 5th of the next month), USD 100 + a USD 20 fee. */
async function newObligation(studentId: string, month = 10) {
  const r = await createMonthlyObligation({ context: context(), studentId, coverage: { year: 2030, month }, planTermsId: terms.id, policyVersionId: feePolicy.id }, deps());
  if (!r.ok) throw new Error(`fixture obligation failed: ${r.error}`);
  return r.obligationId;
}

/** Assesses a fee as of a given date, as `assessLateFeesForStudent`'s own real runner would (not a shortcut past it). */
async function assessAsOf(studentId: string, month: number, day: number) {
  const r = await assessLateFeesForStudent(context(), studentId, deps({ now: at(`2030-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}T12:00:00`) }));
  if (!r.ok) throw new Error(`fixture assessment failed: ${r.reason}`);
  return r.outcomes;
}

function feeIdFor(outcomes: Awaited<ReturnType<typeof assessAsOf>>, obligationId: string): string {
  const outcome = outcomes.find((o) => o.obligationId === obligationId);
  if (!outcome || !("feeId" in outcome) || !outcome.feeId) throw new Error(`fixture: no assessed fee for obligation ${obligationId}`);
  return outcome.feeId;
}

async function currentFee(feeId: string) {
  return prisma.duesLateFee.findUniqueOrThrow({ where: { id: feeId } });
}
function feeRevision(row: { removedAt: Date | null; removalKind: string | null }): string {
  return versionRevision({ removedAt: row.removedAt ? row.removedAt.toISOString() : null, removalKind: row.removalKind });
}

async function ledgerCounts(organizationId: string) {
  return {
    payments: await prisma.duesPayment.count({ where: { organizationId } }),
    settlements: await prisma.duesSettlement.count({ where: { organizationId } }),
    audits: await prisma.auditLog.count({ where: { organizationId, action: { in: ["duesPayment.record", "duesLateFee.void"] } } }),
  };
}

const correct = (over: Partial<Parameters<typeof correctLateFeeAndSettle>[0]> = {}, extraDeps: Record<string, unknown> = {}) =>
  correctLateFeeAndSettle(
    {
      context: context(),
      lateFeeId: "",
      expectedRevision: "",
      removalReason: "student showed a receipt dated the actual payment date",
      receivedOn: { year: 2030, month: 11, day: 5 },
      tender: { currency: "USD", amount: "100.00" },
      method: "EFECTIVO",
      maxBackdateDays: 90,
      ...over,
    },
    deps(extraDeps),
  );

/** A dedicated, test-controlled transaction that takes the student lock and holds it until `release()`. */
function holdStudentLock(studentId: string) {
  let started!: () => void;
  const startedPromise = new Promise<void>((r) => (started = r));
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const held = prisma.$transaction(
    async (tx) => {
      await tx.$queryRawUnsafe(`SELECT "id" FROM "Student" WHERE "id" = '${studentId}' FOR UPDATE`);
      started();
      await gate;
    },
    { timeout: 60_000 },
  );
  return { startedPromise, release, held };
}

async function waitUntilBlockedOnLock(matches: string[], timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = await prisma.$queryRawUnsafe<{ query: string }[]>(`SELECT query FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query IS NOT NULL`);
    if (rows.some((row) => matches.every((m) => row.query.includes(m)))) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

beforeAll(async () => {
  a = await makeAccountingOrg("CUMULATIVE", "correct-a");
  const plan = await prisma.paymentPlan.create({ data: { organizationId: a.org.id, academyId: a.academy.id, name: `Correct plan ${suffix}` } });
  terms = await prisma.paymentPlanTerms.create({
    data: { organizationId: a.org.id, planId: plan.id, effectiveYear: 2027, effectiveMonth: 1, priceAmount: "100.00", currency: "USD", monthsCovered: 1, createdById: a.admin.id },
  });
  feePolicy = await prisma.duesPolicyVersion.create({
    data: { organizationId: a.org.id, academyId: a.academy.id, effectiveYear: 2027, effectiveMonth: 1, dueDay: 20, graceDay: 5, lateFeeAmount: "20.00", lateFeeCurrency: "USD", createdById: a.admin.id },
  });
}, 60_000);

afterAll(async () => {
  if (a) {
    await prisma.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe("SET LOCAL session_replication_role = replica");
        for (const table of ["DuesSettlement", "DuesPayment", "DuesLateFee", "DuesCoverage", "DuesObligation"]) {
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

describe("correctLateFeeAndSettle: the brief's exact example", () => {
  it("assessed Nov 6 for a Nov 5 on-time payment, corrected successfully — fee voided, obligation settled, lateFeeId null", async () => {
    const s = await newStudent("example");
    const obligationId = await newObligation(s.id);
    const outcomes = await assessAsOf(s.id, 11, 6);
    const feeId = feeIdFor(outcomes, obligationId);
    expect(feeId).toBeTruthy();

    const before = await currentFee(feeId);
    const result = await correct({ lateFeeId: feeId, expectedRevision: feeRevision(before) });
    expect(result).toMatchObject({ ok: true, feeId });
    if (!result.ok) return;

    const settlement = await prisma.duesSettlement.findFirstOrThrow({ where: { id: result.settlementIds[0] } });
    expect(settlement.lateFeeId).toBeNull();
    const fee = await currentFee(feeId);
    expect(fee.removalKind).toBe("VOIDED");
    expect(fee.removalReason).toBeTruthy();
  });
});

describe("every refusal-after-provisional-void case leaves the fee untouched and writes nothing else", () => {
  it("wrong tender amount: notASelectableTotal, fee not voided", async () => {
    const s = await newStudent("wrongamount");
    const obligationId = await newObligation(s.id);
    const feeId = feeIdFor(await assessAsOf(s.id, 11, 6), obligationId);
    const before = await currentFee(feeId);
    const beforeCounts = await ledgerCounts(a.org.id);

    const result = await correct({ lateFeeId: feeId, expectedRevision: feeRevision(before), tender: { currency: "USD", amount: "1.00" } });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(["notASelectableTotal", "totalMismatch"]).toContain(result.error);

    const after = await currentFee(feeId);
    expect(after.removedAt).toBeNull();
    expect(await ledgerCounts(a.org.id)).toEqual(beforeCounts);
  });

  it("an older, still-unpaid obligation for the same student: notOldestFirst, fee not voided", async () => {
    const s = await newStudent("older");
    await newObligation(s.id, 9); // older, left unpaid
    const obligationId = await newObligation(s.id, 10);
    const feeId = feeIdFor(await assessAsOf(s.id, 11, 6), obligationId);
    const before = await currentFee(feeId);
    const beforeCounts = await ledgerCounts(a.org.id);

    const result = await correct({ lateFeeId: feeId, expectedRevision: feeRevision(before) });
    expect(result).toMatchObject({ ok: false, error: "notOldestFirst" });

    const after = await currentFee(feeId);
    expect(after.removedAt).toBeNull();
    expect(await ledgerCounts(a.org.id)).toEqual(beforeCounts);
  });

  it("a receivedOn outside maxBackdateDays: tooOld, fee not voided", async () => {
    const s = await newStudent("tooold");
    const obligationId = await newObligation(s.id);
    const feeId = feeIdFor(await assessAsOf(s.id, 11, 6), obligationId);
    const before = await currentFee(feeId);
    const beforeCounts = await ledgerCounts(a.org.id);

    const result = await correct({ lateFeeId: feeId, expectedRevision: feeRevision(before), receivedOn: { year: 2029, month: 1, day: 1 } });
    expect(result).toMatchObject({ ok: false, error: "tooOld" });

    const after = await currentFee(feeId);
    expect(after.removedAt).toBeNull();
    expect(await ledgerCounts(a.org.id)).toEqual(beforeCounts);
  });

  it("a future receivedOn: futureDate, fee not voided", async () => {
    // A date on-time against the grace deadline (Nov 5) AND in the future needs "today" set earlier than the default clock —
    // otherwise every future date is also past grace, and `notOnTime` (checked first) would mask `futureDate` entirely.
    const s = await newStudent("future");
    const obligationId = await newObligation(s.id);
    const feeId = feeIdFor(await assessAsOf(s.id, 11, 6), obligationId);
    const before = await currentFee(feeId);
    const beforeCounts = await ledgerCounts(a.org.id);

    const result = await correct({ lateFeeId: feeId, expectedRevision: feeRevision(before), receivedOn: { year: 2030, month: 11, day: 3 } }, { now: at("2030-11-01T12:00:00") });
    expect(result).toMatchObject({ ok: false, error: "futureDate" });

    const after = await currentFee(feeId);
    expect(after.removedAt).toBeNull();
    expect(await ledgerCounts(a.org.id)).toEqual(beforeCounts);
  });

  it("the target obligation already has an active settlement: alreadySettled, fee not voided", async () => {
    const s = await newStudent("settled");
    const obligationId = await newObligation(s.id);
    const feeId = feeIdFor(await assessAsOf(s.id, 11, 6), obligationId);
    // Already genuinely settled through the ordinary LATE path (tuition + fee together) — the fee stays active/linked.
    const paid = await recordDuesPayment(
      { context: context(), studentId: s.id, receivedOn: { year: 2030, month: 11, day: 10 }, tender: { currency: "USD", amount: "120.00" }, method: "EFECTIVO", obligationIds: [obligationId], maxBackdateDays: 90 },
      deps(),
    );
    expect(paid.ok).toBe(true);
    const before = await currentFee(feeId);
    expect(before.removedAt).toBeNull();
    const beforeCounts = await ledgerCounts(a.org.id);

    const result = await correct({ lateFeeId: feeId, expectedRevision: feeRevision(before) });
    expect(result).toMatchObject({ ok: false, error: "alreadySettled" });

    const after = await currentFee(feeId);
    expect(after.removedAt).toBeNull();
    expect(await ledgerCounts(a.org.id)).toEqual(beforeCounts);
  });
});

describe("the checks that gate voiding at all", () => {
  it("a claimed date that is not on time against the stored grace deadline: notOnTime, voids nothing", async () => {
    const s = await newStudent("notontime");
    const obligationId = await newObligation(s.id);
    const feeId = feeIdFor(await assessAsOf(s.id, 11, 6), obligationId);
    const before = await currentFee(feeId);

    const result = await correct({ lateFeeId: feeId, expectedRevision: feeRevision(before), receivedOn: { year: 2030, month: 11, day: 6 } }); // grace was Nov 5
    expect(result).toMatchObject({ ok: false, error: "notOnTime" });
    expect((await currentFee(feeId)).removedAt).toBeNull();
  });

  it("a non-ADMIN context is refused", async () => {
    const s = await newStudent("nonadmin");
    const obligationId = await newObligation(s.id);
    const feeId = feeIdFor(await assessAsOf(s.id, 11, 6), obligationId);
    const before = await currentFee(feeId);

    const result = await correct({ context: context({ organizationRole: "DIRECTOR" }), lateFeeId: feeId, expectedRevision: feeRevision(before) });
    expect(result).toMatchObject({ ok: false, error: "notFound" });
    expect((await currentFee(feeId)).removedAt).toBeNull();
  });

  it("a stale expectedRevision is refused", async () => {
    const s = await newStudent("stale");
    const obligationId = await newObligation(s.id);
    const feeId = feeIdFor(await assessAsOf(s.id, 11, 6), obligationId);

    const result = await correct({ lateFeeId: feeId, expectedRevision: "not-the-real-revision" });
    expect(result).toMatchObject({ ok: false, error: "stale" });
    expect((await currentFee(feeId)).removedAt).toBeNull();
  });

  it("an already-voided fee refuses a second attempt", async () => {
    const s = await newStudent("twice");
    const obligationId = await newObligation(s.id);
    const feeId = feeIdFor(await assessAsOf(s.id, 11, 6), obligationId);
    const first = await correct({ lateFeeId: feeId, expectedRevision: feeRevision(await currentFee(feeId)) });
    expect(first.ok).toBe(true);

    const second = await correct({ lateFeeId: feeId, expectedRevision: feeRevision(await currentFee(feeId)) });
    expect(second).toMatchObject({ ok: false, error: "alreadyRemoved" });
  });
});

describe("rollback proof: a failure late in the transaction rolls back everything, including the void", () => {
  it("forcing a failure right after the void and its audit row still leaves the fee un-voided and nothing else written", async () => {
    const s = await newStudent("rollback");
    const obligationId = await newObligation(s.id);
    const feeId = feeIdFor(await assessAsOf(s.id, 11, 6), obligationId);
    const before = await currentFee(feeId);
    const beforeCounts = await ledgerCounts(a.org.id);

    await expect(
      correct({ lateFeeId: feeId, expectedRevision: feeRevision(before) }, { afterVoidForTest: async () => { throw new Error("forced failure, proving rollback"); } }),
    ).rejects.toThrow("forced failure");

    const after = await currentFee(feeId);
    expect(after.removedAt).toBeNull(); // the provisional void did NOT survive
    expect(await ledgerCounts(a.org.id)).toEqual(beforeCounts);
  });
});

describe("concurrency: correction races assessment, an ordinary payment, and itself", () => {
  it("correction vs. a live assessLateFeesForStudent run for the same student: serialized on the student lock", async () => {
    const s = await newStudent("vsassess");
    const obligationId = await newObligation(s.id);
    const feeId = feeIdFor(await assessAsOf(s.id, 11, 6), obligationId);
    const revision = feeRevision(await currentFee(feeId));

    const { startedPromise, release, held } = holdStudentLock(s.id);
    await startedPromise;
    let correctionDone = false;
    const correcting = correct({ lateFeeId: feeId, expectedRevision: revision }).then((r) => ((correctionDone = true), r));
    const blocked = await waitUntilBlockedOnLock(['FROM "Student"', "FOR UPDATE"]);
    expect(blocked).toBe(true);
    expect(correctionDone).toBe(false);
    release();
    await held;
    expect((await correcting).ok).toBe(true);
  });

  it("two concurrent corrections targeting the same fee: only one wins, the loser refuses cleanly", async () => {
    const s = await newStudent("twocorrections");
    const obligationId = await newObligation(s.id);
    const feeId = feeIdFor(await assessAsOf(s.id, 11, 6), obligationId);
    const revision = feeRevision(await currentFee(feeId));

    const [r1, r2] = await Promise.all([correct({ lateFeeId: feeId, expectedRevision: revision }), correct({ lateFeeId: feeId, expectedRevision: revision })]);
    const results = [r1, r2];
    const wins = results.filter((r) => r.ok).length;
    const losses = results.filter((r) => !r.ok);
    expect(wins).toBe(1);
    expect(losses).toHaveLength(1);
    expect(["stale", "alreadyRemoved", "alreadySettled"]).toContain((losses[0] as { error: string }).error);
  });
});

describe("recordDuesPaymentInTx: called directly, enforces its own checks (bypassing the public wrapper entirely)", () => {
  it("a same-organization student outside the context's allowed branches is refused notFound", async () => {
    const otherAcademy = await prisma.academy.create({ data: { organizationId: a.org.id, name: `Other ${suffix}`, slug: `other-${suffix}`, kioskTokenHash: `other-${suffix}` } });
    const s = await newStudent("scopecheck");
    const obligationId = await newObligation(s.id);
    const scopedElsewhere = context({ organizationRole: "DIRECTOR", academyIds: [otherAcademy.id] });

    const result = await appPrisma.$transaction((tx) =>
      recordDuesPaymentInTx(
        tx,
        {
          context: scopedElsewhere,
          student: { id: s.id, homeAcademyId: a.academy.id },
          receivedOn: { year: 2030, month: 11, day: 5 },
          tender: { currency: "USD", amount: "100.00" },
          method: "EFECTIVO",
          obligationIds: [obligationId],
          maxBackdateDays: 90,
        },
        deps(),
      ),
    );
    expect(result).toMatchObject({ ok: false, error: "notFound" });
    await prisma.academy.delete({ where: { id: otherAcademy.id } });
  });
});
