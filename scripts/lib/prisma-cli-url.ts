import { parseDatabaseTarget } from "./database-url";

/**
 * Which connection string the Prisma CLI (`migrate deploy`, `migrate diff`,
 * `db seed`'s own bookkeeping — everything prisma7.config.ts's `datasource.url`
 * drives) should use.
 *
 * Two different jobs need two different connections once a pooler is in
 * front of the database. The running app talks through the pooler
 * (`DATABASE_URL`); migrations need real session-level behaviour (advisory
 * locks, DDL) that a transaction-mode pooler does not give them, so they go
 * direct (`DIRECT_URL`). Prisma 7 removed `url`/`directUrl` from the schema's
 * `datasource` block — this config file is where the CLI's URL lives now, and
 * `DIRECT_URL` is the convention Prisma's own driver-adapter docs use for it.
 *
 * `DIRECT_URL` unset (local dev, CI) falls back to `DATABASE_URL` — one
 * database reached one way, exactly as before this existed.
 *
 * The guard: several scripts and test fixtures redirect ONLY `DATABASE_URL`
 * to the test database before shelling out to Prisma. A stale ambient
 * `DIRECT_URL` (say, a production string left in the shell after running
 * `migrate deploy` by hand) would silently win over that redirect and aim
 * migrations at the wrong database. A legitimate pooled/direct pair is one
 * database reached two ways, so both always name the SAME database; refusing
 * when they differ turns that silent misdirection into an immediate error.
 */
export function resolveCliDatabaseUrl(env: Record<string, string | undefined> = process.env): string | undefined {
  const direct = env.DIRECT_URL?.trim() || undefined;
  const pooled = env.DATABASE_URL?.trim() || undefined;

  if (!direct) return pooled;
  if (!pooled) return direct;

  const directDatabase = databaseNameOf("DIRECT_URL", direct);
  const pooledDatabase = databaseNameOf("DATABASE_URL", pooled);
  if (directDatabase !== pooledDatabase) {
    throw new Error(
      `Refusing to run the Prisma CLI: DIRECT_URL names database "${directDatabase}" but DATABASE_URL names ` +
        `"${pooledDatabase}". DIRECT_URL and DATABASE_URL must be the SAME database reached two ways (direct vs. ` +
        `through the pooler). If you are pointing DATABASE_URL at a different database on purpose (for example the ` +
        `test database), unset DIRECT_URL for that command — otherwise the CLI would silently target DIRECT_URL.`,
    );
  }
  return direct;
}

function databaseNameOf(variable: string, url: string): string {
  try {
    return parseDatabaseTarget(url).database;
  } catch {
    throw new Error(`${variable} is not a valid connection URL.`);
  }
}
