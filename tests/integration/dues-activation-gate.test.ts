import "dotenv/config";
import { Pool, type PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { getTestPrismaClient } from "../helpers/test-db";
import { makeAccountingOrg } from "../helpers/accounting-org";
import { resolveGuardedTestDatabaseUrl } from "../../scripts/lib/test-database-guard";
import type { TenantContext } from "../../src/lib/tenant/types";

/**
 * Stage 9, PR 9-1 (docs/dues/STAGE-9-IMPLEMENTATION-PLAN.md revision 4, concurrency rules 1–9) against the REAL isolated test
 * database. A "holder" is a raw pg connection that takes the organization row lock exactly as the PR 9-3 switch will
 * (`FOR UPDATE`, optionally writing an effective activation) so each test controls when it commits or rolls back. Waiting is
 * proved with pg_blocking_pids(), never inferred from timing. Private temporary organization, synthetic amounts.
 */
let currentSession: { user: { id: string; role: string } | null; activeOrganizationId?: string } | null = null;
vi.mock("@/auth", () => ({ auth: () => Promise.resolve(currentSession), signIn: vi.fn() }));
vi.mock("@/lib/email/send-transactional-email", () => ({ sendTransactionalEmail: vi.fn(async () => ({ success: true })) }));
// Every test outlives its longest internal wait (the 5 s legacy gate timeout, the 5 s blocked-poll), so a slow test fails on
// its own assertion instead of being abandoned while its body keeps running into the next test.
vi.setConfig({ testTimeout: 20_000, hookTimeout: 60_000 });

const gate = await import("../../src/lib/dues/activation-gate");
const { prisma: appPrisma } = await import("../../src/lib/prisma");
const { ledgerActivation } = await import("../../src/lib/dues/ledger/activation");
const { recordPayment } = await import("../../src/lib/payments/payment-actions");
const { getCurrentPaymentPeriod, currentCrDateParts } = await import("../../src/lib/payments/get-current-period");
const { ensureCustomPromoPlan } = await import("../../src/lib/payments/ensure-custom-promo-plan");
const { createPlan, changeOrganizationCurrency } = await import("../../src/lib/payments/plan-actions");
const { assignPlan } = await import("../../src/lib/dues/assignment-actions");
const { addPolicyVersion } = await import("../../src/lib/dues/config-actions");
const { createOpeningDraft } = await import("../../src/lib/dues/readiness/opening-actions");
const { runStatusHistoryBaseline } = await import("../../src/lib/students/baseline-action");
const { createLocationForOwner } = await import("../../src/lib/locations/location-service");
const { approveStudentInTx } = await import("../../src/app/[locale]/(staff)/students/[id]/approve-student-core");
const { createMonthlyObligation } = await import("../../src/lib/dues/ledger/create-monthly-obligation");

const prisma = getTestPrismaClient();
const pool = new Pool({ connectionString: resolveGuardedTestDatabaseUrl(), max: 6 });
type Fixture = Awaited<ReturnType<typeof makeAccountingOrg>>;

let fx: Fixture;
let plan: { id: string };
let n = 0;
const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
const today = currentCrDateParts();
const previous = today.month === 1 ? { year: today.year - 1, month: 12 } : { year: today.year, month: today.month - 1 };

const asOwner = () => (currentSession = { user: { id: fx.admin.id, role: "ADMIN" }, activeOrganizationId: fx.org.id });
const ctx = (): TenantContext => ({
  kind: "tenant", actorUserId: fx.admin.id, organizationId: fx.org.id, organizationRole: "ADMIN", academyIds: "ALL", selfStudentId: null, linkedStudentId: null,
});
const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};

async function newStudent(status: "ACTIVE" | "PENDING" = "ACTIVE", history = true) {
  n++;
  const student = await prisma.student.create({
    data: {
      organizationId: fx.org.id, homeAcademyId: fx.academy.id, firstName: "Gate", lastName: `S${n}`, phone: "00000000",
      email: `gate91-${n}-${suffix}@example.com`, currentRankId: await fx.rankId("WHITE"), codeHash: `gate91-${n}-${suffix}`, status,
    },
  });
  if (history) {
    await prisma.studentStatusChange.create({
      data: { organizationId: fx.org.id, studentId: student.id, status, effectiveOn: new Date(Date.UTC(2022, 0, 1)), sequence: 1, source: "EVENT", actorId: fx.admin.id },
    });
  }
  return student.id;
}

const openHolders = new Set<PoolClient>();

/** A connection holding the organization row lock in an open transaction — the PR 9-3 switch's shape (`FOR NO KEY UPDATE`). */
async function hold(mode: "FOR NO KEY UPDATE" | "FOR UPDATE" | "FOR SHARE" = "FOR NO KEY UPDATE") {
  const client: PoolClient = await pool.connect();
  openHolders.add(client);
  await client.query("BEGIN");
  await client.query(`SELECT "id" FROM "Organization" WHERE "id" = $1 ${mode}`, [fx.org.id]);
  const pid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
  const end = async (sql: "COMMIT" | "ROLLBACK") => {
    if (!openHolders.delete(client)) return;
    try {
      await client.query(sql);
    } finally {
      client.release();
    }
  };
  return {
    pid,
    client,
    /** Inside the held transaction: an approved activation made effective (what the switch commits). */
    activate: async () => {
      const id = `gate91-act-${++n}-${suffix}`;
      await client.query(
        `INSERT INTO "DuesActivation" ("id","organizationId","startYear","startMonth","fingerprintFormat","configFingerprint","studentFingerprints","approvedById","approvedAt")
         VALUES ($1, $2, 2026, 12, 'test', 'cfg', '{}'::jsonb, $3, now())`,
        [id, fx.org.id, fx.admin.id],
      );
      await client.query(`UPDATE "DuesActivation" SET "effectiveAt" = now(), "effectiveById" = $2 WHERE "id" = $1`, [id, fx.admin.id]);
    },
    commit: () => end("COMMIT"),
    rollback: () => end("ROLLBACK"),
  };
}

/**
 * Polls until some backend is blocked BY `holderPid` (pg_blocking_pids), so a "waits" claim is observed, not timed. Returns
 * the blocked statements, so a test can prove WHICH lock it waits on (the gate's own SELECT, not some later row lock).
 */
async function waitUntilBlockedBy(holderPid: number, timeoutMs = 5_000): Promise<string[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rows = await prisma.$queryRaw<{ query: string }[]>`SELECT query FROM pg_stat_activity WHERE ${holderPid}::int = ANY(pg_blocking_pids(pid))`;
    if (rows.length > 0) return rows.map((r) => r.query);
    if (Date.now() > deadline) throw new Error(`nothing became blocked by pid ${holderPid}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}
const GATE_SHARE_SQL = /FROM "Organization" WHERE "id" = \$1 FOR SHARE/;

/** Test cleanup only: activation rows are undeletable by design (trigger), bypassed the same way other suites clean ledger rows. */
async function clearActivation() {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SET LOCAL session_replication_role = replica");
    await tx.$executeRaw`DELETE FROM "DuesActivation" WHERE "organizationId" = ${fx.org.id}`;
  });
}

const paymentForm = (studentId: string, notes = "cash at the front desk") =>
  form({ studentId, year: String(today.year), month: String(today.month), planId: plan.id, status: "PAID", amount: "25000", method: "EFECTIVO", notes });

beforeAll(async () => {
  fx = await makeAccountingOrg("CUMULATIVE", "gate91");
  plan = await prisma.paymentPlan.create({ data: { organizationId: fx.org.id, academyId: fx.academy.id, name: "Mensualidad", defaultAmount: 25000 } });
  asOwner();
}, 60_000);

// Every test starts inactive with no lock held, whatever the previous one left behind.
afterEach(async () => {
  for (const client of [...openHolders]) {
    openHolders.delete(client);
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
  }
  await clearActivation();
});

afterAll(async () => {
  await clearActivation();
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SET LOCAL session_replication_role = replica");
    await tx.$executeRaw`DELETE FROM "DuesReadinessConfirmation" WHERE "organizationId" = ${fx.org.id}`;
    await tx.$executeRaw`DELETE FROM "DuesOpeningItem" WHERE "organizationId" = ${fx.org.id}`;
  });
  await prisma.studentPlanAssignment.deleteMany({ where: { organizationId: fx.org.id } });
  await prisma.duesPolicyVersion.deleteMany({ where: { organizationId: fx.org.id } });
  await prisma.paymentPeriod.deleteMany({ where: { organizationId: fx.org.id } });
  await prisma.paymentPlan.deleteMany({ where: { organizationId: fx.org.id } });
  await fx.drop();
  await pool.end();
});

describe("DuesActivation: the database keeps the record set-once", () => {
  const insert = (id: string, extra = "") =>
    prisma.$executeRawUnsafe(
      `INSERT INTO "DuesActivation" ("id","organizationId","startYear","startMonth","fingerprintFormat","configFingerprint","studentFingerprints","approvedById","approvedAt"${extra ? ',"effectiveAt","effectiveById"' : ""})
       VALUES ('${id}', '${fx.org.id}', 2026, 12, 'f', 'c', '{}'::jsonb, '${fx.admin.id}', now()${extra})`,
    );

  it("refuses a row born effective, then allows effective once; approval columns, a second marker, a second live row and delete all refuse", async () => {
    await expect(insert(`born-${suffix}`, `, now(), '${fx.admin.id}'`)).rejects.toThrow(/cannot be set on insert/);
    await insert(`a1-${suffix}`);
    await expect(insert(`a2-${suffix}`)).rejects.toThrow(/DuesActivation_one_live_per_organization/);
    await expect(prisma.$executeRawUnsafe(`UPDATE "DuesActivation" SET "startMonth" = 11 WHERE "id" = 'a1-${suffix}'`)).rejects.toThrow(/approval is immutable/);
    await expect(prisma.$executeRawUnsafe(`UPDATE "DuesActivation" SET "effectiveAt" = now() WHERE "id" = 'a1-${suffix}'`)).rejects.toThrow(/DuesActivation_effective_complete/);
    expect(await ledgerActivation.isActive(fx.org.id)).toBe(false); // approved only: not active
    await prisma.$executeRawUnsafe(`UPDATE "DuesActivation" SET "effectiveAt" = now(), "effectiveById" = '${fx.admin.id}' WHERE "id" = 'a1-${suffix}'`);
    expect(await ledgerActivation.isActive(fx.org.id)).toBe(true);
    await expect(prisma.$executeRawUnsafe(`UPDATE "DuesActivation" SET "effectiveAt" = now() - interval '1 day' WHERE "id" = 'a1-${suffix}'`)).rejects.toThrow(/already effective/);
    await expect(prisma.$executeRawUnsafe(`UPDATE "DuesActivation" SET "withdrawnAt" = now(), "withdrawnById" = '${fx.admin.id}' WHERE "id" = 'a1-${suffix}'`)).rejects.toThrow(/not_withdrawn_and_effective/);
    await expect(prisma.$executeRawUnsafe(`DELETE FROM "DuesActivation" WHERE "id" = 'a1-${suffix}'`)).rejects.toThrow();
    await clearActivation();
    expect(await ledgerActivation.isActive(fx.org.id)).toBe(false);
  });
});

describe("PostgreSQL lock modes on the gate (rule 1)", () => {
  it("two FOR SHARE holders never block each other; the switch's FOR NO KEY UPDATE waits for FOR SHARE, and FOR SHARE waits for it", async () => {
    const s1 = await hold("FOR SHARE");
    const s2 = await hold("FOR SHARE"); // acquired while s1 holds: would hang here otherwise
    const blockedBySharers = await prisma.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM pg_stat_activity WHERE ${s1.pid}::int = ANY(pg_blocking_pids(pid)) OR ${s2.pid}::int = ANY(pg_blocking_pids(pid))`;
    expect(blockedBySharers[0].n).toBe(0);
    const switcher = appPrisma.$transaction(async (tx) => {
      await gate.lockOrganizationGate(tx, fx.org.id, "update");
    });
    expect((await waitUntilBlockedBy(s1.pid)).some((q) => /FOR NO KEY UPDATE/.test(q))).toBe(true);
    await s1.rollback();
    await s2.rollback();
    await switcher;
    const u = await hold();
    const sharer = appPrisma.$transaction((tx) => gate.lockOrganizationGate(tx, fx.org.id));
    expect((await waitUntilBlockedBy(u.pid)).some((q) => GATE_SHARE_SQL.test(q))).toBe(true);
    await u.rollback();
    expect(await sharer).toEqual({ active: false, activeSince: null });
  });

  it("the switch's lock does not hold up an unrelated insert that only references the organization (foreign-key FOR KEY SHARE)", async () => {
    // An AuditLog row (AuditLog → Organization foreign key): a table no readiness, opening or activation read uses. Every
    // application write to a table those reads use takes the gate FOR SHARE first instead (rule 9), so it waits like any writer.
    // `async` so the query starts at once: a Prisma query is lazy and only runs when awaited or then'd.
    const auditInsert = async () =>
      prisma.auditLog.create({ data: { organizationId: fx.org.id, actorId: fx.admin.id, action: "gate91.fkProbe", entityType: "Test", entityId: suffix } });
    const h = await hold();
    await auditInsert(); // completes while the switch lock is held
    await h.rollback();
    // Contrast: plain FOR UPDATE would have blocked that same insert.
    const strict = await hold("FOR UPDATE");
    const blockedInsert = auditInsert();
    await waitUntilBlockedBy(strict.pid);
    await strict.rollback();
    await blockedInsert;
  });

  it("the switch waits for a writer already inside its transaction, then reads what that writer committed", async () => {
    const studentId = await newStudent();
    // A participant mid-transaction: it holds the gate FOR SHARE and has written a legacy payment row, not yet committed.
    const writer = await hold("FOR SHARE");
    await writer.client.query(
      `INSERT INTO "PaymentPeriod" ("id","studentId","academyId","organizationId","year","month","planId","status","amount","currency","recordedById")
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'PAID', 25000, 'CRC', $8)`,
      [`gate91-pp-${suffix}`, studentId, fx.academy.id, fx.org.id, today.year, today.month, plan.id, fx.admin.id],
    );
    // The switch's shape: exclusive gate first, then a separate READ COMMITTED read (here, what readiness check 5 reads).
    const switched = appPrisma.$transaction(async (tx) => {
      await gate.lockOrganizationGate(tx, fx.org.id, "update");
      return tx.paymentPeriod.count({ where: { organizationId: fx.org.id, studentId } });
    });
    expect((await waitUntilBlockedBy(writer.pid)).some((q) => /FOR NO KEY UPDATE/.test(q))).toBe(true);
    await writer.commit();
    expect(await switched).toBe(1); // the switch sees the row committed while it waited
  });

  it("a writer that waited on the gate sees the activation the switch committed during its wait", async () => {
    const h = await hold();
    await h.activate();
    const viaGate = appPrisma.$transaction((tx) => gate.lockOrganizationGate(tx, fx.org.id));
    await waitUntilBlockedBy(h.pid);
    await h.commit();
    const state = await viaGate;
    expect(state?.active).toBe(true);
    expect(state?.activeSince).toBeInstanceOf(Date);
  });
});

describe("legacy payment vs the switch (rule 6)", () => {
  it("waits on the gate; after the switch commits it refuses, writes nothing, and returns the submitted values", async () => {
    const studentId = await newStudent();
    const h = await hold();
    await h.activate();
    const pending = recordPayment(fx.org.id, {}, paymentForm(studentId, "paid in cash, receipt 1042"));
    await waitUntilBlockedBy(h.pid);
    await h.commit();
    const result = await pending;
    expect(result.error).toBe("ledgerActive");
    expect(result.submitted).toMatchObject({ studentId, planId: plan.id, status: "PAID", amount: "25000", method: "EFECTIVO", notes: "paid in cash, receipt 1042" });
    expect(Number.isNaN(Date.parse(result.messageValues?.switchedAt ?? ""))).toBe(false);
    expect(await prisma.paymentPeriod.count({ where: { studentId } })).toBe(0);
    expect(await prisma.auditLog.count({ where: { organizationId: fx.org.id, action: "payment.record", entityType: "PaymentPeriod" } })).toBe(0);
  });

  it("waits on the gate; when the switch rolls back (atomic failure) the payment proceeds and nothing stays blocked", async () => {
    const studentId = await newStudent();
    const h = await hold();
    await h.activate();
    const pending = recordPayment(fx.org.id, {}, paymentForm(studentId));
    await waitUntilBlockedBy(h.pid);
    await h.rollback();
    expect(await pending).toEqual({ ok: true });
    expect(await prisma.duesActivation.count({ where: { organizationId: fx.org.id } })).toBe(0);
    expect(await prisma.paymentPeriod.count({ where: { studentId } })).toBe(1);
    // The next payment is not blocked by anything left over.
    expect(await recordPayment(fx.org.id, {}, paymentForm(await newStudent()))).toEqual({ ok: true });
  });

  it("a gate wait past the timeout answers tryAgain with the submitted values, and writes nothing", async () => {
    const studentId = await newStudent();
    const h = await hold();
    const started = Date.now();
    const result = await recordPayment(fx.org.id, {}, paymentForm(studentId, "transfer 88"));
    const waited = Date.now() - started;
    await h.rollback();
    expect(result).toMatchObject({ error: "tryAgain" });
    expect(waited).toBeGreaterThanOrEqual(gate.LEGACY_PAYMENT_GATE_TIMEOUT_MS - 200);
    expect(result.submitted?.notes).toBe("transfer 88");
    expect(await prisma.paymentPeriod.count({ where: { studentId } })).toBe(0);
  }, 20_000);
});

describe("page-load writers (rule 7)", () => {
  async function recurringPromoStudent() {
    const promo = (await ensureCustomPromoPlan(fx.org.id, fx.academy.id))!;
    const studentId = await newStudent();
    await prisma.paymentPeriod.create({
      data: {
        organizationId: fx.org.id, academyId: fx.academy.id, studentId, year: previous.year, month: previous.month, planId: promo.id, status: "PAID",
        amount: 22500, currency: "CRC", promoName: "Family", promoRecurring: true, recordedById: fx.admin.id,
      },
    });
    return studentId;
  }

  it("carry-forward waits on the gate; after the switch commits it creates nothing and returns null", async () => {
    const studentId = await recurringPromoStudent();
    const h = await hold();
    await h.activate();
    const pending = getCurrentPaymentPeriod(studentId, fx.org.id, today);
    await waitUntilBlockedBy(h.pid);
    await h.commit();
    expect(await pending).toBeNull();
    expect(await prisma.paymentPeriod.count({ where: { studentId, year: today.year, month: today.month } })).toBe(0);
  });

  it("carry-forward after a rolled-back switch creates the row as before", async () => {
    const studentId = await recurringPromoStudent();
    const h = await hold();
    const pending = getCurrentPaymentPeriod(studentId, fx.org.id, today);
    await waitUntilBlockedBy(h.pid);
    await h.rollback();
    expect((await pending)?.status).toBe("PENDING");
  });

  it("carry-forward past its wait renders without the row (null), never an error", async () => {
    const studentId = await recurringPromoStudent();
    const h = await hold();
    const result = await getCurrentPaymentPeriod(studentId, fx.org.id, today);
    await h.rollback();
    expect(result).toBeNull();
    expect(await prisma.paymentPeriod.count({ where: { studentId, year: today.year, month: today.month } })).toBe(0);
  }, 15_000);

  it("ensureCustomPromoPlan creates nothing once the ledger is active, and nothing past its wait", async () => {
    const branch = await prisma.academy.create({ data: { organizationId: fx.org.id, name: `Gate branch ${suffix}`, slug: `gate91-b-${suffix}`, kioskTokenHash: `gate91-b-${suffix}` } });
    const h = await hold();
    expect(await ensureCustomPromoPlan(fx.org.id, branch.id)).toBeNull(); // timed out
    await h.activate();
    await h.commit();
    expect(await ensureCustomPromoPlan(fx.org.id, branch.id)).toBeNull(); // active
    expect(await prisma.paymentPlan.count({ where: { academyId: branch.id } })).toBe(0);
    await clearActivation();
    await prisma.academy.delete({ where: { id: branch.id } });
  }, 15_000);
});

describe("every writer class waits on the gate itself (rule 9), proved with pg_blocking_pids and the blocked statement", () => {
  const nextYear = String(today.year + 1);
  // Each case prepares its fixtures BEFORE the switch lock is taken, then returns the writer call.
  const cases: [string, () => Promise<() => Promise<unknown>>][] = [
    ["9a legacy payment", async () => {
      const studentId = await newStudent();
      return () => recordPayment(fx.org.id, {}, paymentForm(studentId));
    }],
    ["9b student approval", async () => {
      const id = await newStudent("PENDING");
      return () =>
        appPrisma.$transaction((tx) =>
          approveStudentInTx(tx, { context: ctx(), student: { id, organizationId: fx.org.id, homeAcademyId: fx.academy.id, timezone: "America/Costa_Rica", userId: null }, planId: null }),
        );
    }],
    ["9b status-history baseline", async () => {
      await newStudent("ACTIVE", false);
      return () => runStatusHistoryBaseline(fx.org.id, {}, new FormData());
    }],
    ["9e assignment", async () => {
      const studentId = await newStudent();
      return () => assignPlan(fx.org.id, {}, form({ studentId, planId: plan.id, effectiveYear: nextYear, effectiveMonth: "1" }));
    }],
    ["9f dues configuration", async () => {
      const month = String((++n % 12) + 1);
      return () => addPolicyVersion(fx.org.id, {}, form({ academyId: fx.academy.id, effectiveYear: nextYear, effectiveMonth: month, dueDay: "5", graceDay: "5", lateFeeAmount: "0", lateFeeCurrency: "CRC" }));
    }],
    ["9g legacy plan", async () => {
      const name = `Gate plan ${++n}`;
      return () => createPlan(fx.org.id, {}, form({ academyId: fx.academy.id, name }));
    }],
    ["9h branch", async () => {
      const name = `Gate location ${++n} ${suffix}`;
      return () => createLocationForOwner(ctx(), { name, address: null });
    }],
    ["9i organization currency", async () => {
      const current = (await prisma.organization.findUniqueOrThrow({ where: { id: fx.org.id } })).currency;
      return () => changeOrganizationCurrency(fx.org.id, {}, form({ currency: current === "USD" ? "CRC" : "USD" }));
    }],
    ["9j opening review", async () => {
      const studentId = await newStudent();
      const month = String((++n % 12) + 1);
      return () => createOpeningDraft(fx.org.id, {}, form({ studentId, coverageYear: "2005", coverageMonth: month, amount: "100.00", currency: "USD", note: "Unpaid before the switch" }));
    }],
    ["9k ledger writer", async () => {
      const studentId = await newStudent();
      return () => createMonthlyObligation({ context: ctx(), studentId, coverage: { year: today.year + 1, month: 1 }, planTermsId: "none", policyVersionId: "none" }, { activation: { isActive: async () => true } });
    }],
  ];

  for (const [name, prepare] of cases) {
    it(name, async () => {
      asOwner();
      const run = await prepare();
      const h = await hold();
      let settled = false;
      const pending = run().then((value) => {
        settled = true;
        return value;
      });
      const blocked = await waitUntilBlockedBy(h.pid);
      expect(blocked.some((q) => GATE_SHARE_SQL.test(q))).toBe(true); // waiting on the gate's own SELECT, not a later lock
      expect(settled).toBe(false);
      await h.rollback();
      await pending;
      expect(settled).toBe(true);
    }, 15_000);
  }

  // Branches created here are removed with the organization in the top-level afterAll (plans first, then fx.drop()).
});
