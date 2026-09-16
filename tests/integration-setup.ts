import "dotenv/config";
import { resolveGuardedTestDatabaseUrl } from "../scripts/lib/test-database-guard";

/**
 * Runs once per test FILE (vitest setupFiles), before that file's own
 * top-level imports execute. Application code under test (route handlers,
 * server actions, lib modules) reads DATABASE_URL through the app's own
 * @/lib/prisma singleton at import time — it is not dependency-injected —
 * so redirecting the env var here, only after resolveGuardedTestDatabaseUrl
 * has verified the target is a genuine, separate test database, is what
 * keeps that singleton off the dev database during a test run without a
 * repo-wide refactor.
 */
process.env.DATABASE_URL = resolveGuardedTestDatabaseUrl();
