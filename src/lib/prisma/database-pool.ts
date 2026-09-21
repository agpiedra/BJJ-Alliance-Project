import { Pool } from "pg";
import { attachDatabasePool } from "@vercel/functions";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import { resolveDatabaseSsl } from "./database-ssl";

type Env = Record<string, string | undefined>;

/**
 * Built for a DATABASE_URL that points at a transaction-mode pooler in
 * production (docs/DEPLOYMENT_RUNBOOK.md). Verified against the real
 * adapter and a real PgBouncer in transaction mode, not assumed:
 *
 * - No `?pgbouncer=true`: that's a Prisma *engine* parameter. This adapter
 *   hands the URL to node-postgres, which stores it as an inert key and
 *   never sends it.
 * - TLS is decided by `resolveDatabaseSsl`, through the Pool's `ssl` option —
 *   not by the URL's `sslmode`, which node-postgres only partly honours and
 *   which would override the option.
 * - `idleTimeoutMillis: 5000` + `attachDatabasePool` (in `createPrismaClient`):
 *   Vercel's guidance for pg on Fluid compute — idle connections close before
 *   an instance suspends. `attachDatabasePool` is inert off Vercel. Don't cap
 *   `max` at 1 (Vercel: it harms concurrency without reducing connections).
 *
 * Separate from `createPrismaClient` so scripts/verify-pooling.ts can probe
 * the connection and the TLS session with exactly the configuration the app
 * uses, instead of a copy that could drift.
 */
export function createDatabasePool(env: Env = process.env): Pool {
  const connectionString = env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("Missing required environment variable: DATABASE_URL");
  }
  const ssl = resolveDatabaseSsl(connectionString, env);
  return new Pool({ connectionString, idleTimeoutMillis: 5_000, ...(ssl === undefined ? {} : { ssl }) });
}

/**
 * The app's Prisma client over `createDatabasePool`.
 *
 * Never pass `statementNameGenerator`: without it this adapter creates no
 * named prepared statements (0 in `pg_prepared_statements`), which is what
 * makes transaction pooling safe. Opting in fails 110 of 120 concurrent
 * queries with `42P05 prepared statement already exists`
 * (tests/integration/no-named-prepared-statements.test.ts pins this).
 *
 * `disposeExternalPool`: the pool is ours, so `$disconnect()` must end it.
 */
export function createPrismaClient(env: Env = process.env): PrismaClient {
  const pool = createDatabasePool(env);
  attachDatabasePool(pool);
  return new PrismaClient({ adapter: new PrismaPg(pool, { disposeExternalPool: true }) });
}
