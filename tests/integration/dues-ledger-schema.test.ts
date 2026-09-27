import "dotenv/config";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getTestPrismaClient } from "../helpers/test-db";
import { makeAccountingOrg } from "../helpers/accounting-org";
import { prisma as guardedPrisma } from "../../src/lib/prisma";
import { UnscopedTenantQueryError } from "../../src/lib/tenant/tenant-guard";

/**
 * PR 2B (student dues LEDGER schema), proved against the REAL test database. Private, temporary organizations are created (never the
 * seeded Alliance data). Amounts, days and reasons are synthetic test data.
 *
 * ISOLATION. Most tests run inside a transaction that is always rolled back, so nothing they write (including writes the database
 * must refuse) persists and no production constraint or trigger is ever weakened to clean up. Rejected statements are wrapped in a
 * SAVEPOINT so a refusal does not abort the surrounding transaction. Only the concurrency tests must COMMIT (two connections have to
 * see each other's work); their rows are removed in afterAll by a test-only transaction that sets `session_replication_role =
 * replica` (the test database user is a superuser). That switch exists in this file alone; the schema keeps every trigger.
 *
 * WHAT THE DATABASE ENFORCES (asserted as rejections): tenant- and student-safe composite foreign keys; duplicate coverage; at most one
 * ACTIVE settlement per obligation, also under concurrent writes; the reversal marker (set once, nothing else changes, reason required);
 * permanent history (no deletes); obligations that agree with the configuration version they reference; and protection of referenced
 * configuration versions, also under concurrent reference creation and correction.
 *
 * WHAT IT DOES NOT (asserted below as documented non-guarantees so the schema comments cannot overstate): a payment covering the full
 * amount or matching currency (a settlement has no amount columns, which only means it cannot DISAGREE with its obligation), and a
 * payment reversal reversing all of its settlements. Future writers own those, transactionally.
 */
const prisma = getTestPrismaClient();
type Db = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];
type Fixture = Awaited<ReturnType<typeof makeAccountingOrg>>;

const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;

let a: Fixture; // organization A: owner = a.admin
let b: Fixture; // organization B
let a2: { id: string }; // a second branch of A
let ana: { id: string };
let bruno: { id: string }; // a second student of A
let studentB: { id: string };
let termsMonthly: { id: string }; // A, branch 1, USD, 1 month
let termsPackage: { id: string }; // A, branch 1, USD, 3 months
let termsOtherBranch: { id: string }; // A, branch 2, USD, 1 month
let termsB: { id: string }; // organization B
let policy1: { id: string }; // A, branch 1, USD fee
let policyOtherBranch: { id: string }; // A, branch 2, USD fee
let policyCrc: { id: string }; // A, branch 1, CRC fee

/** A different calendar month for every call, so committed rows from concurrency tests never collide with anything. */
let monthCounter = 0;
function nextMonth(): { year: number; month: number } {
  const i = monthCounter++;
  return { year: 2031 + Math.floor(i / 12), month: (i % 12) + 1 };
}
const dateOf = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));

class Rollback extends Error {}

/** Runs `fn` in a transaction that is ALWAYS rolled back. */
async function isolated(fn: (tx: Db) => Promise<void>) {
  try {
    await prisma.$transaction(
      async (tx) => {
        await fn(tx);
        throw new Rollback();
      },
      { timeout: 60_000, maxWait: 30_000 },
    );
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
  }
}

/**
 * The database's OWN message for a refused write (constraint or index name, or a trigger's text). A Prisma error's `String(error)` also
 * embeds an excerpt of the calling source, which includes neighbouring assertions and their hint strings, so matching a hint against it
 * would pass for the wrong reason. Only the driver's original message is used.
 */
function dbMessage(error: unknown): string {
  const cause = (error as { meta?: { driverAdapterError?: { cause?: { originalMessage?: string; message?: string } } } } | undefined)?.meta?.driverAdapterError?.cause;
  return [cause?.originalMessage, cause?.message].filter(Boolean).join(" | ");
}

/** The database must refuse `op`, and `hint` (a constraint, index or trigger message) must appear in the database's own message. The transaction stays usable. */
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

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function newStudent(fx: Fixture, academyId: string, label: string) {
  return prisma.student.create({
    data: {
      organizationId: fx.org.id, homeAcademyId: academyId, firstName: "Ledger", lastName: label, phone: "00000000",
      email: `ledger-${label}-${suffix}@example.com`, currentRankId: await fx.rankId("WHITE"), codeHash: `ledger-${label}-${suffix}`, status: "ACTIVE",
    },
  });
}

async function newTerms(
  label: string,
  over: { currency?: "USD" | "CRC"; monthsCovered?: number; academyId?: string; organizationId?: string; createdById?: string } = {},
) {
  const organizationId = over.organizationId ?? a.org.id;
  const plan = await prisma.paymentPlan.create({
    data: { organizationId, academyId: over.academyId ?? a.academy.id, name: `Ledger plan ${label} ${suffix}` },
  });
  return prisma.paymentPlanTerms.create({
    data: {
      organizationId, planId: plan.id, effectiveYear: 2027, effectiveMonth: 1, priceAmount: "100.00", currency: over.currency ?? "USD",
      monthsCovered: over.monthsCovered ?? 1, createdById: over.createdById ?? a.admin.id,
    },
  });
}

type ObligationOver = Partial<{
  organizationId: string; studentId: string; academyId: string; type: "MONTHLY" | "PACKAGE"; origin: "SCHEDULED_JOB" | "PREPAYMENT" | "STAFF";
  coverageYear: number; coverageMonth: number; monthsCovered: number; amount: string; currency: "USD" | "CRC"; lateFeeAmount: string | null;
  dueOn: Date | null; graceDeadline: Date | null; planTermsId: string; policyVersionId: string | null; createdById: string | null;
}>;

function obligationData(over: ObligationOver = {}) {
  const month = nextMonth();
  return {
    organizationId: a.org.id, studentId: ana.id, academyId: a.academy.id, type: "MONTHLY" as const, origin: "SCHEDULED_JOB" as const,
    coverageYear: month.year, coverageMonth: month.month, monthsCovered: 1, amount: "100.00", currency: "USD" as const, lateFeeAmount: "20.00" as string | null,
    dueOn: dateOf(month.year, month.month, 20) as Date | null, graceDeadline: dateOf(month.year, month.month + 1, 5) as Date | null,
    planTermsId: termsMonthly.id, policyVersionId: policy1.id as string | null, createdById: a.admin.id as string | null,
    ...over,
  };
}

/** The obligation plus its coverage rows, as a writer would insert them in one transaction. */
async function createObligation(db: Db, over: ObligationOver = {}) {
  const data = obligationData(over);
  const obligation = await db.duesObligation.create({ data });
  for (let i = 0; i < data.monthsCovered; i++) {
    const index = data.coverageYear * 12 + (data.coverageMonth - 1) + i;
    await db.duesCoverage.create({
      data: { organizationId: data.organizationId, studentId: data.studentId, obligationId: obligation.id, year: Math.floor(index / 12), month: (index % 12) + 1 },
    });
  }
  return obligation;
}

type PaymentOver = Partial<{ organizationId: string; studentId: string; academyId: string; tenderAmount: string; tenderCurrency: "USD" | "CRC" }>;
const createPayment = (db: Db, over: PaymentOver = {}) =>
  db.duesPayment.create({
    data: {
      organizationId: a.org.id, studentId: ana.id, academyId: a.academy.id, receivedOn: dateOf(2030, 1, 3), tenderCurrency: "USD", tenderAmount: "100.00",
      method: "EFECTIVO", recordedById: a.admin.id, ...over,
    },
  });

const settle = (db: Db, paymentId: string, obligationId: string, over: Partial<{ studentId: string; lateFeeId: string; organizationId: string }> = {}) =>
  db.duesSettlement.create({ data: { organizationId: a.org.id, studentId: ana.id, paymentId, obligationId, ...over } });

const marker = (reason = "entered on the wrong student") => ({ reversedAt: new Date(), reversedById: a.admin.id, reversalReason: reason });

/** What a future reversal writer does: mark the payment and every ACTIVE settlement of it. (Atomicity across the two tables is the writer's job.) */
async function reverse(db: Db, paymentId: string, reason?: string) {
  await db.duesSettlement.updateMany({ where: { paymentId, reversedAt: null }, data: marker(reason) });
  await db.duesPayment.update({ where: { id: paymentId }, data: marker(reason) });
}

beforeAll(async () => {
  a = await makeAccountingOrg("CUMULATIVE", "ledger-a");
  b = await makeAccountingOrg("CUMULATIVE", "ledger-b");
  a2 = await prisma.academy.create({
    data: { organizationId: a.org.id, name: "Ledger A Second Branch", slug: `ledger-a2-${suffix}`, kioskTokenHash: `ledger-a2-${suffix}` },
  });
  ana = await newStudent(a, a.academy.id, "ana");
  bruno = await newStudent(a, a.academy.id, "bruno");
  studentB = await newStudent(b, b.academy.id, "b");
  termsMonthly = await newTerms("monthly");
  termsPackage = await newTerms("package", { monthsCovered: 3 });
  termsOtherBranch = await newTerms("other-branch", { academyId: a2.id });
  termsB = await newTerms("b", { organizationId: b.org.id, academyId: b.academy.id, createdById: b.admin.id });
  const policyBase = { organizationId: a.org.id, effectiveYear: 2027, effectiveMonth: 1, dueDay: 20, graceDay: 5, lateFeeAmount: "20.00", createdById: a.admin.id };
  policy1 = await prisma.duesPolicyVersion.create({ data: { ...policyBase, academyId: a.academy.id, lateFeeCurrency: "USD" } });
  policyOtherBranch = await prisma.duesPolicyVersion.create({ data: { ...policyBase, academyId: a2.id, lateFeeCurrency: "USD" } });
  policyCrc = await prisma.duesPolicyVersion.create({ data: { ...policyBase, effectiveMonth: 2, academyId: a.academy.id, lateFeeCurrency: "CRC" } });
}, 60_000);

afterAll(async () => {
  const orgIds = [a?.org.id, b?.org.id].filter(Boolean) as string[];
  if (orgIds.length > 0) {
    // Test-only: committed concurrency rows can only be removed with the ledger's own no-delete triggers switched off, for this
    // transaction alone. The migration's triggers are untouched.
    await prisma.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe("SET LOCAL session_replication_role = replica");
        for (const table of ["DuesSettlement", "DuesPayment", "DuesLateFee", "DuesCoverage", "DuesObligation"]) {
          await tx.$executeRawUnsafe(`DELETE FROM "${table}" WHERE "organizationId" = ANY($1::text[])`, orgIds);
        }
      },
      { timeout: 60_000 },
    );
  }
  for (const fx of [a, b]) {
    if (!fx) continue;
    await prisma.paymentPlanTerms.deleteMany({ where: { organizationId: fx.org.id } });
    await prisma.duesPolicyVersion.deleteMany({ where: { organizationId: fx.org.id } });
    await prisma.paymentPlan.deleteMany({ where: { organizationId: fx.org.id } });
  }
  await a?.drop();
  await b?.drop();
}, 120_000);

describe("tenant- and student-safe relationships", () => {
  it("an obligation cannot name a student, branch or terms version of another organization", async () => {
    await isolated(async (tx) => {
      await refused(tx, () => tx.duesObligation.create({ data: obligationData({ studentId: studentB.id }) }), "DuesObligation_organizationId_studentId_fkey");
      // Two layers refuse a wrong-organization branch or terms version: the reference trigger (it fires first) and the foreign keys.
      // Each is proved separately: with the trigger disabled, only for this rolled-back transaction, the foreign keys alone must refuse.
      await tx.$executeRawUnsafe('ALTER TABLE "DuesObligation" DISABLE TRIGGER "DuesObligation_check_references"');
      await refused(tx, () => tx.duesObligation.create({ data: obligationData({ academyId: b.academy.id }) }), "DuesObligation_organizationId_academyId_fkey");
      await refused(tx, () => tx.duesObligation.create({ data: obligationData({ planTermsId: termsB.id }) }), "DuesObligation_organizationId_planTermsId_fkey");
      await tx.$executeRawUnsafe('ALTER TABLE "DuesObligation" ENABLE TRIGGER "DuesObligation_check_references"');
      // and with the trigger on, the trigger itself refuses them first
      await refused(tx, () => tx.duesObligation.create({ data: obligationData({ academyId: b.academy.id }) }), "dues_ledger: terms version belongs to another branch");
      await refused(tx, () => tx.duesObligation.create({ data: obligationData({ planTermsId: termsB.id }) }), "dues_ledger: unknown terms version for this organization");
    });
  });

  it("a coverage row cannot name another student's obligation, and a payment cannot use another organization's student or branch", async () => {
    await isolated(async (tx) => {
      const o = await tx.duesObligation.create({ data: obligationData() });
      const month = nextMonth();
      await refused(
        tx,
        () => tx.duesCoverage.create({ data: { organizationId: a.org.id, studentId: bruno.id, obligationId: o.id, year: month.year, month: month.month } }),
        "DuesCoverage_organizationId_obligationId_studentId_fkey",
      );
      await refused(tx, () => createPayment(tx, { studentId: studentB.id }), "DuesPayment_organizationId_studentId_fkey");
      await refused(tx, () => createPayment(tx, { academyId: b.academy.id }), "DuesPayment_organizationId_academyId_fkey");
    });
  });

  it("a settlement's payment and obligation must belong to the same student, and to the same organization", async () => {
    await isolated(async (tx) => {
      const anaOctober = await createObligation(tx);
      const brunoPayment = await createPayment(tx, { studentId: bruno.id });
      // Bruno's payment against Ana's obligation, whichever student the settlement claims
      await refused(tx, () => settle(tx, brunoPayment.id, anaOctober.id, { studentId: bruno.id }), "DuesSettlement_organizationId_obligationId_studentId_fkey");
      await refused(tx, () => settle(tx, brunoPayment.id, anaOctober.id, { studentId: ana.id }), "DuesSettlement_organizationId_paymentId_studentId_fkey");
      // an organization B row inside an organization A settlement
      const anaPayment = await createPayment(tx);
      await refused(tx, () => settle(tx, anaPayment.id, anaOctober.id, { organizationId: b.org.id }), "DuesSettlement_organizationId_paymentId_studentId_fkey");
    });
  });

  it("a settlement can only name a fee of its own obligation, and a fee can only belong to a MONTHLY obligation", async () => {
    await isolated(async (tx) => {
      const first = await createObligation(tx);
      const second = await createObligation(tx);
      const feeOfSecond = await tx.duesLateFee.create({ data: { organizationId: a.org.id, obligationId: second.id, assessableFrom: dateOf(2031, 3, 6) } });
      const payment = await createPayment(tx);
      await refused(tx, () => settle(tx, payment.id, first.id, { lateFeeId: feeOfSecond.id }), "DuesSettlement_organizationId_lateFeeId_obligationId_fkey");
      const pack = await createObligation(tx, {
        type: "PACKAGE", monthsCovered: 3, planTermsId: termsPackage.id, dueOn: null, graceDeadline: null, lateFeeAmount: null, policyVersionId: null, amount: "270.00",
      });
      // by default the fee claims to be MONTHLY, which the package obligation is not (composite foreign key on the type)
      await refused(tx, () => tx.duesLateFee.create({ data: { organizationId: a.org.id, obligationId: pack.id, assessableFrom: dateOf(2031, 3, 6) } }), "DuesLateFee_organizationId_obligationId_obligationType_fkey");
      // and a fee that claims to be for a PACKAGE is refused by the CHECK itself
      await refused(
        tx,
        () => tx.duesLateFee.create({ data: { organizationId: a.org.id, obligationId: pack.id, obligationType: "PACKAGE", assessableFrom: dateOf(2031, 3, 6) } }),
        "DuesLateFee_only_monthly",
      );
    });
  });
});

describe("remaining CHECK constraints", () => {
  it("a payment must be positive, a fee non-negative, and months and years must be real", async () => {
    await isolated(async (tx) => {
      await refused(tx, () => createPayment(tx, { tenderAmount: "0.00" }), "DuesPayment_tender_positive");
      await refused(tx, () => tx.duesObligation.create({ data: obligationData({ lateFeeAmount: "-0.01" }) }), "DuesObligation_late_fee_non_negative");
      await refused(tx, () => tx.duesObligation.create({ data: obligationData({ coverageYear: 1999 }) }), "DuesObligation_coverage_year_sane");
      const october = await tx.duesObligation.create({ data: obligationData() });
      const month = nextMonth();
      await refused(
        tx,
        () => tx.duesCoverage.create({ data: { organizationId: a.org.id, studentId: ana.id, obligationId: october.id, year: month.year, month: 13 } }),
        "DuesCoverage_month_valid",
      );
      await refused(
        tx,
        () => tx.duesCoverage.create({ data: { organizationId: a.org.id, studentId: ana.id, obligationId: october.id, year: 2101, month: 1 } }),
        "DuesCoverage_year_sane",
      );
    });
  });
});

describe("one late fee per obligation", () => {
  it("a second fee for the same obligation is refused, even after the first was waived", async () => {
    await isolated(async (tx) => {
      const october = await createObligation(tx);
      const fee = await tx.duesLateFee.create({ data: { organizationId: a.org.id, obligationId: october.id, assessableFrom: dateOf(2031, 3, 6) } });
      await refused(tx, () => tx.duesLateFee.create({ data: { organizationId: a.org.id, obligationId: october.id, assessableFrom: dateOf(2031, 3, 7) } }), "DuesLateFee_obligationId_key");
      await tx.duesLateFee.update({ where: { id: fee.id }, data: { removedAt: new Date(), removalKind: "WAIVED", removedById: a.admin.id, removalReason: "owner waived" } });
      await refused(tx, () => tx.duesLateFee.create({ data: { organizationId: a.org.id, obligationId: october.id, assessableFrom: dateOf(2031, 3, 8) } }), "DuesLateFee_obligationId_key");
    });
  });
});

describe("obligation shape and agreement with its configuration version", () => {
  it("CHECKs: positive amount, valid month, and the MONTHLY / PACKAGE column shapes", async () => {
    await isolated(async (tx) => {
      // The reference trigger runs BEFORE the CHECKs and would refuse the duration mismatches below first, masking the CHECK. It is
      // disabled for this rolled-back transaction only, so each CHECK is proved on its own; the trigger is proved in the next test.
      await tx.$executeRawUnsafe('ALTER TABLE "DuesObligation" DISABLE TRIGGER "DuesObligation_check_references"');
      await refused(tx, () => tx.duesObligation.create({ data: obligationData({ amount: "0.00" }) }), "DuesObligation_amount_positive");
      await refused(tx, () => tx.duesObligation.create({ data: obligationData({ coverageMonth: 13 }) }), "DuesObligation_coverage_month_valid");
      await refused(tx, () => tx.duesObligation.create({ data: obligationData({ dueOn: null }) }), "DuesObligation_shape_by_type");
      await refused(tx, () => tx.duesObligation.create({ data: obligationData({ policyVersionId: null }) }), "DuesObligation_shape_by_type");
      await refused(tx, () => tx.duesObligation.create({ data: obligationData({ graceDeadline: dateOf(2020, 1, 1) }) }), "DuesObligation_shape_by_type");
      await refused(tx, () => tx.duesObligation.create({ data: obligationData({ monthsCovered: 2 }) }), "DuesObligation_shape_by_type");
      await refused(
        tx,
        () => tx.duesObligation.create({ data: obligationData({ type: "PACKAGE", monthsCovered: 1, planTermsId: termsPackage.id, dueOn: null, graceDeadline: null, lateFeeAmount: null, policyVersionId: null }) }),
        "DuesObligation_shape_by_type",
      );
      await refused(tx, () => tx.duesObligation.create({ data: obligationData({ type: "PACKAGE", monthsCovered: 3, planTermsId: termsPackage.id }) }), "DuesObligation_shape_by_type");
      // a zero fee is allowed
      await tx.duesObligation.create({ data: obligationData({ lateFeeAmount: "0.00" }) });
    });
  });

  it("an obligation must agree with the version it references: branch, currency and duration", async () => {
    await isolated(async (tx) => {
      await refused(tx, () => tx.duesObligation.create({ data: obligationData({ planTermsId: termsOtherBranch.id }) }), "dues_ledger: terms version belongs to another branch");
      await refused(tx, () => tx.duesObligation.create({ data: obligationData({ policyVersionId: policyOtherBranch.id }) }), "dues_ledger: policy version belongs to another branch");
      await refused(tx, () => tx.duesObligation.create({ data: obligationData({ currency: "CRC" }) }), "dues_ledger: currency does not match");
      await refused(tx, () => tx.duesObligation.create({ data: obligationData({ policyVersionId: policyCrc.id }) }), "dues_ledger: currency does not match");
      await refused(
        tx,
        () => tx.duesObligation.create({ data: obligationData({ type: "PACKAGE", monthsCovered: 2, planTermsId: termsPackage.id, dueOn: null, graceDeadline: null, lateFeeAmount: null, policyVersionId: null }) }),
        "dues_ledger: duration does not match",
      );
      await createObligation(tx); // and the matching one is accepted
    });
  });
});

describe("coverage: one row per student per calendar month, preserved across reversal", () => {
  it("a second monthly obligation, a second coverage row, and an overlapping package are refused", async () => {
    await isolated(async (tx) => {
      const month = nextMonth();
      const october = await createObligation(tx, { coverageYear: month.year, coverageMonth: month.month });
      // the same monthly identity again
      await refused(tx, () => tx.duesObligation.create({ data: obligationData({ coverageYear: month.year, coverageMonth: month.month }) }), "DuesObligation_student_month_monthly_key");
      // a package whose first month is that month, and one that only overlaps it
      const pack = (start: { year: number; month: number }) =>
        createObligation(tx, {
          type: "PACKAGE", monthsCovered: 3, planTermsId: termsPackage.id, amount: "270.00", dueOn: null, graceDeadline: null, lateFeeAmount: null, policyVersionId: null,
          coverageYear: start.year, coverageMonth: start.month,
        });
      await refused(tx, () => pack({ year: month.year, month: month.month }), "DuesCoverage_studentId_year_month_key");
      const before = month.month === 1 ? { year: month.year - 1, month: 12 } : { year: month.year, month: month.month - 1 };
      await refused(tx, () => pack(before), "DuesCoverage_studentId_year_month_key");
      // a second coverage row for the same month on the same obligation
      await refused(
        tx,
        () => tx.duesCoverage.create({ data: { organizationId: a.org.id, studentId: ana.id, obligationId: october.id, year: month.year, month: month.month } }),
        "DuesCoverage_studentId_year_month_key",
      );
      expect(await tx.duesCoverage.count({ where: { studentId: ana.id, year: month.year, month: month.month } })).toBe(1);
    });
  });

  it("another student may cover the same month", async () => {
    await isolated(async (tx) => {
      const month = nextMonth();
      await createObligation(tx, { coverageYear: month.year, coverageMonth: month.month });
      await createObligation(tx, { studentId: bruno.id, coverageYear: month.year, coverageMonth: month.month });
    });
  });

  it("REVERSAL: a reversed obligation can be settled again, but its month can never be covered twice", async () => {
    await isolated(async (tx) => {
      const month = nextMonth();
      const october = await createObligation(tx, { coverageYear: month.year, coverageMonth: month.month });
      const wrong = await createPayment(tx);
      await settle(tx, wrong.id, october.id);
      await reverse(tx, wrong.id);

      // coverage and the obligation are untouched by the reversal
      expect(await tx.duesCoverage.count({ where: { obligationId: october.id } })).toBe(1);
      expect(await tx.duesObligation.count({ where: { id: october.id } })).toBe(1);
      // a NEW settlement of the same obligation is allowed after the reversal (the obligation is unpaid again)
      const right = await createPayment(tx);
      await settle(tx, right.id, october.id);
      // ...but no second charge, prepaid month or overlapping package can appear, before or after the reversal
      await refused(tx, () => tx.duesObligation.create({ data: obligationData({ coverageYear: month.year, coverageMonth: month.month, origin: "PREPAYMENT" }) }), "DuesObligation_student_month_monthly_key");
      await refused(
        tx,
        () =>
          createObligation(tx, {
            type: "PACKAGE", monthsCovered: 3, planTermsId: termsPackage.id, amount: "270.00", dueOn: null, graceDeadline: null, lateFeeAmount: null, policyVersionId: null,
            coverageYear: month.year, coverageMonth: month.month,
          }),
        "DuesCoverage_studentId_year_month_key",
      );
      expect(await tx.duesCoverage.count({ where: { studentId: ana.id, year: month.year, month: month.month } })).toBe(1);
    });
  });
});

describe("at most one active settlement per obligation; reversal keeps history", () => {
  it("a second ACTIVE settlement is refused, and a reversed one stays as history beside the new one", async () => {
    await isolated(async (tx) => {
      const october = await createObligation(tx);
      const first = await createPayment(tx);
      const firstSettlement = await settle(tx, first.id, october.id);
      const second = await createPayment(tx);
      await refused(tx, () => settle(tx, second.id, october.id), "DuesSettlement_one_active_per_obligation_key");

      await reverse(tx, first.id, "wrong student");
      const secondSettlement = await settle(tx, second.id, october.id);
      // the third payment would be a second active settlement again
      const third = await createPayment(tx);
      await refused(tx, () => settle(tx, third.id, october.id), "DuesSettlement_one_active_per_obligation_key");

      // history: both settlements exist; the first carries who, when and why
      const rows = await tx.duesSettlement.findMany({ where: { obligationId: october.id }, orderBy: { createdAt: "asc" } });
      expect(rows.map((r) => r.id).sort()).toEqual([firstSettlement.id, secondSettlement.id].sort());
      const reversed = rows.find((r) => r.id === firstSettlement.id)!;
      expect(reversed.reversedById).toBe(a.admin.id);
      expect(reversed.reversedAt).toBeInstanceOf(Date);
      expect(reversed.reversalReason).toBe("wrong student");
      expect(rows.find((r) => r.id === secondSettlement.id)!.reversedAt).toBeNull();
      const payment = await tx.duesPayment.findUniqueOrThrow({ where: { id: first.id } });
      expect([payment.reversedById, payment.reversalReason]).toEqual([a.admin.id, "wrong student"]);
    });
  });

  it("several reversed settlements of one obligation may coexist (each reversal keeps its own history)", async () => {
    await isolated(async (tx) => {
      const october = await createObligation(tx);
      for (let i = 0; i < 3; i++) {
        const payment = await createPayment(tx);
        await settle(tx, payment.id, october.id);
        await reverse(tx, payment.id, `mistake ${i}`);
      }
      expect(await tx.duesSettlement.count({ where: { obligationId: october.id, reversedAt: { not: null } } })).toBe(3);
    });
  });
});

describe("reversal marker: set once, nothing else changes, never deleted", () => {
  it("payment: the marker needs all three fields and a non-blank reason, and cannot be set twice or cleared", async () => {
    await isolated(async (tx) => {
      const payment = await createPayment(tx);
      await refused(tx, () => tx.duesPayment.update({ where: { id: payment.id }, data: { reversedAt: new Date() } }), "DuesPayment_reversal_marker_complete");
      await refused(tx, () => tx.duesPayment.update({ where: { id: payment.id }, data: marker("   ") }), "DuesPayment_reversal_marker_complete");
      await tx.duesPayment.update({ where: { id: payment.id }, data: marker("ok") });
      await refused(tx, () => tx.duesPayment.update({ where: { id: payment.id }, data: marker("again") }), "dues_ledger: only the reversal marker may be set, once");
      await refused(
        tx,
        () => tx.duesPayment.update({ where: { id: payment.id }, data: { reversedAt: null, reversedById: null, reversalReason: null } }),
        "dues_ledger: only the reversal marker may be set, once",
      );
    });
  });

  it("payment: a marker update cannot also change an original field, and no original field can change alone", async () => {
    await isolated(async (tx) => {
      const payment = await createPayment(tx);
      await refused(tx, () => tx.duesPayment.update({ where: { id: payment.id }, data: { ...marker(), tenderAmount: "1.00" } }), "dues_ledger: only the reversal marker may be set, once");
      await refused(tx, () => tx.duesPayment.update({ where: { id: payment.id }, data: { ...marker(), tenderCurrency: "CRC" } }), "dues_ledger: only the reversal marker may be set, once");
      await refused(tx, () => tx.duesPayment.update({ where: { id: payment.id }, data: { ...marker(), notes: "edited" } }), "dues_ledger: only the reversal marker may be set, once");
      await refused(tx, () => tx.duesPayment.update({ where: { id: payment.id }, data: { tenderAmount: "1.00" } }), "dues_ledger: only the reversal marker may be set, once");
      await refused(tx, () => tx.duesPayment.update({ where: { id: payment.id }, data: { receivedOn: dateOf(2030, 2, 2) } }), "dues_ledger: only the reversal marker may be set, once");
      const untouched = await tx.duesPayment.findUniqueOrThrow({ where: { id: payment.id } });
      expect(untouched.tenderAmount.toFixed(2)).toBe("100.00");
      expect(untouched.reversedAt).toBeNull();
    });
  });

  it("settlement: same restrictions (reason, once, no other change, no clearing)", async () => {
    await isolated(async (tx) => {
      const october = await createObligation(tx);
      const other = await createObligation(tx);
      const payment = await createPayment(tx);
      const settlement = await settle(tx, payment.id, october.id);
      await refused(tx, () => tx.duesSettlement.update({ where: { id: settlement.id }, data: marker("") }), "DuesSettlement_reversal_marker_complete");
      await refused(tx, () => tx.duesSettlement.update({ where: { id: settlement.id }, data: { ...marker(), obligationId: other.id } }), "dues_ledger: only the reversal marker may be set, once");
      await refused(tx, () => tx.duesSettlement.update({ where: { id: settlement.id }, data: { obligationId: other.id } }), "dues_ledger: only the reversal marker may be set, once");
      await tx.duesSettlement.update({ where: { id: settlement.id }, data: marker("ok") });
      await refused(tx, () => tx.duesSettlement.update({ where: { id: settlement.id }, data: marker("twice") }), "dues_ledger: only the reversal marker may be set, once");
      await refused(
        tx,
        () => tx.duesSettlement.update({ where: { id: settlement.id }, data: { reversedAt: null, reversedById: null, reversalReason: null } }),
        "dues_ledger: only the reversal marker may be set, once",
      );
    });
  });

  it("late fee: only its removal marker may be set, once; obligations change only their due and grace dates; coverage never changes", async () => {
    await isolated(async (tx) => {
      const october = await createObligation(tx);
      const fee = await tx.duesLateFee.create({ data: { organizationId: a.org.id, obligationId: october.id, assessableFrom: dateOf(2031, 3, 6) } });
      const removal = { removedAt: new Date(), removalKind: "WAIVED" as const, removedById: a.admin.id, removalReason: "owner waived" };
      await refused(tx, () => tx.duesLateFee.update({ where: { id: fee.id }, data: { removedAt: new Date() } }), "DuesLateFee_removal_marker_complete");
      await refused(tx, () => tx.duesLateFee.update({ where: { id: fee.id }, data: { ...removal, assessableFrom: dateOf(2031, 4, 1) } }), "dues_ledger: only the removal marker may be set, once");
      await tx.duesLateFee.update({ where: { id: fee.id }, data: removal });
      await refused(tx, () => tx.duesLateFee.update({ where: { id: fee.id }, data: { ...removal, removalKind: "VOIDED" } }), "dues_ledger: only the removal marker may be set, once");

      await refused(tx, () => tx.duesObligation.update({ where: { id: october.id }, data: { amount: "1.00" } }), "dues_ledger: obligation fields other than the due and grace dates are immutable");
      await refused(tx, () => tx.duesObligation.update({ where: { id: october.id }, data: { currency: "CRC" } }), "dues_ledger: obligation fields other than the due and grace dates are immutable");
      await refused(tx, () => tx.duesObligation.update({ where: { id: october.id }, data: { coverageMonth: 1 } }), "dues_ledger: obligation fields other than the due and grace dates are immutable");
      await refused(tx, () => tx.duesObligation.update({ where: { id: october.id }, data: { lateFeeAmount: "0.00" } }), "dues_ledger: obligation fields other than the due and grace dates are immutable");
      // rescheduling is decided later (D5), so the dates stay updatable by the database
      await tx.duesObligation.update({ where: { id: october.id }, data: { dueOn: dateOf(2031, 3, 25) } });

      const coverage = await tx.duesCoverage.findFirstOrThrow({ where: { obligationId: october.id } });
      await refused(tx, () => tx.duesCoverage.update({ where: { id: coverage.id }, data: { month: 12 } }), "dues_ledger: coverage rows are never updated");
    });
  });

  it("nothing in the ledger can be deleted", async () => {
    await isolated(async (tx) => {
      const october = await createObligation(tx);
      const payment = await createPayment(tx);
      const settlement = await settle(tx, payment.id, october.id);
      const fee = await tx.duesLateFee.create({ data: { organizationId: a.org.id, obligationId: october.id, assessableFrom: dateOf(2031, 3, 6) } });
      const coverage = await tx.duesCoverage.findFirstOrThrow({ where: { obligationId: october.id } });
      const gone = "dues_ledger: rows are never deleted";
      await refused(tx, () => tx.duesSettlement.delete({ where: { id: settlement.id } }), gone);
      await refused(tx, () => tx.duesPayment.delete({ where: { id: payment.id } }), gone);
      await refused(tx, () => tx.duesLateFee.delete({ where: { id: fee.id } }), gone);
      await refused(tx, () => tx.duesCoverage.delete({ where: { id: coverage.id } }), gone);
      await refused(tx, () => tx.duesObligation.delete({ where: { id: october.id } }), gone);
      await reverse(tx, payment.id);
      await refused(tx, () => tx.duesSettlement.delete({ where: { id: settlement.id } }), gone);
      await refused(tx, () => tx.duesPayment.delete({ where: { id: payment.id } }), gone);
    });
  });
});

describe("documented non-guarantees (future writers own these, transactionally)", () => {
  it("a settlement has no amount, so the database does NOT check that a payment covers the obligation or matches its currency", async () => {
    await isolated(async (tx) => {
      const october = await createObligation(tx); // USD 100.00
      const tiny = await createPayment(tx, { tenderAmount: "0.01", tenderCurrency: "CRC" });
      await settle(tx, tiny.id, october.id); // accepted: validation of tender against obligations is the writer's job
      expect(await tx.duesSettlement.count({ where: { obligationId: october.id } })).toBe(1);
    });
  });

  it("the payment marker and the settlement markers are separate rows, so reversing a payment does NOT by itself reverse its settlements", async () => {
    await isolated(async (tx) => {
      const october = await createObligation(tx);
      const payment = await createPayment(tx);
      const settlement = await settle(tx, payment.id, october.id);
      await tx.duesPayment.update({ where: { id: payment.id }, data: marker() }); // accepted: writers must reverse both, in one transaction
      const still = await tx.duesSettlement.findUniqueOrThrow({ where: { id: settlement.id } });
      expect(still.reversedAt).toBeNull();
    });
  });

  it("a writer that reads a version's price without locking it can snapshot a stale price: only branch, currency and duration are checked", async () => {
    await isolated(async (tx) => {
      const t = await newTerms("price-not-checked");
      // the version says 100.00; an obligation with a different amount is accepted (amounts may differ by exception, decision D8)
      await tx.duesObligation.create({ data: obligationData({ planTermsId: t.id, amount: "37.00" }) });
    });
  });
});

describe("configuration versions referenced by an obligation are protected", () => {
  it("a referenced terms or policy version cannot be updated or deleted; an unreferenced one can still be corrected", async () => {
    await isolated(async (tx) => {
      const t = await newTerms("protect");
      const free = await newTerms("free");
      await createObligation(tx, { planTermsId: t.id });
      await refused(tx, () => tx.paymentPlanTerms.update({ where: { id: t.id }, data: { priceAmount: "55.00" } }), "dues_config_referenced");
      await refused(tx, () => tx.paymentPlanTerms.delete({ where: { id: t.id } }), "DuesObligation_organizationId_planTermsId_fkey");
      await refused(tx, () => tx.duesPolicyVersion.update({ where: { id: policy1.id }, data: { lateFeeAmount: "21.00" } }), "dues_config_referenced");
      await refused(tx, () => tx.duesPolicyVersion.delete({ where: { id: policy1.id } }), "DuesObligation_organizationId_policyVersionId_fkey");
      await tx.paymentPlanTerms.update({ where: { id: free.id }, data: { priceAmount: "55.00" } });
      expect((await tx.paymentPlanTerms.findUniqueOrThrow({ where: { id: free.id } })).priceAmount.toFixed(2)).toBe("55.00");
    });
  });

  /** Two real connections. `holdA` and `holdB` keep a transaction open until released, so the interleaving is deterministic. */
  it("CONCURRENT: a correction started while an obligation referencing the version is uncommitted waits, then is refused", async () => {
    const t = await newTerms("race-reference-first");
    const inserted = deferred();
    const releaseA = deferred();
    const txA = prisma.$transaction(
      async (tx) => {
        await createObligation(tx, { planTermsId: t.id });
        inserted.resolve();
        await releaseA.promise;
      },
      { timeout: 60_000 },
    );
    await inserted.promise;
    let bDone = false;
    const txB = prisma
      .$transaction(async (tx) => tx.paymentPlanTerms.update({ where: { id: t.id }, data: { priceAmount: "55.00" } }), { timeout: 60_000 })
      .then(
        () => ((bDone = true), null),
        (e: unknown) => ((bDone = true), e),
      );
    await sleep(600);
    expect(bDone, "the correction must wait for the uncommitted reference, not slip past it").toBe(false);
    releaseA.resolve();
    await txA;
    const error = await txB;
    expect(dbMessage(error)).toContain("dues_config_referenced");
    expect((await prisma.paymentPlanTerms.findUniqueOrThrow({ where: { id: t.id } })).priceAmount.toFixed(2)).toBe("100.00");
    expect(await prisma.duesObligation.count({ where: { planTermsId: t.id } })).toBe(1);
  });

  it("CONCURRENT: an obligation created while a correction of its version is uncommitted waits, then sees the corrected version and is refused if it no longer agrees", async () => {
    const t = await newTerms("race-correction-first");
    const updated = deferred();
    const releaseB = deferred();
    const txB = prisma.$transaction(
      async (tx) => {
        await tx.paymentPlanTerms.update({ where: { id: t.id }, data: { currency: "CRC" } });
        updated.resolve();
        await releaseB.promise;
      },
      { timeout: 60_000 },
    );
    await updated.promise;
    let aDone = false;
    const student = { studentId: bruno.id };
    const txA = prisma
      .$transaction(async (tx) => createObligation(tx, { ...student, planTermsId: t.id, currency: "USD" }), { timeout: 60_000 })
      .then(
        () => ((aDone = true), null),
        (e: unknown) => ((aDone = true), e),
      );
    await sleep(600);
    expect(aDone, "the obligation must wait for the uncommitted correction").toBe(false);
    releaseB.resolve();
    await txB;
    const error = await txA;
    expect(dbMessage(error)).toContain("dues_ledger: currency does not match");
    expect(await prisma.duesObligation.count({ where: { planTermsId: t.id } })).toBe(0);
  });
});

describe("configuration protection under concurrency: policy versions", () => {
  let policyCounter = 0;
  const freshPolicy = () =>
    prisma.duesPolicyVersion.create({
      data: {
        organizationId: a.org.id, academyId: a.academy.id, effectiveYear: 2050 + Math.floor(policyCounter / 12), effectiveMonth: (policyCounter++ % 12) + 1,
        dueDay: 20, graceDay: 5, lateFeeAmount: "20.00", lateFeeCurrency: "USD", createdById: a.admin.id,
      },
    });

  it("CONCURRENT: a policy correction started while an obligation referencing it is uncommitted waits, then is refused", async () => {
    const policy = await freshPolicy();
    const inserted = deferred();
    const releaseA = deferred();
    const txA = prisma.$transaction(
      async (tx) => {
        await createObligation(tx, { policyVersionId: policy.id });
        inserted.resolve();
        await releaseA.promise;
      },
      { timeout: 60_000 },
    );
    await inserted.promise;
    let bDone = false;
    const txB = prisma
      .$transaction(async (tx) => tx.duesPolicyVersion.update({ where: { id: policy.id }, data: { lateFeeAmount: "25.00" } }), { timeout: 60_000 })
      .then(
        () => ((bDone = true), null),
        (e: unknown) => ((bDone = true), e),
      );
    await sleep(600);
    expect(bDone, "the correction must wait for the uncommitted reference").toBe(false);
    releaseA.resolve();
    await txA;
    const error = await txB;
    expect(dbMessage(error)).toContain("dues_config_referenced");
    expect((await prisma.duesPolicyVersion.findUniqueOrThrow({ where: { id: policy.id } })).lateFeeAmount.toFixed(2)).toBe("20.00");
  });

  it("CONCURRENT: an obligation created while a policy correction is uncommitted waits, then is refused if the corrected policy no longer agrees", async () => {
    const policy = await freshPolicy();
    const updated = deferred();
    const releaseB = deferred();
    const txB = prisma.$transaction(
      async (tx) => {
        await tx.duesPolicyVersion.update({ where: { id: policy.id }, data: { lateFeeCurrency: "CRC" } });
        updated.resolve();
        await releaseB.promise;
      },
      { timeout: 60_000 },
    );
    await updated.promise;
    let aDone = false;
    const txA = prisma
      .$transaction(async (tx) => createObligation(tx, { studentId: bruno.id, policyVersionId: policy.id }), { timeout: 60_000 })
      .then(
        () => ((aDone = true), null),
        (e: unknown) => ((aDone = true), e),
      );
    await sleep(600);
    expect(aDone, "the obligation must wait for the uncommitted policy correction").toBe(false);
    releaseB.resolve();
    await txB;
    const error = await txA;
    expect(dbMessage(error)).toContain("dues_ledger: currency does not match its policy version");
    expect(await prisma.duesObligation.count({ where: { policyVersionId: policy.id } })).toBe(0);
  });
});

describe("concurrent writes keep the ledger's uniqueness", () => {
  it("two payments settling one obligation at the same moment: exactly one active settlement survives", async () => {
    const october = await createObligation(prisma);
    const p1 = await createPayment(prisma);
    const p2 = await createPayment(prisma);
    const inserted = deferred();
    const release = deferred();
    const tx1 = prisma.$transaction(
      async (tx) => {
        await settle(tx, p1.id, october.id);
        inserted.resolve();
        await release.promise;
      },
      { timeout: 60_000 },
    );
    await inserted.promise;
    let done = false;
    const tx2 = prisma.$transaction(async (tx) => settle(tx, p2.id, october.id), { timeout: 60_000 }).then(
      () => ((done = true), null),
      (e: unknown) => ((done = true), e),
    );
    await sleep(600);
    expect(done, "the second settlement must wait on the first").toBe(false);
    release.resolve();
    await tx1;
    const error = await tx2;
    expect(dbMessage(error)).toContain("DuesSettlement_one_active_per_obligation_key");
    expect(await prisma.duesSettlement.count({ where: { obligationId: october.id, reversedAt: null } })).toBe(1);
  });

  it("two obligations covering the same student-month at the same moment (a monthly and a package): exactly one wins", async () => {
    const month = nextMonth();
    const inserted = deferred();
    const release = deferred();
    const monthly = prisma.$transaction(
      async (tx) => {
        await createObligation(tx, { coverageYear: month.year, coverageMonth: month.month });
        inserted.resolve();
        await release.promise;
      },
      { timeout: 60_000 },
    );
    await inserted.promise;
    let done = false;
    const pack = prisma
      .$transaction(
        async (tx) =>
          createObligation(tx, {
            type: "PACKAGE", monthsCovered: 3, planTermsId: termsPackage.id, amount: "270.00", dueOn: null, graceDeadline: null, lateFeeAmount: null, policyVersionId: null,
            coverageYear: month.year, coverageMonth: month.month,
          }),
        { timeout: 60_000 },
      )
      .then(
        () => ((done = true), null),
        (e: unknown) => ((done = true), e),
      );
    await sleep(600);
    expect(done, "the package must wait on the monthly obligation's coverage").toBe(false);
    release.resolve();
    await monthly;
    const error = await pack;
    expect(dbMessage(error)).toContain("DuesCoverage_studentId_year_month_key");
    expect(await prisma.duesCoverage.count({ where: { studentId: ana.id, year: month.year, month: month.month } })).toBe(1);
    expect(await prisma.duesObligation.count({ where: { studentId: ana.id, coverageYear: month.year, coverageMonth: month.month } })).toBe(1);
  });

  it("two reversals of one payment at the same moment: the second is refused, the first keeps its owner and reason", async () => {
    const october = await createObligation(prisma);
    const payment = await createPayment(prisma);
    await settle(prisma, payment.id, october.id);
    const marked = deferred();
    const release = deferred();
    const tx1 = prisma.$transaction(
      async (tx) => {
        await tx.duesPayment.update({ where: { id: payment.id }, data: marker("first owner") });
        marked.resolve();
        await release.promise;
      },
      { timeout: 60_000 },
    );
    await marked.promise;
    const tx2 = prisma
      .$transaction(async (tx) => tx.duesPayment.update({ where: { id: payment.id }, data: marker("second owner") }), { timeout: 60_000 })
      .then(
        () => null,
        (e: unknown) => e,
      );
    await sleep(600);
    release.resolve();
    await tx1;
    const error = await tx2;
    expect(dbMessage(error)).toContain("dues_ledger: only the reversal marker may be set, once");
    expect((await prisma.duesPayment.findUniqueOrThrow({ where: { id: payment.id } })).reversalReason).toBe("first owner");
  });
});

describe("scope of the migration and the tenant guard", () => {
  it("is additive: it never alters a legacy or organization table, and touches the 2A tables only with a unique index and triggers", () => {
    const sql = readFileSync("prisma/migrations/20260927153000_dues_ledger_schema/migration.sql", "utf8");
    expect(sql).not.toMatch(/DROP\s+(TABLE|COLUMN|INDEX|CONSTRAINT)/i);
    for (const table of ["PaymentPeriod", "PaymentPlan", "Student", "Academy", "User", "Organization", "DuesPolicyVersion", "PaymentPlanTerms", "StudentPlanAssignment"]) {
      expect(sql, `no ALTER TABLE on ${table}`).not.toMatch(new RegExp(`ALTER TABLE "${table}"`));
    }
    expect(sql).toContain('CREATE UNIQUE INDEX "PaymentPlanTerms_organizationId_id_key"');
    expect(sql).toContain('CREATE UNIQUE INDEX "DuesPolicyVersion_organizationId_id_key"');
    expect(sql).not.toMatch(/INSERT\s+INTO/i); // no seed, no default amount, fee, limit or date
  });

  it("every ledger table is empty apart from this file's temporary organizations", async () => {
    const ours = [a.org.id, b.org.id];
    for (const delegate of ["duesObligation", "duesCoverage", "duesLateFee", "duesPayment", "duesSettlement"] as const) {
      const count = await (prisma[delegate] as unknown as { count: (args: object) => Promise<number> }).count({ where: { organizationId: { notIn: ours } } });
      expect(count, `${delegate} must hold no row outside the temporary test organizations`).toBe(0);
    }
  });

  it.each(["duesObligation", "duesCoverage", "duesLateFee", "duesPayment", "duesSettlement"] as const)(
    "the guarded client refuses an unscoped %s query and allows one scoped by organization",
    async (delegate) => {
      const model = guardedPrisma[delegate] as unknown as { findMany: (args: object) => Promise<unknown[]> };
      await expect(model.findMany({})).rejects.toThrow(UnscopedTenantQueryError);
      await expect(model.findMany({ where: { organizationId: a.org.id } })).resolves.toBeInstanceOf(Array);
    },
  );
});
