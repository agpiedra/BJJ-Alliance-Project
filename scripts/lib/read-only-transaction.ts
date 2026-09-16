import type { PrismaClient } from "../../src/generated/prisma/client";

/**
 * Runs `fn` inside a Postgres transaction that is genuinely read-only.
 *
 * `SET TRANSACTION READ ONLY` is the first statement — before any data
 * query — because `SET LOCAL default_transaction_read_only = on` only sets
 * the default for *subsequent* transactions and does nothing to the one
 * already open; it is not a guard. Then verifies via `SHOW
 * transaction_read_only` and aborts loudly if it is not `on`, so an accepted
 * misconfiguration is never silently trusted. A write attempted inside `fn`
 * fails at the database level, not just by convention — see
 * tests/integration/read-only-transaction.test.ts.
 *
 * Shared by scripts/alliance-baseline.ts and scripts/db-inventory.ts so this
 * enforcement exists in exactly one place.
 */
export async function runReadOnly<T>(
  prisma: PrismaClient,
  fn: (tx: Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0]) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
      const [{ transaction_read_only }] = await tx.$queryRawUnsafe<Array<{ transaction_read_only: string }>>(
        "SHOW transaction_read_only",
      );
      if (transaction_read_only !== "on") {
        throw new Error(`Read-only enforcement failed: SHOW transaction_read_only returned "${transaction_read_only}"`);
      }
      return fn(tx);
    },
    { timeout: 120_000, maxWait: 10_000 },
  );
}
