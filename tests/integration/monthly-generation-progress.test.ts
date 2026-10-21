import "dotenv/config";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getTestPrismaClient } from "../helpers/test-db";
import { makeAccountingOrg } from "../helpers/accounting-org";
import type { LedgerActivation } from "../../src/lib/dues/ledger/activation";
import type { YearMonth } from "../../src/lib/dues/calendar";
import type { Tx } from "../../src/lib/dues/ledger/common";
import type { GenerationBoundary, MonthlyGenerationRunDeps } from "../../src/lib/dues/monthly-generation-progress";

vi.mock("@/auth", () => ({ auth: () => Promise.resolve(null), signIn: vi.fn() }));
const { runMonthlyGeneration } = await import("../../src/lib/dues/monthly-generation-progress");
const { createMonthlyObligationInTx, writeMonthlyObligationInTx } = await import("../../src/lib/dues/ledger/create-monthly-obligation");
const { prisma: appPrisma } = await import("../../src/lib/prisma");

/**
 * Monthly-generation G1 (docs/dues/MONTHLY-GENERATION-TRIGGER-PLAN.md revision 4), proved against the real, isolated test
 * database. Each test builds private organizations; `DuesGenerationProgress` is used by no other test file (integration files
 * run one at a time), so every test starts from an empty table. Crashes are simulated deterministically at each commit boundary
 * of plan §6.4: a test hook throws `Crash` where the process would die, leaving whatever had committed; one scenario also kills
 * the student transaction's database connection for real (`pg_terminate_backend`). Evidence and limits:
 * design/matroom/verification/dues-g1-monthly-generation/README.md.
 */
const prisma = getTestPrismaClient();
const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
const ACTIVE: LedgerActivation = { isActive: async () => true };
const SEPT_2030 = () => new Date("2030-09-15T18:00:00Z"); // Costa Rica (UTC-6 all year): 2030-09-15 12:00
const S: YearMonth = { year: 2030, month: 9 };
class Crash extends Error {}

interface Branch {
  academyId: string;
  planId: string;
  unpricedPlanId: string;
}
interface Org {
  id: string;
  adminId: string;
  main: Branch;
  rankId: string;
  drop: () => Promise<void>;
}
const orgs: Org[] = [];
const starts = new Map<string, YearMonth>();
let counter = 0;

/** A branch (the given academy, or a new one) with a priced plan, an unpriced plan and a policy, all effective since 2027-01. */
async function addBranch(org: { id: string; adminId: string }, academyId?: string, opts: { active?: boolean; timezone?: string } = {}): Promise<Branch> {
  const n = counter++;
  const id =
    academyId ??
    (
      await prisma.academy.create({
        data: { organizationId: org.id, name: `G1 branch ${suffix}-${n}`, slug: `g1-${suffix}-${n}`, kioskTokenHash: `g1-${suffix}-${n}`, active: opts.active ?? true, timezone: opts.timezone ?? "America/Costa_Rica" },
      })
    ).id;
  const plan = await prisma.paymentPlan.create({ data: { organizationId: org.id, academyId: id, name: `G1 priced ${suffix}-${n}` } });
  await prisma.paymentPlanTerms.create({
    data: { organizationId: org.id, planId: plan.id, effectiveYear: 2027, effectiveMonth: 1, priceAmount: "100.00", currency: "USD", monthsCovered: 1, createdById: org.adminId },
  });
  await prisma.duesPolicyVersion.create({
    data: { organizationId: org.id, academyId: id, effectiveYear: 2027, effectiveMonth: 1, dueDay: 20, graceDay: 5, lateFeeAmount: "20.00", lateFeeCurrency: "USD", createdById: org.adminId },
  });
  const unpriced = await prisma.paymentPlan.create({ data: { organizationId: org.id, academyId: id, name: `G1 unpriced ${suffix}-${n}` } });
  return { academyId: id, planId: plan.id, unpricedPlanId: unpriced.id };
}

async function makeOrg(label: string, start: YearMonth | null = S): Promise<Org> {
  const fx = await makeAccountingOrg("CUMULATIVE", `g1-${label}`);
  const base = { id: fx.org.id, adminId: fx.admin.id };
  const org: Org = { ...base, main: await addBranch(base, fx.academy.id), rankId: await fx.rankId("WHITE"), drop: fx.drop };
  orgs.push(org);
  if (start) starts.set(org.id, start);
  return org;
}

type Kind = "priced" | "unpriced" | "ineligible";
/** A student ACTIVE since 2030-08-01 (one real status row), with no assignment yet. */
async function addStudent(org: Org, branch: Branch = org.main, id?: string): Promise<string> {
  const n = counter++;
  const student = await prisma.student.create({
    data: {
      ...(id ? { id } : {}),
      organizationId: org.id,
      homeAcademyId: branch.academyId,
      firstName: "G1",
      lastName: `s${n}`,
      phone: "00000000",
      email: `g1-${n}-${suffix}@example.com`,
      currentRankId: org.rankId,
      codeHash: `g1-${n}-${suffix}`,
      status: "ACTIVE",
    },
  });
  await prisma.studentStatusChange.create({
    data: { organizationId: org.id, studentId: student.id, status: "ACTIVE", effectiveOn: new Date(Date.UTC(2030, 7, 1)), sequence: 1, source: "EVENT", actorId: org.adminId },
  });
  return student.id;
}
async function assign(org: Org, studentId: string, kind: Kind, branch: Branch = org.main, month: YearMonth = S) {
  if (kind === "ineligible") return; // no assignment: NO_ASSIGNMENT
  await prisma.studentPlanAssignment.create({
    data: { organizationId: org.id, studentId, planId: kind === "priced" ? branch.planId : branch.unpricedPlanId, effectiveYear: month.year, effectiveMonth: month.month, createdById: org.adminId },
  });
}
/** Students of the organization in the database's own id order — the order the cursor walks. */
async function orderedIds(orgId: string): Promise<string[]> {
  return (await prisma.$queryRaw<{ id: string }[]>`SELECT "id" FROM "Student" WHERE "organizationId" = ${orgId} ORDER BY "id"`).map((r) => r.id);
}
/** `kinds.length` students, assigned so that the i-th in cursor order gets kinds[i]. */
async function studentsInOrder(org: Org, kinds: Kind[], branch: Branch = org.main): Promise<string[]> {
  for (let i = 0; i < kinds.length; i++) await addStudent(org, branch);
  const ids = await orderedIds(org.id);
  for (let i = 0; i < kinds.length; i++) await assign(org, ids[i], kinds[i], branch);
  return ids;
}
async function addSegment(orgId: string, month: YearMonth = S, lastVisitedAt = new Date(0)) {
  return prisma.duesGenerationProgress.create({ data: { organizationId: orgId, year: month.year, month: month.month, lastVisitedAt } });
}
const segment = (id: string) => prisma.duesGenerationProgress.findUniqueOrThrow({ where: { id } });
const expireLease = (id: string) => prisma.$executeRaw`UPDATE "DuesGenerationProgress" SET "leaseUntil" = (now() AT TIME ZONE 'UTC') - interval '1 hour' WHERE "id" = ${id}`;
const obligationsFor = (orgId: string, studentId?: string, month: YearMonth = S) =>
  prisma.duesObligation.findMany({ where: { organizationId: orgId, coverageYear: month.year, coverageMonth: month.month, ...(studentId ? { studentId } : {}) } });
async function financialCounts(orgId: string) {
  return {
    obligations: await prisma.duesObligation.count({ where: { organizationId: orgId } }),
    coverage: await prisma.duesCoverage.count({ where: { organizationId: orgId } }),
    audit: await prisma.auditLog.count({ where: { organizationId: orgId, action: "duesObligation.create" } }),
  };
}

function deps(over: Partial<MonthlyGenerationRunDeps> = {}): MonthlyGenerationRunDeps {
  return { closurePolicy: "none", activation: ACTIVE, now: SEPT_2030, generationStart: async (orgId) => starts.get(orgId) ?? null, ...over };
}
const crashAt =
  (boundary: GenerationBoundary, studentId?: string): MonthlyGenerationRunDeps["boundaryForTest"] =>
  async (b, where) => {
    if (b === boundary && (!studentId || where.studentId === studentId)) throw new Crash(boundary);
  };

/**
 * The contiguity invariant (plan §5): the four pass counts equal the number of students at or before the cursor; and, while no
 * pass has finished yet, a generation-created obligation exists only for a student at or before the cursor.
 */
async function expectContiguous(org: Org, segmentId: string) {
  const row = await segment(segmentId);
  const ids = await orderedIds(org.id);
  const upto = row.cursorStudentId ? ids.slice(0, ids.indexOf(row.cursorStudentId) + 1) : [];
  expect(row.passIneligible + row.passCovered + row.passUnpriced + row.passPending).toBe(upto.length);
  if (!row.lastPassCompletedAt) {
    for (const o of await obligationsFor(org.id, undefined, { year: row.year, month: row.month })) {
      if (o.origin === "SCHEDULED_JOB") expect(upto, `obligation for ${o.studentId} past the cursor`).toContain(o.studentId);
    }
  }
  return row;
}

beforeEach(async () => {
  await prisma.$executeRaw`DELETE FROM "DuesGenerationProgress"`;
});

afterAll(async () => {
  await prisma.$executeRaw`DELETE FROM "DuesGenerationProgress"`;
  for (const org of orgs) {
    await prisma.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe("SET LOCAL session_replication_role = replica");
        for (const table of ["DuesSettlement", "DuesPayment", "DuesLateFee", "DuesCoverage", "DuesObligation"]) {
          await tx.$executeRawUnsafe(`DELETE FROM "${table}" WHERE "organizationId" = $1`, org.id);
        }
      },
      { timeout: 60_000 },
    );
    await prisma.studentPlanAssignment.deleteMany({ where: { organizationId: org.id } });
    await prisma.studentStatusChange.deleteMany({ where: { organizationId: org.id } });
    await prisma.paymentPlanTerms.deleteMany({ where: { organizationId: org.id } });
    await prisma.duesPolicyVersion.deleteMany({ where: { organizationId: org.id } });
    await prisma.paymentPlan.deleteMany({ where: { organizationId: org.id } });
    await org.drop();
  }
}, 120_000);

describe("production defaults produce no financial writes", () => {
  it("with no progress row, a run claims nothing and writes nothing", async () => {
    const org = await makeOrg("nodefault");
    await studentsInOrder(org, ["priced", "priced"]);
    const before = await financialCounts(org.id);
    const report = await runMonthlyGeneration(deps());
    expect(report).toEqual({ visits: [], claimErrors: 0, stoppedBy: "noClaimableSegment" });
    expect(await financialCounts(org.id)).toEqual(before);
    expect(await prisma.duesGenerationProgress.count()).toBe(0);
  });

  it("with a progress row but production defaults (inactive ledger, no start month), every visit is refused and nothing financial is written", async () => {
    const org = await makeOrg("closed");
    await studentsInOrder(org, ["priced", "priced"]);
    const seg = await addSegment(org.id);
    const before = await financialCounts(org.id);

    const productionDefaults = await runMonthlyGeneration({ closurePolicy: "none", now: SEPT_2030 });
    expect(productionDefaults.visits.map((v) => v.refused)).toEqual(["ledgerNotActive"]);

    const activeButNoStart = await runMonthlyGeneration({ closurePolicy: "none", now: SEPT_2030, activation: ACTIVE });
    expect(activeButNoStart.visits.map((v) => v.refused)).toEqual(["beforeStart"]);

    const beforeS = await runMonthlyGeneration(deps({ generationStart: async () => ({ year: 2030, month: 10 }) }));
    expect(beforeS.visits.map((v) => v.refused)).toEqual(["beforeStart"]);

    expect(await financialCounts(org.id)).toEqual(before);
    const row = await segment(seg.id);
    expect(row.cursorStudentId).toBeNull();
    expect(row.passIneligible + row.passCovered + row.passUnpriced + row.passPending).toBe(0);
    expect(await prisma.duesGenerationProgress.count()).toBe(1); // no rollover on a refused visit
  });

  it("an organization that is not ACTIVE is refused even with an active ledger and a start month", async () => {
    const org = await makeOrg("suspended");
    await studentsInOrder(org, ["priced"]);
    await addSegment(org.id);
    await prisma.organization.update({ where: { id: org.id }, data: { status: "SUSPENDED" } });
    try {
      const report = await runMonthlyGeneration(deps());
      expect(report.visits.map((v) => v.refused)).toEqual(["organizationNotActive"]);
      expect((await financialCounts(org.id)).obligations).toBe(0);
    } finally {
      await prisma.organization.update({ where: { id: org.id }, data: { status: "ACTIVE" } });
    }
  });
});

describe("contiguous, atomically committed cursor and counts for every outcome", () => {
  it("each student's class and the cursor commit together, one student at a time, for every class", async () => {
    const org = await makeOrg("classes");
    const ids = await studentsInOrder(org, ["ineligible", "unpriced", "priced", "priced"]);
    await createByStaff(org, ids[3]); // the 4th already has an obligation: COVERED by the existing duplicate rule
    const seg = await addSegment(org.id);

    const observed: Array<{ cursor: string | null; total: number }> = [];
    const report = await runMonthlyGeneration(
      deps({
        boundaryForTest: async (b) => {
          if (b !== "afterStudentCommit") return;
          const row = await expectContiguous(org, seg.id);
          observed.push({ cursor: row.cursorStudentId, total: row.passIneligible + row.passCovered + row.passUnpriced + row.passPending });
        },
      }),
    );

    expect(observed).toEqual(ids.map((id, i) => ({ cursor: id, total: i + 1 })));
    const [visit] = report.visits;
    expect(visit.classes).toEqual({ INELIGIBLE: 1, COVERED: 2, UNPRICED: 1, PENDING: 0 });
    expect(visit.created).toBe(1);
    expect(visit.reasons).toEqual({ noEffectiveVersion: 1 });
    expect(visit.passFinished).toEqual({ ineligible: 1, covered: 2, unpriced: 1, pending: 0, clean: false });
    expect(await segment(seg.id)).toMatchObject({ cursorStudentId: null, passStartedAt: null, lastPassIneligible: 1, lastPassCovered: 2, lastPassUnpriced: 1, lastPassPending: 0, lastPassClean: false });
  });

  it("D1: a job-created obligation is SCHEDULED_JOB with a null creator and audit actor; the staff path stays STAFF with its actor; pricing and dates are identical", async () => {
    const org = await makeOrg("attribution");
    const [jobStudent, staffStudent] = await studentsInOrder(org, ["priced", "priced"]);
    await createByStaff(org, staffStudent);
    await addSegment(org.id);
    await runMonthlyGeneration(deps());

    const [job] = await obligationsFor(org.id, jobStudent);
    expect(job).toMatchObject({ origin: "SCHEDULED_JOB", createdById: null });
    expect(job.amount.toFixed(2)).toBe("100.00");
    expect((await prisma.auditLog.findFirstOrThrow({ where: { organizationId: org.id, entityId: job.id } })).actorId).toBeNull();

    const [staff] = await obligationsFor(org.id, staffStudent);
    expect(staff).toMatchObject({ origin: "STAFF", createdById: org.adminId });
    expect((await prisma.auditLog.findFirstOrThrow({ where: { organizationId: org.id, entityId: staff.id } })).actorId).toBe(org.adminId);

    for (const key of ["amount", "currency", "lateFeeAmount", "dueOn", "graceDeadline", "planTermsId", "policyVersionId", "coverageYear", "coverageMonth", "monthsCovered", "type"] as const) {
      expect(String(job[key]), key).toBe(String(staff[key]));
    }
    expect(await prisma.duesCoverage.count({ where: { obligationId: job.id } })).toBe(1);
  });

  it("D1 pairing: the write core refuses SCHEDULED_JOB from a staff context and any other origin from a system-job context", async () => {
    const org = await makeOrg("pairing");
    const [studentId] = await studentsInOrder(org, ["priced"]);
    const terms = await prisma.paymentPlanTerms.findFirstOrThrow({ where: { planId: org.main.planId } });
    const policy = await prisma.duesPolicyVersion.findFirstOrThrow({ where: { academyId: org.main.academyId } });
    const base = { student: { id: studentId, homeAcademyId: org.main.academyId }, coverage: S, planTermsId: terms.id, policyVersionId: policy.id };
    const job = { kind: "system-job" as const, organizationId: org.id, jobName: "monthly-generation" };
    await appPrisma.$transaction(async (tx) => {
      expect(await writeMonthlyObligationInTx(tx, { ...base, context: staffContext(org), origin: "SCHEDULED_JOB" }, { activation: ACTIVE })).toEqual({ ok: false, error: "invalid" });
      expect(await writeMonthlyObligationInTx(tx, { ...base, context: job, origin: "STAFF" }, { activation: ACTIVE })).toEqual({ ok: false, error: "invalid" });
      expect(await writeMonthlyObligationInTx(tx, { ...base, context: job, origin: "PREPAYMENT" }, { activation: ACTIVE })).toEqual({ ok: false, error: "invalid" });
    });
    expect((await financialCounts(org.id)).obligations).toBe(0);
  });
});

describe("obligation, coverage, audit and progress roll back together on fence loss", () => {
  it("a fenced cursor update that affects zero rows inside the student's transaction rolls back the obligation, coverage and audit rows with it", async () => {
    const org = await makeOrg("fence-rollback");
    const [a, b] = await studentsInOrder(org, ["unpriced", "priced"]);
    const seg = await addSegment(org.id);
    const before = await financialCounts(org.id);

    const report = await runMonthlyGeneration(
      deps({
        // Inside B's transaction, after its obligation/coverage/audit writes, the lease token changes (in this same
        // transaction — it holds the row lock), so B's fenced cursor update matches zero rows.
        beforeRecordForTest: async (tx: Tx, studentId) => {
          if (studentId !== b) return;
          expect(await tx.duesObligation.count({ where: { organizationId: org.id } })).toBe(before.obligations + 1); // really written
          expect(await tx.duesCoverage.count({ where: { organizationId: org.id } })).toBe(before.coverage + 1);
          expect(await tx.auditLog.count({ where: { organizationId: org.id, action: "duesObligation.create" } })).toBe(before.audit + 1);
          await tx.$executeRaw`UPDATE "DuesGenerationProgress" SET "leaseToken" = 'someone-else' WHERE "id" = ${seg.id}`;
        },
      }),
    );

    expect(report.visits[0].ended).toBe("fenced");
    expect(await financialCounts(org.id)).toEqual(before); // obligation, coverage and audit all rolled back
    const row = await segment(seg.id);
    expect(row.leaseToken).not.toBe("someone-else"); // the token change rolled back too
    expect(row).toMatchObject({ cursorStudentId: a, passUnpriced: 1, passCovered: 0 });
    await expectContiguous(org, seg.id);
  });

  it("lease takeover: a stale run fails its next fence before writing anything, and the claimant continues from the committed cursor", async () => {
    const org = await makeOrg("takeover");
    const [a, b, c] = await studentsInOrder(org, ["priced", "priced", "priced"]);
    const seg = await addSegment(org.id);
    let claimant: Awaited<ReturnType<typeof runMonthlyGeneration>> | undefined;

    const stale = await runMonthlyGeneration(
      deps({
        boundaryForTest: async (boundary, where) => {
          if (boundary !== "afterStudentCommit" || where.studentId !== a || claimant) return;
          await expireLease(seg.id); // the stale run's lease lapses between two of its student transactions
          claimant = await runMonthlyGeneration(deps());
        },
      }),
    );

    expect(stale.visits[0]).toMatchObject({ ended: "fenced", created: 1 });
    expect(claimant!.visits[0]).toMatchObject({ created: 2, passFinished: { covered: 3, ineligible: 0, unpriced: 0, pending: 0, clean: true } });
    for (const id of [a, b, c]) expect(await obligationsFor(org.id, id)).toHaveLength(1);
  });
});

describe("crash recovery at each documented commit boundary (plan §6.4), mixed page: A unpriced, B priced", () => {
  type Scenario = {
    name: string;
    crash: (ids: { a: string; b: string }) => Partial<MonthlyGenerationRunDeps>;
    after: { cursor: "none" | "a" | "b"; counts: [unpriced: number, covered: number, pending: number]; bObligation: boolean; markerA?: number };
  };
  const failB = (b: string) => async (_tx: Tx, studentId: string) => {
    if (studentId === b) throw new Error("injected failure inside B's transaction");
  };
  const scenarios: Scenario[] = [
    { name: "after the claim", crash: () => ({ boundaryForTest: crashAt("afterClaim") }), after: { cursor: "none", counts: [0, 0, 0], bObligation: false } },
    { name: "after the marker", crash: () => ({ boundaryForTest: crashAt("afterMarker") }), after: { cursor: "none", counts: [0, 0, 0], bObligation: false, markerA: 1 } },
    { name: "after A's transaction commits", crash: ({ a }) => ({ boundaryForTest: crashAt("afterStudentCommit", a) }), after: { cursor: "a", counts: [1, 0, 0], bObligation: false } },
    {
      name: "inside B's transaction, after its writes, before the cursor update",
      crash: ({ b }) => ({ beforeRecordForTest: failB(b), boundaryForTest: crashAt("afterStudentFailure", b) }),
      after: { cursor: "a", counts: [1, 0, 0], bObligation: false },
    },
    {
      name: "inside B's transaction, after the cursor update, before commit",
      crash: ({ b }) => ({ afterRecordForTest: failB(b), boundaryForTest: crashAt("afterStudentFailure", b) }),
      after: { cursor: "a", counts: [1, 0, 0], bObligation: false },
    },
    {
      name: "B's database connection killed for real (pg_terminate_backend) after the cursor update, before commit",
      crash: ({ b }) => ({
        afterRecordForTest: async (tx, studentId) => {
          if (studentId !== b) return;
          const [{ pid }] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
          await prisma.$queryRaw`SELECT pg_terminate_backend(${pid}::int)`;
        },
        boundaryForTest: crashAt("afterStudentFailure", b),
      }),
      after: { cursor: "a", counts: [1, 0, 0], bObligation: false },
    },
    { name: "after B's transaction commits", crash: ({ b }) => ({ boundaryForTest: crashAt("afterStudentCommit", b) }), after: { cursor: "b", counts: [1, 1, 0], bObligation: true } },
    {
      name: "after B's failure record commits",
      crash: ({ b }) => ({ beforeRecordForTest: failB(b), boundaryForTest: crashAt("afterFailureRecord", b) }),
      after: { cursor: "b", counts: [1, 0, 1], bObligation: false },
    },
    { name: "before the pass end", crash: () => ({ boundaryForTest: crashAt("beforePassEnd") }), after: { cursor: "b", counts: [1, 1, 0], bObligation: true } },
    { name: "after the pass end", crash: () => ({ boundaryForTest: crashAt("afterPassEnd") }), after: { cursor: "none", counts: [0, 0, 0], bObligation: true } },
  ];

  for (const scenario of scenarios) {
    it(`crash ${scenario.name}: committed state is contiguous, and recovery completes with no double count or duplicate`, async () => {
      const org = await makeOrg("crash");
      const [a, b] = await studentsInOrder(org, ["unpriced", "priced"]);
      const seg = await addSegment(org.id);

      await expect(runMonthlyGeneration(deps(scenario.crash({ a, b })))).rejects.toBeInstanceOf(Crash);

      const row = await expectContiguous(org, seg.id);
      expect(row.cursorStudentId).toBe({ none: null, a, b }[scenario.after.cursor]);
      expect([row.passUnpriced, row.passCovered, row.passPending]).toEqual(scenario.after.counts);
      expect(await obligationsFor(org.id, b)).toHaveLength(scenario.after.bObligation ? 1 : 0);
      expect(await obligationsFor(org.id, a)).toHaveLength(0);
      if (scenario.after.markerA) expect(row).toMatchObject({ inFlightStudentId: a, inFlightAttempts: scenario.after.markerA });

      // Recovery: the dead run's lease lapses; the next runs finish the interrupted pass and one more full pass.
      await expireLease(seg.id);
      await runMonthlyGeneration(deps());
      await runMonthlyGeneration(deps());
      expect(await segment(seg.id)).toMatchObject({ lastPassUnpriced: 1, lastPassCovered: 1, lastPassPending: 0, lastPassIneligible: 0, lastPassClean: false });
      expect(await obligationsFor(org.id, b)).toHaveLength(1);
      expect(await obligationsFor(org.id, a)).toHaveLength(0);
    });
  }

  it("a student that kills the process three visits in a row is recorded PENDING (repeatedFailure) on the fourth, passed, and keeps the pass from being clean", async () => {
    const org = await makeOrg("poison");
    const [x, y] = await studentsInOrder(org, ["priced", "priced"]);
    const seg = await addSegment(org.id);
    const killX: Partial<MonthlyGenerationRunDeps> = {
      beforeRecordForTest: async (_tx, studentId) => {
        if (studentId === x) throw new Error("dies on X");
      },
      boundaryForTest: crashAt("afterStudentFailure", x),
    };

    for (let attempt = 1; attempt <= 3; attempt++) {
      await expect(runMonthlyGeneration(deps(killX))).rejects.toBeInstanceOf(Crash);
      expect(await segment(seg.id)).toMatchObject({ cursorStudentId: null, inFlightStudentId: x, inFlightAttempts: attempt });
      await expireLease(seg.id);
    }
    const fourth = await runMonthlyGeneration(deps(killX)); // X is passed before it can die again
    expect(fourth.visits[0].reasons).toEqual({ repeatedFailure: 1 });
    expect(fourth.visits[0].passFinished).toEqual({ ineligible: 0, covered: 1, unpriced: 0, pending: 1, clean: false });
    expect(await obligationsFor(org.id, x)).toHaveLength(0);
    expect(await obligationsFor(org.id, y)).toHaveLength(1);
    expect(await segment(seg.id)).toMatchObject({ inFlightStudentId: null, inFlightAttempts: 0 });
  });
});

describe("future-month refusal under the branch lock", () => {
  const JAN_31_2031 = () => new Date("2031-01-31T12:00:00Z"); // Costa Rica: Jan 31 06:00; Kiritimati (UTC+14): Feb 1 02:00
  const FEB_2031: YearMonth = { year: 2031, month: 2 };

  async function februaryStudent(org: Org) {
    const [x] = await studentsInOrder(org, ["ineligible"]);
    await assign(org, x, "priced", org.main, FEB_2031);
    return x;
  }

  it("a month the student's branch has not reached is PENDING futureMonth, with no obligation", async () => {
    const org = await makeOrg("future", FEB_2031);
    await februaryStudent(org);
    await addSegment(org.id, FEB_2031);
    const report = await runMonthlyGeneration(deps({ now: JAN_31_2031 }));
    expect(report.visits[0].reasons).toEqual({ futureMonth: 1 });
    expect(report.visits[0].passFinished?.clean).toBe(false);
    expect((await financialCounts(org.id)).obligations).toBe(0);
  });

  it("the decision uses the timezone read under the branch lock: a configuration save holding the branch decides it", async () => {
    const org = await makeOrg("future-lock", FEB_2031);
    const x = await februaryStudent(org);
    const seg = await addSegment(org.id, FEB_2031);

    // A configuration save holds the branch FOR UPDATE (as config-actions does) and moves it to Kiritimati, where February
    // has already begun.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let holding!: () => void;
    const held = new Promise<void>((r) => (holding = r));
    const save = prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "Academy" WHERE "id" = ${org.main.academyId} FOR UPDATE`;
        await tx.academy.update({ where: { id: org.main.academyId }, data: { timezone: "Pacific/Kiritimati" } });
        holding();
        await gate;
      },
      { timeout: 60_000 },
    );
    await held;

    // Generous timeouts so the held lock is waited on, not timed out; the deadline grows with them (each unit's maximum duration
    // is derived from the timeouts, and a unit starts only if it fits).
    const slow = { statementTimeoutMs: 20_000, lockTimeoutMs: 20_000, shortTimeoutMs: 20_000, studentTimeoutMs: 30_000, deadlineMs: 10_000_000 };
    const running = runMonthlyGeneration(deps({ now: JAN_31_2031, limits: slow }));
    expect(await waitUntilBlocked(['FROM "Academy"', "FOR SHARE"]), "the runner must wait on the branch lock").toBe(true);
    release();
    await save;
    const report = await running;

    expect(report.visits[0]).toMatchObject({ created: 1, reasons: {} });
    expect(await obligationsFor(org.id, x, FEB_2031)).toHaveLength(1);
    expect((await segment(seg.id)).lastPassClean).toBe(true);
  }, 60_000);
});

describe("bounded reads and rollover", () => {
  it("a history overflow, a thrown failure and a statement timeout inside the student transaction each record PENDING and advance the cursor", async () => {
    const org = await makeOrg("bounds");
    const [history, thrown, slow, fine] = await studentsInOrder(org, ["priced", "priced", "priced", "priced"]);
    await prisma.studentStatusChange.create({
      data: { organizationId: org.id, studentId: history, status: "ACTIVE", effectiveOn: new Date(Date.UTC(2030, 7, 2)), sequence: 2, source: "EVENT", actorId: org.adminId },
    });
    const seg = await addSegment(org.id);

    const report = await runMonthlyGeneration(
      deps({
        limits: { historyCap: 1, statementTimeoutMs: 300, lockTimeoutMs: 300 },
        beforeRecordForTest: async (tx, studentId) => {
          if (studentId === thrown) throw new Error("injected failure");
          if (studentId === slow) await tx.$queryRaw`SELECT pg_sleep(2)`; // exceeds the 300 ms statement_timeout
        },
      }),
    );
    const [visit] = report.visits;
    expect(visit.reasons).toEqual({ historyTooLarge: 1, unexpected: 2 });
    expect(visit.created).toBe(1);
    expect(visit.passFinished).toEqual({ ineligible: 0, covered: 1, unpriced: 0, pending: 3, clean: false });
    expect(await obligationsFor(org.id, fine)).toHaveLength(1);
    for (const id of [history, thrown, slow]) expect(await obligationsFor(org.id, id)).toHaveLength(0);
    expect((await segment(seg.id)).lastPassPending).toBe(3);
  });

  it("a configuration overflow (more candidate versions than the cap) records PENDING configurationTooLarge and advances", async () => {
    const org = await makeOrg("config-cap");
    const [x, y] = await studentsInOrder(org, ["priced", "priced"]);
    await prisma.duesPolicyVersion.create({
      data: { organizationId: org.id, academyId: org.main.academyId, effectiveYear: 2028, effectiveMonth: 1, dueDay: 20, graceDay: 5, lateFeeAmount: "20.00", lateFeeCurrency: "USD", createdById: org.adminId },
    });
    await addSegment(org.id);
    const report = await runMonthlyGeneration(deps({ limits: { configurationCap: 1 } }));
    expect(report.visits[0].reasons).toEqual({ configurationTooLarge: 2 });
    expect(report.visits[0].passFinished).toMatchObject({ pending: 2, clean: false });
    for (const id of [x, y]) expect(await obligationsFor(org.id, id)).toHaveLength(0);
  });

  it("rollover inserts at most `rolloverRows` month rows per visit, only from the newest row, only up to the earliest branch's current month", async () => {
    const org = await makeOrg("rollover", { year: 2030, month: 6 });
    await addBranch(org, undefined, { timezone: "Pacific/Kiritimati" }); // a second branch, a day ahead
    await addSegment(org.id, { year: 2030, month: 6 });
    // 2031-01-01T05:00Z: Costa Rica is still 2030-12-31; Kiritimati is already in January. current_min = December 2030.
    const report = await runMonthlyGeneration(deps({ now: () => new Date("2031-01-01T05:00:00Z"), limits: { rolloverRows: 3 } }));
    const inserted = report.visits.map((v) => (v.rollover && "inserted" in v.rollover ? v.rollover.inserted : -1));
    expect(Math.max(...inserted)).toBe(3);
    expect(inserted.reduce((sum, n) => sum + n, 0)).toBe(6); // July–December
    const months = await prisma.duesGenerationProgress.findMany({ where: { organizationId: org.id }, orderBy: [{ year: "asc" }, { month: "asc" }], select: { year: true, month: true } });
    expect(months).toEqual([6, 7, 8, 9, 10, 11, 12].map((month) => ({ year: 2030, month })));
  });

  it("a branch list over the cap skips rollover (reported) and still processes the claimed row", async () => {
    const org = await makeOrg("branch-cap");
    await addBranch(org);
    const [x] = await studentsInOrder(org, ["priced"]);
    await addSegment(org.id);
    const report = await runMonthlyGeneration(deps({ now: () => new Date("2030-12-15T18:00:00Z"), limits: { branchCap: 1 } }));
    expect(report.visits[0].rollover).toEqual({ skipped: "configurationTooLarge" });
    expect(await obligationsFor(org.id, x)).toHaveLength(1);
    expect(await prisma.duesGenerationProgress.count({ where: { organizationId: org.id } })).toBe(1);
  });

  it("the invocation deadline: no unit starts unless it fits, so an exhausted budget claims and writes nothing", async () => {
    const org = await makeOrg("deadline");
    await studentsInOrder(org, ["priced"]);
    const seg = await addSegment(org.id);
    const report = await runMonthlyGeneration(deps({ elapsedMs: () => 44_000 })); // default T = 45 s
    expect(report).toEqual({ visits: [], claimErrors: 0, stoppedBy: "deadline" });
    expect((await segment(seg.id)).leaseToken).toBeNull();
    expect((await financialCounts(org.id)).obligations).toBe(0);
  });
});

describe("fair selection across more segments than one invocation can visit", () => {
  it("least recently visited first: with one student per invocation, each of 5 segments is visited once in every 5 consecutive runs, and every student is reached", async () => {
    const segs: { id: string; org: Org }[] = [];
    for (let i = 0; i < 5; i++) {
      const org = await makeOrg(`fair${i}`);
      await studentsInOrder(org, ["priced", "priced", "priced"]);
      segs.push({ id: (await addSegment(org.id, S, new Date(i * 1000))).id, org });
    }
    let exhausted = false;
    const oneStudentPerRun = deps({
      elapsedMs: () => (exhausted ? 1e9 : 0),
      limits: { discoveryLimit: 2 },
      boundaryForTest: async (b) => {
        if (b === "afterStudentCommit") exhausted = true; // the budget runs out right after one student commits
      },
    });

    const visited: string[] = [];
    for (let run = 0; run < 15; run++) {
      exhausted = false;
      const report = await runMonthlyGeneration(oneStudentPerRun);
      expect(report.visits).toHaveLength(1);
      expect(report.visits[0].ended).toBe("deadline");
      visited.push(report.visits[0].segmentId);
    }
    expect(visited.slice(0, 5)).toEqual(segs.map((s) => s.id)); // the initial least-recently-visited order
    for (let i = 0; i + 5 <= visited.length; i++) expect(new Set(visited.slice(i, i + 5)).size).toBe(5);
    for (const { org } of segs) expect(await obligationsFor(org.id)).toHaveLength(3);
  });
});

describe("overlapping runs", () => {
  it("a claim on a row held by another run's student transaction waits (proven in pg_stat_activity), times out and skips; the holder stays contiguous and stops at its lapsed lease", async () => {
    const orgA = await makeOrg("overlap-a");
    const [a1] = await studentsInOrder(orgA, ["priced", "priced"]);
    const orgB = await makeOrg("overlap-b");
    await studentsInOrder(orgB, ["priced"]);
    const segA = await addSegment(orgA.id, S, new Date(0));
    const segB = await addSegment(orgB.id, S, new Date(1000));

    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let inside!: () => void;
    const holding = new Promise<void>((r) => (inside = r));
    const runA = runMonthlyGeneration(
      deps({
        limits: { leaseSeconds: 1, shortTimeoutMs: 30_000, studentTimeoutMs: 30_000, idleInTransactionTimeoutMs: 30_000, deadlineMs: 10_000_000 }, // the transaction sits idle, outliving the 1 s lease, while the test holds it
        beforeRecordForTest: async (_tx, studentId) => {
          if (studentId !== a1) return;
          inside();
          await gate; // holds segA's row lock (and a1's locks) open
        },
      }),
    );
    await holding;
    await new Promise((r) => setTimeout(r, 1_500)); // A's 1 s lease lapses while its transaction still holds the row lock

    let sawWait = false;
    let watchingDone = false;
    const watching = (async () => {
      while (!sawWait && !watchingDone) {
        sawWait = await isBlocked(['UPDATE "DuesGenerationProgress"']);
        await new Promise((r) => setTimeout(r, 10));
      }
    })();
    const runB = await runMonthlyGeneration(deps({ limits: { lockTimeoutMs: 500 } }));
    watchingDone = true;
    await watching;
    expect(sawWait, "B's claim must genuinely wait on A's row lock").toBe(true);
    expect(runB.claimErrors).toBeGreaterThanOrEqual(1);
    expect(runB.visits.map((v) => v.segmentId)).toEqual([segB.id]);

    release();
    const reportA = await runA;
    expect(reportA.visits[0].ended).toBe("fenced"); // its next fence sees the lapsed lease and stops before writing
    expect(await expectContiguous(orgA, segA.id)).toMatchObject({ cursorStudentId: a1, passCovered: 1 });
    expect(await obligationsFor(orgA.id, a1)).toHaveLength(1);
  }, 60_000);
});

describe("configuration failures remain visible and cannot produce a clean pass", () => {
  it("missing pricing and an inactive branch (D4) keep the pass unclean and bill nothing for them; fixing both gives a clean pass", async () => {
    const org = await makeOrg("visible");
    const closedBranch = await addBranch(org, undefined, { active: false });
    const [unpriced] = await studentsInOrder(org, ["unpriced"]);
    const inactive = await addStudent(org, closedBranch);
    await assign(org, inactive, "priced", closedBranch);
    const seg = await addSegment(org.id);

    const first = await runMonthlyGeneration(deps());
    expect(first.visits[0].reasons).toEqual({ noEffectiveVersion: 1, inactiveBranch: 1 });
    expect(first.visits[0].passFinished).toEqual({ ineligible: 0, covered: 0, unpriced: 2, pending: 0, clean: false });
    expect(await obligationsFor(org.id)).toHaveLength(0);

    await prisma.paymentPlanTerms.create({
      data: { organizationId: org.id, planId: org.main.unpricedPlanId, effectiveYear: 2027, effectiveMonth: 1, priceAmount: "90.00", currency: "USD", monthsCovered: 1, createdById: org.adminId },
    });
    await prisma.academy.update({ where: { id: closedBranch.academyId }, data: { active: true } });
    const second = await runMonthlyGeneration(deps());
    expect(second.visits[0].passFinished).toEqual({ ineligible: 0, covered: 2, unpriced: 0, pending: 0, clean: true });
    expect(await obligationsFor(org.id, unpriced)).toHaveLength(1);
    expect(await obligationsFor(org.id, inactive)).toHaveLength(1);
    expect((await segment(seg.id)).lastPassClean).toBe(true);
  });

  it("a student inserted behind the cursor during a pass is not seen by that pass (which can still read clean) and is billed by the next", async () => {
    const org = await makeOrg("behind");
    const [first] = await studentsInOrder(org, ["priced", "priced"]);
    const seg = await addSegment(org.id);
    let late: string | undefined;
    const report = await runMonthlyGeneration(
      deps({
        boundaryForTest: async (b, where) => {
          if (b !== "afterStudentCommit" || where.studentId !== first || late) return;
          late = await addStudent(org, org.main, `a0000behind${suffix.replace(/\D/g, "")}`); // sorts before every cuid ("c…")
          await assign(org, late, "priced");
        },
      }),
    );
    expect(report.visits[0].passFinished).toEqual({ ineligible: 0, covered: 2, unpriced: 0, pending: 0, clean: true });
    expect(await obligationsFor(org.id, late!)).toHaveLength(0); // "clean" is what the pass observed, not current completeness

    const next = await runMonthlyGeneration(deps());
    expect(next.visits[0].passFinished).toMatchObject({ covered: 3, clean: true });
    expect(await obligationsFor(org.id, late!)).toHaveLength(1);
    expect((await segment(seg.id)).lastPassCovered).toBe(3);
  });
});

describe("failure isolation: a recoverable database failure ends only its student or segment; later organizations progress", () => {
  /** Two organizations, one priced student each; A is visited first. */
  async function pair(label: string) {
    const a = await makeOrg(`${label}-a`);
    const [aStudent] = await studentsInOrder(a, ["priced"]);
    const b = await makeOrg(`${label}-b`);
    const [bStudent] = await studentsInOrder(b, ["priced"]);
    const segA = await addSegment(a.id, S, new Date(0));
    const segB = await addSegment(b.id, S, new Date(1000));
    return { a, b, aStudent, bStudent, segA, segB };
  }
  /** Locks the lock (another connection) at `onBoundary` of segment A; releases it when B is claimed. */
  function lockDuringA(segA: string, segB: string, onBoundary: GenerationBoundary, sql: string): MonthlyGenerationRunDeps["boundaryForTest"] {
    let lock: ReturnType<typeof holdLock> | undefined;
    return async (boundary, where) => {
      if (boundary === onBoundary && where.segmentId === segA && !lock) {
        lock = holdLock(sql);
        await lock.held;
      }
      if (boundary === "afterClaim" && where.segmentId === segB && lock) await lock.release();
    };
  }
  const SAFE = /^(P\d{4}|PrismaClient\w+Error|TypeError|RangeError|unrecognized_error)$/;

  it("the student lookup runs inside the student's bounded transaction: blocked, it fails that student (recorded PENDING), and the next organization is billed", async () => {
    const { a, b, aStudent, bStudent, segA, segB } = await pair("lookup");
    let lock: ReturnType<typeof holdLock> | undefined;
    const report = await runMonthlyGeneration(
      deps({
        boundaryForTest: async (boundary, where) => {
          // After A's page read and marker, the Student table is locked: the first statement to block is the lookup.
          if (boundary === "afterMarker" && where.segmentId === segA.id) {
            lock = holdLock(`LOCK TABLE "Student" IN ACCESS EXCLUSIVE MODE`);
            await lock.held;
          }
          if (boundary === "afterFailureRecord" && lock) await lock.release();
        },
      }),
    );
    const [visitA, visitB] = report.visits;
    expect(visitA).toMatchObject({ segmentId: segA.id, reasons: { unexpected: 1 }, passFinished: { pending: 1, clean: false } });
    expect(Object.keys(visitA.errorCodes).every((code) => SAFE.test(code))).toBe(true);
    expect(visitB).toMatchObject({ segmentId: segB.id, created: 1 });
    expect(await obligationsFor(a.id, aStudent)).toHaveLength(0);
    expect(await obligationsFor(b.id, bStudent)).toHaveLength(1);
  }, 60_000);

  const stages: Array<{ stage: string; boundary: GenerationBoundary; sql: (segA: string) => string; failStudent?: boolean; cursorAfter: "none" | "student" }> = [
    { stage: "gate", boundary: "afterClaim", sql: () => `LOCK TABLE "Organization" IN ACCESS EXCLUSIVE MODE`, cursorAfter: "none" },
    { stage: "page", boundary: "afterClaim", sql: () => `LOCK TABLE "Student" IN ACCESS EXCLUSIVE MODE`, cursorAfter: "none" },
    { stage: "marker", boundary: "afterClaim", sql: (segA) => `SELECT 1 FROM "DuesGenerationProgress" WHERE "id" = '${segA}' FOR UPDATE`, cursorAfter: "none" },
    { stage: "failureRecord", boundary: "afterStudentFailure", sql: (segA) => `SELECT 1 FROM "DuesGenerationProgress" WHERE "id" = '${segA}' FOR UPDATE`, failStudent: true, cursorAfter: "none" },
    { stage: "passEnd", boundary: "beforePassEnd", sql: (segA) => `SELECT 1 FROM "DuesGenerationProgress" WHERE "id" = '${segA}' FOR UPDATE`, cursorAfter: "student" },
  ];
  for (const { stage, boundary, sql, failStudent, cursorAfter } of stages) {
    it(`a real database failure in the ${stage} ends only A's visit (reported, committed state kept), and B is billed`, async () => {
      const { a, b, aStudent, bStudent, segA, segB } = await pair(stage);
      const before = await segment(segA.id);
      const t0 = Date.now();
      const report = await runMonthlyGeneration(
        deps({
          boundaryForTest: lockDuringA(segA.id, segB.id, boundary, sql(segA.id)),
          beforeRecordForTest: failStudent
            ? async (_tx, id) => {
                if (id === aStudent) throw new Error("student failure");
              }
            : undefined,
        }),
      );
      const [visitA, visitB] = report.visits;
      expect(visitA).toMatchObject({ segmentId: segA.id, ended: "error", error: { stage } });
      expect(visitA.error!.code).toMatch(SAFE);
      expect(visitB).toMatchObject({ segmentId: segB.id, created: 1 });
      expect(await obligationsFor(b.id, bStudent)).toHaveLength(1);

      const after = await expectContiguous(a, segA.id);
      expect(after.cursorStudentId).toBe(cursorAfter === "none" ? null : aStudent);
      expect(after.lastPassCompletedAt).toBe(before.lastPassCompletedAt); // no pass end recorded
      // failureRecord: A's student failed and its outcome could not be recorded, so the cursor did not pass it.
      if (failStudent) expect(after).toMatchObject({ cursorStudentId: null, passPending: 0, inFlightStudentId: aStudent, inFlightAttempts: 1 });
      const leaseLeftMs = after.leaseUntil!.getTime() - Date.now();
      if (sql(segA.id).includes('"DuesGenerationProgress')) {
        // The progress row itself is locked, so the release (a bounded update of that row) also times out and is skipped:
        // the lease is left to expire after L, which only delays the next claim.
        expect(leaseLeftMs).toBeGreaterThan(60_000);
      } else {
        expect(leaseLeftMs).toBeLessThan(60_000); // released at once, not left for L
      }
      expect(Date.now() - t0).toBeLessThan(20_000);
    }, 60_000);
  }

  it("discovery waiting for a connection (pool exhausted for real) ends the run within maxWait with a safe code, writing nothing", async () => {
    const org = await makeOrg("pool");
    await studentsInOrder(org, ["priced"]);
    const seg = await addSegment(org.id);
    const holders = await exhaustAppPool();
    try {
      const t0 = Date.now();
      const report = await runMonthlyGeneration(deps({ limits: { shortMaxWaitMs: 500 } }));
      const waited = Date.now() - t0;
      expect(report).toMatchObject({ visits: [], stoppedBy: "discoveryFailed" });
      expect(report.discoveryError).toMatch(SAFE);
      expect(waited).toBeGreaterThanOrEqual(450); // it really waited for a connection...
      expect(waited).toBeLessThan(3_000); // ...and no longer than maxWait (plus overhead)
    } finally {
      await holders.release();
    }
    expect((await segment(seg.id)).leaseToken).toBeNull();
    expect(await obligationsFor(org.id)).toHaveLength(0);
  }, 60_000);
});

describe("deadline accounting with real waits", () => {
  it("students whose transactions really block until statement_timeout are processed one by one, each recorded, and the run returns before the deadline", async () => {
    const org = await makeOrg("deadline-real");
    await studentsInOrder(org, Array.from({ length: 30 }, () => "priced" as const));
    const seg = await addSegment(org.id);
    // A configuration save holds the branch FOR UPDATE for the whole run: every student transaction waits on the branch
    // FOR SHARE lock until its statement_timeout, fails, and is recorded PENDING.
    const lock = holdLock(`SELECT 1 FROM "Academy" WHERE "id" = '${org.main.academyId}' FOR UPDATE`);
    await lock.held;
    const limits = { statementTimeoutMs: 300, lockTimeoutMs: 300, idleInTransactionTimeoutMs: 300, shortMaxWaitMs: 200, shortTimeoutMs: 400, studentMaxWaitMs: 200, studentTimeoutMs: 1_000, deadlineMs: 9_000 };
    const t0 = Date.now();
    let report: Awaited<ReturnType<typeof runMonthlyGeneration>>;
    try {
      report = await runMonthlyGeneration(deps({ limits }));
    } finally {
      await lock.release();
    }
    const wall = Date.now() - t0;
    expect(wall).toBeLessThan(limits.deadlineMs); // the guarantee: returns by T (here with room to spare)
    const [visit] = report.visits;
    expect(visit.ended).toBe("deadline"); // stopped because the next student's worst case no longer fit, not because work ran out
    expect(visit.classes.PENDING).toBeGreaterThan(0);
    expect(visit.classes.PENDING).toBeLessThan(30);
    const row = await expectContiguous(org, seg.id);
    expect(row.passPending).toBe(visit.classes.PENDING); // every student passed was recorded
    expect(await obligationsFor(org.id)).toHaveLength(0);
  }, 60_000);

  it("rejects limits under which the per-transaction bound would not hold", async () => {
    await expect(runMonthlyGeneration(deps({ limits: { statementTimeoutMs: 3_000, shortTimeoutMs: 2_000 } }))).rejects.toThrow(RangeError);
    await expect(runMonthlyGeneration(deps({ limits: { lockTimeoutMs: 2_000, statementTimeoutMs: 1_000 } }))).rejects.toThrow(RangeError);
  });
});

describe("safe error details: only validated codes or fixed fallbacks leave a failure", () => {
  const SECRET = "s3cr3t-Fabricated-7781";
  function secretError(over: { name?: string; code?: unknown } = {}) {
    const error = new Error(`message ${SECRET}`, { cause: { token: `cause ${SECRET}` } });
    error.name = over.name ?? `Name${SECRET}`;
    error.stack = `stack ${SECRET}\n    at somewhere (${SECRET}.ts:1:1)`;
    Object.assign(error, { code: over.code ?? `code-${SECRET}`, meta: { query: `SELECT '${SECRET}'`, target: SECRET } });
    return error;
  }

  it("a failure carrying secrets in name, code, message, stack, meta and cause yields only the fixed fallback, and nothing is logged", async () => {
    const org = await makeOrg("secrets");
    const [x, recognized, named] = await studentsInOrder(org, ["priced", "priced", "priced"]);
    await addSegment(org.id);
    const logged: string[] = [];
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void logged.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a, Object.getOwnPropertyNames(a ?? {})))).join(" "))),
    );
    let report: Awaited<ReturnType<typeof runMonthlyGeneration>>;
    try {
      report = await runMonthlyGeneration(
        deps({
          beforeRecordForTest: async (_tx, id) => {
            if (id === x) throw secretError();
            if (id === recognized) throw secretError({ code: "P2034" }); // a recognized Prisma code survives
            if (id === named) throw secretError({ name: "PrismaClientUnknownRequestError", code: 42 }); // an allow-listed class name survives
          },
        }),
      );
    } finally {
      spies.forEach((spy) => spy.mockRestore());
    }
    const [visit] = report.visits;
    expect(visit.errorCodes).toEqual({ unrecognized_error: 1, P2034: 1, PrismaClientUnknownRequestError: 1 });
    expect(visit.reasons).toEqual({ unexpected: 3 });
    expect(JSON.stringify(report)).not.toContain(SECRET);
    expect(logged.join("\n")).not.toContain(SECRET);
  });

  it("the runner's own returned detail is the safe code only", async () => {
    const org = await makeOrg("secrets-runner");
    const [x] = await studentsInOrder(org, ["priced"]);
    const { generateMonthlyObligationForStudent } = await import("../../src/lib/dues/monthly-generation");
    const outcome = await generateMonthlyObligationForStudent(staffContext(org), x, S, { activation: ACTIVE, now: SEPT_2030 }, {
      beforeRecordForTest: async () => {
        throw secretError();
      },
    });
    expect(outcome).toEqual({ category: "failure", reason: "unexpected", detail: { code: "unrecognized_error" } });
    expect(JSON.stringify(outcome)).not.toContain(SECRET);
    expect(await obligationsFor(org.id, x)).toHaveLength(0); // the injected failure rolled the write back
  });
});

describe("G2a: idle_in_transaction_session_timeout releases a paused transaction's locks, and the pool recovers", () => {
  it("a transaction left idle past the timeout is terminated (its row lock freed for another connection), and later transactions on the same pool succeed", async () => {
    const org = await makeOrg("idle-direct");
    let failure: unknown;
    const idle = appPrisma
      .$transaction(
        async (tx) => {
          await tx.$executeRawUnsafe(`SET LOCAL idle_in_transaction_session_timeout = 300`);
          await tx.$queryRaw`SELECT "id" FROM "Academy" WHERE "id" = ${org.main.academyId} FOR UPDATE`;
          await new Promise((r) => setTimeout(r, 1_200)); // idle: no statement running
          await tx.$queryRaw`SELECT 1`; // the session is gone by now
        },
        { timeout: 10_000 },
      )
      .catch((error: unknown) => (failure = error));

    // Another connection gets the same row lock without waiting, once the idle session has been ended.
    await new Promise((r) => setTimeout(r, 700));
    const free = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = 100`);
      return tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "Academy" WHERE "id" = ${org.main.academyId} FOR UPDATE NOWAIT`;
    });
    expect(free).toHaveLength(1);
    await idle;
    expect(failure, "the idle transaction must have failed").toBeDefined();

    // Pool recovery: more sequential transactions than the pool has connections (10), each must succeed.
    for (let i = 0; i < 12; i++) {
      expect(await appPrisma.$transaction(async (tx) => tx.$queryRaw<{ one: number }[]>`SELECT 1 AS one`)).toEqual([{ one: 1 }]);
    }
  }, 30_000);

  it("in the loop: a student transaction paused idle is ended and recorded PENDING; the next student, on the same pool, commits", async () => {
    const org = await makeOrg("idle-loop");
    const [paused, next] = await studentsInOrder(org, ["priced", "priced"]);
    const seg = await addSegment(org.id);
    const report = await runMonthlyGeneration(
      deps({
        limits: { idleInTransactionTimeoutMs: 300 },
        beforeRecordForTest: async (_tx, studentId) => {
          if (studentId === paused) await new Promise((r) => setTimeout(r, 1_200)); // idle inside the transaction
        },
      }),
    );
    const [visit] = report.visits;
    expect(visit.reasons).toEqual({ unexpected: 1 });
    expect(visit.created).toBe(1);
    expect(await obligationsFor(org.id, paused)).toHaveLength(0); // its write rolled back with the ended session
    expect(await obligationsFor(org.id, next)).toHaveLength(1);
    expect((await segment(seg.id)).lastPassPending).toBe(1);
  }, 30_000);
});

// ---------------------------------------------------------------------------------------------------------------------------------

/** A lock taken by another connection (the test client) and held until `release()`. */
function holdLock(sql: string) {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let ready!: () => void;
  const held = new Promise<void>((r) => (ready = r));
  const tx = prisma.$transaction(
    async (t) => {
      await t.$executeRawUnsafe(sql);
      ready();
      await gate;
    },
    { timeout: 120_000 },
  );
  return {
    held,
    release: async () => {
      release();
      await tx;
    },
  };
}

/** Holds every connection of the application's pool (pg's default, 10) open until `release()`. */
async function exhaustAppPool() {
  const releases: Array<() => void> = [];
  const holders: Promise<unknown>[] = [];
  for (let i = 0; i < 10; i++) {
    let started!: () => void;
    const ready = new Promise<void>((r) => (started = r));
    holders.push(
      appPrisma.$transaction(
        async (tx) => {
          await tx.$executeRawUnsafe("SELECT 1");
          started();
          await new Promise<void>((r) => releases.push(r));
        },
        { maxWait: 10_000, timeout: 120_000 },
      ),
    );
    await ready;
  }
  return {
    release: async () => {
      releases.forEach((r) => r());
      await Promise.allSettled(holders);
    },
  };
}

function staffContext(org: Org) {
  return { kind: "tenant" as const, actorUserId: org.adminId, organizationId: org.id, organizationRole: "ADMIN" as const, academyIds: "ALL" as const, selfStudentId: null, linkedStudentId: null };
}

/** The existing staff path (createMonthlyObligationInTx with a tenant context), for comparison and for a pre-existing obligation. */
async function createByStaff(org: Org, studentId: string) {
  const terms = await prisma.paymentPlanTerms.findFirstOrThrow({ where: { planId: org.main.planId } });
  const policy = await prisma.duesPolicyVersion.findFirstOrThrow({ where: { academyId: org.main.academyId } });
  const result = await appPrisma.$transaction((tx) =>
    createMonthlyObligationInTx(
      tx,
      { context: staffContext(org), student: { id: studentId, homeAcademyId: org.main.academyId }, coverage: S, planTermsId: terms.id, policyVersionId: policy.id },
      { activation: ACTIVE, now: SEPT_2030 },
    ),
  );
  expect(result).toMatchObject({ ok: true, created: true });
}

async function isBlocked(matches: string[]): Promise<boolean> {
  const rows = await prisma.$queryRawUnsafe<{ query: string }[]>(`SELECT query FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query IS NOT NULL`);
  return rows.some((row) => matches.every((m) => row.query.includes(m)));
}

async function waitUntilBlocked(matches: string[], timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isBlocked(matches)) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}
