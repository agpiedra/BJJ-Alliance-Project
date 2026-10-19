import "dotenv/config";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { getTestPrismaClient } from "../helpers/test-db";

/**
 * docs/SWEEP_BOUND_INVESTIGATION.md — both throttle sweeps must delete at most their batch (100) per call, return the
 * real deletion count, keep every row inside the retention period, and let concurrent sweeps skip each other's locks.
 *
 * The bound is exercised on the statistics state that broke it: ANALYZE taken on a bloated heap (2000 dead tuples, 1
 * live row), so the planner expects ~1 row; with the old `WHERE "id" IN (SELECT … LIMIT … SKIP LOCKED)` it made the
 * candidate subquery the re-executed inner side of a nested loop and one call deleted 150–250.
 *
 * Statistics and autovacuum changes are confined to the two throttle tables of the isolated test database, for this
 * file only: afterAll removes the fixture rows, RESETs autovacuum and re-ANALYZEs the tables.
 *
 * The REAL functions run unchanged. A test-only Proxy over `@/lib/prisma` can route their `$executeRaw` into a pinned
 * interactive transaction (a controlled clock — `now()` is fixed for the whole transaction, which freezing JavaScript
 * Date cannot do — and held row locks), or capture the exact SQL they send (for the plan check).
 */
type RawCall = { strings: TemplateStringsArray; values: unknown[] };
let pinned: { $executeRaw: (strings: TemplateStringsArray, ...values: unknown[]) => Promise<number> } | null = null;
let capture: RawCall | null | "armed" = null;
vi.mock("@/lib/prisma", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/lib/prisma")>();
  const prisma = new Proxy(real.prisma, {
    get(target, prop) {
      if (prop === "$executeRaw") {
        return (strings: TemplateStringsArray, ...values: unknown[]) => {
          if (capture === "armed") {
            capture = { strings, values };
            return Promise.resolve(0);
          }
          if (pinned) return pinned.$executeRaw(strings, ...values);
          return (target.$executeRaw as (s: TemplateStringsArray, ...v: unknown[]) => Promise<number>)(strings, ...values);
        };
      }
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { ...real, prisma };
});

const { sweepExpiredResetRequests } = await import("../../src/lib/auth/password-reset-throttle");
const { sweepExpiredLoginAttempts } = await import("../../src/lib/auth/login-throttle");

const prisma = getTestPrismaClient();

const KINDS = {
  reset: {
    sweep: sweepExpiredResetRequests,
    table: '"PasswordResetRequest"',
    columns: '("id","keyKind","keyDigest","createdAt")',
    row: (id: string, createdAt: string) => `('${id}', 'email', 'digest-${id}', ${createdAt})`,
  },
  login: {
    sweep: sweepExpiredLoginAttempts,
    table: '"LoginAttempt"',
    columns: '("id","accountDigest","ipDigest","createdAt")',
    row: (id: string, createdAt: string) => `('${id}', 'acct-${id}', NULL, ${createdAt})`,
  },
} as const;
type Kind = keyof typeof KINDS;

const NOW = `(now() AT TIME ZONE 'UTC')`;
const EXPIRED = (secondsBeforeOldest: number) => `${NOW} - interval '25 hours' - (${secondsBeforeOldest} * interval '1 second')`;

async function insert(kind: Kind, rows: string[]) {
  const k = KINDS[kind];
  for (let start = 0; start < rows.length; start += 1000) {
    await prisma.$executeRawUnsafe(`INSERT INTO ${k.table} ${k.columns} VALUES ${rows.slice(start, start + 1000).join(",")}`);
  }
}

/**
 * The reproduced failing state: statistics taken on a bloated heap (2000 dead tuples + 1 live row), then 250 expired
 * rows (in chronological order — a synthetic condition, not verified production storage order) and 5 recent rows.
 */
async function bloatedFixture(kind: Kind) {
  const k = KINDS[kind];
  await prisma.$executeRawUnsafe(`ALTER TABLE ${k.table} SET (autovacuum_enabled = false)`);
  await prisma.$executeRawUnsafe(`TRUNCATE ${k.table}`);
  await insert(kind, Array.from({ length: 2000 }, (_, i) => k.row(`fx-dead-${i}`, NOW)));
  await prisma.$executeRawUnsafe(`DELETE FROM ${k.table} WHERE "id" LIKE 'fx-dead-%'`);
  await insert(kind, [k.row("fx-seen", NOW)]);
  await prisma.$executeRawUnsafe(`ANALYZE ${k.table}`);
  await prisma.$executeRawUnsafe(`DELETE FROM ${k.table} WHERE "id" = 'fx-seen'`);
  await insert(kind, [
    ...Array.from({ length: 250 }, (_, i) => k.row(`fx-old-${String(i).padStart(3, "0")}`, EXPIRED(249 - i))),
    ...Array.from({ length: 5 }, (_, i) => k.row(`fx-recent-${i}`, NOW)),
  ]);
}

async function counts(kind: Kind) {
  const [row] = await prisma.$queryRawUnsafe<{ old: number; recent: number }[]>(
    `SELECT count(*) FILTER (WHERE "id" LIKE 'fx-old-%')::int AS old, count(*) FILTER (WHERE "id" LIKE 'fx-recent-%')::int AS recent FROM ${KINDS[kind].table}`,
  );
  return row;
}

/** Runs `body` with the real function's `$executeRaw` routed into one interactive transaction (fixed now(), held locks). */
async function inPinnedTransaction<T>(body: (tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0]) => Promise<T>, hold?: Promise<void>) {
  return prisma.$transaction(
    async (tx) => {
      pinned = tx as unknown as typeof pinned;
      try {
        const result = await body(tx);
        pinned = null;
        if (hold) await hold;
        return result;
      } finally {
        pinned = null;
      }
    },
    { timeout: 30_000, maxWait: 10_000 },
  );
}

afterEach(() => {
  pinned = null;
  capture = null;
});

afterAll(async () => {
  for (const kind of Object.keys(KINDS) as Kind[]) {
    const k = KINDS[kind];
    await prisma.$executeRawUnsafe(`DELETE FROM ${k.table} WHERE "id" LIKE 'fx-%'`);
    await prisma.$executeRawUnsafe(`ALTER TABLE ${k.table} RESET (autovacuum_enabled)`);
    await prisma.$executeRawUnsafe(`ANALYZE ${k.table}`);
  }
});

for (const kind of Object.keys(KINDS) as Kind[]) {
  const k = KINDS[kind];

  describe(`${kind === "reset" ? "sweepExpiredResetRequests" : "sweepExpiredLoginAttempts"}`, () => {
    it("REQUIRED on the bloated-statistics fixture: every call deletes at most 100, returns exactly what it deleted, and recent rows survive", async () => {
      await bloatedFixture(kind);
      const returned: number[] = [];
      for (let call = 0; call < 4; call++) {
        const before = await counts(kind);
        const n = await k.sweep();
        const after = await counts(kind);
        returned.push(n);
        expect(n, `call ${call + 1} returned ${n}`).toBeLessThanOrEqual(100);
        expect(before.old - after.old, `call ${call + 1}: returned count equals rows actually deleted`).toBe(n);
        expect(after.recent).toBe(5);
      }
      expect(returned).toEqual([100, 100, 50, 0]);
    });

    it("REQUIRED the candidate set is evaluated once — its row-locking scan runs a single loop", async () => {
      await bloatedFixture(kind);
      capture = "armed";
      await k.sweep(); // captured, not executed
      const call = capture as unknown as RawCall;
      capture = null;
      expect(call?.strings).toBeDefined();
      // The exact statement the function sends, with its own bound parameters.
      const text = call.strings.reduce((sql, part, i) => sql + part + (i < call.values.length ? `$${i + 1}` : ""), "");
      // EXPLAIN ANALYZE executes the DELETE, so it runs inside a transaction that is rolled back.
      let plan: unknown;
      await prisma
        .$transaction(async (tx) => {
          const rows = await tx.$queryRawUnsafe<{ "QUERY PLAN": unknown }[]>(`EXPLAIN (ANALYZE, FORMAT JSON) ${text}`, ...call.values);
          plan = rows[0]["QUERY PLAN"];
          throw new Error("rollback");
        })
        .catch((error: Error) => {
          if (error.message !== "rollback") throw error;
        });
      // Only the candidate scan is asserted: every row-locking (FOR UPDATE SKIP LOCKED) node ran exactly once.
      const lockRows: { "Actual Loops": number }[] = [];
      const walk = (node: { "Node Type"?: string; Plans?: unknown[] }) => {
        if (node["Node Type"] === "LockRows") lockRows.push(node as { "Actual Loops": number });
        (node.Plans ?? []).forEach((child) => walk(child as typeof node));
      };
      walk((plan as { Plan: Parameters<typeof walk>[0] }[])[0].Plan);
      expect(lockRows.length).toBeGreaterThan(0);
      expect(lockRows.map((node) => node["Actual Loops"])).toEqual(lockRows.map(() => 1));
      expect(await counts(kind)).toEqual({ old: 250, recent: 5 }); // rolled back
    });

    it("REQUIRED retention boundary at storage precision, under a controlled transaction clock: the latest instant before the cutoff is deleted; the earliest instant not before it, and recent rows, are kept", async () => {
      await prisma.$executeRawUnsafe(`DELETE FROM ${k.table} WHERE "id" LIKE 'fx-%'`);
      // createdAt is TIMESTAMP(3); now() has microseconds. Inside ONE transaction now() is fixed, so the cutoff the
      // sweep computes equals the one computed here. "notBefore" = the cutoff rounded UP to a millisecond (equal to the
      // cutoff when now() falls on a whole millisecond); "before" = 1 ms earlier, always strictly before the cutoff.
      const cutoff = `(${NOW} - make_interval(hours => 24))`;
      const notBefore = `(date_trunc('milliseconds', ${cutoff}) + CASE WHEN date_trunc('milliseconds', ${cutoff}) = ${cutoff} THEN interval '0' ELSE interval '1 millisecond' END)`;
      const result = await inPinnedTransaction(async (tx) => {
        await tx.$executeRawUnsafe(
          `INSERT INTO ${k.table} ${k.columns} VALUES ${[
            k.row("fx-boundary-before", `${notBefore} - interval '1 millisecond'`),
            k.row("fx-boundary-notbefore", notBefore),
            k.row("fx-boundary-inside", `${cutoff} + interval '1 second'`),
            k.row("fx-recent-0", NOW),
          ].join(",")}`,
        );
        const deleted = await k.sweep(); // the real function, inside this transaction
        const left = await tx.$queryRawUnsafe<{ id: string }[]>(`SELECT "id" FROM ${k.table} WHERE "id" LIKE 'fx-%' ORDER BY "id"`);
        return { deleted, left: left.map((row) => row.id) };
      });
      expect(result).toEqual({ deleted: 1, left: ["fx-boundary-inside", "fx-boundary-notbefore", "fx-recent-0"] });
      await prisma.$executeRawUnsafe(`DELETE FROM ${k.table} WHERE "id" LIKE 'fx-%'`);
    });

    it("REQUIRED concurrent sweeps take disjoint batches: the second completes while the first still holds its row locks", async () => {
      await bloatedFixture(kind);
      let release!: () => void;
      const hold = new Promise<void>((resolve) => (release = resolve));
      let firstDone!: () => void;
      const firstSwept = new Promise<void>((resolve) => (firstDone = resolve));
      let firstCount = -1;
      const first = inPinnedTransaction(async () => {
        firstCount = await k.sweep(); // deletes (and locks) its batch; the transaction stays open until `hold`
        firstDone();
        return firstCount;
      }, hold);
      await firstSwept;

      const timeout = new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 8_000));
      const second = await Promise.race([k.sweep(), timeout]); // autocommit, outside the first transaction
      release();
      await first;

      expect(second).not.toBe("blocked");
      expect(firstCount).toBe(100);
      expect(second).toBe(100);
      // 250 expired: two disjoint batches of 100 leave exactly 50 (an overlap would leave more); recent rows untouched.
      expect(await counts(kind)).toEqual({ old: 50, recent: 5 });
    });
  });
}
