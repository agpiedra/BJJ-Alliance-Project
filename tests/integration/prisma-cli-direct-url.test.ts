import "dotenv/config";
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveGuardedTestDatabaseUrl } from "../../scripts/lib/test-database-guard";

/**
 * `prisma migrate deploy` must run against the DIRECT connection once the
 * running app's DATABASE_URL points at a transaction-mode pooler. Verified
 * against a real PgBouncer: running it THROUGH the pooler appears to work,
 * then leaves Prisma Migrate's advisory lock held by an idle pooled backend,
 * and the next real migration times out with
 * `P1002: Timed out trying to acquire a postgres advisory lock`. That's a
 * failure that shows up on a later deploy, not the one that caused it — so
 * "the CLI really uses DIRECT_URL" is worth a permanent test, not a
 * one-time manual check.
 *
 * Runs against a throwaway database on the TEST server only (name contains
 * "test"; created and dropped here), never the dev database or the test
 * database's own contents.
 */
const testUrl = resolveGuardedTestDatabaseUrl();
const scratchName = `alliance_test_cli_direct_${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`;

function urlFor(database: string, base = testUrl): string {
  const url = new URL(base);
  url.pathname = `/${database}`;
  url.search = "";
  return url.toString();
}

const scratchUrl = urlFor(scratchName);
const admin = new Pool({ connectionString: urlFor("postgres"), max: 1 });

function migrateDeploy(env: Record<string, string>) {
  return spawnSync("pnpm", ["exec", "prisma", "migrate", "deploy"], {
    cwd: process.cwd(),
    // Both variables are always set explicitly, so nothing ambient in the
    // developer's shell can leak into what this test is asserting.
    env: { ...process.env, ...env },
    encoding: "utf-8",
    shell: process.platform === "win32",
    timeout: 120_000,
  });
}

async function migrationsApplied(): Promise<number | null> {
  const scratch = new Pool({ connectionString: scratchUrl, max: 1 });
  try {
    const exists = await scratch.query<{ t: string | null }>("select to_regclass('public._prisma_migrations') as t");
    if (!exists.rows[0].t) return null;
    const applied = await scratch.query<{ n: number }>(
      "select count(*)::int as n from _prisma_migrations where finished_at is not null",
    );
    return applied.rows[0].n;
  } finally {
    await scratch.end();
  }
}

describe("Prisma CLI connection: DIRECT_URL for migrations", () => {
  beforeAll(async () => {
    await admin.query(`create database "${scratchName}"`);
  });

  afterAll(async () => {
    await admin.query(`drop database if exists "${scratchName}" with (force)`);
    await admin.end();
  });

  it("REQUIRED: refuses when DIRECT_URL and DATABASE_URL name different databases, and touches nothing", async () => {
    // The hazard: a script redirects DATABASE_URL to the test database while
    // a stale DIRECT_URL (say, production) is still in the shell.
    const result = migrateDeploy({ DATABASE_URL: testUrl, DIRECT_URL: scratchUrl });

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain("Refusing to run the Prisma CLI");
    expect(await migrationsApplied(), "the scratch database must be untouched").toBeNull();
  }, 120_000);

  it("REQUIRED: migrate deploy uses DIRECT_URL, not DATABASE_URL — it succeeds even though DATABASE_URL is unreachable", async () => {
    // Same database NAME (a legitimate pooled/direct pair), but DATABASE_URL
    // points at a closed port. Success can only mean the CLI went direct.
    const unreachablePooled = urlFor(scratchName, "postgresql://alliance:unused@127.0.0.1:1/x");

    const result = migrateDeploy({ DATABASE_URL: unreachablePooled, DIRECT_URL: scratchUrl });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const expected = readdirSync(path.join(process.cwd(), "prisma", "migrations"), { withFileTypes: true }).filter((entry) =>
      entry.isDirectory(),
    ).length;
    expect(await migrationsApplied()).toBe(expected);
  }, 120_000);
});
