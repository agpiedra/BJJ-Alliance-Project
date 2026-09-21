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
  if (!pooled) return requireExplicitCertificateHandling(direct);

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
  return requireExplicitCertificateHandling(direct);
}

const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1"]);

/**
 * Only for `DIRECT_URL` — the URL an operator deliberately points at a real
 * database to migrate it.
 *
 * On the Prisma CLI's own connection path, `sslmode` does NOT verify the
 * server's certificate: verified against a real TLS Postgres with a private
 * CA, `sslmode=require` and even `sslmode=verify-full` connected with a WRONG
 * CA (encrypted, unauthenticated). Only `sslaccept=strict` checks the chain and
 * the hostname (accepts the right CA via `sslcert=<file>`, refuses a wrong one
 * or a certificate that doesn't name the host). That is the same engine-vs-
 * driver trap as `pgbouncer=true`, reversed: a URL that reads as "verified"
 * and isn't. So a remote DIRECT_URL must state its certificate handling
 * explicitly instead of inheriting the silent default. (The `DATABASE_URL`
 * fallback is exempt: it is the local/CI path, and `prisma generate` — which
 * never connects — also loads this file, e.g. on Vercel with a remote URL.)
 */
function requireExplicitCertificateHandling(direct: string): string {
  let url: URL;
  try {
    url = new URL(direct);
  } catch {
    throw new Error("DIRECT_URL is not a valid connection URL.");
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const accept = url.searchParams.get("sslaccept");
  if (!LOCAL_HOSTNAMES.has(hostname) && accept !== "strict" && accept !== "accept_invalid_certs") {
    throw new Error(
      `DIRECT_URL points at "${hostname}" but sets no sslaccept, so the Prisma CLI would connect without verifying the ` +
        "server's certificate — sslmode alone does not verify it, even sslmode=verify-full. Add " +
        "`sslaccept=strict&sslcert=<path to the database CA file>` to verify (see docs/DEPLOYMENT_RUNBOOK.md, step 5), or " +
        "`sslaccept=accept_invalid_certs` to skip verification knowingly (temporary fallback).",
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
