import { prisma } from "@/lib/prisma";
import type { Tx } from "@/lib/students/lock";

/**
 * Stage 9 organization gate (docs/dues/STAGE-9-IMPLEMENTATION-PLAN.md, revision 4, concurrency rules 1–9).
 *
 * The gate is the `Organization` row lock. Approval, withdrawal and the activation switch (PR 9-3) take it exclusively; every
 * writer that changes something readiness reads takes it `FOR SHARE` as its FIRST lock, inside its own transaction, and then
 * reads the activation state. Shared holders never block each other, so this costs ordinary writers nothing except while a
 * switch runs. Lock order after it is unchanged: branches, students, versions, rows.
 *
 * The exclusive mode is `FOR NO KEY UPDATE`, not `FOR UPDATE`: it conflicts with every `FOR SHARE` participant exactly the same,
 * but not with the `FOR KEY SHARE` lock PostgreSQL takes for a foreign-key check, so unrelated inserts that reference the
 * organization (a check-in, an attendance row) are not held up by a switch (proved in tests/integration/dues-activation-gate.test.ts).
 *
 * Writers must run at READ COMMITTED (the default; none participating sets another level). The activation state is read in a
 * separate statement after the lock is granted, which under READ COMMITTED takes a fresh snapshot and therefore sees a switch
 * that committed while this transaction waited (tests/integration/dues-activation-gate.test.ts proves the waiting writer sees it).
 */
export type GateMode = "share" | "update";

export interface GateState {
  /** The ledger is authoritative for this organization (it has an effective activation). */
  active: boolean;
  /** When the activation became effective; null while inactive. */
  activeSince: Date | null;
}

/** Locks the organization row and reads the activation state. Null when the organization does not exist. */
export async function lockOrganizationGate(tx: Tx, organizationId: string, mode: GateMode = "share"): Promise<GateState | null> {
  const locked =
    mode === "update"
      ? await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "Organization" WHERE "id" = ${organizationId} FOR NO KEY UPDATE`
      : await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "Organization" WHERE "id" = ${organizationId} FOR SHARE`;
  if (locked.length === 0) return null;
  const activeSince = await effectiveSince(tx, organizationId);
  return { active: activeSince !== null, activeSince };
}

/**
 * Same as `lockOrganizationGate(tx, id, "share")`, but waits at most `lockTimeoutMs` for the lock (page loads and the legacy
 * payment form: rules 6 and 7). A longer wait raises PostgreSQL `lock_not_available` (55P03), which aborts the transaction; the
 * caller catches it with `isLockTimeout` and degrades. `SET LOCAL` ends with the transaction.
 */
export async function lockOrganizationGateWithTimeout(tx: Tx, organizationId: string, lockTimeoutMs: number): Promise<GateState | null> {
  if (!Number.isInteger(lockTimeoutMs) || lockTimeoutMs <= 0) throw new RangeError("lockTimeoutMs must be a positive integer");
  await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = ${lockTimeoutMs}`);
  return lockOrganizationGate(tx, organizationId, "share");
}

/** Page loads wait this long for the gate before rendering without writing. */
export const PAGE_LOAD_GATE_TIMEOUT_MS = 2_000;
/** The legacy payment form waits this long before answering "not saved — try again". */
export const LEGACY_PAYMENT_GATE_TIMEOUT_MS = 5_000;

async function effectiveSince(db: Tx | typeof prisma, organizationId: string): Promise<Date | null> {
  const rows = await db.$queryRaw<{ effectiveAt: Date }[]>`
    SELECT "effectiveAt" FROM "DuesActivation" WHERE "organizationId" = ${organizationId} AND "effectiveAt" IS NOT NULL LIMIT 1`;
  return rows[0]?.effectiveAt ?? null;
}

/**
 * Unlocked read of the activation state, for display and for the ledger writers' early `notActive` refusal. Safe without the
 * gate because activation is one-way (A5: no undo; the database refuses to clear `effectiveAt`): a reader that sees "active"
 * stays right forever, and one that sees "inactive" only refuses or shows the legacy screen. A legacy WRITER must not rely on
 * it — it must hold the gate (rule 6).
 */
export async function readLedgerActive(organizationId: string): Promise<boolean> {
  return (await effectiveSince(prisma, organizationId)) !== null;
}

/** The start month S of the organization's EFFECTIVE activation, or null while inactive. Unlocked, for display (same reasoning as
 * `readLedgerActive`: an effective activation never changes). */
export async function readLedgerStart(organizationId: string): Promise<{ year: number; month: number } | null> {
  const row = await prisma.duesActivation.findFirst({
    where: { organizationId, effectiveAt: { not: null } },
    select: { startYear: true, startMonth: true },
  });
  return row ? { year: row.startYear, month: row.startMonth } : null;
}

/** PostgreSQL `lock_not_available` (55P03), as raised by `lock_timeout`, through Prisma's driver adapter. */
export function isLockTimeout(error: unknown): boolean {
  const e = error as { message?: unknown; meta?: { driverAdapterError?: { cause?: { originalCode?: unknown; originalMessage?: unknown } } } };
  const cause = e?.meta?.driverAdapterError?.cause;
  if (cause?.originalCode === "55P03") return true;
  const text = [e?.message, cause?.originalMessage].filter((t) => typeof t === "string").join(" ");
  return /lock timeout|could not obtain lock/i.test(text);
}
