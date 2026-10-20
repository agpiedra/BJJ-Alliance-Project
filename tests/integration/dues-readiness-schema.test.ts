import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getTestPrismaClient } from "../helpers/test-db";
import { makeAccountingOrg } from "../helpers/accounting-org";
import { prisma as guardedPrisma } from "../../src/lib/prisma";
import { UnscopedTenantQueryError } from "../../src/lib/tenant/tenant-guard";

/**
 * Stage 8b (docs/dues/STAGE-8B-IMPLEMENTATION-PLAN.md): the opening-debt DRAFT and readiness CONFIRMATION schema, proved against
 * the REAL isolated test database with private temporary organizations. Amounts, notes and hashes are synthetic.
 *
 * There is no writer yet (stage 8c). The draft-edit and confirmation protocols the 8c writers must follow are therefore exercised
 * here DIRECTLY in database transactions (raw SQL locks, plain inserts/updates), so what is proved is what the database and the
 * documented protocol guarantee — not any application code.
 *
 * Transaction isolation: every protocol transaction here runs at PostgreSQL's default READ COMMITTED (asserted below). Under it,
 * each statement takes a fresh snapshot, so a `MAX(sequence)` read issued AFTER the student lock is granted sees every
 * confirmation committed before the grant. Under REPEATABLE READ the snapshot can predate the grant; the last ordering test shows
 * the protocol then fails loudly instead of mis-ordering.
 *
 * ISOLATION of the tests themselves: most run in a transaction that is always rolled back; refusals are wrapped in a SAVEPOINT.
 * Tests that must COMMIT (deferred-FK commit failure, concurrency) leave rows that only a test-only `session_replication_role =
 * replica` transaction in afterAll can remove (the tables reject DELETE). The migration's triggers are never weakened.
 */
const prisma = getTestPrismaClient();
type Db = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];
type Fixture = Awaited<ReturnType<typeof makeAccountingOrg>>;

const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
const HEX = (c: string) => c.repeat(64);

let a: Fixture;
let b: Fixture;
let ana: { id: string };
let bruno: { id: string };
let studentB: { id: string };
let periodAnaNov: { id: string }; // A, ana, 2030-11
let periodBrunoNov: { id: string }; // A, bruno, 2030-11
let periodB: { id: string }; // B, studentB, 2030-11

/** A different month for every call, so committed rows never collide with each other. */
let monthCounter = 0;
function nextMonth(): { coverageYear: number; coverageMonth: number } {
  const i = monthCounter++;
  return { coverageYear: 2020 + Math.floor(i / 12), coverageMonth: (i % 12) + 1 };
}

class Rollback extends Error {}
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

type DriverCause = { originalCode?: string; originalMessage?: string; message?: string; constraint?: unknown };
/** The database's own message for a refusal (constraint, index or trigger text), never Prisma's source excerpt. A statement's
 * refusal arrives as a Prisma error (`meta.driverAdapterError.cause`); a refusal at COMMIT (the deferred FK) arrives as the
 * driver adapter's own error, whose `cause` carries the same fields. */
function dbMessage(error: unknown): string {
  const e = error as { meta?: { driverAdapterError?: { cause?: DriverCause } }; cause?: DriverCause } | undefined;
  const cause = e?.meta?.driverAdapterError?.cause ?? e?.cause;
  return [cause?.originalCode, cause?.originalMessage, cause?.message, cause?.constraint ? JSON.stringify(cause.constraint) : undefined].filter(Boolean).join(" | ");
}

async function refused(tx: Db, op: () => Promise<unknown>, hint: string, label = "") {
  await tx.$executeRawUnsafe("SAVEPOINT refusal_probe");
  let error: unknown;
  try {
    await op();
  } catch (e) {
    error = e;
  }
  await tx.$executeRawUnsafe("ROLLBACK TO SAVEPOINT refusal_probe");
  expect(error, `the database must refuse this write (expected: ${hint}): ${label || op.toString().slice(0, 200)}`).toBeDefined();
  expect(dbMessage(error), `the refusal must come from the expected database object (${hint})`).toContain(hint);
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Polls until `waiterPid` is genuinely blocked by `holderPid` (a real lock wait, not a scheduling accident). */
async function waitUntilBlocked(waiterPid: number, holderPid: number, timeoutMs = 10_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const [row] = await prisma.$queryRaw<{ blocked: boolean }[]>`SELECT ${holderPid}::int = ANY(pg_blocking_pids(${waiterPid}::int)) AS blocked`;
    if (row.blocked) return;
    await sleep(25);
  }
  throw new Error(`pid ${waiterPid} was never blocked by ${holderPid}`);
}
const backendPid = async (tx: Db) => (await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`)[0].pid;

async function newStudent(fx: Fixture, label: string) {
  return prisma.student.create({
    data: {
      organizationId: fx.org.id, homeAcademyId: fx.academy.id, firstName: "Opening", lastName: label, phone: "00000000",
      email: `opening-${label}-${suffix}@example.com`, currentRankId: await fx.rankId("WHITE"), codeHash: `opening-${label}-${suffix}`, status: "ACTIVE",
    },
  });
}

async function newPeriod(fx: Fixture, studentId: string, year: number, month: number) {
  const plan = await prisma.paymentPlan.create({ data: { organizationId: fx.org.id, academyId: fx.academy.id, name: `Opening plan ${randomUUID()}` } });
  return prisma.paymentPeriod.create({
    data: { organizationId: fx.org.id, studentId, academyId: fx.academy.id, year, month, planId: plan.id, status: "PENDING", amount: "50.00", currency: "USD", recordedById: fx.admin.id },
  });
}

type DraftInput = {
  id?: string;
  organizationId?: string;
  studentId?: string;
  coverageYear?: number;
  coverageMonth?: number;
  amount?: string;
  currency?: "USD" | "CRC";
  note?: string;
  legacyPaymentPeriodId?: string | null;
};
function draftData(over: DraftInput = {}) {
  return {
    organizationId: a.org.id, studentId: ana.id, ...nextMonth(), amount: "100.00", currency: "USD" as const, note: "Unpaid before the switch",
    createdById: a.admin.id, ...over,
  };
}
const createDraft = (db: Db | typeof prisma, over: DraftInput = {}) => db.duesOpeningItem.create({ data: draftData(over) });

const editedMarker = (successorId: string) => ({ withdrawnAt: new Date(), withdrawnById: a.admin.id, withdrawalKind: "EDITED" as const, supersededById: successorId });
const withdrawnMarker = (reason = "Entered by mistake") => ({ withdrawnAt: new Date(), withdrawnById: a.admin.id, withdrawalKind: "WITHDRAWN" as const, withdrawalReason: reason });

/** The ledger's lock order, as the 8c writers will take it: branch FOR SHARE, then student FOR UPDATE. */
async function lockStudentRow(tx: Db, organizationId: string, studentId: string) {
  await tx.$queryRaw`SELECT 1 FROM "Academy" a JOIN "Student" s ON s."homeAcademyId" = a."id" WHERE s."id" = ${studentId} AND a."organizationId" = ${organizationId} FOR SHARE OF a`;
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "Student" WHERE "id" = ${studentId} AND "organizationId" = ${organizationId} FOR UPDATE`;
  if (rows.length !== 1) throw new Error("student not in organization");
}

/** The documented edit protocol (plan §3): lock, re-read as active, pre-generate the successor id, marker FIRST, then insert. */
async function editDraft(tx: Db, oldId: string, next: DraftInput) {
  const old = await tx.duesOpeningItem.findFirstOrThrow({ where: { id: oldId, organizationId: a.org.id } });
  await lockStudentRow(tx, old.organizationId, old.studentId);
  const current = await tx.duesOpeningItem.findFirstOrThrow({ where: { id: oldId, organizationId: a.org.id } });
  if (current.withdrawnAt !== null) throw new Error("changed since you opened it");
  const successorId = randomUUID();
  await tx.duesOpeningItem.update({ where: { id: oldId }, data: editedMarker(successorId) });
  return tx.duesOpeningItem.create({
    data: draftData({
      id: successorId, studentId: old.studentId, coverageYear: old.coverageYear, coverageMonth: old.coverageMonth,
      amount: old.amount.toFixed(2), currency: old.currency, note: old.note, legacyPaymentPeriodId: old.legacyPaymentPeriodId, ...next,
    }),
  });
}

type Identity = { organizationId: string; studentId: string; candidateYear: number; candidateMonth: number; kind: "OPENING_REVIEWED" | "PRICING_ACKNOWLEDGED" };
const confirmationShape = (kind: Identity["kind"]) =>
  kind === "OPENING_REVIEWED" ? { declaredNoOpeningDebt: true, branchFingerprint: null } : { declaredNoOpeningDebt: null, branchFingerprint: HEX("b") };

/** The documented confirmation protocol (plan §4): student lock, THEN MAX(sequence)+1 for the identity, then insert. */
async function confirmUnderLock(tx: Db, id: Identity, over: { confirmedAt?: Date } = {}) {
  await lockStudentRow(tx, id.organizationId, id.studentId);
  const [{ next }] = await tx.$queryRaw<{ next: number }[]>`
    SELECT COALESCE(MAX("sequence"), 0) + 1 AS next FROM "DuesReadinessConfirmation"
    WHERE "organizationId" = ${id.organizationId} AND "studentId" = ${id.studentId} AND "candidateYear" = ${id.candidateYear}
      AND "candidateMonth" = ${id.candidateMonth} AND "kind" = ${id.kind}::"DuesReadinessConfirmationKind"`;
  return tx.duesReadinessConfirmation.create({
    data: { ...id, sequence: next, fingerprintFormat: "r2", binding: HEX("a"), studentFingerprint: HEX("c"), confirmedById: a.admin.id, ...confirmationShape(id.kind), ...over },
  });
}
const current = (db: Db | typeof prisma, id: Identity) =>
  db.duesReadinessConfirmation.findFirstOrThrow({ where: id, orderBy: { sequence: "desc" } });

let candidateCounter = 0;
const newIdentity = (kind: Identity["kind"] = "OPENING_REVIEWED", studentId = ana.id): Identity => {
  const i = candidateCounter++;
  return { organizationId: a.org.id, studentId, candidateYear: 2040 + Math.floor(i / 12), candidateMonth: (i % 12) + 1, kind };
};

async function ledgerCounts(organizationId: string) {
  return {
    obligations: await prisma.duesObligation.count({ where: { organizationId } }),
    coverage: await prisma.duesCoverage.count({ where: { organizationId } }),
    lateFees: await prisma.duesLateFee.count({ where: { organizationId } }),
    payments: await prisma.duesPayment.count({ where: { organizationId } }),
    settlements: await prisma.duesSettlement.count({ where: { organizationId } }),
    paymentPeriods: await prisma.paymentPeriod.count({ where: { organizationId } }),
  };
}

beforeAll(async () => {
  a = await makeAccountingOrg("CUMULATIVE", "opening-a");
  b = await makeAccountingOrg("CUMULATIVE", "opening-b");
  ana = await newStudent(a, "ana");
  bruno = await newStudent(a, "bruno");
  studentB = await newStudent(b, "b");
  periodAnaNov = await newPeriod(a, ana.id, 2030, 11);
  periodBrunoNov = await newPeriod(a, bruno.id, 2030, 11);
  periodB = await newPeriod(b, studentB.id, 2030, 11);
}, 60_000);

afterAll(async () => {
  const orgIds = [a?.org.id, b?.org.id].filter(Boolean) as string[];
  if (orgIds.length > 0) {
    // Test-only: committed rows can only be removed with the tables' own no-delete triggers switched off, for this transaction
    // alone. The migration's triggers are untouched.
    await prisma.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe("SET LOCAL session_replication_role = replica");
        for (const table of ["DuesReadinessConfirmation", "DuesOpeningItem"]) {
          await tx.$executeRawUnsafe(`DELETE FROM "${table}" WHERE "organizationId" = ANY($1::text[])`, orgIds);
        }
      },
      { timeout: 60_000 },
    );
  }
  for (const fx of [a, b]) {
    if (!fx) continue;
    await prisma.paymentPeriod.deleteMany({ where: { organizationId: fx.org.id } });
    await prisma.paymentPlan.deleteMany({ where: { organizationId: fx.org.id } });
    await fx.drop();
  }
}, 120_000);

describe("the database objects exist as designed (the drift check cannot see these two)", () => {
  // `pnpm db:check-drift` reports clean even with the successor FK made NOT DEFERRABLE or the partial index dropped (recorded in
  // design/matroom/verification/dues-stage8b-schema/README.md), so the catalog is asserted directly.
  it("the successor FK is DEFERRABLE INITIALLY DEFERRED and the one-active index is unique and partial", async () => {
    const [fk] = await prisma.$queryRaw<{ condeferrable: boolean; condeferred: boolean; def: string }[]>`
      SELECT condeferrable, condeferred, pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conname = 'DuesOpeningItem_organizationId_studentId_supersededById_fkey'`;
    expect(fk).toMatchObject({ condeferrable: true, condeferred: true });
    expect(fk.def).toContain('REFERENCES "DuesOpeningItem"("organizationId", "studentId", id)');
    const [idx] = await prisma.$queryRaw<{ indexdef: string }[]>`SELECT indexdef FROM pg_indexes WHERE indexname = 'DuesOpeningItem_one_active_per_month_key'`;
    expect(idx.indexdef).toMatch(/^CREATE UNIQUE INDEX .* \("organizationId", "studentId", "coverageYear", "coverageMonth"\) WHERE \("withdrawnAt" IS NULL\)$/);
  });

  it("every other FK on the two tables is immediate, and the four protection triggers are installed", async () => {
    const fks = await prisma.$queryRaw<{ conname: string; condeferrable: boolean }[]>`
      SELECT conname, condeferrable FROM pg_constraint WHERE contype = 'f' AND conrelid IN ('"DuesOpeningItem"'::regclass, '"DuesReadinessConfirmation"'::regclass)`;
    expect(fks.filter((f) => f.condeferrable).map((f) => f.conname)).toEqual(["DuesOpeningItem_organizationId_studentId_supersededById_fkey"]);
    const triggers = await prisma.$queryRaw<{ tgname: string }[]>`
      SELECT tgname FROM pg_trigger WHERE NOT tgisinternal AND tgrelid IN ('"DuesOpeningItem"'::regclass, '"DuesReadinessConfirmation"'::regclass) ORDER BY tgname`;
    expect(triggers.map((t) => t.tgname)).toEqual([
      "DuesOpeningItem_marker_once", "DuesOpeningItem_no_delete", "DuesReadinessConfirmation_no_delete", "DuesReadinessConfirmation_no_update",
    ]);
  });
});

describe("tenant, student and month reference integrity", () => {
  it("a draft or confirmation cannot name another organization's student", async () => {
    await isolated(async (tx) => {
      await refused(tx, () => createDraft(tx, { studentId: studentB.id }), "DuesOpeningItem_organizationId_studentId_fkey");
      await refused(
        tx,
        () => tx.duesReadinessConfirmation.create({
          data: { ...newIdentity(), studentId: studentB.id, sequence: 1, fingerprintFormat: "r2", binding: HEX("a"), studentFingerprint: HEX("c"), declaredNoOpeningDebt: true, confirmedById: a.admin.id },
        }),
        "DuesReadinessConfirmation_organizationId_studentId_fkey",
      );
    });
  });

  it("the legacy link must be the same organization's, the same student's AND the same month's PaymentPeriod", async () => {
    const fk = "DuesOpeningItem_organizationId_studentId_coverageYear_cove_fkey";
    await isolated(async (tx) => {
      await refused(tx, () => createDraft(tx, { coverageYear: 2030, coverageMonth: 10, legacyPaymentPeriodId: periodAnaNov.id }), fk, "another month");
      await refused(tx, () => createDraft(tx, { coverageYear: 2030, coverageMonth: 11, legacyPaymentPeriodId: periodBrunoNov.id }), fk, "another student");
      await refused(tx, () => createDraft(tx, { coverageYear: 2030, coverageMonth: 11, legacyPaymentPeriodId: periodB.id }), fk, "another organization");
      await createDraft(tx, { coverageYear: 2030, coverageMonth: 11, legacyPaymentPeriodId: periodAnaNov.id }); // accepted
      await createDraft(tx, { coverageYear: 2030, coverageMonth: 10, legacyPaymentPeriodId: null }); // no link: unchecked (MATCH SIMPLE)
    });
  });

  it("a successor must be the same organization's and the same student's draft; the month may change", async () => {
    const fk = "DuesOpeningItem_organizationId_studentId_supersededById_fkey";
    await isolated(async (tx) => {
      const old = await createDraft(tx);
      const brunos = await createDraft(tx, { studentId: bruno.id });
      const otherOrg = await createDraft(tx, { organizationId: b.org.id, studentId: studentB.id });
      for (const [label, successor] of [["another student", brunos.id], ["another organization", otherOrg.id]] as const) {
        await tx.$executeRawUnsafe("SAVEPOINT successor_probe");
        await tx.duesOpeningItem.update({ where: { id: old.id }, data: editedMarker(successor) }); // deferred: accepted for now
        await refused(tx, () => tx.$executeRawUnsafe("SET CONSTRAINTS ALL IMMEDIATE"), fk, label);
        await tx.$executeRawUnsafe("ROLLBACK TO SAVEPOINT successor_probe");
      }
      const sameStudentOtherMonth = await createDraft(tx);
      await tx.duesOpeningItem.update({ where: { id: old.id }, data: editedMarker(sameStudentOtherMonth.id) });
      await tx.$executeRawUnsafe("SET CONSTRAINTS ALL IMMEDIATE"); // passes
    });
  });

  it("rollback when the successor is missing: an edit that never inserts its successor fails at COMMIT and leaves nothing", async () => {
    const old = await createDraft(prisma);
    const neverInserted = randomUUID();
    let error: unknown;
    try {
      await prisma.$transaction(async (tx) => {
        await lockStudentRow(tx, a.org.id, ana.id);
        // The statement itself is accepted (the FK is deferred) ...
        await tx.duesOpeningItem.update({ where: { id: old.id }, data: editedMarker(neverInserted) });
        // ... and the successor insert is simply never made.
      });
    } catch (e) {
      error = e;
    }
    expect(error, "COMMIT must fail on the deferred successor FK").toBeDefined();
    expect(dbMessage(error)).toContain("23503"); // foreign_key_violation, raised at COMMIT
    expect(dbMessage(error)).toContain("DuesOpeningItem_organizationId_studentId_supersededById_fkey");
    const after = await prisma.duesOpeningItem.findUniqueOrThrow({ where: { id: old.id } });
    expect(after).toMatchObject({ withdrawnAt: null, withdrawalKind: null, supersededById: null });
    expect(await prisma.duesOpeningItem.count({ where: { id: neverInserted } })).toBe(0);
  });
});

describe("invalid values are refused", () => {
  it("drafts: amount, month, year, note", async () => {
    await isolated(async (tx) => {
      await refused(tx, () => createDraft(tx, { amount: "0.00" }), "DuesOpeningItem_amount_positive");
      await refused(tx, () => createDraft(tx, { amount: "-1.00" }), "DuesOpeningItem_amount_positive");
      await refused(tx, () => createDraft(tx, { coverageMonth: 0 }), "DuesOpeningItem_month_valid");
      await refused(tx, () => createDraft(tx, { coverageMonth: 13 }), "DuesOpeningItem_month_valid");
      await refused(tx, () => createDraft(tx, { coverageYear: 1999 }), "DuesOpeningItem_year_sane");
      await refused(tx, () => createDraft(tx, { coverageYear: 2101 }), "DuesOpeningItem_year_sane");
      await refused(tx, () => createDraft(tx, { note: "   " }), "DuesOpeningItem_note_present");
      await refused(tx, () => createDraft(tx, { note: "x".repeat(501) }), "DuesOpeningItem_note_present");
      await createDraft(tx, { note: "x".repeat(500) }); // the boundary is accepted
    });
  });

  it("drafts: the withdrawal marker must be complete and consistent", async () => {
    const marker = "DuesOpeningItem_withdrawal_marker_complete";
    await isolated(async (tx) => {
      const probe = async (data: Record<string, unknown>, hint: string, label: string) => {
        const d = await createDraft(tx);
        await refused(tx, () => tx.duesOpeningItem.update({ where: { id: d.id }, data }), hint, label);
      };
      await probe({ withdrawnAt: new Date() }, marker, "incomplete marker");
      await probe({ withdrawnAt: new Date(), withdrawnById: a.admin.id, withdrawalKind: "EDITED" }, marker, "EDITED without successor");
      await probe({ withdrawnAt: new Date(), withdrawnById: a.admin.id, withdrawalKind: "WITHDRAWN" }, marker, "WITHDRAWN without reason");
      await probe({ ...withdrawnMarker(), supersededById: randomUUID() }, marker, "WITHDRAWN with a successor");
      await probe(withdrawnMarker("   "), "DuesOpeningItem_withdrawal_reason_length", "blank reason");
      await probe(withdrawnMarker("x".repeat(501)), "DuesOpeningItem_withdrawal_reason_length", "501-character reason");
      const self = await createDraft(tx);
      await refused(tx, () => tx.duesOpeningItem.update({ where: { id: self.id }, data: editedMarker(self.id) }), "DuesOpeningItem_not_self_superseding");
    });
  });

  it("confirmations: sequence, month, year, hashes, format and shape by kind", async () => {
    await isolated(async (tx) => {
      const base = () => ({ ...newIdentity(), sequence: 1, fingerprintFormat: "r2", binding: HEX("a"), studentFingerprint: HEX("c"), declaredNoOpeningDebt: true as boolean | null, confirmedById: a.admin.id });
      const create = (over: Record<string, unknown>) => () => tx.duesReadinessConfirmation.create({ data: { ...base(), ...over } as ReturnType<typeof base> });
      await refused(tx, create({ sequence: 0 }), "DuesReadinessConfirmation_sequence_positive");
      await refused(tx, create({ sequence: -1 }), "DuesReadinessConfirmation_sequence_positive");
      await refused(tx, create({ candidateMonth: 13 }), "DuesReadinessConfirmation_month_valid");
      await refused(tx, create({ candidateYear: 1999 }), "DuesReadinessConfirmation_year_sane");
      await refused(tx, create({ binding: HEX("A") }), "DuesReadinessConfirmation_hashes_hex", "uppercase hex");
      await refused(tx, create({ binding: "ab".repeat(31) }), "DuesReadinessConfirmation_hashes_hex", "short hash");
      await refused(tx, create({ studentFingerprint: HEX("g") }), "DuesReadinessConfirmation_hashes_hex", "non-hex");
      await refused(tx, create({ fingerprintFormat: "" }), "DuesReadinessConfirmation_format_present");
      await refused(tx, create({ fingerprintFormat: "x".repeat(17) }), "DuesReadinessConfirmation_format_present");
      await refused(tx, create({ declaredNoOpeningDebt: null }), "DuesReadinessConfirmation_shape_by_kind", "OPENING without declaration");
      await refused(tx, create({ branchFingerprint: HEX("b") }), "DuesReadinessConfirmation_shape_by_kind", "OPENING with a branch hash");
      await refused(tx, create({ kind: "PRICING_ACKNOWLEDGED", declaredNoOpeningDebt: null }), "DuesReadinessConfirmation_shape_by_kind", "PRICING without branch hash");
      await refused(tx, create({ kind: "PRICING_ACKNOWLEDGED", branchFingerprint: HEX("b") }), "DuesReadinessConfirmation_shape_by_kind", "PRICING with a declaration");
      await refused(tx, create({ kind: "PRICING_ACKNOWLEDGED", branchFingerprint: "nothex", declaredNoOpeningDebt: null }), "DuesReadinessConfirmation_hashes_hex", "PRICING bad branch hash");
      await create({ kind: "PRICING_ACKNOWLEDGED", branchFingerprint: HEX("b"), declaredNoOpeningDebt: null })(); // accepted
      await create({ declaredNoOpeningDebt: false })(); // "I reviewed and there IS opening debt" is a valid statement
    });
  });
});

describe("one active draft per month, and the edit order", () => {
  it("two active drafts for one student and month are refused; an active one plus a withdrawn one is allowed", async () => {
    await isolated(async (tx) => {
      const month = nextMonth();
      const first = await createDraft(tx, month);
      await refused(tx, () => createDraft(tx, month), "DuesOpeningItem_one_active_per_month_key");
      await tx.duesOpeningItem.update({ where: { id: first.id }, data: withdrawnMarker() });
      await createDraft(tx, month); // accepted: the withdrawn one no longer counts
      await createDraft(tx, { ...month, studentId: bruno.id }); // another student, same month: accepted
    });
  });

  it("same-month replacement in the specified order (marker first, then insert, one transaction) leaves exactly one active draft", async () => {
    await isolated(async (tx) => {
      const old = await createDraft(tx, { amount: "100.00" });
      const successor = await editDraft(tx, old.id, { amount: "80.00" });
      await tx.$executeRawUnsafe("SET CONSTRAINTS ALL IMMEDIATE"); // the deferred FK holds
      const rows = await tx.duesOpeningItem.findMany({ where: { organizationId: a.org.id, studentId: ana.id, coverageYear: old.coverageYear, coverageMonth: old.coverageMonth } });
      expect(rows.filter((r) => r.withdrawnAt === null).map((r) => r.id)).toEqual([successor.id]);
      const oldRow = rows.find((r) => r.id === old.id)!;
      expect(oldRow).toMatchObject({ withdrawalKind: "EDITED", supersededById: successor.id });
      expect(oldRow.amount.toFixed(2)).toBe("100.00"); // the old content is untouched history
    });
  });

  it("the REVERSE order (insert the successor first) is refused by the immediate partial unique index", async () => {
    await isolated(async (tx) => {
      const old = await createDraft(tx);
      await refused(tx, () => createDraft(tx, { coverageYear: old.coverageYear, coverageMonth: old.coverageMonth, amount: "80.00" }), "DuesOpeningItem_one_active_per_month_key");
    });
  });

  it("changed-month replacement leaves one active draft, in the new month", async () => {
    await isolated(async (tx) => {
      const old = await createDraft(tx);
      const target = nextMonth();
      const successor = await editDraft(tx, old.id, target);
      await tx.$executeRawUnsafe("SET CONSTRAINTS ALL IMMEDIATE");
      const active = await tx.duesOpeningItem.findMany({ where: { organizationId: a.org.id, withdrawnAt: null, id: { in: [old.id, successor.id] } } });
      expect(active.map((r) => [r.id, r.coverageYear, r.coverageMonth])).toEqual([[successor.id, target.coverageYear, target.coverageMonth]]);
    });
  });

  it("a successor can be named by only one draft (supersededById is unique)", async () => {
    await isolated(async (tx) => {
      const one = await createDraft(tx);
      const two = await createDraft(tx);
      const successor = await createDraft(tx);
      await tx.duesOpeningItem.update({ where: { id: one.id }, data: editedMarker(successor.id) });
      await refused(tx, () => tx.duesOpeningItem.update({ where: { id: two.id }, data: editedMarker(successor.id) }), "supersededById");
    });
  });
});

describe("immutability", () => {
  it("draft content never changes; the marker is set once; nothing is deleted", async () => {
    await isolated(async (tx) => {
      const d = await createDraft(tx);
      await refused(tx, () => tx.duesOpeningItem.update({ where: { id: d.id }, data: { amount: "1.00" } }), "only the withdrawal marker may be set, once");
      await refused(tx, () => tx.duesOpeningItem.update({ where: { id: d.id }, data: { note: "rewritten" } }), "only the withdrawal marker may be set, once");
      await refused(tx, () => tx.duesOpeningItem.update({ where: { id: d.id }, data: { ...withdrawnMarker(), amount: "1.00" } }), "no other column may change", "marker plus content");
      await tx.duesOpeningItem.update({ where: { id: d.id }, data: withdrawnMarker("first") });
      await refused(tx, () => tx.duesOpeningItem.update({ where: { id: d.id }, data: { withdrawalReason: "second" } }), "it is already set");
      await refused(tx, () => tx.duesOpeningItem.delete({ where: { id: d.id } }), "rows are never deleted");
    });
  });

  it("a confirmation is never updated or deleted", async () => {
    await isolated(async (tx) => {
      const c = await confirmUnderLock(tx, newIdentity());
      await refused(tx, () => tx.duesReadinessConfirmation.update({ where: { id: c.id }, data: { binding: HEX("d") } }), "confirmation rows are never updated");
      await refused(tx, () => tx.duesReadinessConfirmation.update({ where: { id: c.id }, data: { sequence: 9 } }), "confirmation rows are never updated");
      await refused(tx, () => tx.duesReadinessConfirmation.delete({ where: { id: c.id } }), "rows are never deleted");
    });
  });
});

describe("concurrent replacement protection", () => {
  it("two edits of one draft at once: the second, waiting at the student lock, re-reads it as no longer active and stops", async () => {
    const old = await createDraft(prisma);
    const locked = deferred<number>();
    const release = deferred();
    const first = prisma.$transaction(
      async (tx) => {
        const pid = await backendPid(tx);
        const successor = await editDraft(tx, old.id, { amount: "80.00" });
        locked.resolve(pid);
        await release.promise;
        return successor;
      },
      { timeout: 60_000 },
    );
    const holderPid = await locked.promise;
    const secondPid = deferred<number>();
    const second = prisma
      .$transaction(
        async (tx) => {
          secondPid.resolve(await backendPid(tx));
          return editDraft(tx, old.id, { amount: "70.00" });
        },
        { timeout: 60_000 },
      )
      .then(() => null, (e: unknown) => e);
    try {
      await waitUntilBlocked(await secondPid.promise, holderPid);
    } finally {
      release.resolve(); // released even if the wait assertion fails, so no transaction is left holding a lock
    }
    const successor = await first;
    expect(String(await second)).toContain("changed since you opened it");
    const active = await prisma.duesOpeningItem.findMany({ where: { organizationId: a.org.id, coverageYear: old.coverageYear, coverageMonth: old.coverageMonth, withdrawnAt: null } });
    expect(active.map((r) => [r.id, r.amount.toFixed(2)])).toEqual([[successor.id, "80.00"]]);
  }, 60_000);

  it("database backstop: a second writer that SKIPS the lock and re-read waits on the row and is refused by the marker trigger", async () => {
    const old = await createDraft(prisma);
    const marked = deferred<number>();
    const release = deferred();
    const first = prisma.$transaction(
      async (tx) => {
        const pid = await backendPid(tx);
        const successorId = randomUUID();
        await tx.duesOpeningItem.update({ where: { id: old.id }, data: editedMarker(successorId) });
        await createDraft(tx, { id: successorId, coverageYear: old.coverageYear, coverageMonth: old.coverageMonth, amount: "80.00" });
        marked.resolve(pid);
        await release.promise;
      },
      { timeout: 60_000 },
    );
    const holderPid = await marked.promise;
    const rogueSuccessor = randomUUID();
    const roguePid = deferred<number>();
    const rogue = prisma
      .$transaction(
        async (tx) => {
          roguePid.resolve(await backendPid(tx));
          await tx.duesOpeningItem.update({ where: { id: old.id }, data: editedMarker(rogueSuccessor) });
          await createDraft(tx, { id: rogueSuccessor, coverageYear: old.coverageYear, coverageMonth: old.coverageMonth, amount: "70.00" });
        },
        { timeout: 60_000 },
      )
      .then(() => null, (e: unknown) => e);
    try {
      await waitUntilBlocked(await roguePid.promise, holderPid);
    } finally {
      release.resolve(); // released even if the wait assertion fails, so no transaction is left holding a lock
    }
    await first;
    expect(dbMessage(await rogue)).toContain("only the withdrawal marker may be set, once (it is already set)");
    expect(await prisma.duesOpeningItem.count({ where: { id: rogueSuccessor } })).toBe(0);
  }, 60_000);

  it("two creates for one month at once: the second waits on the unique index and is refused once the first commits", async () => {
    const month = nextMonth();
    const inserted = deferred<number>();
    const release = deferred();
    const first = prisma.$transaction(
      async (tx) => {
        await createDraft(tx, month);
        inserted.resolve(await backendPid(tx));
        await release.promise;
      },
      { timeout: 60_000 },
    );
    const holderPid = await inserted.promise;
    const secondPid = deferred<number>();
    const second = prisma
      .$transaction(
        async (tx) => {
          secondPid.resolve(await backendPid(tx));
          await createDraft(tx, month);
        },
        { timeout: 60_000 },
      )
      .then(() => null, (e: unknown) => e);
    try {
      await waitUntilBlocked(await secondPid.promise, holderPid);
    } finally {
      release.resolve(); // released even if the wait assertion fails, so no transaction is left holding a lock
    }
    await first;
    expect(dbMessage(await second)).toContain("DuesOpeningItem_one_active_per_month_key");
  }, 60_000);
});

/** @@unique([organizationId, studentId, candidateYear, candidateMonth, kind, sequence]), as PostgreSQL truncates its name. */
const SEQUENCE_KEY = "DuesReadinessConfirmation_organizationId_studentId_candidat_key";

describe("confirmation ordering: sequence under the student lock, never confirmedAt or id", () => {
  it("the protocol's transactions run at READ COMMITTED (each statement after the lock takes a fresh snapshot)", async () => {
    const level = await prisma.$transaction(async (tx) => (await tx.$queryRawUnsafe<{ transaction_isolation: string }[]>("SHOW transaction_isolation"))[0].transaction_isolation);
    expect(level).toBe("read committed");
  });

  it("equal timestamps: the current confirmation is the highest sequence; confirmedAt cannot tell them apart", async () => {
    const id = newIdentity();
    const at = new Date("2040-01-01T00:00:00.000Z");
    const first = await prisma.$transaction((tx) => confirmUnderLock(tx, id, { confirmedAt: at }));
    const second = await prisma.$transaction((tx) => confirmUnderLock(tx, id, { confirmedAt: at }));
    expect([first.sequence, second.sequence]).toEqual([1, 2]);
    expect((await current(prisma, id)).id).toBe(second.id);
    // A "latest by confirmedAt" rule has no answer here: both rows carry the same instant.
    expect(await prisma.duesReadinessConfirmation.count({ where: { ...id, confirmedAt: at } })).toBe(2);
  }, 60_000);

  it("start order differs from lock order: T1 begins first but waits for T2's lock; T1 gets sequence 2 and is current despite its EARLIER confirmedAt", async () => {
    const id = newIdentity();
    const t1Started = deferred<number>();
    const t1MayLock = deferred();
    const t2Locked = deferred<number>();
    const t2MayCommit = deferred();

    // Each transaction stamps confirmedAt with its own START time: PostgreSQL's now(), which is what the column's database default
    // records (a writer that stamps when its action starts behaves the same). Prisma's own @default(now()) is filled on the app
    // server at INSERT time instead, a third clock; none of them is the lock order.
    const startedAt = async (tx: Db) => (await tx.$queryRaw<{ now: Date }[]>`SELECT now() AS now`)[0].now;
    const t1 = prisma.$transaction(
      async (tx) => {
        const pid = await backendPid(tx);
        const at = await startedAt(tx); // T1 starts first
        t1Started.resolve(pid);
        await t1MayLock.promise;
        return confirmUnderLock(tx, id, { confirmedAt: at }); // blocks on the student lock T2 holds
      },
      { timeout: 60_000 },
    );
    const t1Pid = await t1Started.promise;
    await sleep(50); // T2 starts strictly later
    const t2 = prisma.$transaction(
      async (tx) => {
        const pid = await backendPid(tx);
        const row = await confirmUnderLock(tx, id, { confirmedAt: await startedAt(tx) }); // takes the lock first: MAX = 0, sequence 1
        t2Locked.resolve(pid);
        await t2MayCommit.promise;
        return row;
      },
      { timeout: 60_000 },
    );
    const t2Pid = await t2Locked.promise;
    t1MayLock.resolve();
    try {
      await waitUntilBlocked(t1Pid, t2Pid); // T1 is genuinely waiting on T2's lock
    } finally {
      t2MayCommit.resolve(); // released even if the wait assertion fails, so no transaction is left holding a lock
    }
    const r2 = await t2;
    const r1 = await t1; // after the grant, T1's MAX read sees T2's committed row

    expect(r2.sequence).toBe(1);
    expect(r1.sequence).toBe(2);
    expect(r1.confirmedAt.getTime()).toBeLessThan(r2.confirmedAt.getTime()); // started first, recorded second
    expect((await current(prisma, id)).id).toBe(r1.id); // the authoritative order is the lock order
  }, 60_000);

  it("backstop: two inserts with one identity and sequence that skip the lock — one fails on the unique key, the other is unchanged", async () => {
    const id = newIdentity();
    const row = { ...id, sequence: 1, fingerprintFormat: "r2", binding: HEX("a"), studentFingerprint: HEX("c"), confirmedById: a.admin.id, ...confirmationShape(id.kind) };
    const kept = await prisma.duesReadinessConfirmation.create({ data: row });
    const error = await prisma.duesReadinessConfirmation.create({ data: { ...row, binding: HEX("e") } }).then(() => null, (e: unknown) => e);
    expect(dbMessage(error)).toContain(SEQUENCE_KEY);
    expect(await prisma.duesReadinessConfirmation.findMany({ where: id })).toEqual([kept]);
  });

  it("why READ COMMITTED: under REPEATABLE READ a snapshot taken before the lock misses the committed row, and the transaction fails rather than mis-orders", async () => {
    const id = newIdentity();
    const t1Started = deferred<number>();
    const t1MayLock = deferred();
    const t2Locked = deferred<number>();
    const t2MayCommit = deferred();
    const t1 = prisma
      .$transaction(
        async (tx) => {
          await tx.$executeRawUnsafe("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
          const pid = await backendPid(tx); // the snapshot is taken here, before T2 commits
          t1Started.resolve(pid);
          await t1MayLock.promise;
          return confirmUnderLock(tx, id);
        },
        { timeout: 60_000 },
      )
      .then(() => null, (e: unknown) => e);
    const t1Pid = await t1Started.promise;
    const t2 = prisma.$transaction(
      async (tx) => {
        const pid = await backendPid(tx);
        const row = await confirmUnderLock(tx, id);
        t2Locked.resolve(pid);
        await t2MayCommit.promise;
        return row;
      },
      { timeout: 60_000 },
    );
    const t2Pid = await t2Locked.promise;
    t1MayLock.resolve();
    try {
      await waitUntilBlocked(t1Pid, t2Pid);
    } finally {
      t2MayCommit.resolve(); // released even if the wait assertion fails, so no transaction is left holding a lock
    }
    const r2 = await t2;
    const error = await t1;
    expect(error, "T1 must not succeed with a stale MAX").not.toBeNull();
    // Either PostgreSQL refuses the lock outright (serialization failure) or the stale MAX collides on the unique key.
    expect(dbMessage(error)).toMatch(new RegExp(`could not serialize|${SEQUENCE_KEY}`));
    expect((await prisma.duesReadinessConfirmation.findMany({ where: id })).map((r) => r.id)).toEqual([r2.id]);
  }, 60_000);
});

describe("no ledger effect, and the tenant guard", () => {
  it("drafts, edits, withdrawals and confirmations change no ledger or legacy-payment row", async () => {
    const before = await ledgerCounts(a.org.id);
    const periodBefore = await prisma.paymentPeriod.findUniqueOrThrow({ where: { id: periodAnaNov.id } });
    const d = await createDraft(prisma, { coverageYear: 2030, coverageMonth: 11, legacyPaymentPeriodId: periodAnaNov.id });
    const successor = await prisma.$transaction((tx) => editDraft(tx, d.id, { amount: "60.00" }));
    await prisma.duesOpeningItem.update({ where: { id: successor.id }, data: withdrawnMarker() });
    await prisma.$transaction((tx) => confirmUnderLock(tx, newIdentity("PRICING_ACKNOWLEDGED")));
    expect(await ledgerCounts(a.org.id)).toEqual(before);
    expect(await prisma.paymentPeriod.findUniqueOrThrow({ where: { id: periodAnaNov.id } })).toEqual(periodBefore);
  }, 60_000);

  it("a query on either model without organizationId throws through the guarded client", async () => {
    await expect(guardedPrisma.duesOpeningItem.findMany({ where: { studentId: ana.id } })).rejects.toThrow(UnscopedTenantQueryError);
    await expect(guardedPrisma.duesReadinessConfirmation.findMany({ where: { studentId: ana.id } })).rejects.toThrow(UnscopedTenantQueryError);
    await expect(guardedPrisma.duesOpeningItem.findMany({ where: { organizationId: a.org.id, studentId: ana.id } })).resolves.toBeInstanceOf(Array);
  });
});
