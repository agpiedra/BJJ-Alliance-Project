/**
 * Two independent comparisons, both gating CI, both computed via the shadow
 * database:
 *
 *   (a) schema.prisma <-> migration history — are the migrations complete?
 *       Catches someone editing schema.prisma and forgetting to generate a
 *       migration for it: silent, common, and it would otherwise only
 *       surface when a deploy replays the history and produces the wrong
 *       schema.
 *   (b) migration history <-> live database — has a database drifted?
 *       Catches a manual `ALTER TABLE`, `prisma db push`, or a hand-edited
 *       migration that was never actually replayed — the failure this
 *       session hit firsthand when the test database's stale BeltRequirement
 *       structure rejected a later migration outright.
 *
 * Deliberately does NOT check "schema.prisma <-> live database" directly
 * (what `--from-config-datasource --to-schema` computes) — that comparison
 * conflates (a) and (b) into one result and can't tell you which one broke.
 *
 * Checks whatever DATABASE_URL currently resolves to for (b) — run this
 * against dev locally, and it also runs in CI against the CI database
 * (always freshly migrated from empty, so (b) should always be silently
 * clean there; the value in CI is (a), and (b) is the regression trip-wire
 * if that ever changes).
 *
 * Usage: tsx scripts/check-drift.ts
 */
import "dotenv/config";
import { execFileSync } from "node:child_process";

function runDiff(args: string[]): string {
  return execFileSync("npx", ["prisma", "migrate", "diff", ...args, "--script"], {
    encoding: "utf8",
    shell: process.platform === "win32",
  });
}

function report(label: string, output: string): boolean {
  const isEmpty = output.includes("This is an empty migration.");
  if (isEmpty) {
    console.log(`check:db-drift — ${label}: clean.`);
    return true;
  }
  console.error(`check:db-drift — ${label}: MISMATCH.\n`);
  console.error(output);
  return false;
}

function main() {
  let schemaVsHistory: string;
  let historyVsDatabase: string;
  try {
    // (a) schema.prisma <-> migration history
    schemaVsHistory = runDiff(["--from-migrations", "prisma/migrations", "--to-schema", "prisma/schema.prisma"]);
    // (b) migration history <-> live database (DATABASE_URL)
    historyVsDatabase = runDiff(["--from-migrations", "prisma/migrations", "--to-config-datasource"]);
  } catch (error) {
    console.error("check:db-drift — could not compute one of the diffs (see output above).");
    throw error;
  }

  const aClean = report("schema.prisma vs migration history", schemaVsHistory);
  const bClean = report("migration history vs live database", historyVsDatabase);

  if (!aClean) {
    console.error(
      "\nschema.prisma declares something the migration history doesn't produce — someone edited the " +
        "schema without generating a migration for it. Run `prisma migrate dev` to generate the missing one.",
    );
  }
  if (!bClean) {
    console.error(
      "\nThis database's live structure doesn't match what the migration history produces — a manual " +
        "ALTER TABLE, `prisma db push`, or a hand-edited migration that was never replayed here. Write a " +
        "real migration for the intended change, or investigate how this database diverged — never paper " +
        "over this by re-running the same broken migration against a fresh database.",
    );
  }

  if (!aClean || !bClean) {
    process.exit(1);
  }
}

main();
