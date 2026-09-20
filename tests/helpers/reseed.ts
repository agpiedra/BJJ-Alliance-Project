import { spawnSync } from "node:child_process";
import { resolveGuardedTestDatabaseUrl, testDatabaseChildEnv } from "../../scripts/lib/test-database-guard";

/**
 * Runs the real seed script exactly as `pnpm db:test:seed` does (the same
 * `tsx prisma/seed.ts` command prisma7.config.ts's `migrations.seed`
 * declares), forcing DATABASE_URL to the guarded test target regardless of
 * the ambient environment.
 *
 * Shared by tests/integration/seed-idempotence.test.ts (does reseeding
 * change anything it shouldn't) and seed-repairs-drift.test.ts (does
 * reseeding fix a value that's drifted from the seed source) — both need
 * the exact same child-process invocation, not two copies of it.
 */
export function reseed(): void {
  const databaseUrl = resolveGuardedTestDatabaseUrl();
  const result = spawnSync("pnpm", ["exec", "tsx", "prisma/seed.ts"], {
    cwd: process.cwd(),
    env: testDatabaseChildEnv(databaseUrl),
    encoding: "utf-8",
    shell: process.platform === "win32",
  });
  if (result.status !== 0) {
    throw new Error(`Reseed failed (exit ${result.status}):\n${result.stdout}\n${result.stderr}`);
  }
}
