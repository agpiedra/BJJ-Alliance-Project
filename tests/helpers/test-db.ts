import { PrismaClient } from "../../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { resolveGuardedTestDatabaseUrl } from "../../scripts/lib/test-database-guard";

let testPrisma: PrismaClient | undefined;

/**
 * The one explicit Prisma client integration tests use for their own fixture
 * setup/teardown and assertions — built from the guarded TEST_DATABASE_URL,
 * never from the ambient DATABASE_URL. Replaces the per-file
 * `new PrismaClient({ adapter: new PrismaPg({ connectionString: requireEnv("DATABASE_URL") }) })`
 * that every integration test file used to duplicate.
 *
 * tests/integration-setup.ts (vitest setupFiles) has already overwritten
 * process.env.DATABASE_URL to this same guarded value by the time any test
 * file's top-level code runs, so application code under test (route
 * handlers, server actions) that imports the app's own @/lib/prisma
 * singleton also lands on the test database — not because it was left to
 * chance, but because the redirect happens only after this guard has
 * verified the target.
 */
export function getTestPrismaClient(): PrismaClient {
  if (!testPrisma) {
    const adapter = new PrismaPg({ connectionString: resolveGuardedTestDatabaseUrl() });
    testPrisma = new PrismaClient({ adapter });
  }
  return testPrisma;
}
