import { parseDatabaseTarget } from "./database-url";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

/**
 * The deterministic seed (prisma/seed.ts) creates accounts with known,
 * fixed passwords — a real login, not a mess, if it ever ran against a
 * production or unknown database. Called at the very top of the seed's
 * main(), before any write, against whatever URL `prisma db seed` resolved
 * (prisma7.config.ts's datasource reads process.env.DATABASE_URL).
 *
 * Refuses to proceed unless the target is explicitly local
 * (localhost/127.0.0.1/::1) or its database name contains "test" — the same
 * "test" heuristic scripts/lib/test-database-guard.ts uses, kept as an
 * independent rule here since the seed can be invoked directly against
 * DATABASE_URL (the local dev database) as well as against TEST_DATABASE_URL.
 */
export function assertSafeSeedTarget(databaseUrl: string): void {
  const target = parseDatabaseTarget(databaseUrl);
  const isLocalHost = LOCAL_HOSTS.has(target.hostname);
  const looksLikeTestDb = /test/i.test(target.database);

  if (!isLocalHost && !looksLikeTestDb) {
    throw new Error(
      `Refusing to seed known-password accounts into ${target.hostname}:${target.port}/${target.database} — ` +
        `this seed only runs against an explicitly local host (localhost/127.0.0.1) or a database whose name ` +
        `contains "test". A seed like this reaching any other database is a backdoor admin account, not a mess.`,
    );
  }
}
