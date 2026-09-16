/**
 * Runs an arbitrary command with DATABASE_URL overridden to the guarded
 * TEST_DATABASE_URL — used by `pnpm db:test:migrate` / `pnpm db:test:seed`
 * so prisma7.config.ts's datasource (which reads process.env.DATABASE_URL)
 * targets the test database instead of dev, without ever touching the real
 * DATABASE_URL value.
 *
 * Usage: tsx scripts/run-against-test-db.ts <command> [...args]
 */
import "dotenv/config";
import { spawnSync } from "node:child_process";
import { resolveGuardedTestDatabaseUrl } from "./lib/test-database-guard";

const [, , command, ...args] = process.argv;
if (!command) {
  throw new Error("Usage: tsx scripts/run-against-test-db.ts <command> [...args]");
}

const testUrl = resolveGuardedTestDatabaseUrl();

// On win32, spawnSync's shell:true joins command+args into one string for
// cmd.exe without auto-quoting elements containing spaces — quote any that
// need it (see scripts/ci-parity-check.ts's run() for where this bit us).
const isWindows = process.platform === "win32";
const quotedArgs = isWindows ? args.map((a) => (/\s/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)) : args;

const result = spawnSync(command, quotedArgs, {
  stdio: "inherit",
  shell: isWindows,
  env: { ...process.env, DATABASE_URL: testUrl },
});

process.exit(result.status ?? 1);
