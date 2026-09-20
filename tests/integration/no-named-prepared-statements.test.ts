import "dotenv/config";
import { createHash } from "node:crypto";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../src/generated/prisma/client";
import { resolveGuardedTestDatabaseUrl } from "../../scripts/lib/test-database-guard";

const { prisma } = await import("../../src/lib/prisma");

/**
 * Production points DATABASE_URL at a transaction-mode pooler
 * (docs/DEPLOYMENT_RUNBOOK.md). The one thing that breaks such a pooler for
 * a Prisma app is NAMED prepared statements: a name is bound to one backend
 * connection, and the pooler hands the next transaction a different one.
 * `@prisma/adapter-pg` names statements only if `statementNameGenerator` is
 * supplied. Against a real PgBouncer in transaction mode, opting in failed
 * 110 of 120 concurrent queries with `42P05 prepared statement already
 * exists`; the default config passed 120 of 120.
 *
 * This pins the property directly, server-side, with no pooler needed:
 * `pg_prepared_statements` lists exactly the named statements a session
 * holds. Someone "optimizing" unscoped.ts with statement caching would
 * pass every other test and break production under concurrency — this is
 * the test that fails instead.
 */
describe("the app's Prisma client and transaction-mode pooling", () => {
  it("REQUIRED: the real client leaves zero named prepared statements in its session", async () => {
    // Sequential on purpose: one pool connection serves all of it, so the
    // session inspected below is the session that ran everything.
    await prisma.organization.findMany({ take: 1 });
    await prisma.organization.findMany({ take: 1 }); // identical statement again — a caching adapter would name it now
    await prisma.$transaction(async (tx) => {
      await tx.organization.count();
      await tx.user.count();
    });
    await prisma.user.findFirst();

    const probe = () =>
      prisma.$queryRaw<Array<{ pid: number; named: number }>>`
        select pg_backend_pid()::int as pid, (select count(*)::int from pg_prepared_statements) as named
      `;
    const [first] = await probe();
    const [second] = await probe();

    expect(second.pid, "premise: every statement above ran on one pooled connection").toBe(first.pid);
    expect(first.named).toBe(0);
  });

  it("CONTROL: opting in to statementNameGenerator DOES leave named statements — so the assertion above is capable of failing", async () => {
    const pool = new Pool({ connectionString: resolveGuardedTestDatabaseUrl(), max: 1 });
    const client = new PrismaClient({
      adapter: new PrismaPg(pool, {
        statementNameGenerator: (query) => `stmt_${createHash("md5").update(query.sql).digest("hex")}`,
      }),
    });
    try {
      await client.organization.findMany({ take: 1 });
      const { rows } = await pool.query<{ n: number }>("select count(*)::int as n from pg_prepared_statements");
      expect(rows[0].n).toBeGreaterThan(0);
    } finally {
      await client.$disconnect();
      await pool.end();
    }
  });
});
