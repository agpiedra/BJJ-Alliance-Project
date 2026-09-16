/** Shared connection-string parsing for every database-target safety guard
 * in this repo (test-database guard, seed safety guard, migration runner).
 * One implementation so a parsing quirk (trailing slash, stray query param)
 * can't cause two guards to disagree about what a URL points at. */
export interface DatabaseTarget {
  hostname: string;
  port: string;
  database: string;
}

export function parseDatabaseTarget(databaseUrl: string): DatabaseTarget {
  const parsed = new URL(databaseUrl);
  return {
    hostname: parsed.hostname,
    port: parsed.port || "5432",
    database: parsed.pathname.replace(/^\/+/, "").replace(/\/+$/, ""),
  };
}

export function sameTarget(a: DatabaseTarget, b: DatabaseTarget): boolean {
  return a.hostname === b.hostname && a.port === b.port && a.database === b.database;
}
