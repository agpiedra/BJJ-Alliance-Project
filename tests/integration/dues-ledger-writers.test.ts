import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getTestPrismaClient } from "../helpers/test-db";
import { makeAccountingOrg } from "../helpers/accounting-org";
import type { TenantContext } from "../../src/lib/tenant/types";
import {
  createMonthlyObligation,
  inactiveLedgerActivation,
  recordDuesPayment,
  type LedgerActivation,
} from "../../src/lib/dues/ledger";

/**
 * PR 4a (the first ledger writers), proved against the REAL test database with private, temporary organizations. Amounts, dates and
 * days are synthetic. Both writers are plain library functions with no caller; the tests inject the activation and the clock.
 *
 * Ledger rows are committed (the writers commit), and the ledger refuses deletes by trigger, so afterAll removes them in a test-only
 * transaction that switches triggers off for itself alone (`session_replication_role = replica`). No production trigger is weakened.
 * The fixed clock is 2030, so "today" and every deadline below are deterministic.
 */
const prisma = getTestPrismaClient();
type Fixture = Awaited<ReturnType<typeof makeAccountingOrg>>;

const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
const ACTIVE: LedgerActivation = { isActive: async () => true };
/** Costa Rica is UTC-6 all year. The month names are for reading; the instants are what matter. */
const at = (isoLocal: string) => () => new Date(`${isoLocal}-06:00`);
const DEC_2030 = at("2030-12-01T12:00:00"); // "now" while creating September, October and November 2030
const OCT_5 = at("2030-10-05T12:00:00"); // September's inclusive grace deadline (due day 20, grace day 5)
const OCT_6 = at("2030-10-06T12:00:00"); // the first late day for September
const deps = (now: () => Date) => ({ activation: ACTIVE, now });
/**
 * How long a concurrency test waits before asserting the racing side has NOT finished, for tests that also check a VALUE only a genuine
 * wait could produce (a snapshot taken from the corrected row). `createMonthlyObligation`'s own round trips vary widely on this database
 * (measured 650ms to over 2000ms for the SAME unblocked call, Docker overhead dominating), so this checkpoint is a cheap early check, not
 * the proof — the value assertion after `release()` is what actually catches a missing lock. For a lock that changes no value on its own
 * (the branch or student row, held with no update), see `waitUntilBlockedOnLock` below: a timing checkpoint alone proved too unreliable
 * for those (removing either lock still "survived" a mutation run at a 2000ms checkpoint, because the writer is sometimes that slow even
 * unblocked) and is not used for them.
 */
const WAIT_CHECKPOINT_MS = 2000;

/**
 * Waits until Postgres itself reports a session genuinely blocked on a lock, instead of guessing from a wall-clock delay. Polls
 * `pg_stat_activity` for a row with `wait_event_type = 'Lock'` whose query text contains every string in `matches` (the query's own
 * static SQL, e.g. `FROM "Academy"` and `FOR SHARE` — Prisma's raw queries are parameterized, so no bound value ever appears in it).
 * Returns as soon as it is seen (real waits are found within a poll or two), or false if nothing matches within `timeoutMs`.
 */
async function waitUntilBlockedOnLock(matches: string[], timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = await prisma.$queryRawUnsafe<{ query: string }[]>(`SELECT query FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query IS NOT NULL`);
    if (rows.some((row) => matches.every((m) => row.query.includes(m)))) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

let a: Fixture;
let b: Fixture;
let a2: { id: string }; // a second branch of A
let a3: { id: string }; // a third branch of A (USD prices, CRC fee: for the currency-mismatch case)
let terms1: { id: string }; // A, branch 1, USD 100.00, one month, effective 2027-01
let terms2: { id: string }; // the same plan, USD 120.00, effective 2032-01 (a LATER version)
let termsPackage: { id: string }; // A, branch 1, three months
let termsOtherBranch: { id: string }; // A, branch 2
let termsB: { id: string }; // organization B
let termsC3: { id: string }; // A, branch 3, USD
let policy1: { id: string }; // A, branch 1, due 20, grace 5, fee 20.00 USD, effective 2027-01
let policyOtherBranch: { id: string };
let policyC3: { id: string }; // A, branch 3, fee in CRC
let planId1: string;

function context(fx: Fixture, over: Partial<TenantContext> = {}): TenantContext {
  return {
    kind: "tenant", actorUserId: fx.admin.id, organizationId: fx.org.id, organizationRole: "ADMIN", academyIds: "ALL", selfStudentId: null, linkedStudentId: null, ...over,
  };
}

let studentCounter = 0;
async function newStudent(fx: Fixture, academyId: string, label: string) {
  const n = ++studentCounter;
  return prisma.student.create({
    data: {
      organizationId: fx.org.id, homeAcademyId: academyId, firstName: "Writer", lastName: `${label}${n}`, phone: "00000000",
      email: `writer-${label}-${n}-${suffix}@example.com`, currentRankId: await fx.rankId("WHITE"), codeHash: `writer-${label}-${n}-${suffix}`, status: "ACTIVE",
    },
  });
}

async function newTerms(label: string, opts: { organizationId?: string; academyId?: string; createdById?: string; monthsCovered?: number; price?: string } = {}) {
  const organizationId = opts.organizationId ?? a.org.id;
  const plan = await prisma.paymentPlan.create({ data: { organizationId, academyId: opts.academyId ?? a.academy.id, name: `Writers plan ${label} ${suffix}` } });
  const terms = await prisma.paymentPlanTerms.create({
    data: {
      organizationId, planId: plan.id, effectiveYear: 2027, effectiveMonth: 1, priceAmount: opts.price ?? "100.00", currency: "USD",
      monthsCovered: opts.monthsCovered ?? 1, createdById: opts.createdById ?? a.admin.id,
    },
  });
  return { plan, terms };
}

async function counts(organizationId: string) {
  return {
    obligations: await prisma.duesObligation.count({ where: { organizationId } }),
    coverage: await prisma.duesCoverage.count({ where: { organizationId } }),
    fees: await prisma.duesLateFee.count({ where: { organizationId } }),
    payments: await prisma.duesPayment.count({ where: { organizationId } }),
    settlements: await prisma.duesSettlement.count({ where: { organizationId } }),
    audits: await prisma.auditLog.count({ where: { organizationId, action: { startsWith: "dues" } } }),
  };
}

/** September, October and November 2030 for one student, each USD 100.00 (due the 20th, grace to the 5th of the next month, fee 20.00). */
async function threeMonths(studentId: string) {
  const ids: string[] = [];
  for (const month of [9, 10, 11]) {
    const r = await createMonthlyObligation(
      { context: context(a), studentId, coverage: { year: 2030, month }, planTermsId: terms1.id, policyVersionId: policy1.id },
      deps(DEC_2030),
    );
    if (!r.ok) throw new Error(`fixture obligation failed: ${r.error}`);
    ids.push(r.obligationId);
  }
  return ids;
}

const pay = (studentId: string, obligationIds: string[], amount: string, when: { now: () => Date; day: number; month?: number }, over: Record<string, unknown> = {}) =>
  recordDuesPayment(
    {
      context: context(a), studentId, receivedOn: { year: 2030, month: when.month ?? 10, day: when.day }, tender: { currency: "USD", amount }, method: "EFECTIVO",
      obligationIds, maxBackdateDays: 5, ...over,
    } as Parameters<typeof recordDuesPayment>[0],
    deps(when.now),
  );

beforeAll(async () => {
  a = await makeAccountingOrg("CUMULATIVE", "writers-a");
  b = await makeAccountingOrg("CUMULATIVE", "writers-b");
  a2 = await prisma.academy.create({ data: { organizationId: a.org.id, name: "Writers A2", slug: `writers-a2-${suffix}`, kioskTokenHash: `writers-a2-${suffix}` } });
  a3 = await prisma.academy.create({ data: { organizationId: a.org.id, name: "Writers A3", slug: `writers-a3-${suffix}`, kioskTokenHash: `writers-a3-${suffix}` } });
  const main = await newTerms("main");
  planId1 = main.plan.id;
  terms1 = main.terms;
  terms2 = await prisma.paymentPlanTerms.create({
    data: { organizationId: a.org.id, planId: planId1, effectiveYear: 2032, effectiveMonth: 1, priceAmount: "120.00", currency: "USD", monthsCovered: 1, createdById: a.admin.id },
  });
  termsPackage = (await newTerms("package", { monthsCovered: 3, price: "270.00" })).terms;
  termsOtherBranch = (await newTerms("other-branch", { academyId: a2.id })).terms;
  termsB = (await newTerms("b", { organizationId: b.org.id, academyId: b.academy.id, createdById: b.admin.id })).terms;
  termsC3 = (await newTerms("c3", { academyId: a3.id })).terms;
  const base = { organizationId: a.org.id, effectiveYear: 2027, effectiveMonth: 1, dueDay: 20, graceDay: 5, lateFeeAmount: "20.00", createdById: a.admin.id };
  policy1 = await prisma.duesPolicyVersion.create({ data: { ...base, academyId: a.academy.id, lateFeeCurrency: "USD" } });
  policyOtherBranch = await prisma.duesPolicyVersion.create({ data: { ...base, academyId: a2.id, lateFeeCurrency: "USD" } });
  policyC3 = await prisma.duesPolicyVersion.create({ data: { ...base, academyId: a3.id, lateFeeCurrency: "CRC" } });
}, 60_000);

afterAll(async () => {
  const orgIds = [a?.org.id, b?.org.id].filter(Boolean) as string[];
  if (orgIds.length > 0) {
    await prisma.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe("SET LOCAL session_replication_role = replica");
        // Currency-conversion brief PR 3: AwaitingRateReceipt added — a captured receipt (this file's own
        // rateUnavailable-now-captured test) carries a composite FK from Student, same as every other dues table here.
        for (const table of ["DuesSettlement", "DuesPayment", "DuesLateFee", "DuesCoverage", "DuesObligation", "AwaitingRateReceipt"]) {
          await tx.$executeRawUnsafe(`DELETE FROM "${table}" WHERE "organizationId" = ANY($1::text[])`, orgIds);
        }
      },
      { timeout: 60_000 },
    );
  }
  for (const fx of [a, b]) {
    if (!fx) continue;
    await prisma.auditLog.deleteMany({ where: { organizationId: fx.org.id } });
    await prisma.paymentPlanTerms.deleteMany({ where: { organizationId: fx.org.id } });
    await prisma.duesPolicyVersion.deleteMany({ where: { organizationId: fx.org.id } });
    await prisma.paymentPlan.deleteMany({ where: { organizationId: fx.org.id } });
  }
  await a?.drop();
  await b?.drop();
}, 120_000);

describe("the gate: closed by default, injected open only in tests", () => {
  it("both writers refuse with notActive and write nothing when no activation is injected (production default)", async () => {
    const ana = await newStudent(a, a.academy.id, "gate");
    const before = await counts(a.org.id);
    const created = await createMonthlyObligation({ context: context(a), studentId: ana.id, coverage: { year: 2030, month: 9 }, planTermsId: terms1.id, policyVersionId: policy1.id });
    expect(created).toEqual({ ok: false, error: "notActive" });
    const paid = await recordDuesPayment({
      context: context(a), studentId: ana.id, receivedOn: { year: 2030, month: 10, day: 5 }, tender: { currency: "USD", amount: "100.00" }, method: "EFECTIVO",
      obligationIds: ["x"], maxBackdateDays: 5,
    });
    expect(paid).toEqual({ ok: false, error: "notActive" });
    expect(await counts(a.org.id)).toEqual(before);
  });

  it("the production activation reports every organization inactive", async () => {
    expect(await inactiveLedgerActivation.isActive(a.org.id)).toBe(false);
    expect(await inactiveLedgerActivation.isActive("any-organization")).toBe(false);
  });

  it("an activation that says inactive for this organization refuses too", async () => {
    const ana = await newStudent(a, a.academy.id, "gate2");
    const r = await createMonthlyObligation(
      { context: context(a), studentId: ana.id, coverage: { year: 2030, month: 9 }, planTermsId: terms1.id, policyVersionId: policy1.id },
      { activation: { isActive: async (id) => id !== a.org.id }, now: DEC_2030 },
    );
    expect(r).toEqual({ ok: false, error: "notActive" });
  });
});

describe("createMonthlyObligation", () => {
  it("creates the obligation, its coverage row and an audit row together, snapshotting the configuration exactly", async () => {
    const ana = await newStudent(a, a.academy.id, "create");
    const before = await counts(a.org.id);
    const r = await createMonthlyObligation({ context: context(a), studentId: ana.id, coverage: { year: 2030, month: 9 }, planTermsId: terms1.id, policyVersionId: policy1.id }, deps(DEC_2030));
    expect(r).toMatchObject({ ok: true, created: true });
    if (!r.ok) return;
    const o = await prisma.duesObligation.findUniqueOrThrow({ where: { id: r.obligationId } });
    expect([o.type, o.origin, o.coverageYear, o.coverageMonth, o.monthsCovered, o.currency, o.createdById]).toEqual(["MONTHLY", "STAFF", 2030, 9, 1, "USD", a.admin.id]);
    expect([o.amount.toFixed(2), o.lateFeeAmount?.toFixed(2)]).toEqual(["100.00", "20.00"]);
    expect([o.dueOn?.toISOString().slice(0, 10), o.graceDeadline?.toISOString().slice(0, 10)]).toEqual(["2030-09-20", "2030-10-05"]);
    expect([o.planTermsId, o.policyVersionId, o.academyId, o.studentId]).toEqual([terms1.id, policy1.id, a.academy.id, ana.id]);
    expect(await prisma.duesCoverage.count({ where: { obligationId: o.id, year: 2030, month: 9 } })).toBe(1);
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { organizationId: a.org.id, action: "duesObligation.create", entityId: o.id } });
    expect(JSON.stringify(audit.after)).toContain("100.00");
    const after = await counts(a.org.id);
    expect(after).toEqual({ ...before, obligations: before.obligations + 1, coverage: before.coverage + 1, audits: before.audits + 1 });
  });

  it("clamps the due day to a short month (a due day of 31 in February) on a branch of its own", async () => {
    const clampBranch = await prisma.academy.create({ data: { organizationId: a.org.id, name: "Writers clamp", slug: `writers-clamp-${suffix}`, kioskTokenHash: `writers-clamp-${suffix}` } });
    const ana = await newStudent(a, clampBranch.id, "clamp");
    const { terms } = await newTerms("clamp", { academyId: clampBranch.id });
    const policy = await prisma.duesPolicyVersion.create({
      data: { organizationId: a.org.id, academyId: clampBranch.id, effectiveYear: 2027, effectiveMonth: 1, dueDay: 31, graceDay: 31, lateFeeAmount: "0.00", lateFeeCurrency: "USD", createdById: a.admin.id },
    });
    const r = await createMonthlyObligation({ context: context(a), studentId: ana.id, coverage: { year: 2030, month: 2 }, planTermsId: terms.id, policyVersionId: policy.id }, deps(DEC_2030));
    expect(r).toMatchObject({ ok: true, created: true });
    if (!r.ok) return;
    const o = await prisma.duesObligation.findUniqueOrThrow({ where: { id: r.obligationId } });
    expect([o.dueOn?.toISOString().slice(0, 10), o.graceDeadline?.toISOString().slice(0, 10), o.lateFeeAmount?.toFixed(2)]).toEqual(["2030-02-28", "2030-03-31", "0.00"]);
  });

  it("a duplicate returns the existing obligation without touching its snapshot and without adding coverage or audit rows", async () => {
    const ana = await newStudent(a, a.academy.id, "dup");
    const first = await createMonthlyObligation({ context: context(a), studentId: ana.id, coverage: { year: 2030, month: 9 }, planTermsId: terms1.id, policyVersionId: policy1.id }, deps(DEC_2030));
    if (!first.ok) throw new Error(first.error);
    const before = await counts(a.org.id);
    const snapshot = JSON.stringify(await prisma.duesObligation.findUniqueOrThrow({ where: { id: first.obligationId } }));
    const again = await createMonthlyObligation({ context: context(a), studentId: ana.id, coverage: { year: 2030, month: 9 }, planTermsId: terms1.id, policyVersionId: policy1.id }, deps(DEC_2030));
    expect(again).toEqual({ ok: true, created: false, obligationId: first.obligationId });
    // even with version ids that would now be refused, the existing obligation is returned, not modified
    const stale = await createMonthlyObligation({ context: context(a), studentId: ana.id, coverage: { year: 2030, month: 9 }, planTermsId: terms2.id, policyVersionId: policy1.id }, deps(DEC_2030));
    expect(stale).toEqual({ ok: true, created: false, obligationId: first.obligationId });
    expect(await counts(a.org.id)).toEqual(before);
    expect(JSON.stringify(await prisma.duesObligation.findUniqueOrThrow({ where: { id: first.obligationId } }))).toBe(snapshot);
  });

  it("two identical concurrent creations produce exactly one obligation, one coverage row and one audit row", async () => {
    const ana = await newStudent(a, a.academy.id, "dupconc");
    const before = await counts(a.org.id);
    const run = () => createMonthlyObligation({ context: context(a), studentId: ana.id, coverage: { year: 2030, month: 9 }, planTermsId: terms1.id, policyVersionId: policy1.id }, deps(DEC_2030));
    const [x, y] = await Promise.all([run(), run()]);
    expect([x.ok, y.ok]).toEqual([true, true]);
    expect([x, y].filter((r) => r.ok && r.created).length).toBe(1);
    const after = await counts(a.org.id);
    expect(after).toEqual({ ...before, obligations: before.obligations + 1, coverage: before.coverage + 1, audits: before.audits + 1 });
  });

  it("refuses stale, foreign, unknown and inapplicable version ids, and a future month, writing nothing each time", async () => {
    const ana = await newStudent(a, a.academy.id, "refuse");
    const carla = await newStudent(a, a3.id, "refuse3");
    const otherOrgStudent = await newStudent(b, b.academy.id, "x");
    const month = { year: 2030, month: 9 };
    const base = { context: context(a), studentId: ana.id, coverage: month, planTermsId: terms1.id, policyVersionId: policy1.id };
    const before = await counts(a.org.id);
    const cases: Array<[string, Parameters<typeof createMonthlyObligation>[0], string]> = [
      ["a version that is not yet effective for the month (stale or premature)", { ...base, planTermsId: terms2.id }, "staleVersion"],
      ["terms of another organization", { ...base, planTermsId: termsB.id }, "notFound"],
      ["an unknown terms id", { ...base, planTermsId: "no-such-terms" }, "notFound"],
      ["an unknown policy id", { ...base, policyVersionId: "no-such-policy" }, "notFound"],
      ["terms of another branch", { ...base, planTermsId: termsOtherBranch.id }, "inapplicable"],
      ["a policy of another branch", { ...base, policyVersionId: policyOtherBranch.id }, "inapplicable"],
      ["a package (three-month) terms version", { ...base, planTermsId: termsPackage.id }, "inapplicable"],
      ["a policy whose fee currency differs from the terms currency", { ...base, studentId: carla.id, planTermsId: termsC3.id, policyVersionId: policyC3.id }, "currencyMismatch"],
      ["a month after the branch's current month (future billing is out of scope)", { ...base, coverage: { year: 2031, month: 1 } }, "futureMonth"],
      ["a student of another organization", { ...base, studentId: otherOrgStudent.id }, "notFound"],
    ];
    for (const [label, args, error] of cases) {
      expect(await createMonthlyObligation(args, deps(DEC_2030)), label).toEqual({ ok: false, error });
    }
    expect(await counts(a.org.id)).toEqual(before);
  });

  it("uses the version effective for the month: a later version prices later months, and the old one is then stale", async () => {
    const ana = await newStudent(a, a.academy.id, "effective");
    const later = deps(at("2035-01-01T12:00:00"));
    const atFeb2032 = await createMonthlyObligation({ context: context(a), studentId: ana.id, coverage: { year: 2032, month: 2 }, planTermsId: terms2.id, policyVersionId: policy1.id }, later);
    expect(atFeb2032).toMatchObject({ ok: true, created: true });
    if (!atFeb2032.ok) return;
    expect((await prisma.duesObligation.findUniqueOrThrow({ where: { id: atFeb2032.obligationId } })).amount.toFixed(2)).toBe("120.00");
    const bruno = await newStudent(a, a.academy.id, "effective2");
    expect(await createMonthlyObligation({ context: context(a), studentId: bruno.id, coverage: { year: 2032, month: 2 }, planTermsId: terms1.id, policyVersionId: policy1.id }, later)).toEqual({
      ok: false,
      error: "staleVersion",
    });
  });

  it("a Director outside the student's branch cannot create (scope), and nothing is written", async () => {
    const ana = await newStudent(a, a.academy.id, "scope");
    const before = await counts(a.org.id);
    const director = context(a, { organizationRole: "DIRECTOR", academyIds: [a2.id] });
    expect(await createMonthlyObligation({ context: director, studentId: ana.id, coverage: { year: 2030, month: 9 }, planTermsId: terms1.id, policyVersionId: policy1.id }, deps(DEC_2030))).toEqual({ ok: false, error: "notFound" });
    expect(await counts(a.org.id)).toEqual(before);
  });

  it("is atomic: if the coverage insert fails after the obligation was inserted, nothing persists", async () => {
    const ana = await newStudent(a, a.academy.id, "atomic");
    const fn = `pr4a_fail_coverage_${studentCounter}`;
    await prisma.$executeRawUnsafe(`CREATE FUNCTION ${fn}() RETURNS trigger AS $$ BEGIN IF NEW."studentId" = '${ana.id}' THEN RAISE EXCEPTION 'test: coverage refused'; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql`);
    await prisma.$executeRawUnsafe(`CREATE TRIGGER ${fn} BEFORE INSERT ON "DuesCoverage" FOR EACH ROW EXECUTE FUNCTION ${fn}()`);
    const before = await counts(a.org.id);
    try {
      await expect(createMonthlyObligation({ context: context(a), studentId: ana.id, coverage: { year: 2030, month: 9 }, planTermsId: terms1.id, policyVersionId: policy1.id }, deps(DEC_2030))).rejects.toThrow();
    } finally {
      await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${fn} ON "DuesCoverage"`);
      await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${fn}()`);
    }
    expect(await counts(a.org.id)).toEqual(before);
  });

  /** A configuration save holds the branch row FOR UPDATE and changes the version; the writer must wait and snapshot the NEW value. */
  it("CONCURRENT: creation waits for an in-flight configuration save (branch lock and version lock) and snapshots the corrected price", async () => {
    const ana = await newStudent(a, a.academy.id, "race-both");
    const { terms } = await newTerms("race-both");
    const held = { resolve: () => {} };
    const started = new Promise<void>((r) => (held.resolve = r));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const save = prisma.$transaction(
      async (tx) => {
        await tx.$queryRawUnsafe(`SELECT "id" FROM "Academy" WHERE "id" = '${a.academy.id}' FOR UPDATE`);
        await tx.paymentPlanTerms.update({ where: { id: terms.id }, data: { priceAmount: "110.00" } });
        held.resolve();
        await gate;
      },
      { timeout: 60_000 },
    );
    await started;
    let done = false;
    const creating = createMonthlyObligation({ context: context(a), studentId: ana.id, coverage: { year: 2030, month: 9 }, planTermsId: terms.id, policyVersionId: policy1.id }, deps(DEC_2030)).then((r) => ((done = true), r));
    await new Promise((r) => setTimeout(r, WAIT_CHECKPOINT_MS));
    expect(done, "creation must wait for the uncommitted configuration save").toBe(false);
    release();
    await save;
    const r = await creating;
    expect(r).toMatchObject({ ok: true, created: true });
    if (r.ok) expect((await prisma.duesObligation.findUniqueOrThrow({ where: { id: r.obligationId } })).amount.toFixed(2)).toBe("110.00");
  });

  it("CONCURRENT: the version's own row lock alone (an update with no branch lock) also makes creation wait and read the new value", async () => {
    const ana = await newStudent(a, a.academy.id, "race-row");
    const { terms } = await newTerms("race-row");
    const held = { resolve: () => {} };
    const started = new Promise<void>((r) => (held.resolve = r));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const save = prisma.$transaction(
      async (tx) => {
        await tx.paymentPlanTerms.update({ where: { id: terms.id }, data: { priceAmount: "111.00" } });
        held.resolve();
        await gate;
      },
      { timeout: 60_000 },
    );
    await started;
    let done = false;
    const creating = createMonthlyObligation({ context: context(a), studentId: ana.id, coverage: { year: 2030, month: 9 }, planTermsId: terms.id, policyVersionId: policy1.id }, deps(DEC_2030)).then((r) => ((done = true), r));
    await new Promise((r) => setTimeout(r, WAIT_CHECKPOINT_MS));
    expect(done, "creation must wait on the version row lock").toBe(false);
    release();
    await save;
    const r = await creating;
    if (!r.ok) throw new Error(r.error);
    expect((await prisma.duesObligation.findUniqueOrThrow({ where: { id: r.obligationId } })).amount.toFixed(2)).toBe("111.00");
  });

  it("CONCURRENT: the policy row's own lock alone also makes creation wait and snapshot the corrected fee", async () => {
    const raceBranch = await prisma.academy.create({ data: { organizationId: a.org.id, name: "Writers race", slug: `writers-race-${suffix}`, kioskTokenHash: `writers-race-${suffix}` } });
    const carla = await newStudent(a, raceBranch.id, "race-policy");
    const { terms } = await newTerms("race-policy", { academyId: raceBranch.id });
    const policy = await prisma.duesPolicyVersion.create({
      data: { organizationId: a.org.id, academyId: raceBranch.id, effectiveYear: 2027, effectiveMonth: 1, dueDay: 20, graceDay: 5, lateFeeAmount: "20.00", lateFeeCurrency: "USD", createdById: a.admin.id },
    });
    const held = { resolve: () => {} };
    const started = new Promise<void>((r) => (held.resolve = r));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const save = prisma.$transaction(
      async (tx) => {
        await tx.duesPolicyVersion.update({ where: { id: policy.id }, data: { lateFeeAmount: "22.00" } });
        held.resolve();
        await gate;
      },
      { timeout: 60_000 },
    );
    await started;
    let done = false;
    const creating = createMonthlyObligation({ context: context(a), studentId: carla.id, coverage: { year: 2030, month: 9 }, planTermsId: terms.id, policyVersionId: policy.id }, deps(DEC_2030)).then((r) => ((done = true), r));
    await new Promise((r) => setTimeout(r, WAIT_CHECKPOINT_MS));
    expect(done, "creation must wait on the policy row lock").toBe(false);
    release();
    await save;
    const r = await creating;
    if (!r.ok) throw new Error(r.error);
    expect((await prisma.duesObligation.findUniqueOrThrow({ where: { id: r.obligationId } })).lateFeeAmount?.toFixed(2)).toBe("22.00");
  });

  it("CONCURRENT: the branch lock alone (a configuration save that holds only the branch row, no update) makes creation genuinely wait", async () => {
    const ana = await newStudent(a, a.academy.id, "race-branch");
    const held = { resolve: () => {} };
    const started = new Promise<void>((r) => (held.resolve = r));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const save = prisma.$transaction(
      async (tx) => {
        await tx.$queryRawUnsafe(`SELECT "id" FROM "Academy" WHERE "id" = '${a.academy.id}' FOR UPDATE`);
        held.resolve();
        await gate;
      },
      { timeout: 60_000 },
    );
    await started;
    let done = false;
    const creating = createMonthlyObligation({ context: context(a), studentId: ana.id, coverage: { year: 2030, month: 9 }, planTermsId: terms1.id, policyVersionId: policy1.id }, deps(DEC_2030)).then((r) => ((done = true), r));
    const blocked = await waitUntilBlockedOnLock(['FROM "Academy"', "FOR SHARE"]);
    expect(blocked, "creation must genuinely be waiting on the Academy row lock (Postgres's own report, not a guessed delay)").toBe(true);
    expect(done).toBe(false);
    release();
    await save;
    expect(await creating).toMatchObject({ ok: true });
  });

  it("CONCURRENT: the student lock alone (an unrelated writer holding just the student row) makes creation genuinely wait", async () => {
    const ana = await newStudent(a, a.academy.id, "race-student-create");
    const held = { resolve: () => {} };
    const started = new Promise<void>((r) => (held.resolve = r));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const holder = prisma.$transaction(
      async (tx) => {
        await tx.$queryRawUnsafe(`SELECT "id" FROM "Student" WHERE "id" = '${ana.id}' FOR UPDATE`);
        held.resolve();
        await gate;
      },
      { timeout: 60_000 },
    );
    await started;
    let done = false;
    const creating = createMonthlyObligation({ context: context(a), studentId: ana.id, coverage: { year: 2030, month: 9 }, planTermsId: terms1.id, policyVersionId: policy1.id }, deps(DEC_2030)).then((r) => ((done = true), r));
    const blocked = await waitUntilBlockedOnLock(['FROM "Student"', "FOR UPDATE"]);
    expect(blocked, "creation must genuinely be waiting on the student row lock").toBe(true);
    expect(done).toBe(false);
    release();
    await holder;
    expect(await creating).toMatchObject({ ok: true });
  });
});

describe("recordDuesPayment: validate first, then write", () => {
  it("settles the oldest obligation on time: USD 100.00, no fee row", async () => {
    const ana = await newStudent(a, a.academy.id, "pay1");
    const [sep] = await threeMonths(ana.id);
    const before = await counts(a.org.id);
    const r = await pay(ana.id, [sep], "100.00", { now: OCT_5, day: 5 });
    expect(r).toMatchObject({ ok: true, totalMinor: 10000 });
    if (!r.ok) return;
    const after = await counts(a.org.id);
    expect(after).toEqual({ ...before, payments: before.payments + 1, settlements: before.settlements + 1, audits: before.audits + 1 });
    const settlement = await prisma.duesSettlement.findFirstOrThrow({ where: { obligationId: sep, reversedAt: null } });
    expect([settlement.paymentId, settlement.lateFeeId, settlement.studentId]).toEqual([r.paymentId, null, ana.id]);
    const payment = await prisma.duesPayment.findUniqueOrThrow({ where: { id: r.paymentId } });
    expect([payment.tenderAmount.toFixed(2), payment.tenderCurrency, payment.method, payment.recordedById, payment.receivedOn.toISOString().slice(0, 10)]).toEqual(["100.00", "USD", "EFECTIVO", a.admin.id, "2030-10-05"]);
  });

  it("the grace deadline is inclusive: Oct 5 costs 100.00, Oct 6 costs 120.00 and creates the one fee row", async () => {
    const early = await newStudent(a, a.academy.id, "boundary1");
    const [sepEarly] = await threeMonths(early.id);
    expect(await pay(early.id, [sepEarly], "120.00", { now: OCT_5, day: 5 })).toMatchObject({ ok: false, error: "notASelectableTotal" });

    const late = await newStudent(a, a.academy.id, "boundary2");
    const [sepLate] = await threeMonths(late.id);
    expect(await pay(late.id, [sepLate], "100.00", { now: OCT_6, day: 6 })).toMatchObject({ ok: false, error: "notASelectableTotal" });
    const before = await counts(a.org.id);
    const r = await pay(late.id, [sepLate], "120.00", { now: OCT_6, day: 6 });
    expect(r).toMatchObject({ ok: true, totalMinor: 12000 });
    if (!r.ok) return;
    const after = await counts(a.org.id);
    expect(after).toMatchObject({ fees: before.fees + 1, payments: before.payments + 1, settlements: before.settlements + 1 });
    const fee = await prisma.duesLateFee.findFirstOrThrow({ where: { obligationId: sepLate } });
    expect(fee.assessableFrom.toISOString().slice(0, 10)).toBe("2030-10-06");
    expect((await prisma.duesSettlement.findFirstOrThrow({ where: { obligationId: sepLate, reversedAt: null } })).lateFeeId).toBe(fee.id);
    expect(r.feeIds).toEqual([fee.id]);
  });

  it("settles several obligations oldest first, each with its own fee decision (Sep late, Oct on time): 120 + 100 = 220", async () => {
    const ana = await newStudent(a, a.academy.id, "multi");
    const [sep, oct] = await threeMonths(ana.id);
    const r = await pay(ana.id, [sep, oct], "220.00", { now: OCT_6, day: 6 });
    expect(r).toMatchObject({ ok: true, totalMinor: 22000 });
    expect(await prisma.duesLateFee.count({ where: { obligationId: { in: [sep, oct] } } })).toBe(1);
    expect(await prisma.duesSettlement.count({ where: { obligationId: { in: [sep, oct] }, reversedAt: null } })).toBe(2);
  });

  it("refuses, with the selectable totals, an amount that is not the sum of the chosen prefix (200, 230, 250, 90)", async () => {
    const ana = await newStudent(a, a.academy.id, "refuse-amt");
    const [sep, oct] = await threeMonths(ana.id);
    for (const amount of ["230.00", "250.00", "90.00", "0.01", "101.00"]) {
      const r = await pay(ana.id, [sep, oct], amount, { now: OCT_5, day: 5 });
      expect(r, amount).toMatchObject({ ok: false, error: "notASelectableTotal" });
      if (!r.ok) expect(r.selectableTotals).toEqual(["100.00", "200.00", "300.00"]);
    }
  });

  it("the chosen ids must be the oldest outstanding prefix and must match the amount", async () => {
    const ana = await newStudent(a, a.academy.id, "order");
    const [sep, oct, nov] = await threeMonths(ana.id);
    expect(await pay(ana.id, [oct], "100.00", { now: OCT_5, day: 5 })).toMatchObject({ ok: false, error: "notOldestFirst" });
    expect(await pay(ana.id, [nov], "100.00", { now: OCT_5, day: 5 })).toMatchObject({ ok: false, error: "notOldestFirst" });
    expect(await pay(ana.id, [sep, nov], "200.00", { now: OCT_5, day: 5 })).toMatchObject({ ok: false, error: "notOldestFirst" });
    // 200 is a valid total, but the selection is one obligation: the amount and the selection must agree
    expect(await pay(ana.id, [sep], "200.00", { now: OCT_5, day: 5 })).toMatchObject({ ok: false, error: "totalMismatch" });
    expect(await pay(ana.id, [sep, oct], "100.00", { now: OCT_5, day: 5 })).toMatchObject({ ok: false, error: "totalMismatch" });
    expect(await pay(ana.id, [], "100.00", { now: OCT_5, day: 5 })).toMatchObject({ ok: false, error: "invalid" });
    expect(await pay(ana.id, [sep, sep], "100.00", { now: OCT_5, day: 5 })).toMatchObject({ ok: false, error: "invalid" });
  });

  it("refuses invalid input: inexact amounts, bad currency, bad method, bad date; a receipt in another currency", async () => {
    const ana = await newStudent(a, a.academy.id, "invalid");
    const [sep] = await threeMonths(ana.id);
    for (const amount of ["100.001", "1e2", "-100.00", "abc", "", "0", "0.00", " 100.00"]) {
      expect(await pay(ana.id, [sep], amount, { now: OCT_5, day: 5 }), amount).toMatchObject({ ok: false, error: "invalid" });
    }
    expect(await pay(ana.id, [sep], "100.00", { now: OCT_5, day: 5 }, { method: "BITCOIN" })).toMatchObject({ ok: false, error: "invalid" });
    expect(await pay(ana.id, [sep], "100.00", { now: OCT_5, day: 30, month: 2 })).toMatchObject({ ok: false, error: "invalid" }); // February 30
    expect(await pay(ana.id, [sep], "100.00", { now: OCT_5, day: 5, month: 13 })).toMatchObject({ ok: false, error: "invalid" });
    expect(await pay(ana.id, [sep], "100.00", { now: OCT_5, day: 5 }, { tender: { currency: "EUR", amount: "100.00" } })).toMatchObject({ ok: false, error: "invalid" });
    // CRC receipt against USD obligations: currency-conversion brief PR 2/3 — this org has never entered an exchange
    // rate quote, so the conversion this writer attempts resolves no rate at all. PR 3 changed what happens next: this
    // now captures an awaiting-rate receipt (plan §2) rather than the plain rateUnavailable refusal PR 2 originally
    // produced — an intentional, reviewed change in this one assertion, not the old currencyMismatch (reserved, since
    // PR 2, for MIXED-currency items — see dues-currency-settlement.test.ts).
    expect(await pay(ana.id, [sep], "52000.00", { now: OCT_5, day: 5 }, { tender: { currency: "CRC", amount: "52000.00" } })).toMatchObject({ ok: false, error: "captured" });
  });

  it("the received date cannot be in the future or older than the injected backdating window", async () => {
    const ana = await newStudent(a, a.academy.id, "dates");
    const [sep] = await threeMonths(ana.id);
    expect(await pay(ana.id, [sep], "100.00", { now: OCT_5, day: 6 })).toMatchObject({ ok: false, error: "futureDate" });
    expect(await pay(ana.id, [sep], "100.00", { now: OCT_6, day: 5 }, { maxBackdateDays: 0 })).toMatchObject({ ok: false, error: "tooOld" });
    expect(await pay(ana.id, [sep], "100.00", { now: OCT_6, day: 5 }, { maxBackdateDays: 1 })).toMatchObject({ ok: true }); // Oct 5 on time, recorded Oct 6
  });

  it("'today' is the BRANCH's calendar date, not UTC's: 22:00 in Costa Rica is already the next day in UTC", async () => {
    const ana = await newStudent(a, a.academy.id, "zone");
    const [sep] = await threeMonths(ana.id);
    const lateEvening = at("2030-10-05T22:00:00"); // Oct 5 in Costa Rica (still on time), Oct 6 04:00 UTC
    // with a zero backdating window the received date must be exactly the branch's today, Oct 5, and it is on time (USD 100)
    expect(await pay(ana.id, [sep], "100.00", { now: lateEvening, day: 5 }, { maxBackdateDays: 0 })).toMatchObject({ ok: true, totalMinor: 10000 });
    const bruno = await newStudent(a, a.academy.id, "zone2");
    const [brunoSep] = await threeMonths(bruno.id);
    // and Oct 6 is the future there, whatever UTC says
    expect(await pay(bruno.id, [brunoSep], "120.00", { now: lateEvening, day: 6 }, { maxBackdateDays: 0 })).toMatchObject({ ok: false, error: "futureDate" });
  });

  it("EVERY refused submission leaves all ledger tables and audit rows unchanged, even when a fee would have been created", async () => {
    const ana = await newStudent(a, a.academy.id, "unchanged");
    const [sep, oct] = await threeMonths(ana.id);
    const bruno = await newStudent(a, a.academy.id, "unchanged2");
    const [brunoSep] = await threeMonths(bruno.id);
    const before = await counts(a.org.id);
    const late = { now: OCT_6, day: 6 };
    const refusals = [
      // late (a fee would be owed) but the total is wrong: no fee row may be created
      await pay(ana.id, [sep], "100.00", late),
      await pay(ana.id, [sep, oct], "250.00", late),
      await pay(ana.id, [oct], "100.00", late), // skips the oldest
      await pay(ana.id, [sep], "220.00", late), // a valid total for a different selection
      await pay(ana.id, [sep], "120.00", { now: OCT_5, day: 7 }), // future date
      await pay(ana.id, [sep], "120.00", late, { tender: { currency: "CRC", amount: "120.00" } }),
      await pay(ana.id, [brunoSep], "120.00", late), // another student's obligation
      await pay(ana.id, ["no-such-obligation"], "120.00", late),
    ];
    expect(refusals.every((r) => !r.ok)).toBe(true);
    expect(await counts(a.org.id)).toEqual(before);
    expect(await prisma.duesLateFee.count({ where: { obligationId: { in: [sep, oct] } } })).toBe(0);
  });

  it("existing fee waivers are preserved: a waived fee is not owed and is never touched", async () => {
    const ana = await newStudent(a, a.academy.id, "waived");
    const [sep] = await threeMonths(ana.id);
    const removal = { removedAt: new Date(), removalKind: "WAIVED" as const, removedById: a.admin.id, removalReason: "owner waived it" };
    const fee = await prisma.duesLateFee.create({ data: { organizationId: a.org.id, obligationId: sep, assessableFrom: new Date(Date.UTC(2030, 9, 6)), ...removal } });
    const feeBefore = JSON.stringify(await prisma.duesLateFee.findUniqueOrThrow({ where: { id: fee.id } }));
    expect(await pay(ana.id, [sep], "120.00", { now: OCT_6, day: 6 })).toMatchObject({ ok: false, error: "notASelectableTotal" });
    const r = await pay(ana.id, [sep], "100.00", { now: OCT_6, day: 6 });
    expect(r).toMatchObject({ ok: true, totalMinor: 10000 });
    expect((await prisma.duesSettlement.findFirstOrThrow({ where: { obligationId: sep, reversedAt: null } })).lateFeeId).toBeNull();
    expect(await prisma.duesLateFee.count({ where: { obligationId: sep } })).toBe(1);
    expect(JSON.stringify(await prisma.duesLateFee.findUniqueOrThrow({ where: { id: fee.id } }))).toBe(feeBefore);
  });

  it("an already-assessed, active fee is reused when the payment is late, and refused (feeAlreadyAssessed) when an earlier received date would remove it", async () => {
    const ana = await newStudent(a, a.academy.id, "assessed");
    const [sep] = await threeMonths(ana.id);
    const fee = await prisma.duesLateFee.create({ data: { organizationId: a.org.id, obligationId: sep, assessableFrom: new Date(Date.UTC(2030, 9, 6)) } });
    const before = await counts(a.org.id);
    // on time by the received date, but the fee is already assessed: removing it is a fee-removal behaviour this PR does not have
    expect(await pay(ana.id, [sep], "100.00", { now: OCT_6, day: 5 }, { maxBackdateDays: 3 })).toMatchObject({ ok: false, error: "feeAlreadyAssessed" });
    expect(await counts(a.org.id)).toEqual(before);
    const r = await pay(ana.id, [sep], "120.00", { now: OCT_6, day: 6 });
    expect(r).toMatchObject({ ok: true, feeIds: [] });
    expect((await prisma.duesSettlement.findFirstOrThrow({ where: { obligationId: sep, reversedAt: null } })).lateFeeId).toBe(fee.id);
    expect(await prisma.duesLateFee.count({ where: { obligationId: sep } })).toBe(1);
  });

  it("LOST-RESPONSE RETRY: the same request again is refused as alreadySettled and is NEVER applied to the next unpaid months", async () => {
    const ana = await newStudent(a, a.academy.id, "retry");
    const [sep, oct, nov] = await threeMonths(ana.id);
    const first = await pay(ana.id, [sep], "100.00", { now: OCT_5, day: 5 });
    expect(first).toMatchObject({ ok: true });
    const after = await counts(a.org.id);
    // the response was lost; the client sends the identical request again. October and November are unpaid and cost the same amount.
    const retry = await pay(ana.id, [sep], "100.00", { now: OCT_5, day: 5 });
    expect(retry).toMatchObject({ ok: false, error: "alreadySettled", alreadySettledIds: [sep] });
    expect(await counts(a.org.id)).toEqual(after);
    expect(await prisma.duesSettlement.count({ where: { obligationId: { in: [oct, nov] } } })).toBe(0);
    expect(await prisma.duesPayment.count({ where: { studentId: ana.id } })).toBe(1);
  });

  it("CONCURRENT duplicate submissions of one request: exactly one payment; the others are alreadySettled; later obligations untouched", async () => {
    const ana = await newStudent(a, a.academy.id, "dupsubmit");
    const [sep, oct, nov] = await threeMonths(ana.id);
    const before = await counts(a.org.id);
    const results = await Promise.all([1, 2, 3].map(() => pay(ana.id, [sep], "100.00", { now: OCT_5, day: 5 })));
    expect(results.filter((r) => r.ok).length).toBe(1);
    expect(results.filter((r) => !r.ok && r.error === "alreadySettled").length).toBe(2);
    const after = await counts(a.org.id);
    expect(after).toEqual({ ...before, payments: before.payments + 1, settlements: before.settlements + 1, audits: before.audits + 1 });
    expect(await prisma.duesSettlement.count({ where: { obligationId: { in: [oct, nov] } } })).toBe(0);
    expect(await prisma.duesSettlement.count({ where: { obligationId: sep, reversedAt: null } })).toBe(1);
  });

  it("CONCURRENT payments for the same student and different obligations are serialized: the older one always succeeds, the newer only after it", async () => {
    const ana = await newStudent(a, a.academy.id, "serial");
    const [sep, oct] = await threeMonths(ana.id);
    const [x, y] = await Promise.all([pay(ana.id, [sep], "100.00", { now: OCT_5, day: 5 }), pay(ana.id, [oct], "100.00", { now: OCT_5, day: 5 })]);
    expect(x.ok).toBe(true);
    if (!y.ok) expect(y.error).toBe("notOldestFirst");
    else expect(await prisma.duesSettlement.count({ where: { obligationId: { in: [sep, oct] }, reversedAt: null } })).toBe(2);
  });

  it("CONCURRENT: the student row lock alone makes a payment wait for another writer holding that student", async () => {
    const ana = await newStudent(a, a.academy.id, "lockwait");
    const [sep] = await threeMonths(ana.id);
    const held = { resolve: () => {} };
    const started = new Promise<void>((r) => (held.resolve = r));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const other = prisma.$transaction(
      async (tx) => {
        await tx.$queryRawUnsafe(`SELECT "id" FROM "Student" WHERE "id" = '${ana.id}' FOR UPDATE`);
        held.resolve();
        await gate;
      },
      { timeout: 60_000 },
    );
    await started;
    let done = false;
    const paying = pay(ana.id, [sep], "100.00", { now: OCT_5, day: 5 }).then((r) => ((done = true), r));
    const blocked = await waitUntilBlockedOnLock(['FROM "Student"', "FOR UPDATE"]);
    expect(blocked, "the payment must genuinely be waiting on the student row lock").toBe(true);
    expect(done).toBe(false);
    release();
    await other;
    expect(await paying).toMatchObject({ ok: true });
  });

  it("tenant isolation: another organization's student, another student's obligations and another organization's obligations are notFound and write nothing", async () => {
    const ana = await newStudent(a, a.academy.id, "tenant1");
    const bruno = await newStudent(a, a.academy.id, "tenant2");
    const [sep] = await threeMonths(ana.id);
    const [brunoSep] = await threeMonths(bruno.id);
    const studentB = await newStudent(b, b.academy.id, "tenantb");
    const before = await counts(a.org.id);
    const beforeB = await counts(b.org.id);
    expect(await pay(studentB.id, [sep], "100.00", { now: OCT_5, day: 5 })).toEqual({ ok: false, error: "notFound" });
    expect(await pay(ana.id, [brunoSep], "100.00", { now: OCT_5, day: 5 })).toEqual({ ok: false, error: "notFound" });
    // an organization B owner naming organization A's student and obligation
    const asB = await recordDuesPayment(
      { context: context(b), studentId: ana.id, receivedOn: { year: 2030, month: 10, day: 5 }, tender: { currency: "USD", amount: "100.00" }, method: "EFECTIVO", obligationIds: [sep], maxBackdateDays: 5 },
      deps(OCT_5),
    );
    expect(asB).toEqual({ ok: false, error: "notFound" });
    const director = context(a, { organizationRole: "DIRECTOR", academyIds: [a2.id] });
    expect(
      await recordDuesPayment(
        { context: director, studentId: ana.id, receivedOn: { year: 2030, month: 10, day: 5 }, tender: { currency: "USD", amount: "100.00" }, method: "EFECTIVO", obligationIds: [sep], maxBackdateDays: 5 },
        deps(OCT_5),
      ),
    ).toEqual({ ok: false, error: "notFound" });
    expect(await counts(a.org.id)).toEqual(before);
    expect(await counts(b.org.id)).toEqual(beforeB);
  });

  it("is atomic: if the settlement insert fails after the payment (and a fee) were inserted, nothing persists", async () => {
    const ana = await newStudent(a, a.academy.id, "atomicpay");
    const [sep] = await threeMonths(ana.id);
    const fn = `pr4a_fail_settlement_${studentCounter}`;
    await prisma.$executeRawUnsafe(`CREATE FUNCTION ${fn}() RETURNS trigger AS $$ BEGIN IF NEW."studentId" = '${ana.id}' THEN RAISE EXCEPTION 'test: settlement refused'; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql`);
    await prisma.$executeRawUnsafe(`CREATE TRIGGER ${fn} BEFORE INSERT ON "DuesSettlement" FOR EACH ROW EXECUTE FUNCTION ${fn}()`);
    const before = await counts(a.org.id);
    try {
      await expect(pay(ana.id, [sep], "120.00", { now: OCT_6, day: 6 })).rejects.toThrow();
    } finally {
      await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${fn} ON "DuesSettlement"`);
      await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${fn}()`);
    }
    expect(await counts(a.org.id)).toEqual(before);
    expect(await prisma.duesLateFee.count({ where: { obligationId: sep } })).toBe(0);
  });

  it("an archived student's existing debt stays payable (status is not checked here)", async () => {
    const ana = await newStudent(a, a.academy.id, "archived");
    const [sep] = await threeMonths(ana.id);
    await prisma.student.update({ where: { id: ana.id }, data: { status: "ARCHIVED" } });
    expect(await pay(ana.id, [sep], "100.00", { now: OCT_5, day: 5 })).toMatchObject({ ok: true });
  });
});

/**
 * Package-purchase brief's own review restored an assertion the recordDuesPaymentInTx/writeSettlementInTx extraction had
 * silently dropped: the original, pre-extraction code computed `feeOwed` per chosen obligation during validation, then
 * cross-checked it against `assessLateFeeInTx`'s own fresh read at write time, throwing (forcing full rollback) if they
 * ever disagreed — "should be impossible under the same lock, but never trust that without checking." Proven here with a
 * GENUINE disagreement, not a mocked return value: a test-only hook (`beforeSettlementFeeCheckForTest`) mutates real
 * DuesLateFee state for the target obligation, inside the SAME transaction, immediately before assessLateFeeInTx's own
 * read — the only way to construct a real divergence, since nothing else can run concurrently while the transaction
 * holds the student lock. `purchasePackage`'s own MONTHLY debt items go through this identical shared write path
 * (writeSettlementInTx); proving it here, once, on its original home, covers both callers.
 */
describe("recordDuesPayment: the validated fee state is cross-checked against assessLateFeeInTx's own fresh read", () => {
  it("a genuine disagreement (forced via the test-only hook) rolls back everything — no fee row, no payment, no settlement, no audit entry survives", async () => {
    const ana = await newStudent(a, a.academy.id, "crosscheck");
    const [sep] = await threeMonths(ana.id);
    const before = await counts(a.org.id);

    await expect(
      recordDuesPayment(
        {
          context: context(a), studentId: ana.id, receivedOn: { year: 2030, month: 10, day: 5 }, tender: { currency: "USD", amount: "100.00" },
          method: "EFECTIVO", obligationIds: [sep], maxBackdateDays: 5,
        },
        {
          ...deps(OCT_5),
          beforeSettlementFeeCheckForTest: async (tx, obligationId) => {
            if (obligationId !== sep) return;
            // Settling ON TIME (Oct 5, the inclusive grace deadline) computed expectedOwed: false during validation.
            // Inserting an ACTIVE fee row directly, right before assessLateFeeInTx's own fresh read, makes it find this
            // row and report owed: true — a genuine disagreement with what validation already computed.
            await tx.$executeRawUnsafe(
              `INSERT INTO "DuesLateFee" ("id", "organizationId", "obligationId", "assessableFrom") VALUES ($1, $2, $3, $4)`,
              `forced-${sep}`, a.org.id, obligationId, new Date("2030-10-06T00:00:00Z"),
            );
          },
        },
      ),
    ).rejects.toThrow("disagreed");

    expect(await counts(a.org.id)).toEqual(before);
    expect(await prisma.duesLateFee.findFirst({ where: { obligationId: sep } })).toBeNull();
  });
});

/**
 * A payment's total is a sum of obligation amounts, but the sum, and even a single obligation's tuition plus its own late fee, is not
 * bounded by the CHECK constraints that bound each column alone: two obligations each within Decimal(10,2)'s range can sum past it,
 * and a fee added to near-maximum tuition can too. `minorToDecimal` refuses (by design) to format such a value, so any code path that
 * blindly formats a cumulative or combined total for a REFUSAL MESSAGE must stop before reaching one, not let the RangeError escape.
 * Reproduced through the real writer, with real obligations (never hand-built minor-unit numbers).
 */
describe("payment total boundary: Decimal(10,2)'s own range, not this writer's business rules", () => {
  let boundaryBranch: { id: string };
  let feeBranch: { id: string };

  beforeAll(async () => {
    boundaryBranch = await prisma.academy.create({ data: { organizationId: a.org.id, name: "Writers boundary", slug: `writers-boundary-${suffix}`, kioskTokenHash: `writers-boundary-${suffix}` } });
    feeBranch = await prisma.academy.create({ data: { organizationId: a.org.id, name: "Writers boundary fee", slug: `writers-boundary-fee-${suffix}`, kioskTokenHash: `writers-boundary-fee-${suffix}` } });
    await prisma.duesPolicyVersion.create({
      data: { organizationId: a.org.id, academyId: boundaryBranch.id, effectiveYear: 2027, effectiveMonth: 1, dueDay: 20, graceDay: 5, lateFeeAmount: "0.00", lateFeeCurrency: "USD", createdById: a.admin.id },
    });
    await prisma.duesPolicyVersion.create({
      data: { organizationId: a.org.id, academyId: feeBranch.id, effectiveYear: 2027, effectiveMonth: 1, dueDay: 20, graceDay: 5, lateFeeAmount: "20000000.00", lateFeeCurrency: "USD", createdById: a.admin.id },
    });
  }, 30_000);

  /** Two individually valid (within-range) obligations, September and October 2030, USD 60,000,000.00 each — their sum (120,000,000.00)
   * exceeds Decimal(10,2)'s 99,999,999.99 maximum, but each one alone does not. */
  async function twoObligationsSummingOverTheLimit() {
    const student = await newStudent(a, boundaryBranch.id, "boundary");
    const { terms } = await newTerms(`boundary-${student.id}`, { academyId: boundaryBranch.id, price: "60000000.00" });
    const policy = await prisma.duesPolicyVersion.findFirstOrThrow({ where: { organizationId: a.org.id, academyId: boundaryBranch.id } });
    const ids: string[] = [];
    for (const month of [9, 10]) {
      const r = await createMonthlyObligation({ context: context(a), studentId: student.id, coverage: { year: 2030, month }, planTermsId: terms.id, policyVersionId: policy.id }, deps(DEC_2030));
      if (!r.ok) throw new Error(r.error);
      ids.push(r.obligationId);
    }
    return { student, ids };
  }

  it("(1) an incorrect amount against the two-obligation total is refused with only the in-range total offered, never a crash", async () => {
    const { student, ids } = await twoObligationsSummingOverTheLimit();
    const before = await counts(a.org.id);
    const r = await pay(student.id, ids, "70000000.00", { now: OCT_5, day: 5 }); // matches neither 60,000,000.00 nor the (unrepresentable) 120,000,000.00
    expect(r).toMatchObject({ ok: false, error: "notASelectableTotal", selectableTotals: ["60000000.00"] });
    expect(await counts(a.org.id)).toEqual(before);
  });

  it("(2) the oldest of the two stays payable on its own, even though the pair's total cannot be represented", async () => {
    const { student, ids } = await twoObligationsSummingOverTheLimit();
    const [sep, oct] = ids;
    expect(await pay(student.id, [sep], "60000000.00", { now: OCT_5, day: 5 })).toMatchObject({ ok: true, totalMinor: 6_000_000_000 });
    // and, once it is the oldest outstanding one, October is payable the very same way
    expect(await pay(student.id, [oct], "60000000.00", { now: OCT_5, day: 5 })).toMatchObject({ ok: true, totalMinor: 6_000_000_000 });
  });

  it("(3) an obligation whose tuition plus its own applicable late fee exceeds the column's capacity is an explicit refusal, never split, waived, clamped or crashed", async () => {
    const student = await newStudent(a, feeBranch.id, "boundary-fee");
    const { terms } = await newTerms(`boundary-fee-${student.id}`, { academyId: feeBranch.id, price: "90000000.00" }); // + the branch's 20,000,000.00 fee = 110,000,000.00
    const policy = await prisma.duesPolicyVersion.findFirstOrThrow({ where: { organizationId: a.org.id, academyId: feeBranch.id } });
    const created = await createMonthlyObligation({ context: context(a), studentId: student.id, coverage: { year: 2030, month: 9 }, planTermsId: terms.id, policyVersionId: policy.id }, deps(DEC_2030));
    if (!created.ok) throw new Error(created.error);
    const before = await counts(a.org.id);
    const originalRow = JSON.stringify(await prisma.duesObligation.findUniqueOrThrow({ where: { id: created.obligationId } }));
    const r = await pay(student.id, [created.obligationId], "90000000.00", { now: OCT_6, day: 6 }); // paid LATE, so the fee applies; no amount could ever match tuition+fee here
    expect(r).toEqual({ ok: false, error: "amountUnsupported" });
    expect(await counts(a.org.id)).toEqual(before);
    // not split, not waived, not clamped: the obligation's own row is untouched
    expect(JSON.stringify(await prisma.duesObligation.findUniqueOrThrow({ where: { id: created.obligationId } }))).toBe(originalRow);
  });

  it("(4) totalMismatch also offers only in-range totals: a valid amount for a smaller prefix, wrong selection, while the full total is unrepresentable", async () => {
    const { student, ids } = await twoObligationsSummingOverTheLimit();
    const before = await counts(a.org.id);
    // both obligations chosen (the correct oldest-first pair), but the amount matches only the first one
    const r = await pay(student.id, ids, "60000000.00", { now: OCT_5, day: 5 });
    expect(r).toMatchObject({ ok: false, error: "totalMismatch", selectableTotals: ["60000000.00"] });
    expect(await counts(a.org.id)).toEqual(before);
  });
});
