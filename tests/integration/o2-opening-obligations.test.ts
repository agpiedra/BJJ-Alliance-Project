import "dotenv/config";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getTestPrismaClient } from "../helpers/test-db";
import { makeAccountingOrg } from "../helpers/accounting-org";
import { resolveGuardedTestDatabaseUrl } from "../../scripts/lib/test-database-guard";
import type { TenantContext } from "../../src/lib/tenant/types";
import type { LedgerActivation } from "../../src/lib/dues/ledger/activation";

/**
 * Stage 9 PR 9-2 (docs/dues/STAGE-9-IMPLEMENTATION-PLAN.md; A2–A4 approved 2026-11-10) against the REAL isolated test database:
 * the OPENING shape (no due date, no fee, no terms, no coverage), O2 cancellation reusing O4's safeguards (database rules, writer
 * refusals, owner-only, required reason, refused while a payment is applied), paying opening debt oldest-first with no fee, and
 * a real cancellation-versus-payment race. OPENING rows are created directly here: the activation switch that creates them is
 * PR 9-3. Synthetic data in a private temporary organization.
 */
vi.setConfig({ testTimeout: 20_000, hookTimeout: 60_000 });

const { cancelOpeningObligation } = await import("../../src/lib/dues/ledger/cancel-opening-obligation");
const { recordDuesPayment } = await import("../../src/lib/dues/ledger/record-payment");
const { reversePayment } = await import("../../src/lib/dues/ledger/reverse-payment");

const prisma = getTestPrismaClient();
const pool = new Pool({ connectionString: resolveGuardedTestDatabaseUrl(), max: 4 });
type Fixture = Awaited<ReturnType<typeof makeAccountingOrg>>;
let fx: Fixture;
let n = 0;
const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;

const ACTIVE: LedgerActivation = { isActive: async () => true };
const NOW = () => new Date("2026-11-10T12:00:00-06:00"); // Costa Rica
const deps = { activation: ACTIVE, now: NOW };
const TODAY = { year: 2026, month: 11, day: 10 };
const owner = (): TenantContext => ({ kind: "tenant", actorUserId: fx.admin.id, organizationId: fx.org.id, organizationRole: "ADMIN", academyIds: "ALL", selfStudentId: null, linkedStudentId: null });

async function newStudent() {
  n++;
  const s = await prisma.student.create({
    data: {
      organizationId: fx.org.id, homeAcademyId: fx.academy.id, firstName: "Opening", lastName: `S${n}`, phone: "00000000",
      email: `o2-${n}-${suffix}@example.com`, currentRankId: await fx.rankId("WHITE"), codeHash: `o2-${n}-${suffix}`, status: "ACTIVE",
    },
  });
  return s.id;
}

/** What the PR 9-3 switch will write for one reviewed opening item. */
function opening(studentId: string, month: number, extra: Record<string, unknown> = {}) {
  return prisma.duesObligation.create({
    data: {
      organizationId: fx.org.id, studentId, academyId: fx.academy.id, type: "OPENING", origin: "STAFF", coverageYear: 2026,
      coverageMonth: month, monthsCovered: 1, amount: "25000.00", currency: "CRC", createdById: fx.admin.id, ...extra,
    },
  });
}

const pay = (studentId: string, obligationIds: string[], amount = "25000.00") =>
  recordDuesPayment({ context: owner(), studentId, receivedOn: TODAY, tender: { currency: "CRC", amount }, method: "EFECTIVO", obligationIds, maxBackdateDays: 30 }, deps);
const cancel = (obligationId: string, reason = "typed into the wrong student", context = owner()) =>
  cancelOpeningObligation({ context, obligationId, reasonCategory: "ENTERED_IN_ERROR", reason }, deps);

beforeAll(async () => {
  fx = await makeAccountingOrg("CUMULATIVE", "o2");
});

afterAll(async () => {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SET LOCAL session_replication_role = replica");
    for (const table of ["DuesSettlement", "DuesLateFee", "DuesCoverage", "DuesPayment", "DuesObligation"]) {
      await tx.$executeRawUnsafe(`DELETE FROM "${table}" WHERE "organizationId" = $1`, fx.org.id);
    }
  });
  await fx.drop();
  await pool.end();
});

describe("OPENING shape (database)", () => {
  it("accepts the reviewed shape: no due date, no grace date, no fee, no terms, no policy, STAFF with a creator", async () => {
    const row = await opening(await newStudent(), 9);
    expect(row).toMatchObject({ type: "OPENING", dueOn: null, graceDeadline: null, lateFeeAmount: null, planTermsId: null, policyVersionId: null });
  });

  it.each([
    ["a due date (A2: no due date)", { dueOn: new Date("2026-09-05") }],
    ["a late-fee amount (D7: never a fee)", { lateFeeAmount: "1000.00" }],
    ["a non-STAFF origin", { origin: "PREPAYMENT" }],
    ["no creator", { createdById: null }],
    ["more than one month", { monthsCovered: 2 }],
  ])("refuses %s", async (_label, extra) => {
    await expect(opening(await newStudent(), 9, extra)).rejects.toThrow(/DuesObligation_shape_by_type/);
  });

  it("refuses a second live opening obligation for the same student and month; allows one again after O2 cancellation", async () => {
    const studentId = await newStudent();
    const first = await opening(studentId, 8);
    await expect(opening(studentId, 8)).rejects.toThrow(/DuesObligation_student_month_opening_key/);
    expect(await cancel(first.id)).toMatchObject({ ok: true });
    await expect(opening(studentId, 8)).resolves.toMatchObject({ type: "OPENING" });
  });

  it("never has coverage, and can never carry a late fee", async () => {
    const studentId = await newStudent();
    const row = await opening(studentId, 7);
    await expect(
      prisma.duesCoverage.create({ data: { organizationId: fx.org.id, studentId, obligationId: row.id, year: 2026, month: 7 } }),
    ).rejects.toThrow(/never has coverage/);
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO "DuesLateFee" ("id","organizationId","obligationId","obligationType","assessableFrom") VALUES ($1, $2, $3, 'OPENING', '2026-09-10')`,
        `o2-fee-${suffix}`, fx.org.id, row.id,
      ),
    ).rejects.toThrow(/DuesLateFee_only_monthly/);
  });

  it("refuses a non-OPENING obligation without terms", async () => {
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO "DuesObligation" ("id","organizationId","studentId","academyId","type","origin","coverageYear","coverageMonth","monthsCovered","amount","currency","dueOn","createdById")
         VALUES ($1, $2, $3, $4, 'SIGNUP', 'STAFF', 2026, 9, 1, 100, 'CRC', '2026-09-01', $5)`,
        `o2-signup-${suffix}`, fx.org.id, await newStudent(), fx.academy.id, fx.admin.id,
      ),
    ).rejects.toThrow(/only an OPENING obligation has no terms version|DuesObligation_shape_by_type/);
  });
});

describe("O2 database rules (O4's safeguards, widened by type)", () => {
  const rawCancel = (id: string, set: string) => prisma.$executeRawUnsafe(`UPDATE "DuesObligation" SET ${set} WHERE "id" = $1`, id);

  it("refuses a cancellation while a payment is applied, and accepts it once that payment is reversed", async () => {
    const studentId = await newStudent();
    const row = await opening(studentId, 6);
    const paid = await pay(studentId, [row.id]);
    expect(paid).toMatchObject({ ok: true });
    await expect(rawCancel(row.id, `"cancelledAt" = now(), "cancelledById" = '${fx.admin.id}', "cancellationReason" = '[ENTERED_IN_ERROR] x'`)).rejects.toThrow(/active settlement cannot be cancelled/);
    if (!paid.ok) throw new Error("payment expected");
    expect(await reversePayment({ context: owner(), paymentId: paid.paymentId, reasonCategory: "RECORDED_IN_ERROR", reversalReason: "wrong student" }, deps)).toMatchObject({ ok: true, cancelledObligationIds: [] });
    await expect(rawCancel(row.id, `"cancelledAt" = now(), "cancelledById" = '${fx.admin.id}', "cancellationReason" = '[ENTERED_IN_ERROR] x'`)).resolves.toBe(1);
  });

  // The O2 marker on a MONTHLY (prepaid or staff) row is refused in o4-prepayment-reversal.test.ts, next to O4's own marker checks.
  it("refuses an O2 marker that names a payment or has a blank reason", async () => {
    const row = await opening(await newStudent(), 5);
    await expect(rawCancel(row.id, `"cancelledAt" = now(), "cancelledById" = '${fx.admin.id}', "cancellationReason" = '  '`)).rejects.toThrow(/cancellation_marker_complete/);
    await expect(rawCancel(row.id, `"cancelledAt" = now(), "cancelledById" = '${fx.admin.id}', "cancellationReason" = 'x', "cancelledByReversalOfPaymentId" = 'nope'`)).rejects.toThrow(/cancellation_marker_complete/);
  });

  it("a cancelled opening obligation can never be settled, and its marker never changes", async () => {
    const studentId = await newStudent();
    const row = await opening(studentId, 4);
    expect(await cancel(row.id)).toMatchObject({ ok: true });
    expect(await pay(studentId, [row.id])).toMatchObject({ ok: false, error: "notFound" }); // not debt any more
    await expect(rawCancel(row.id, `"cancellationReason" = '[DUPLICATE] changed'`)).rejects.toThrow(/already set/);
  });
});

describe("O2 writer", () => {
  it("cancels for the owner, storing [CATEGORY] text, with an audit row", async () => {
    const row = await opening(await newStudent(), 3);
    expect(await cancel(row.id, "  entered twice  ")).toEqual({ ok: true, obligationId: row.id });
    const stored = await prisma.duesObligation.findUniqueOrThrow({ where: { id: row.id } });
    expect(stored.cancellationReason).toBe("[ENTERED_IN_ERROR] entered twice");
    expect(stored.cancelledById).toBe(fx.admin.id);
    expect(stored.cancelledByReversalOfPaymentId).toBeNull();
    expect(await prisma.auditLog.count({ where: { organizationId: fx.org.id, action: "duesObligation.cancelOpening", entityId: row.id } })).toBe(1);
  });

  it("refuses: not the owner, a blank reason, an unknown category, already cancelled, not active, not an opening obligation", async () => {
    const row = await opening(await newStudent(), 2);
    const director: TenantContext = { ...owner(), organizationRole: "DIRECTOR", academyIds: [fx.academy.id] };
    expect(await cancel(row.id, "x", director)).toEqual({ ok: false, error: "notFound" });
    expect(await cancel(row.id, "   ")).toEqual({ ok: false, error: "invalid" });
    expect(await cancelOpeningObligation({ context: owner(), obligationId: row.id, reasonCategory: "NOT_RECEIVED" as never, reason: "x" }, deps)).toEqual({ ok: false, error: "invalid" });
    expect(await cancelOpeningObligation({ context: owner(), obligationId: row.id, reasonCategory: "DUPLICATE", reason: "x" }, { now: NOW })).toEqual({ ok: false, error: "notActive" });
    expect(await cancel(row.id)).toMatchObject({ ok: true });
    expect(await cancel(row.id)).toEqual({ ok: false, error: "alreadyCancelled" });
    expect(await cancel("no-such-obligation")).toEqual({ ok: false, error: "notFound" });
    expect(await prisma.auditLog.count({ where: { organizationId: fx.org.id, action: "duesObligation.cancelOpening", entityId: row.id } })).toBe(1);
  });

  it("refuses with hasActivePayment while a payment is applied (A3), and nothing changes", async () => {
    const studentId = await newStudent();
    const row = await opening(studentId, 1);
    expect(await pay(studentId, [row.id])).toMatchObject({ ok: true });
    expect(await cancel(row.id)).toEqual({ ok: false, error: "hasActivePayment" });
    expect((await prisma.duesObligation.findUniqueOrThrow({ where: { id: row.id } })).cancelledAt).toBeNull();
  });
});

describe("paying opening debt (no due date, no fee, oldest first)", () => {
  it("settles oldest first at exactly its amount, never assesses a fee, and a reversal makes it owed again (not cancelled)", async () => {
    const studentId = await newStudent();
    const older = await opening(studentId, 9, { coverageYear: 2025 });
    const newer = await opening(studentId, 10, { coverageYear: 2025 });
    expect(await pay(studentId, [newer.id])).toMatchObject({ ok: false, error: "notOldestFirst" });
    const paid = await pay(studentId, [older.id, newer.id], "50000.00");
    expect(paid).toMatchObject({ ok: true });
    expect(await prisma.duesLateFee.count({ where: { obligationId: { in: [older.id, newer.id] } } })).toBe(0);
    if (!paid.ok) throw new Error("payment expected");
    const reversed = await reversePayment({ context: owner(), paymentId: paid.paymentId, reasonCategory: "NOT_RECEIVED", reversalReason: "cheque bounced" }, deps);
    expect(reversed).toMatchObject({ ok: true, cancelledObligationIds: [] });
    expect(reversed.ok && [...reversed.owedAgainObligationIds].sort()).toEqual([older.id, newer.id].sort());
    expect((await prisma.duesObligation.findMany({ where: { id: { in: [older.id, newer.id] } } })).every((o) => o.cancelledAt === null)).toBe(true);
  });
});

describe("race: O2 cancellation vs a payment of the same opening obligation", () => {
  it("serialize on the student row; exactly one wins and the final state is consistent", async () => {
    const studentId = await newStudent();
    const row = await opening(studentId, 11, { coverageYear: 2025 });
    const holder = await pool.connect();
    await holder.query("BEGIN");
    await holder.query(`SELECT 1 FROM "Student" WHERE "id" = $1 FOR UPDATE`, [studentId]);
    const holderPid = (await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    const both = Promise.all([pay(studentId, [row.id]), cancel(row.id)]);
    try {
      // Both writers wait, directly or transitively: PostgreSQL queues the second row-lock waiter behind the first, so
      // pg_blocking_pids() of the second names the first waiter, not the holder. Count everything reachable from the holder.
      const deadline = Date.now() + 8_000;
      for (;;) {
        const waiting = await prisma.$queryRaw<{ pid: number; blockers: number[] }[]>`
          SELECT pid, pg_blocking_pids(pid) AS blockers FROM pg_stat_activity WHERE cardinality(pg_blocking_pids(pid)) > 0`;
        const reached = new Set<number>([holderPid]);
        for (let grew = true; grew; ) {
          grew = false;
          for (const w of waiting) {
            if (!reached.has(w.pid) && w.blockers.some((b) => reached.has(b))) {
              reached.add(w.pid);
              grew = true;
            }
          }
        }
        if (reached.size - 1 >= 2) break;
        if (Date.now() > deadline) throw new Error("both writers did not wait on the student row");
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
    }
    const [payment, cancellation] = await both;
    expect([payment.ok, cancellation.ok].filter(Boolean)).toHaveLength(1);
    const final = await prisma.duesObligation.findUniqueOrThrow({ where: { id: row.id }, include: { settlements: { where: { reversedAt: null } } } });
    if (cancellation.ok) {
      expect(final.cancelledAt).not.toBeNull();
      expect(final.settlements).toHaveLength(0);
    } else {
      expect(cancellation).toEqual({ ok: false, error: "hasActivePayment" });
      expect(final.cancelledAt).toBeNull();
      expect(final.settlements).toHaveLength(1);
    }
  });
});
