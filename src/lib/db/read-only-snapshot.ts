import type { prisma } from "@/lib/prisma";
import type { Tx } from "@/lib/students/lock";

/**
 * Runs `fn` inside ONE Postgres transaction that the database itself makes `REPEATABLE READ` and `READ ONLY`, so every
 * read in `fn` sees the same snapshot and no write can succeed. `SET TRANSACTION` must be the first statement (it is
 * refused once a query has run), and both settings are read back with `SHOW` and the transaction aborted if either is not
 * what was asked for — never trusted on assumption. Same enforcement idea as `scripts/lib/read-only-transaction.ts`, plus
 * the isolation level.
 *
 * The snapshot makes a report internally consistent. It does not stop anyone writing afterwards: anything that later ACTS
 * on such a report must re-check under its own locks (docs/dues/STAGE-8-READINESS-BRIEF.md §5).
 */
export async function runReadOnlySnapshot<T>(client: typeof prisma, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return client.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
      const [{ transaction_read_only }] = await tx.$queryRawUnsafe<{ transaction_read_only: string }[]>("SHOW transaction_read_only");
      const [{ transaction_isolation }] = await tx.$queryRawUnsafe<{ transaction_isolation: string }[]>("SHOW transaction_isolation");
      if (transaction_read_only !== "on" || transaction_isolation !== "repeatable read") {
        throw new Error(`Read-only snapshot not enforced: read_only=${transaction_read_only}, isolation=${transaction_isolation}`);
      }
      return fn(tx as Tx);
    },
    { timeout: 60_000, maxWait: 10_000 },
  );
}
