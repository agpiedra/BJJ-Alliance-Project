import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getTestPrismaClient } from "../helpers/test-db";
import { makeAccountingOrg } from "../helpers/accounting-org";
import type { TenantContext } from "../../src/lib/tenant/types";
import type { LedgerActivation } from "../../src/lib/dues/ledger/activation";

/**
 * Stage 8 PR 8a against the REAL isolated test database, with two private temporary organizations (removed in afterAll).
 *
 * `@/lib/prisma` is replaced by a pass-through proxy that can be PINNED to one interactive transaction: while pinned, every
 * model call goes to that transaction and `$transaction(fn)` runs `fn` inside it. This is how the equivalence test runs the
 * REAL monthly writer (`generateMonthlyObligationForStudent`, which opens its own transaction) with an injected active stub
 * and then rolls everything back — ledger rows reject DELETE, so a rolled-back transaction is the only clean way. While not
 * pinned, the proxy is the ordinary guarded client.
 */
const pin = vi.hoisted(() => ({ tx: null as unknown }));
vi.mock("@/lib/prisma", async () => {
  const actual = await vi.importActual<typeof import("../../src/lib/prisma")>("../../src/lib/prisma");
  const prisma = new Proxy(actual.prisma, {
    get(target, prop, receiver) {
      if (pin.tx) {
        if (prop === "$transaction") return (fn: (tx: unknown) => unknown) => fn(pin.tx);
        return (pin.tx as Record<string | symbol, unknown>)[prop];
      }
      return Reflect.get(target, prop, receiver);
    },
  });
  return { ...actual, prisma };
});

// Call counters around the snapshot transaction and the loader (both still run the real functions), so a refused call can be
// shown never to open the snapshot or load anything.
const calls = vi.hoisted(() => ({ snapshot: 0, load: 0 }));
vi.mock("@/lib/db/read-only-snapshot", async () => {
  const actual = await vi.importActual<typeof import("../../src/lib/db/read-only-snapshot")>("../../src/lib/db/read-only-snapshot");
  return {
    ...actual,
    runReadOnlySnapshot: ((...args: Parameters<typeof actual.runReadOnlySnapshot>) => {
      calls.snapshot++;
      return actual.runReadOnlySnapshot(...args);
    }) as typeof actual.runReadOnlySnapshot,
  };
});
vi.mock("@/lib/dues/readiness/snapshot", async () => {
  const actual = await vi.importActual<typeof import("../../src/lib/dues/readiness/snapshot")>("../../src/lib/dues/readiness/snapshot");
  return {
    ...actual,
    loadReadinessSnapshot: (...args: Parameters<typeof actual.loadReadinessSnapshot>) => {
      calls.load++;
      return actual.loadReadinessSnapshot(...args);
    },
  };
});

let currentSession: { user: { id: string; role: string } | null; activeOrganizationId?: string } | null = null;
vi.mock("@/auth", () => ({ auth: () => Promise.resolve(currentSession), signIn: vi.fn() }));

const { prisma: appPrisma } = await import("../../src/lib/prisma");
const { getDuesReadinessForOwner } = await import("../../src/lib/dues/readiness");
const { runReadOnlySnapshot } = await import("../../src/lib/db/read-only-snapshot");
const { loadReadinessSnapshot } = await import("../../src/lib/dues/readiness/snapshot");
const { evaluateReadiness } = await import("../../src/lib/dues/readiness/evaluate");
const { FINGERPRINT_FORMAT, openingReviewBinding, studentFingerprint } = await import("../../src/lib/dues/readiness/fingerprint");
const { generateMonthlyObligationForStudent } = await import("../../src/lib/dues/monthly-generation");

const prisma = getTestPrismaClient();
type Fixture = Awaited<ReturnType<typeof makeAccountingOrg>>;
const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
const S = { year: 2030, month: 12 };
const ACTIVE: LedgerActivation = { isActive: async () => true };
const IN_S = () => new Date("2030-12-05T12:00:00-06:00"); // inside S in the branch timezone (Costa Rica, UTC-6)

let a: Fixture;
let b: Fixture;
let director: { id: string };
let usdPlanId: string;
const st: Record<string, string> = {}; // label -> student id in organization A
let bStudent: string;
let legacyNov: string; // a legacy row of A's "created" student, edited in place by the tests

function actAs(userId: string | null, organizationId: string, role = "ADMIN") {
  currentSession = userId ? { user: { id: userId, role }, activeOrganizationId: organizationId } : null;
}
const context = (): TenantContext => ({
  kind: "tenant", actorUserId: a.admin.id, organizationId: a.org.id, organizationRole: "ADMIN", academyIds: "ALL", selfStudentId: null, linkedStudentId: null,
});

let n = 0;
async function newStudent(fx: Fixture, label: string, status: "ACTIVE" | "INACTIVE", history: "ACTIVE" | "INACTIVE" | null) {
  n++;
  const student = await prisma.student.create({
    data: {
      organizationId: fx.org.id, homeAcademyId: fx.academy.id, firstName: "Ready", lastName: `${label}${n}`, phone: "00000000",
      email: `ready-${label}-${n}-${suffix}@example.com`, currentRankId: await fx.rankId("WHITE"), codeHash: `ready-${label}-${n}-${suffix}`, status,
    },
  });
  if (history) {
    await prisma.studentStatusChange.create({
      data: { organizationId: fx.org.id, studentId: student.id, status: history, effectiveOn: new Date(Date.UTC(2030, 7, 1)), sequence: 1, source: "EVENT", actorId: fx.admin.id },
    });
  }
  return student.id;
}
const assign = (fx: Fixture, studentId: string, planId: string | null) =>
  prisma.studentPlanAssignment.create({ data: { organizationId: fx.org.id, studentId, planId, effectiveYear: 2030, effectiveMonth: 9, createdById: fx.admin.id } });

/** Financial and dues-configuration tables only — never AuditLog. */
async function financialCounts(organizationId: string) {
  return {
    paymentPeriod: await prisma.paymentPeriod.count({ where: { organizationId } }),
    obligations: await prisma.duesObligation.count({ where: { organizationId } }),
    coverage: await prisma.duesCoverage.count({ where: { organizationId } }),
    lateFees: await prisma.duesLateFee.count({ where: { organizationId } }),
    settlements: await prisma.duesSettlement.count({ where: { organizationId } }),
    payments: await prisma.duesPayment.count({ where: { organizationId } }),
    statusChanges: await prisma.studentStatusChange.count({ where: { organizationId } }),
    assignments: await prisma.studentPlanAssignment.count({ where: { organizationId } }),
    terms: await prisma.paymentPlanTerms.count({ where: { organizationId } }),
    policies: await prisma.duesPolicyVersion.count({ where: { organizationId } }),
    plans: await prisma.paymentPlan.count({ where: { organizationId } }),
  };
}

async function writeCounts(organizationId: string) {
  return {
    paymentPeriod: await prisma.paymentPeriod.count({ where: { organizationId } }),
    obligations: await prisma.duesObligation.count({ where: { organizationId } }),
    coverage: await prisma.duesCoverage.count({ where: { organizationId } }),
    lateFees: await prisma.duesLateFee.count({ where: { organizationId } }),
    statusChanges: await prisma.studentStatusChange.count({ where: { organizationId } }),
    assignments: await prisma.studentPlanAssignment.count({ where: { organizationId } }),
    terms: await prisma.paymentPlanTerms.count({ where: { organizationId } }),
    policies: await prisma.duesPolicyVersion.count({ where: { organizationId } }),
    audit: await prisma.auditLog.count({ where: { organizationId } }),
  };
}

beforeAll(async () => {
  a = await makeAccountingOrg("CUMULATIVE", "ready-a");
  b = await makeAccountingOrg("CUMULATIVE", "ready-b");

  // A: one branch, USD policy; a USD monthly plan, a CRC monthly plan (currency mismatch), a package plan (inapplicable as
  // monthly) and a plan with no terms (no effective version).
  const plan = (name: string) => prisma.paymentPlan.create({ data: { organizationId: a.org.id, academyId: a.academy.id, name: `${name} ${suffix}` } });
  const usd = await plan("USD monthly");
  usdPlanId = usd.id;
  const crc = await plan("CRC monthly");
  const pack = await plan("Package");
  const bare = await plan("No terms");
  const terms = (planId: string, priceAmount: string, currency: "USD" | "CRC", monthsCovered: number) =>
    prisma.paymentPlanTerms.create({ data: { organizationId: a.org.id, planId, effectiveYear: 2030, effectiveMonth: 1, priceAmount, currency, monthsCovered, createdById: a.admin.id } });
  await terms(usd.id, "100.00", "USD", 1);
  await terms(crc.id, "25000.00", "CRC", 1);
  await terms(pack.id, "270.00", "USD", 3);
  await prisma.duesPolicyVersion.create({
    data: { organizationId: a.org.id, academyId: a.academy.id, effectiveYear: 2030, effectiveMonth: 1, dueDay: 10, graceDay: 5, lateFeeAmount: "10.00", lateFeeCurrency: "USD", createdById: a.admin.id },
  });

  st.created = await newStudent(a, "created", "ACTIVE", "ACTIVE");
  await assign(a, st.created, usd.id);
  st.created2 = await newStudent(a, "created2", "ACTIVE", "ACTIVE");
  await assign(a, st.created2, usd.id);
  st.undecidable = await newStudent(a, "undecidable", "ACTIVE", null);
  await assign(a, st.undecidable, usd.id);
  st.inactive = await newStudent(a, "inactive", "INACTIVE", "INACTIVE");
  await assign(a, st.inactive, usd.id);
  st.unassigned = await newStudent(a, "unassigned", "ACTIVE", "ACTIVE");
  st.noPlan = await newStudent(a, "noplan", "ACTIVE", "ACTIVE");
  await assign(a, st.noPlan, null);
  st.mismatch = await newStudent(a, "mismatch", "ACTIVE", "ACTIVE");
  await assign(a, st.mismatch, crc.id);
  st.package = await newStudent(a, "package", "ACTIVE", "ACTIVE");
  await assign(a, st.package, pack.id);
  st.noTerms = await newStudent(a, "noterms", "ACTIVE", "ACTIVE");
  await assign(a, st.noTerms, bare.id);

  legacyNov = (
    await prisma.paymentPeriod.create({
      data: { organizationId: a.org.id, studentId: st.created, academyId: a.academy.id, year: 2030, month: 11, planId: usd.id, status: "PENDING", amount: "100.00", currency: "USD", recordedById: a.admin.id },
    })
  ).id;

  // B: one student, so isolation has something to leak.
  bStudent = await newStudent(b, "other-org", "ACTIVE", "ACTIVE");

  director = await prisma.user.create({ data: { email: `ready-director-${suffix}@example.com`, passwordHash: "x", role: "DIRECTOR" } });
  await prisma.organizationMembership.create({ data: { userId: director.id, organizationId: a.org.id, role: "DIRECTOR" } });
  await prisma.staffAssignment.create({ data: { userId: director.id, academyId: a.academy.id, organizationId: a.org.id, role: "DIRECTOR" } });
}, 120_000);

afterAll(async () => {
  const orgIds = [a?.org.id, b?.org.id].filter(Boolean) as string[];
  if (orgIds.length > 0) {
    // Test-only: stage 8b drafts and confirmations reject DELETE, so the committed fixture rows are removed with the triggers off
    // for this transaction alone (the same technique as tests/integration/dues-readiness-schema.test.ts).
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL session_replication_role = replica");
      for (const table of ["DuesReadinessConfirmation", "DuesOpeningItem"]) {
        await tx.$executeRawUnsafe(`DELETE FROM "${table}" WHERE "organizationId" = ANY($1::text[])`, orgIds);
      }
    });
  }
  for (const fx of [a, b]) {
    if (!fx) continue;
    await prisma.paymentPeriod.deleteMany({ where: { organizationId: fx.org.id } });
    await prisma.studentPlanAssignment.deleteMany({ where: { organizationId: fx.org.id } });
    await prisma.paymentPlanTerms.deleteMany({ where: { organizationId: fx.org.id } });
    await prisma.duesPolicyVersion.deleteMany({ where: { organizationId: fx.org.id } });
    await prisma.paymentPlan.deleteMany({ where: { organizationId: fx.org.id } });
    await prisma.staffAssignment.deleteMany({ where: { organizationId: fx.org.id } });
    await fx.drop();
  }
  if (director) await prisma.user.deleteMany({ where: { id: director.id } });
}, 120_000);

describe("runReadOnlySnapshot: one PostgreSQL-enforced REPEATABLE READ, READ ONLY transaction", () => {
  it("the database itself reports read-only and repeatable read, and refuses a write", async () => {
    const settings = await runReadOnlySnapshot(appPrisma, async (tx) => ({
      ro: (await tx.$queryRawUnsafe<{ transaction_read_only: string }[]>("SHOW transaction_read_only"))[0].transaction_read_only,
      iso: (await tx.$queryRawUnsafe<{ transaction_isolation: string }[]>("SHOW transaction_isolation"))[0].transaction_isolation,
    }));
    expect(settings).toEqual({ ro: "on", iso: "repeatable read" });

    const before = await writeCounts(a.org.id);
    await expect(
      runReadOnlySnapshot(appPrisma, (tx) => tx.$executeRawUnsafe(`UPDATE "PaymentPeriod" SET "notes" = 'x' WHERE "id" = $1`, legacyNov)),
    ).rejects.toThrow(/read-only transaction/);
    expect(await writeCounts(a.org.id)).toEqual(before);
  });

  it("reads inside one snapshot never see a change another connection commits in the middle", async () => {
    let inserted: string | null = null;
    const seen = await runReadOnlySnapshot(appPrisma, async (tx) => {
      const first = await tx.paymentPeriod.count({ where: { organizationId: a.org.id } });
      inserted = (
        await prisma.paymentPeriod.create({
          data: { organizationId: a.org.id, studentId: st.created2, academyId: a.academy.id, year: 2030, month: 10, planId: usdPlanId, status: "PAID", amount: "100.00", currency: "USD", recordedById: a.admin.id },
        })
      ).id;
      const second = await tx.paymentPeriod.count({ where: { organizationId: a.org.id } });
      return { first, second };
    });
    try {
      expect(seen.second).toBe(seen.first);
      expect(await prisma.paymentPeriod.count({ where: { organizationId: a.org.id } })).toBe(seen.first + 1);
    } finally {
      if (inserted) await prisma.paymentPeriod.delete({ where: { id: inserted } });
    }
  });
});

describe("the loader reads one snapshot, and the fingerprints see in-place edits", () => {
  const load = (hooks = {}) => runReadOnlySnapshot(appPrisma, (tx) => loadReadinessSnapshot(tx, a.org.id, hooks));

  it("a legacy row edited in place (same id, same recordedAt) mid-load is not seen; the next report's fingerprint changes", async () => {
    const recordedBefore = (await prisma.paymentPeriod.findUniqueOrThrow({ where: { id: legacyNov } })).recordedAt;
    const baseline = evaluateReadiness(await load(), S);
    try {
      const during = evaluateReadiness(
        await load({
          afterFirstRead: async () => {
            await prisma.paymentPeriod.update({ where: { id: legacyNov }, data: { status: "PAID", amount: "90.00" } });
          },
        }),
        S,
      );
      // Committed between the organization read and the PaymentPeriod read — invisible to this snapshot.
      expect(during.fingerprints).toEqual(baseline.fingerprints);

      const after = evaluateReadiness(await load(), S);
      const row = await prisma.paymentPeriod.findUniqueOrThrow({ where: { id: legacyNov } });
      expect(row.recordedAt).toEqual(recordedBefore);
      expect(after.fingerprints.students[st.created]).not.toBe(baseline.fingerprints.students[st.created]);
      expect(after.fingerprints.organization).not.toBe(baseline.fingerprints.organization);
      expect(after.fingerprints.students[st.created2]).toBe(baseline.fingerprints.students[st.created2]);
    } finally {
      await prisma.paymentPeriod.update({ where: { id: legacyNov }, data: { status: "PENDING", amount: "100.00" } });
    }
  });

  it("a price corrected in place changes the branch fingerprint", async () => {
    const before = evaluateReadiness(await load(), S);
    const termsRow = await prisma.paymentPlanTerms.findFirstOrThrow({ where: { organizationId: a.org.id, planId: usdPlanId } });
    try {
      await prisma.paymentPlanTerms.update({ where: { id: termsRow.id }, data: { priceAmount: "105.00" } });
      const after = evaluateReadiness(await load(), S);
      expect(after.fingerprints.branches[a.academy.id]).not.toBe(before.fingerprints.branches[a.academy.id]);
    } finally {
      await prisma.paymentPlanTerms.update({ where: { id: termsRow.id }, data: { priceAmount: "100.00" } });
    }
  });
});

describe("getDuesReadinessForOwner: authorization and isolation", () => {
  it("the organization's owner gets the report, never ready", async () => {
    actAs(a.admin.id, a.org.id);
    const result = await getDuesReadinessForOwner(a.org.id, S);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.report.ready).toBe(false);
    expect(result.report.checks.filter((c) => c.status === "notImplemented").map((c) => c.id)).toEqual([6, 7, 8, 9, 10, 11, 12]);
    expect(result.report.checks.find((c) => c.id === 13)!.status).toBe("decisionPending");
  });

  it.each([
    ["a DIRECTOR of the organization", () => actAs(director.id, a.org.id, "DIRECTOR")],
    ["nobody signed in", () => actAs(null, a.org.id)],
  ])("%s gets notFound, and the snapshot is never opened", async (_who, become) => {
    become();
    calls.snapshot = 0;
    calls.load = 0;
    expect(await getDuesReadinessForOwner(a.org.id, S)).toEqual({ ok: false, error: "notFound" });
    expect(calls).toEqual({ snapshot: 0, load: 0 });
  });

  it("the owner of ANOTHER organization gets notFound with no report; the snapshot never loads; the existing security audit records the refusal; no financial data changes", async () => {
    actAs(b.admin.id, a.org.id);
    const financialBeforeA = await financialCounts(a.org.id);
    const financialBeforeB = await financialCounts(b.org.id);
    const refusalsBefore = await prisma.auditLog.findMany({ where: { organizationId: a.org.id, action: "organization.accessRefused" }, select: { id: true } });
    calls.snapshot = 0;
    calls.load = 0;

    const result = await getDuesReadinessForOwner(a.org.id, S);

    expect(result).toEqual({ ok: false, error: "notFound" });
    expect(result).not.toHaveProperty("report");
    expect(calls).toEqual({ snapshot: 0, load: 0 });

    // Authorization runs before the snapshot and keeps its security audit: exactly one new refusal row, naming the
    // refused actor and the organization they targeted.
    const refusals = await prisma.auditLog.findMany({
      where: { organizationId: a.org.id, action: "organization.accessRefused", id: { notIn: refusalsBefore.map((r) => r.id) } },
    });
    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toMatchObject({ actorId: b.admin.id, organizationId: a.org.id, entityType: "Organization", entityId: a.org.id });

    expect(await financialCounts(a.org.id)).toEqual(financialBeforeA);
    expect(await financialCounts(b.org.id)).toEqual(financialBeforeB);
  });

  it("an invalid month is refused", async () => {
    actAs(a.admin.id, a.org.id);
    expect(await getDuesReadinessForOwner(a.org.id, { year: 2030, month: 13 })).toEqual({ ok: false, error: "invalid" });
  });

  it("another organization's students never appear, in fingerprints or in the preview", async () => {
    actAs(a.admin.id, a.org.id);
    const result = await getDuesReadinessForOwner(a.org.id, S);
    if (!result.ok) throw new Error("expected a report");
    const text = JSON.stringify(result.report);
    expect(text).not.toContain(bStudent);
    expect(text).not.toContain(b.academy.id);
    expect(Object.keys(result.report.fingerprints.students).sort()).toEqual(Object.values(st).sort());
  });

  // Scope: an AUTHORIZED owner's call. A refused cross-organization call writes the existing security audit row (the test
  // above); an authorized preview writes nothing at all — no financial row and no audit row.
  it("an authorized owner's preview writes nothing (financial tables and AuditLog)", async () => {
    actAs(a.admin.id, a.org.id);
    const before = await writeCounts(a.org.id);
    calls.snapshot = 0;
    calls.load = 0;
    await getDuesReadinessForOwner(a.org.id, S);
    await getDuesReadinessForOwner(a.org.id, { year: 2031, month: 1 });
    expect(calls).toEqual({ snapshot: 2, load: 2 }); // the snapshot really ran, so this is not a vacuous check
    expect(await writeCounts(a.org.id)).toEqual(before);
  });
});

describe("equivalence with the real monthly writer (active stub, rolled back)", () => {
  it("every student's preview matches what generateMonthlyObligationForStudent does, and the rollback leaves no ledger row", async () => {
    actAs(a.admin.id, a.org.id);
    const result = await getDuesReadinessForOwner(a.org.id, S);
    if (!result.ok) throw new Error("expected a report");
    const preview = Object.fromEntries(result.report.preview.students.map((p) => [p.studentId, p]));

    const ROLLBACK = new Error("rollback");
    const writer: Record<string, { category: string; reason?: string; amount?: string; currency?: string }> = {};
    await appPrisma
      .$transaction(
        async (tx) => {
          pin.tx = tx;
          try {
            for (const id of Object.values(st)) {
              // The writer refuses a month later than ITS clock (futureMonth); the preview predicts the run during S, so the
              // writer runs with its clock inside S — as the real monthly run will after activation.
              const outcome = await generateMonthlyObligationForStudent(context(), id, S, { activation: ACTIVE, now: IN_S });
              if (outcome.category === "created") {
                const row = await tx.duesObligation.findFirstOrThrow({ where: { id: outcome.obligationId, organizationId: a.org.id } });
                writer[id] = { category: "created", amount: row.amount.toFixed(2), currency: row.currency };
              } else {
                writer[id] = { category: outcome.category, reason: "reason" in outcome ? String(outcome.reason) : undefined };
              }
            }
          } finally {
            pin.tx = null;
          }
          throw ROLLBACK;
        },
        { timeout: 60_000 },
      )
      .catch((error) => {
        if (error !== ROLLBACK) throw error;
      });

    // The fixture exercises every category the writer can reach before activation.
    expect(new Set(Object.values(writer).map((w) => `${w.category}:${w.reason ?? ""}`))).toEqual(
      new Set([
        "created:",
        "notEligible:UNDECIDABLE",
        "notEligible:NOT_ELIGIBLE",
        "notEligible:NO_ASSIGNMENT",
        "configurationGap:currencyMismatch",
        "configurationGap:inapplicable",
        "configurationGap:noEffectiveVersion",
      ]),
    );
    for (const id of Object.values(st)) {
      const p = preview[id];
      const w = writer[id];
      const previewView = p.outcome === "created" ? { category: "created", amount: p.amount, currency: p.currency } : { category: p.outcome, reason: p.reason };
      expect(previewView, `student ${id}`).toEqual(w.category === "created" ? w : { category: w.category, reason: w.reason });
    }
    expect(await prisma.duesObligation.count({ where: { organizationId: a.org.id } })).toBe(0);
    expect(await prisma.duesCoverage.count({ where: { organizationId: a.org.id } })).toBe(0);
  }, 120_000);
});

describe("stage 8b: opening-debt drafts in the snapshot and the fingerprints (format r2)", () => {
  const load = (hooks = {}) => runReadOnlySnapshot(appPrisma, (tx) => loadReadinessSnapshot(tx, a.org.id, hooks));
  const binding = (snapshot: Awaited<ReturnType<typeof load>>, studentId: string) => openingReviewBinding(S, studentFingerprint(snapshot, studentId));
  const draft = (studentId: string, coverageMonth: number, over: { amount?: string; note?: string; legacyPaymentPeriodId?: string } = {}) =>
    prisma.duesOpeningItem.create({
      data: { organizationId: a.org.id, studentId, coverageYear: 2030, coverageMonth, amount: "100.00", currency: "USD", note: "Unpaid before the switch", createdById: a.admin.id, ...over },
    });
  const withdraw = (id: string) =>
    prisma.duesOpeningItem.update({ where: { id }, data: { withdrawnAt: new Date(), withdrawnById: a.admin.id, withdrawalKind: "WITHDRAWN", withdrawalReason: "Entered by mistake" } });
  /** The documented edit order (marker first, then the successor), in one transaction. */
  const edit = (oldId: string, studentId: string, coverageMonth: number, amount: string) =>
    prisma.$transaction(async (tx) => {
      const successorId = crypto.randomUUID();
      await tx.duesOpeningItem.update({ where: { id: oldId }, data: { withdrawnAt: new Date(), withdrawnById: a.admin.id, withdrawalKind: "EDITED", supersededById: successorId } });
      return tx.duesOpeningItem.create({
        data: { id: successorId, organizationId: a.org.id, studentId, coverageYear: 2030, coverageMonth, amount, currency: "USD", note: "Unpaid before the switch", createdById: a.admin.id },
      });
    });

  let reportBeforeDrafts: Awaited<ReturnType<typeof evaluateReadiness>>;
  beforeAll(async () => {
    reportBeforeDrafts = evaluateReadiness(await load(), S);
  });

  it("revival regression against the real database: a stored 'no opening debt' confirmation stays stale after add-then-withdraw", async () => {
    const studentId = st.created2;
    const b0 = binding(await load(), studentId);
    // The owner's statement, as stage 8c will store it (sequence 1, current format, binding B0).
    const stored = await prisma.duesReadinessConfirmation.create({
      data: {
        organizationId: a.org.id, studentId, candidateYear: S.year, candidateMonth: S.month, kind: "OPENING_REVIEWED", sequence: 1, fingerprintFormat: FINGERPRINT_FORMAT,
        binding: b0, studentFingerprint: studentFingerprint(await load(), studentId), declaredNoOpeningDebt: true, confirmedById: a.admin.id,
      },
    });
    const valid = async () => stored.fingerprintFormat === FINGERPRINT_FORMAT && stored.binding === binding(await load(), studentId);
    expect(await valid()).toBe(true);

    const d = await draft(studentId, 9);
    const b1 = binding(await load(), studentId);
    expect(await valid()).toBe(false);
    await withdraw(d.id);
    const b2 = binding(await load(), studentId);
    expect(b2).not.toBe(b0);
    expect(b2).not.toBe(b1);
    expect(await valid(), "the add-then-withdraw cycle must not revive the B0 confirmation").toBe(false);
    // The confirmation row itself never changes, and it is in no content hash: recording it changed no fingerprint.
    expect(await prisma.duesReadinessConfirmation.findUniqueOrThrow({ where: { id: stored.id } })).toEqual(stored);
  });

  it("revival regression against the real database: edit-then-withdraw and edit-then-revert never return to an earlier binding", async () => {
    const studentId = st.created;
    const seen = [binding(await load(), studentId)];
    const d1 = await draft(studentId, 10, { amount: "100.00" });
    seen.push(binding(await load(), studentId));
    const d2 = await edit(d1.id, studentId, 10, "80.00");
    seen.push(binding(await load(), studentId));
    const d3 = await edit(d2.id, studentId, 10, "100.00"); // revert: the original values re-entered
    seen.push(binding(await load(), studentId));
    await withdraw(d3.id);
    seen.push(binding(await load(), studentId));
    expect(new Set(seen).size, "every step must produce a binding never seen before").toBe(seen.length);
  });

  it("the loader returns active drafts with their content and withdrawn drafts as identity and marker only (no amount, currency or note)", async () => {
    const studentId = st.mismatch;
    const active = await draft(studentId, 11, { amount: "123.45", note: "active draft note" });
    const gone = await draft(studentId, 8, { amount: "777.77", note: "withdrawn draft note" });
    await withdraw(gone.id);
    const snapshot = await load();
    expect(snapshot.openingItems.filter((d) => d.studentId === studentId)).toEqual([
      { id: active.id, studentId, coverageYear: 2030, coverageMonth: 11, amount: "123.45", currency: "USD", note: "active draft note", legacyPaymentPeriodId: null },
    ]);
    expect(snapshot.withdrawnOpeningItems.filter((d) => d.studentId === studentId)).toEqual([
      { id: gone.id, studentId, withdrawalKind: "WITHDRAWN", supersededById: null },
    ]);
    const text = JSON.stringify(snapshot);
    expect(text).not.toContain("777.77");
    expect(text).not.toContain("withdrawn draft note");
    // Active debt (the active drafts) never includes a withdrawn draft.
    expect(snapshot.openingItems.map((d) => d.id)).not.toContain(gone.id);
    // Another organization's drafts are never loaded.
    expect(snapshot.openingItems.concat(snapshot.withdrawnOpeningItems as never[]).every((d) => Object.values(st).includes(d.studentId))).toBe(true);
  });

  it("a draft committed after the snapshot started is invisible to it; the next report sees it", async () => {
    const studentId = st.package;
    const baseline = evaluateReadiness(await load(), S);
    let inserted = "";
    const during = await load({
      afterFirstRead: async () => {
        inserted = (await draft(studentId, 7)).id;
      },
    });
    expect(during.openingItems.map((d) => d.id)).not.toContain(inserted);
    expect(evaluateReadiness(during, S).fingerprints).toEqual(baseline.fingerprints);
    const after = evaluateReadiness(await load(), S);
    expect(after.fingerprints.students[studentId]).not.toBe(baseline.fingerprints.students[studentId]);
  });

  it("with drafts present, the MONTHLY preview and its totals are unchanged, checks 6-12 stay notImplemented, 13 decisionPending, ready false", async () => {
    const snapshot = await load();
    expect(snapshot.openingItems.length + snapshot.withdrawnOpeningItems.length).toBeGreaterThan(0); // not vacuous
    const after = evaluateReadiness(snapshot, S);
    expect(after.preview).toEqual(reportBeforeDrafts.preview);
    expect(after.checks).toEqual(reportBeforeDrafts.checks);
    expect(after.checks.filter((c) => c.status === "notImplemented").map((c) => c.id)).toEqual([6, 7, 8, 9, 10, 11, 12]);
    expect(after.checks.find((c) => c.id === 13)!.status).toBe("decisionPending");
    expect(after.ready).toBe(false);
    actAs(a.admin.id, a.org.id);
    const result = await getDuesReadinessForOwner(a.org.id, S);
    if (!result.ok) throw new Error("expected a report");
    expect(result.report.preview).toEqual(reportBeforeDrafts.preview);
    expect(result.report.ready).toBe(false);
  });
});
