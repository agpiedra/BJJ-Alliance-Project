import { parseDatabaseTarget, sameTarget } from "./database-url";

/**
 * Resolves and guards the integration-test database target. Throws loudly —
 * never a silent fallback — if:
 *  - TEST_DATABASE_URL is missing (DATABASE_URL is never used as a fallback);
 *  - it resolves to the same host+port+database as DATABASE_URL, compared
 *    structurally (not string equality), so a trailing slash or a stray
 *    query param can't slip a dev URL past this guard;
 *  - its database name doesn't look like a test database (must contain
 *    "test", case-insensitively) — independent of whether DATABASE_URL is
 *    even set, since CI may not export it at all.
 *
 * Used by tests/integration-setup.ts (vitest) and scripts/run-against-test-db.ts
 * (migrate/seed against the test database) so both paths enforce one rule.
 *
 * Memoized per process: tests/integration-setup.ts calls this BEFORE
 * redirecting process.env.DATABASE_URL to the same guarded value, and
 * tests/helpers/test-db.ts calls it again AFTER that redirect — by then
 * DATABASE_URL legitimately equals TEST_DATABASE_URL (that's the redirect
 * working as designed), so re-running the "must not match DATABASE_URL"
 * check at that point would compare the guard's own prior output against
 * itself and refuse a target it already approved. Caching the first
 * successful result sidesteps that without weakening the check itself.
 */
let cachedTestDatabaseUrl: string | undefined;

export function resolveGuardedTestDatabaseUrl(): string {
  if (cachedTestDatabaseUrl) return cachedTestDatabaseUrl;

  const testUrl = process.env.TEST_DATABASE_URL;
  if (!testUrl) {
    throw new Error(
      "TEST_DATABASE_URL is required to run integration tests or migrate/seed the test database. " +
        "It is never inferred from DATABASE_URL.",
    );
  }

  const test = parseDatabaseTarget(testUrl);

  const devUrl = process.env.DATABASE_URL;
  if (devUrl) {
    const dev = parseDatabaseTarget(devUrl);
    if (sameTarget(test, dev)) {
      throw new Error(
        `Refusing to proceed: TEST_DATABASE_URL resolves to the same database as DATABASE_URL ` +
          `(${test.hostname}:${test.port}/${test.database}). Point TEST_DATABASE_URL at a separate database.`,
      );
    }
  }

  if (!/test/i.test(test.database)) {
    throw new Error(
      `Refusing to proceed: TEST_DATABASE_URL's database name ("${test.database}") doesn't look like a test ` +
        `database (expected it to contain "test"). Target was: ${test.hostname}:${test.port}/${test.database}`,
    );
  }

  cachedTestDatabaseUrl = testUrl;
  return testUrl;
}

/**
 * The environment for any child process (a `prisma` CLI call, the seed) that
 * must run against the guarded test database.
 *
 * Redirecting `DATABASE_URL` alone is no longer enough: prisma7.config.ts
 * lets `DIRECT_URL` take precedence for the CLI (migrations must go direct
 * once the app is behind a pooler), so an ambient `DIRECT_URL` — for example
 * a production string left in the shell after running `migrate deploy` by
 * hand — would silently win and aim these commands at the wrong database.
 * Dropping it here means test-database commands can never be redirected by
 * it. (prisma-cli-url.ts additionally refuses when the two name different
 * databases, as the backstop for any call site that forgets to use this.)
 */
export function testDatabaseChildEnv(
  testUrl: string,
  baseEnv: Record<string, string | undefined> = process.env,
): NodeJS.ProcessEnv {
  const env: Record<string, string | undefined> = { ...baseEnv, DATABASE_URL: testUrl };
  delete env.DIRECT_URL;
  return env as NodeJS.ProcessEnv;
}

/** Test-support only — resets the memoization above so a test file can
 * exercise the guard fresh across multiple env-var scenarios in one process. */
export function __resetGuardedTestDatabaseUrlCacheForTests(): void {
  cachedTestDatabaseUrl = undefined;
}
