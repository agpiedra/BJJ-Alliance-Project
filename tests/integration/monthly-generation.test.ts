import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getTestPrismaClient } from "../helpers/test-db";
import { prisma as appPrisma } from "../../src/lib/prisma";
import { makeAccountingOrg } from "../helpers/accounting-org";
import type { TenantContext } from "../../src/lib/tenant/types";
import { generateMonthlyObligationForStudent } from "../../src/lib/dues/monthly-generation";
import { createMonthlyObligationInTx } from "../../src/lib/dues/ledger/create-monthly-obligation";
import type { LedgerActivation } from "../../src/lib/dues/ledger/activation";
import type { YearMonth } from "../../src/lib/dues/calendar";

let currentSession: { user: { id: string; role: string } | null } | null = null;
vi.mock("@/auth", () => ({ auth: () => Promise.resolve(currentSession), signIn: vi.fn() }));
const { assignPlan } = await import("../../src/lib/dues/assignment-actions");

/**
 * Monthly-generation brief, proved against the REAL test database with a private, temporary organization. Both the
 * assignment-race tests and the immutability/rerun tests exist because the brief explicitly rejected treating either as a
 * safe assumption — §5 (races) and §3/§4 (recovery, immutability) are verification requirements, not proven claims.
 */
const prisma = getTestPrismaClient();
type Fixture = Awaited<ReturnType<typeof makeAccountingOrg>>;
const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
const ACTIVE: LedgerActivation = { isActive: async () => true };
const at = (isoLocal: string) => () => new Date(`${isoLocal}-06:00`); // Costa Rica, UTC-6 all year
const DEC_2030 = at("2030-12-01T12:00:00");
const FEB_2031 = at("2031-02-15T12:00:00"); // a later real date, for the delayed-generation test

let a: Fixture;
let planId: string;
let terms: { id: string };

function actAs(userId: string | null, role = "ADMIN") {
  currentSession = userId ? { user: { id: userId, role } } : null;
}
function context(over: Partial<TenantContext> = {}): TenantContext {
  return { kind: "tenant", actorUserId: a.admin.id, organizationId: a.org.id, organizationRole: "ADMIN", academyIds: "ALL", selfStudentId: null, linkedStudentId: null, ...over };
}
function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) fd.set(key, value);
  return fd;
}

let studentCounter = 0;
/** A student, ACTIVE since well before the target month — one real StudentStatusChange row, inserted directly (the writer
 * under test is generateMonthlyObligationForStudent, not the status actions, which have their own test coverage). */
async function newEligibleStudent(label: string): Promise<{ id: string }> {
  const n = ++studentCounter;
  const student = await prisma.student.create({
    data: {
      organizationId: a.org.id, homeAcademyId: a.academy.id, firstName: "Gen", lastName: `${label}${n}`, phone: "00000000",
      email: `gen-${label}-${n}-${suffix}@example.com`, currentRankId: await a.rankId("WHITE"), codeHash: `gen-${label}-${n}-${suffix}`, status: "ACTIVE",
    },
  });
  await prisma.studentStatusChange.create({
    data: { organizationId: a.org.id, studentId: student.id, status: "ACTIVE", effectiveOn: new Date(Date.UTC(2030, 7, 1)), sequence: 1, source: "EVENT", actorId: a.admin.id },
  });
  return student;
}

/** A dedicated, test-controlled transaction that takes the student lock and holds it until `release()` is called — the
 * exact technique tests/integration/dues-ledger-writers.test.ts and student-status-history.test.ts already use, not a race
 * between two real calls with unpredictable timing. */
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
  a = await makeAccountingOrg("CUMULATIVE", "gen-a");
  const plan = await prisma.paymentPlan.create({ data: { organizationId: a.org.id, academyId: a.academy.id, name: `Gen plan ${suffix}` } });
  planId = plan.id;
  terms = await prisma.paymentPlanTerms.create({
    data: { organizationId: a.org.id, planId, effectiveYear: 2027, effectiveMonth: 1, priceAmount: "100.00", currency: "USD", monthsCovered: 1, createdById: a.admin.id },
  });
  await prisma.duesPolicyVersion.create({
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
    await prisma.studentPlanAssignment.deleteMany({ where: { organizationId: a.org.id } });
    await prisma.studentStatusChange.deleteMany({ where: { organizationId: a.org.id } });
    await prisma.auditLog.deleteMany({ where: { organizationId: a.org.id } });
    await prisma.paymentPlanTerms.deleteMany({ where: { organizationId: a.org.id } });
    await prisma.duesPolicyVersion.deleteMany({ where: { organizationId: a.org.id } });
    await prisma.paymentPlan.deleteMany({ where: { organizationId: a.org.id } });
  }
  await a?.drop();
}, 120_000);

describe("ordinary outcomes", () => {
  it("creates an obligation for an eligible, assigned, priced student", async () => {
    const student = await newEligibleStudent("basic");
    actAs(a.admin.id);
    expect(await assignPlan(a.org.id, {}, form({ studentId: student.id, effectiveYear: "2030", effectiveMonth: "9", planId }))).toEqual({ ok: true });

    const outcome = await generateMonthlyObligationForStudent(context(), student.id, { year: 2030, month: 9 }, { activation: ACTIVE, now: DEC_2030 });
    expect(outcome).toMatchObject({ category: "created" });
  });

  it("notEligible: a student with no status history at all (UNDECIDABLE)", async () => {
    const student = await prisma.student.create({
      data: {
        organizationId: a.org.id, homeAcademyId: a.academy.id, firstName: "Gen", lastName: `nohist${++studentCounter}`, phone: "00000000",
        email: `gen-nohist-${studentCounter}-${suffix}@example.com`, currentRankId: await a.rankId("WHITE"), codeHash: `gen-nohist-${studentCounter}-${suffix}`, status: "ACTIVE",
      },
    });
    const outcome = await generateMonthlyObligationForStudent(context(), student.id, { year: 2030, month: 9 }, { activation: ACTIVE, now: DEC_2030 });
    expect(outcome).toEqual({ category: "notEligible", reason: "UNDECIDABLE" });
  });

  it("notEligible: eligible status but no assignment at all (NO_ASSIGNMENT)", async () => {
    const student = await newEligibleStudent("noassign");
    const outcome = await generateMonthlyObligationForStudent(context(), student.id, { year: 2030, month: 9 }, { activation: ACTIVE, now: DEC_2030 });
    expect(outcome).toEqual({ category: "notEligible", reason: "NO_ASSIGNMENT" });
  });

  it("configurationGap: eligible and assigned, but the plan has no effective terms for the month", async () => {
    const unpricedPlan = await prisma.paymentPlan.create({ data: { organizationId: a.org.id, academyId: a.academy.id, name: `Unpriced ${suffix}` } });
    const student = await newEligibleStudent("unpriced");
    actAs(a.admin.id);
    expect(await assignPlan(a.org.id, {}, form({ studentId: student.id, effectiveYear: "2030", effectiveMonth: "9", planId: unpricedPlan.id }))).toEqual({ ok: true });

    const outcome = await generateMonthlyObligationForStudent(context(), student.id, { year: 2030, month: 9 }, { activation: ACTIVE, now: DEC_2030 });
    expect(outcome).toEqual({ category: "configurationGap", reason: "noEffectiveVersion" });
  });

  it("a rerun after the missing configuration is supplied succeeds", async () => {
    const latePlan = await prisma.paymentPlan.create({ data: { organizationId: a.org.id, academyId: a.academy.id, name: `Late-priced ${suffix}` } });
    const student = await newEligibleStudent("laterpriced");
    actAs(a.admin.id);
    expect(await assignPlan(a.org.id, {}, form({ studentId: student.id, effectiveYear: "2030", effectiveMonth: "9", planId: latePlan.id }))).toEqual({ ok: true });

    const before = await generateMonthlyObligationForStudent(context(), student.id, { year: 2030, month: 9 }, { activation: ACTIVE, now: DEC_2030 });
    expect(before).toEqual({ category: "configurationGap", reason: "noEffectiveVersion" });

    await prisma.paymentPlanTerms.create({
      data: { organizationId: a.org.id, planId: latePlan.id, effectiveYear: 2027, effectiveMonth: 1, priceAmount: "80.00", currency: "USD", monthsCovered: 1, createdById: a.admin.id },
    });
    const after = await generateMonthlyObligationForStudent(context(), student.id, { year: 2030, month: 9 }, { activation: ACTIVE, now: DEC_2030 });
    expect(after).toMatchObject({ category: "created" });
  });

  it("failure: LedgerActivation inactive (the production default) reports failure, writes nothing", async () => {
    const student = await newEligibleStudent("inactive");
    actAs(a.admin.id);
    expect(await assignPlan(a.org.id, {}, form({ studentId: student.id, effectiveYear: "2030", effectiveMonth: "9", planId }))).toEqual({ ok: true });

    const before = await prisma.duesObligation.count({ where: { organizationId: a.org.id, studentId: student.id } });
    const outcome = await generateMonthlyObligationForStudent(context(), student.id, { year: 2030, month: 9 }, { now: DEC_2030 }); // no activation injected
    expect(outcome).toEqual({ category: "failure", reason: "notActive" });
    expect(await prisma.duesObligation.count({ where: { organizationId: a.org.id, studentId: student.id } })).toBe(before);
  });
});

describe("simultaneous generation for the same student: no duplicate obligation", () => {
  it("two concurrent generation calls serialize on the student lock; exactly one obligation results", async () => {
    const student = await newEligibleStudent("dupe");
    actAs(a.admin.id);
    expect(await assignPlan(a.org.id, {}, form({ studentId: student.id, effectiveYear: "2030", effectiveMonth: "9", planId }))).toEqual({ ok: true });

    const [first, second] = await Promise.all([
      generateMonthlyObligationForStudent(context(), student.id, { year: 2030, month: 9 }, { activation: ACTIVE, now: DEC_2030 }),
      generateMonthlyObligationForStudent(context(), student.id, { year: 2030, month: 9 }, { activation: ACTIVE, now: DEC_2030 }),
    ]);
    const categories = [first.category, second.category].sort();
    expect(categories).toEqual(["alreadyCovered", "created"]);
    expect(await prisma.duesObligation.count({ where: { organizationId: a.org.id, studentId: student.id, coverageYear: 2030, coverageMonth: 9 } })).toBe(1);
  });
});

describe("both assignment races (brief §5) — genuine lock contention, each order forced deterministically", () => {
  it("order A: assignPlan is genuinely blocked by a held student lock, then wins it and commits; generation then sees it and creates the obligation", async () => {
    const student = await newEligibleStudent("race-a");
    const { startedPromise, release, held } = holdStudentLock(student.id);
    await startedPromise;

    actAs(a.admin.id);
    let assignDone = false;
    const assigning = assignPlan(a.org.id, {}, form({ studentId: student.id, effectiveYear: "2030", effectiveMonth: "9", planId })).then((r) => ((assignDone = true), r));
    const blocked = await waitUntilBlockedOnLock(['FROM "Student"', "FOR UPDATE"]);
    expect(blocked, "assignPlan must genuinely wait on the student row lock (its new lockStudent call)").toBe(true);
    expect(assignDone).toBe(false);

    release();
    await held;
    expect(await assigning).toEqual({ ok: true });

    const outcome = await generateMonthlyObligationForStudent(context(), student.id, { year: 2030, month: 9 }, { activation: ACTIVE, now: DEC_2030 });
    expect(outcome).toMatchObject({ category: "created" });
  });

  it("order B: generation is genuinely blocked by a held student lock, then wins it, finds no assignment yet and reports a gap (not an obligation); assignPlan's insert lands cleanly after, and a later rerun of generation succeeds", async () => {
    const student = await newEligibleStudent("race-b");
    const { startedPromise, release, held } = holdStudentLock(student.id);
    await startedPromise;

    let generationDone = false;
    const generating = generateMonthlyObligationForStudent(context(), student.id, { year: 2030, month: 9 }, { activation: ACTIVE, now: DEC_2030 }).then((r) => ((generationDone = true), r));
    const blocked = await waitUntilBlockedOnLock(['FROM "Student"', "FOR UPDATE"]);
    expect(blocked, "generation must genuinely wait on the student row lock").toBe(true);
    expect(generationDone).toBe(false);

    release();
    await held;

    const firstOutcome = await generating;
    // Do NOT claim the lock guarantees an obligation regardless of order — this order finds nothing, and must say so honestly.
    expect(firstOutcome).toEqual({ category: "notEligible", reason: "NO_ASSIGNMENT" });
    expect(await prisma.duesObligation.count({ where: { organizationId: a.org.id, studentId: student.id, coverageYear: 2030, coverageMonth: 9 } })).toBe(0);

    actAs(a.admin.id);
    expect(await assignPlan(a.org.id, {}, form({ studentId: student.id, effectiveYear: "2030", effectiveMonth: "9", planId }))).toEqual({ ok: true });

    const retried = await generateMonthlyObligationForStudent(context(), student.id, { year: 2030, month: 9 }, { activation: ACTIVE, now: DEC_2030 });
    expect(retried).toMatchObject({ category: "created" });
  });
});

describe("recovery and immutability (brief §3/§4) — verified, not assumed", () => {
  it("a rerun of an already-generated month changes nothing: the stored row is byte-for-byte identical", async () => {
    const student = await newEligibleStudent("rerun");
    actAs(a.admin.id);
    expect(await assignPlan(a.org.id, {}, form({ studentId: student.id, effectiveYear: "2030", effectiveMonth: "9", planId }))).toEqual({ ok: true });

    const first = await generateMonthlyObligationForStudent(context(), student.id, { year: 2030, month: 9 }, { activation: ACTIVE, now: DEC_2030 });
    expect(first).toMatchObject({ category: "created" });
    const before = await prisma.duesObligation.findUniqueOrThrow({ where: { id: (first as { obligationId: string }).obligationId } });

    const second = await generateMonthlyObligationForStudent(context(), student.id, { year: 2030, month: 9 }, { activation: ACTIVE, now: DEC_2030 });
    expect(second).toEqual({ category: "alreadyCovered", reason: "existingObligation", obligationId: before.id });
    const after = await prisma.duesObligation.findUniqueOrThrow({ where: { id: before.id } });
    expect(after).toEqual(before);
  });

  it("an already-created obligation cannot be altered by a direct update — PR 2B's whole-row immutability trigger holds for a generation-created row too", async () => {
    const student = await newEligibleStudent("immutable");
    actAs(a.admin.id);
    expect(await assignPlan(a.org.id, {}, form({ studentId: student.id, effectiveYear: "2030", effectiveMonth: "9", planId }))).toEqual({ ok: true });
    const created = await generateMonthlyObligationForStudent(context(), student.id, { year: 2030, month: 9 }, { activation: ACTIVE, now: DEC_2030 });
    expect(created).toMatchObject({ category: "created" });
    const obligationId = (created as { obligationId: string }).obligationId;

    await expect(prisma.duesObligation.update({ where: { id: obligationId }, data: { amount: "999.99" } })).rejects.toThrow();

    const unchanged = await prisma.duesObligation.findUniqueOrThrow({ where: { id: obligationId } });
    expect(unchanged.amount.toFixed(2)).toBe("100.00");
  });

  it("a later assignment change does not alter an obligation already created from the earlier one", async () => {
    const student = await newEligibleStudent("laterassign");
    const secondPlan = await prisma.paymentPlan.create({ data: { organizationId: a.org.id, academyId: a.academy.id, name: `Second plan ${suffix}` } });
    await prisma.paymentPlanTerms.create({
      data: { organizationId: a.org.id, planId: secondPlan.id, effectiveYear: 2027, effectiveMonth: 1, priceAmount: "150.00", currency: "USD", monthsCovered: 1, createdById: a.admin.id },
    });
    actAs(a.admin.id);
    expect(await assignPlan(a.org.id, {}, form({ studentId: student.id, effectiveYear: "2030", effectiveMonth: "9", planId }))).toEqual({ ok: true });
    const created = await generateMonthlyObligationForStudent(context(), student.id, { year: 2030, month: 9 }, { activation: ACTIVE, now: DEC_2030 });
    expect(created).toMatchObject({ category: "created" });
    const obligationId = (created as { obligationId: string }).obligationId;

    // A first-time assignment for a LATER month (never a correction of September's, which is now past — append-only).
    expect(await assignPlan(a.org.id, {}, form({ studentId: student.id, effectiveYear: "2030", effectiveMonth: "12", planId: secondPlan.id }))).toEqual({ ok: true });

    const stillOriginal = await prisma.duesObligation.findUniqueOrThrow({ where: { id: obligationId } });
    expect(stillOriginal.amount.toFixed(2)).toBe("100.00");
    expect(stillOriginal.planTermsId).toBe(terms.id);
  });

  it("on-time vs. delayed generation with equivalent stored history produces an identical result", async () => {
    const onTime = await newEligibleStudent("ontime");
    const delayed = await newEligibleStudent("delayed");
    actAs(a.admin.id);
    expect(await assignPlan(a.org.id, {}, form({ studentId: onTime.id, effectiveYear: "2030", effectiveMonth: "9", planId }))).toEqual({ ok: true });
    expect(await assignPlan(a.org.id, {}, form({ studentId: delayed.id, effectiveYear: "2030", effectiveMonth: "9", planId }))).toEqual({ ok: true });

    const onTimeResult = await generateMonthlyObligationForStudent(context(), onTime.id, { year: 2030, month: 9 }, { activation: ACTIVE, now: DEC_2030 });
    const delayedResult = await generateMonthlyObligationForStudent(context(), delayed.id, { year: 2030, month: 9 }, { activation: ACTIVE, now: FEB_2031 });
    expect(onTimeResult.category).toBe("created");
    expect(delayedResult.category).toBe("created");

    const onTimeRow = await prisma.duesObligation.findUniqueOrThrow({ where: { id: (onTimeResult as { obligationId: string }).obligationId } });
    const delayedRow = await prisma.duesObligation.findUniqueOrThrow({ where: { id: (delayedResult as { obligationId: string }).obligationId } });
    expect(delayedRow.amount.toFixed(2)).toBe(onTimeRow.amount.toFixed(2));
    expect(delayedRow.dueOn).toEqual(onTimeRow.dueOn);
    expect(delayedRow.graceDeadline).toEqual(onTimeRow.graceDeadline);
    expect(delayedRow.currency).toBe(onTimeRow.currency);
  });
});

describe("createMonthlyObligationInTx validates its own inputs — it must not trust a caller that skipped them", () => {
  it("refuses malformed coverage months (month 13, non-integer year, year 1999, year 2101), writing nothing", async () => {
    const student = await newEligibleStudent("badmonth");
    const badMonths: YearMonth[] = [
      { year: 2030, month: 13 },
      { year: Number.NaN, month: 9 },
      { year: 1999, month: 9 },
      { year: 2101, month: 9 },
    ];
    for (const coverage of badMonths) {
      const result = await appPrisma.$transaction((tx) =>
        createMonthlyObligationInTx(
          tx,
          { context: context(), student: { id: student.id, homeAcademyId: a.academy.id }, coverage, planTermsId: "not-checked-yet", policyVersionId: "not-checked-yet" },
          { activation: ACTIVE, now: DEC_2030 },
        ),
      );
      expect(result).toEqual({ ok: false, error: "invalid" });
    }
    expect(await prisma.duesObligation.count({ where: { organizationId: a.org.id, studentId: student.id } })).toBe(0);
    expect(await prisma.duesCoverage.count({ where: { organizationId: a.org.id, studentId: student.id } })).toBe(0);
    expect(await prisma.auditLog.count({ where: { organizationId: a.org.id, entityId: student.id } })).toBe(0);
  });

  it("refuses null, undefined and shapeless coverage cleanly — assertYearMonth's property access must not throw uncaught past isValidCoverageMonth's catch", async () => {
    const student = await newEligibleStudent("nullmonth");
    const bypassed: unknown[] = [null, undefined, {}];
    for (const coverage of bypassed) {
      const result = await appPrisma.$transaction((tx) =>
        createMonthlyObligationInTx(
          tx,
          { context: context(), student: { id: student.id, homeAcademyId: a.academy.id }, coverage: coverage as YearMonth, planTermsId: "not-checked-yet", policyVersionId: "not-checked-yet" },
          { activation: ACTIVE, now: DEC_2030 },
        ),
      );
      expect(result).toEqual({ ok: false, error: "invalid" });
    }
    expect(await prisma.duesObligation.count({ where: { organizationId: a.org.id, studentId: student.id } })).toBe(0);
  });

  it("refuses a same-organization student outside the context's allowed branches, even though the caller already resolved homeAcademyId correctly", async () => {
    const otherAcademy = await prisma.academy.create({
      data: { organizationId: a.org.id, name: `Other branch ${suffix}`, slug: `other-branch-${suffix}`, kioskTokenHash: `other-branch-${suffix}` },
    });
    const student = await newEligibleStudent("outofscope"); // home academy is a.academy.id
    const scopedElsewhere = context({ organizationRole: "DIRECTOR", academyIds: [otherAcademy.id] }); // does NOT include a.academy.id
    // Real, valid ids for the student's OWN branch — a masked mutation-test trap: bogus ids would ALSO refuse "notFound" for
    // an unrelated reason (the terms/policy lookup), hiding whether the scope check itself ever ran. With real ids, removing
    // the scope check would let this actually create an obligation instead of refusing — a clearly different, wrong result.
    const policy = await prisma.duesPolicyVersion.findFirstOrThrow({ where: { organizationId: a.org.id, academyId: a.academy.id } });

    const result = await appPrisma.$transaction((tx) =>
      createMonthlyObligationInTx(
        tx,
        { context: scopedElsewhere, student: { id: student.id, homeAcademyId: a.academy.id }, coverage: { year: 2030, month: 9 }, planTermsId: terms.id, policyVersionId: policy.id },
        { activation: ACTIVE, now: DEC_2030 },
      ),
    );
    expect(result).toEqual({ ok: false, error: "notFound" });
    expect(await prisma.duesObligation.count({ where: { organizationId: a.org.id, studentId: student.id } })).toBe(0);
    expect(await prisma.auditLog.count({ where: { organizationId: a.org.id, entityId: student.id } })).toBe(0);

    await prisma.academy.delete({ where: { id: otherAcademy.id } });
  });
});

describe("generateMonthlyObligationForStudent rejects an invalid month before any lookup", () => {
  it("an invalid month on a nonexistent student id returns 'invalid', not 'notFound' — proving the month check runs before the student lookup", async () => {
    const outcome = await generateMonthlyObligationForStudent(context(), "does-not-exist-at-all", { year: 2030, month: 13 }, { activation: ACTIVE, now: DEC_2030 });
    expect(outcome).toEqual({ category: "failure", reason: "invalid" });
  });

  it("null, undefined and shapeless coverage refuse cleanly, never an uncaught exception", async () => {
    for (const month of [null, undefined, {}] as unknown[]) {
      const outcome = await generateMonthlyObligationForStudent(context(), "does-not-exist-at-all", month as YearMonth, { activation: ACTIVE, now: DEC_2030 });
      expect(outcome).toEqual({ category: "failure", reason: "invalid" });
    }
  });
});

describe("assignPlan's current-month check races its own lock wait, not a false assumption", () => {
  it("a month current when assignPlan is called can turn past while it waits on a held lock — it refuses pastMonth, never a stale ok", async () => {
    const student = await newEligibleStudent("boundary");
    const { startedPromise, release, held } = holdStudentLock(student.id);
    await startedPromise;

    try {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2030-09-30T23:59:00-06:00")); // still September, Costa Rica time (a.academy's zone)
      actAs(a.admin.id);
      let assignDone = false;
      const assigning = assignPlan(a.org.id, {}, form({ studentId: student.id, effectiveYear: "2030", effectiveMonth: "9", planId })).then((r) => ((assignDone = true), r));
      const blocked = await waitUntilBlockedOnLock(['FROM "Student"', "FOR UPDATE"]);
      expect(blocked, "assignPlan must genuinely wait on the student row lock before its month check runs").toBe(true);
      expect(assignDone).toBe(false);

      vi.setSystemTime(new Date("2030-10-01T00:05:00-06:00")); // October now — September just turned past while assignPlan waited
      release();
      await held;

      expect(await assigning).toEqual({ error: "pastMonth" });
      expect(await prisma.studentPlanAssignment.count({ where: { organizationId: a.org.id, studentId: student.id } })).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
