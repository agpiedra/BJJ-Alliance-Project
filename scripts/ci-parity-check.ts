/**
 * docs/MULTI_ACADEMY_AND_KIDS_BELTS.md Phase 0: "seed -> snapshot -> migrate
 * -> snapshot -> diff. Any unexpected difference fails the build." Wired as
 * a single script so CI's workflow file and a local run
 * (`pnpm ci:parity-check`) invoke exactly the same steps.
 *
 * Runs entirely against TEST_DATABASE_URL (via the same guard every
 * integration test uses) — never DATABASE_URL implicitly. Currently
 * "migrate" is `prisma migrate deploy` against whatever migrations already
 * exist, which is a no-op until Phase 1 adds a real one — the two snapshots
 * are expected to be identical either way, which is itself proof the
 * pipeline and the seed's determinism both work, ahead of a phase that
 * actually needs the diff to catch something.
 */
import "dotenv/config";
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { resolveGuardedTestDatabaseUrl } from "./lib/test-database-guard";

// On win32, spawnSync's shell:true joins command+args into one string for
// cmd.exe without auto-quoting elements containing spaces (a real gotcha —
// this repo's own path, "...BJJ Project\BJJ Alliance Project...", broke it
// on the first run). Quote any arg that needs it ourselves.
function quoteForWindowsShell(arg: string): string {
  return /\s/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg;
}

function run(command: string, args: string[], env: NodeJS.ProcessEnv): void {
  console.log(`\n$ ${command} ${args.join(" ")}`);
  const isWindows = process.platform === "win32";
  const result = spawnSync(command, isWindows ? args.map(quoteForWindowsShell) : args, {
    stdio: "inherit",
    shell: isWindows,
    env,
  });
  if (result.status !== 0) {
    throw new Error(`Command failed (exit ${result.status}): ${command} ${args.join(" ")}`);
  }
}

function main(): void {
  const testUrl = resolveGuardedTestDatabaseUrl();
  const env = { ...process.env, DATABASE_URL: testUrl };

  const outDir = path.resolve(process.cwd(), "ci", "seed-snapshots");
  mkdirSync(outDir, { recursive: true });
  const before = path.join(outDir, "before-migrate.json");
  const after = path.join(outDir, "after-migrate.json");

  console.log("== 1/5: migrate ==");
  run("pnpm", ["exec", "prisma", "migrate", "deploy"], env);

  console.log("\n== 2/5: seed ==");
  run("pnpm", ["exec", "prisma", "db", "seed"], env);

  console.log("\n== 3/5: snapshot (before) ==");
  run("pnpm", ["exec", "tsx", "scripts/alliance-baseline.ts", `--database-url=${testUrl}`, `--out=${before}`], process.env);

  console.log("\n== 4/5: migrate (again — this is the step a real Phase 1+ migration lands in) ==");
  run("pnpm", ["exec", "prisma", "migrate", "deploy"], env);

  console.log("\n== 4/5: snapshot (after) ==");
  run("pnpm", ["exec", "tsx", "scripts/alliance-baseline.ts", `--database-url=${testUrl}`, `--out=${after}`], process.env);

  console.log("\n== 5/5: diff ==");
  run("pnpm", ["exec", "tsx", "scripts/diff-snapshots.ts", before, after], process.env);
}

main();
