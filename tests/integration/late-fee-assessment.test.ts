import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getTestPrismaClient } from "../helpers/test-db";
import { prisma as appPrisma } from "../../src/lib/prisma";
import { makeAccountingOrg } from "../helpers/accounting-org";
import type { TenantContext } from "../../src/lib/tenant/types";
import { createMonthlyObligation } from "../../src/lib/dues/ledger/create-monthly-obligation";
import { recordDuesPayment } from "../../src/lib/dues/ledger/record-payment";
import { assessLateFeeInTx } from "../../src/lib/dues/ledger/record-payment";
import { assessLateFeesForStudent } from "../../src/lib/dues/late-fee-assessment";
import type { LedgerActivation } from "../../src/lib/dues/ledger/activation";

/**
 * Late-fee-assessment brief, proved against the REAL test database, following the exact fixture/concurrency conventions
 * `dues-ledger-writers.test.ts` and `monthly-generation.test.ts` already established. §5/§6's corrections are verification
 * requirements, not proven claims: both concurrency orders are tested for what they actually produce, and the P2002
 * disambiguation is tested directly, not assumed from the code reading correct.
 */
const prisma = getTestPrismaClient();
type Fixture = Awaited<ReturnType<typeof makeAccountingOrg>>;
const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
const ACTIVE: LedgerActivation = { isActive: async () => true };
const at = (isoLocal: string) => () => new Date(`${isoLocal}-06:00`); // Costa Rica, UTC-6 all year
const DEC_2030 = at("2030-12-01T12:00:00");
const deps = (now: () => Date = DEC_2030) => ({ activation: ACTIVE, now });

let a: Fixture;
let zeroFeeAcademy: { id: string };
let planId: string;
let zeroFeePlanId: string;
let terms: { id: string };
let zeroFeeTerms: { id: string };
let zeroFeePolicy: { id: string };
let feePolicy: { id: string };

function context(over: Partial<TenantContext> = {}): TenantContext {
  return { kind: "tenant", actorUserId: a.admin.id, organizationId: a.org.id, organizationRole: "ADMIN", academyIds: "ALL", selfStudentId: null, linkedStudentId: null, ...over };
}

let studentCounter = 0;
async function newStudent(label: string, academyId: string = a.academy.id) {
  const n = ++studentCounter;
  return prisma.student.create({
    data: {
      organizationId: a.org.id, homeAcademyId: academyId, firstName: "Fee", lastName: `${label}${n}`, phone: "00000000",
      email: `fee-${label}-${n}-${suffix}@example.com`, currentRankId: await a.rankId("WHITE"), codeHash: `fee-${label}-${n}-${suffix}`, status: "ACTIVE",
    },
  });
}

/** A MONTHLY obligation (due the 20th, grace to the 5th of the next month), USD 100 + the given policy's fee. Each policy lives
 * on its own branch — PaymentPlanTerms/DuesPolicyVersion are versioned per branch, so two policies on the SAME branch would make
 * only the later-effective one current, not a per-call choice. */
async function newObligation(studentId: string, policy: { id: string }, opts: { month?: number; termsId?: string } = {}) {
  const r = await createMonthlyObligation(
    { context: context(), studentId, coverage: { year: 2030, month: opts.month ?? 9 }, planTermsId: opts.termsId ?? terms.id, policyVersionId: policy.id },
    deps(),
  );
  if (!r.ok) throw new Error(`fixture obligation failed: ${r.error}`);
  return r.obligationId;
}

const pay = (studentId: string, obligationIds: string[], amount: string, receivedOn: { month: number; day: number }, now: () => Date = DEC_2030) =>
  recordDuesPayment(
    { context: context(), studentId, receivedOn: { year: 2030, ...receivedOn }, tender: { currency: "USD", amount }, method: "EFECTIVO", obligationIds, maxBackdateDays: 90 },
    deps(now),
  );

/** A dedicated, test-controlled transaction that takes the student lock and holds it until `release()` — the exact technique
 * dues-ledger-writers.test.ts, student-status-history.test.ts and monthly-generation.test.ts already use. */
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
  a = await makeAccountingOrg("CUMULATIVE", "fee-a");
  zeroFeeAcademy = await prisma.academy.create({ data: { organizationId: a.org.id, name: "Fee zero-branch", slug: `fee-zero-${suffix}`, kioskTokenHash: `fee-zero-${suffix}` } });

  const plan = await prisma.paymentPlan.create({ data: { organizationId: a.org.id, academyId: a.academy.id, name: `Fee plan ${suffix}` } });
  planId = plan.id;
  terms = await prisma.paymentPlanTerms.create({
    data: { organizationId: a.org.id, planId, effectiveYear: 2027, effectiveMonth: 1, priceAmount: "100.00", currency: "USD", monthsCovered: 1, createdById: a.admin.id },
  });
  feePolicy = await prisma.duesPolicyVersion.create({
    data: { organizationId: a.org.id, academyId: a.academy.id, effectiveYear: 2027, effectiveMonth: 1, dueDay: 20, graceDay: 5, lateFeeAmount: "20.00", lateFeeCurrency: "USD", createdById: a.admin.id },
  });

  // A separate branch for the zero-fee case: PaymentPlanTerms/DuesPolicyVersion are versioned per branch, so a second policy on
  // the SAME branch would just supersede the first (only the latest-effective version is ever current), not offer a per-call choice.
  const zeroPlan = await prisma.paymentPlan.create({ data: { organizationId: a.org.id, academyId: zeroFeeAcademy.id, name: `Fee zero-plan ${suffix}` } });
  zeroFeePlanId = zeroPlan.id;
  zeroFeeTerms = await prisma.paymentPlanTerms.create({
    data: { organizationId: a.org.id, planId: zeroFeePlanId, effectiveYear: 2027, effectiveMonth: 1, priceAmount: "100.00", currency: "USD", monthsCovered: 1, createdById: a.admin.id },
  });
  zeroFeePolicy = await prisma.duesPolicyVersion.create({
    data: { organizationId: a.org.id, academyId: zeroFeeAcademy.id, effectiveYear: 2027, effectiveMonth: 1, dueDay: 20, graceDay: 5, lateFeeAmount: "0.00", lateFeeCurrency: "USD", createdById: a.admin.id },
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

describe("assessLateFeeInTx: the three reasons to do nothing (brief §2)", () => {
  it("a zero-fee obligation: nothing owed, nothing created", async () => {
    const s = await newStudent("zero", zeroFeeAcademy.id);
    const obligationId = await newObligation(s.id, zeroFeePolicy, { termsId: zeroFeeTerms.id });
    const result = await appPrisma.$transaction((tx) => assessLateFeeInTx(tx, { context: context(), obligationId, asOf: { year: 2030, month: 12, day: 1 }, actorId: null }, deps()));
    expect(result).toEqual({ ok: true, feeId: null, owed: false, created: false });
    expect(await prisma.duesLateFee.count({ where: { organizationId: a.org.id, obligationId } })).toBe(0);
  });

  it("already settled on time (using the payment's real receivedOn, not a row-creation timestamp): no fee, even asked long after grace", async () => {
    const s = await newStudent("ontime");
    const obligationId = await newObligation(s.id, feePolicy);
    expect(await pay(s.id, [obligationId], "100.00", { month: 9, day: 15 })).toMatchObject({ ok: true }); // Sep 15, before the Sep 20 due date

    const result = await appPrisma.$transaction((tx) => assessLateFeeInTx(tx, { context: context(), obligationId, asOf: { year: 2030, month: 12, day: 1 }, actorId: null }, deps()));
    expect(result).toEqual({ ok: true, feeId: null, owed: false, created: false });
    expect(await prisma.duesLateFee.count({ where: { organizationId: a.org.id, obligationId } })).toBe(0);
  });

  it("waived and voided fee rows: never touched, never re-created, whatever their removal state", async () => {
    for (const removalKind of ["WAIVED", "VOIDED"] as const) {
      const s = await newStudent(`removed-${removalKind}`);
      const obligationId = await newObligation(s.id, feePolicy);
      const existing = await prisma.duesLateFee.create({
        data: {
          organizationId: a.org.id, obligationId, assessableFrom: new Date(Date.UTC(2030, 9, 6)),
          removedAt: new Date(), removalKind, removedById: a.admin.id, removalReason: "test fixture",
        },
      });
      const result = await appPrisma.$transaction((tx) => assessLateFeeInTx(tx, { context: context(), obligationId, asOf: { year: 2030, month: 12, day: 1 }, actorId: null }, deps()));
      expect(result).toEqual({ ok: true, feeId: existing.id, owed: false, created: false });
      const stillThere = await prisma.duesLateFee.findUniqueOrThrow({ where: { id: existing.id } });
      expect(stillThere.removedAt).not.toBeNull();
      expect(stillThere.removalKind).toBe(removalKind);
    }
  });

  it("a direct call enforces branch scope itself: a same-organization obligation outside the context's allowed branches refuses notFound", async () => {
    const s = await newStudent("scoped"); // home branch: a.academy.id
    const obligationId = await newObligation(s.id, feePolicy);
    const scopedToOtherBranch = context({ organizationRole: "DIRECTOR", academyIds: [zeroFeeAcademy.id] }); // does NOT include a.academy.id
    const result = await appPrisma.$transaction((tx) => assessLateFeeInTx(tx, { context: scopedToOtherBranch, obligationId, asOf: { year: 2030, month: 12, day: 1 }, actorId: null }, deps()));
    expect(result).toEqual({ ok: false, error: "notFound" });
  });
});

describe("assessLateFeeInTx: already-late, reused, and reversed settlements (brief §2/§3)", () => {
  it("already settled late, with an existing fee: reused, never duplicated", async () => {
    const s = await newStudent("late");
    const obligationId = await newObligation(s.id, feePolicy);
    const paid = await pay(s.id, [obligationId], "120.00", { month: 10, day: 10 }); // Oct 10: after the Sep 20 due date AND the Oct 5 grace deadline
    expect(paid).toMatchObject({ ok: true });
    const firstFeeId = (paid as { feeIds: string[] }).feeIds[0];
    expect(firstFeeId).toBeTruthy();

    const result = await appPrisma.$transaction((tx) => assessLateFeeInTx(tx, { context: context(), obligationId, asOf: { year: 2030, month: 12, day: 1 }, actorId: null }, deps()));
    expect(result).toEqual({ ok: true, feeId: firstFeeId, owed: true, created: false });
    expect(await prisma.duesLateFee.count({ where: { organizationId: a.org.id, obligationId } })).toBe(1);
  });

  it("a reversed settlement is treated as unsettled: the fee IS assessed, since the reversed payment doesn't count", async () => {
    const s = await newStudent("reversed");
    const obligationId = await newObligation(s.id, feePolicy);
    const paid = await pay(s.id, [obligationId], "100.00", { month: 9, day: 15 }); // on time
    expect(paid).toMatchObject({ ok: true });
    await prisma.duesSettlement.updateMany({
      where: { organizationId: a.org.id, obligationId },
      data: { reversedAt: new Date(), reversedById: a.admin.id, reversalReason: "test fixture: pretend this was reversed" },
    });

    const result = await appPrisma.$transaction((tx) => assessLateFeeInTx(tx, { context: context(), obligationId, asOf: { year: 2030, month: 12, day: 1 }, actorId: null }, deps()));
    expect(result.ok).toBe(true);
    expect((result as { feeId: string | null }).feeId).not.toBeNull();
    expect((result as { created: boolean }).created).toBe(true);
  });

  it("a genuinely late payment: fee created and settled together in one call, as today", async () => {
    const s = await newStudent("latepay");
    const obligationId = await newObligation(s.id, feePolicy);
    const result = await pay(s.id, [obligationId], "120.00", { month: 10, day: 10 });
    expect(result).toMatchObject({ ok: true });
    expect((result as { feeIds: string[] }).feeIds).toHaveLength(1);
    expect(await prisma.duesLateFee.count({ where: { organizationId: a.org.id, obligationId } })).toBe(1);
  });

  it("repeated assessment runs are idempotent: no duplicate", async () => {
    const s = await newStudent("repeat");
    const obligationId = await newObligation(s.id, feePolicy);
    const first = await appPrisma.$transaction((tx) => assessLateFeeInTx(tx, { context: context(), obligationId, asOf: { year: 2030, month: 12, day: 1 }, actorId: null }, deps()));
    const second = await appPrisma.$transaction((tx) => assessLateFeeInTx(tx, { context: context(), obligationId, asOf: { year: 2030, month: 12, day: 1 }, actorId: null }, deps()));
    expect(first.ok && second.ok).toBe(true);
    expect((first as { feeId: string | null }).feeId).toBe((second as { feeId: string | null }).feeId);
    expect(await prisma.duesLateFee.count({ where: { organizationId: a.org.id, obligationId } })).toBe(1);
  });
});

describe("both concurrency orders of an on-time payment recorded after grace (brief §5, corrected — do not claim only one outcome)", () => {
  it("order A: payment wins the lock first — settles on time; assessment then correctly creates no fee", async () => {
    const s = await newStudent("orderA");
    const obligationId = await newObligation(s.id, feePolicy);
    const { startedPromise, release, held } = holdStudentLock(s.id);
    await startedPromise;

    let paymentDone = false;
    const paying = pay(s.id, [obligationId], "100.00", { month: 9, day: 15 }).then((r) => ((paymentDone = true), r)); // on time
    const blocked = await waitUntilBlockedOnLock(['FROM "Student"', "FOR UPDATE"]);
    expect(blocked, "recordDuesPayment must genuinely wait on the student row lock").toBe(true);
    expect(paymentDone).toBe(false);

    release();
    await held;
    expect(await paying).toMatchObject({ ok: true });

    const assessed = await appPrisma.$transaction((tx) => assessLateFeeInTx(tx, { context: context(), obligationId, asOf: { year: 2030, month: 12, day: 1 }, actorId: null }, deps()));
    expect(assessed).toEqual({ ok: true, feeId: null, owed: false, created: false });
  });

  it("order B: assessment wins the lock first — creates a fee; payment then correctly refuses feeAlreadyAssessed with zero payment-side writes", async () => {
    const s = await newStudent("orderB");
    const obligationId = await newObligation(s.id, feePolicy);
    const { startedPromise, release, held } = holdStudentLock(s.id);
    await startedPromise;

    // assessLateFeeInTx itself takes no lock (it trusts the caller to already hold one) — to genuinely contend on the student
    // lock here, go through the runner, exactly the caller shape this race is actually about.
    let assessDone = false;
    const assessing = assessLateFeesForStudent(context(), s.id, deps()).then((r) => ((assessDone = true), r));
    const blocked = await waitUntilBlockedOnLock(['FROM "Student"', "FOR UPDATE"]);
    expect(blocked, "assessLateFeesForStudent must genuinely wait on the student row lock").toBe(true);
    expect(assessDone).toBe(false);

    release();
    await held;
    const assessed = await assessing;
    expect(assessed.ok).toBe(true);
    if (!assessed.ok) return;
    expect(assessed.outcomes.find((o) => o.obligationId === obligationId)).toMatchObject({ category: "assessed" });

    const before = { payments: await prisma.duesPayment.count({ where: { organizationId: a.org.id } }), settlements: await prisma.duesSettlement.count({ where: { organizationId: a.org.id } }) };
    const paid = await pay(s.id, [obligationId], "100.00", { month: 9, day: 15 }); // on time, but a fee already exists
    expect(paid).toEqual({ ok: false, error: "feeAlreadyAssessed" });
    const after = { payments: await prisma.duesPayment.count({ where: { organizationId: a.org.id } }), settlements: await prisma.duesSettlement.count({ where: { organizationId: a.org.id } }) };
    expect(after).toEqual(before);
  });
});

describe("concurrent assessment for the same student serializes on the lock (brief §3)", () => {
  it("two concurrent generation calls for the same student: exactly one fee results", async () => {
    const s = await newStudent("concurrent");
    const obligationId = await newObligation(s.id, feePolicy);
    const [r1, r2] = await Promise.all([
      appPrisma.$transaction((tx) => assessLateFeeInTx(tx, { context: context(), obligationId, asOf: { year: 2030, month: 12, day: 1 }, actorId: null }, deps())),
      appPrisma.$transaction((tx) => assessLateFeeInTx(tx, { context: context(), obligationId, asOf: { year: 2030, month: 12, day: 1 }, actorId: null }, deps())),
    ]);
    expect(r1.ok && r2.ok).toBe(true);
    const feeId1 = (r1 as { feeId: string | null }).feeId;
    const feeId2 = (r2 as { feeId: string | null }).feeId;
    expect(feeId1).not.toBeNull();
    expect(feeId1).toBe(feeId2); // both calls agree on the SAME fee, whichever created it and whichever lost the race
    expect(await prisma.duesLateFee.count({ where: { organizationId: a.org.id, obligationId } })).toBe(1);
  });
});

describe("the runner: assessLateFeesForStudent (brief §7/§8)", () => {
  it("assesses every open MONTHLY obligation for a student in one call, reporting distinct categories", async () => {
    // Two obligations for the SAME student across the org's two branches isn't possible (an obligation's academyId is the
    // student's own home branch) — instead, one student on the fee branch with two different coverage months: September
    // (owed) and October (also owed, proving the runner iterates every open obligation, not just the first).
    const s = await newStudent("runner");
    const owed = await newObligation(s.id, feePolicy, { month: 9 });
    const owedToo = await newObligation(s.id, feePolicy, { month: 10 });
    const result = await assessLateFeesForStudent(context(), s.id, deps());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const byId = new Map(result.outcomes.map((o) => [o.obligationId, o]));
    expect(byId.get(owed)?.category).toBe("assessed");
    expect(byId.get(owedToo)?.category).toBe("assessed");
  });

  it("a forged or foreign student id refuses notFound", async () => {
    expect(await assessLateFeesForStudent(context(), "does-not-exist-at-all", deps())).toEqual({ ok: false, reason: "notFound" });
  });
});
