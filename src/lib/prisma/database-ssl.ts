import { isIP } from "node:net";
import type { PoolConfig } from "pg";

type Env = Record<string, string | undefined>;

/**
 * Query parameters `pg` turns into an `ssl` config when it parses the URL.
 * Verified against pg 8.23 (see docs/DEPLOYMENT_RUNBOOK.md, "Connection
 * pooling"): whatever the URL parses to OVERRIDES the Pool's own options
 * (`Object.assign({}, config, parse(config.connectionString))`), so a URL
 * `sslmode=verify-full` next to `ssl: { ca }` silently throws the CA away and
 * fails with "unable to verify the first certificate".
 */
const URL_TLS_PARAMS = ["ssl", "sslmode", "sslcert", "sslkey", "sslrootcert", "uselibpqcompat"];

const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1"]);

/**
 * The `ssl` option for the app's pg Pool — the ONE place TLS to the database
 * is decided.
 *
 * The connection string's `sslmode` is a libpq parameter that node-postgres
 * only partly honours, and it is not where this is configured: TLS comes from
 * two env vars, applied through the Pool's `ssl` option.
 *
 *  - `DATABASE_SSL_CA_B64` — the database provider's CA certificate (a public
 *    certificate, not a secret), base64-encoded. Full verification: the chain
 *    must lead to this CA AND the certificate must name the host. Rotation is
 *    a config change, not a code change.
 *  - `DATABASE_SSL_MODE=no-verify` — the documented TEMPORARY fallback:
 *    encrypted, but authenticates nothing. Warns on every start. Its exit
 *    condition lives in docs/DEPLOYMENT_RUNBOOK.md ("SSL fallback").
 *
 * Returns `undefined` (leave it to `pg`'s own URL handling) only where that
 * cannot silently mean plaintext to a remote database: outside production, or
 * for a local host.
 */
export function resolveDatabaseSsl(connectionString: string, env: Env = process.env): PoolConfig["ssl"] {
  const caBase64 = env.DATABASE_SSL_CA_B64?.trim() || undefined;
  const mode = env.DATABASE_SSL_MODE?.trim() || undefined;

  if (caBase64 && mode) {
    throw new Error(
      "DATABASE_SSL_CA_B64 and DATABASE_SSL_MODE are both set. Set only one: the CA (full verification) or " +
        "DATABASE_SSL_MODE=no-verify (temporary fallback).",
    );
  }
  if (mode && mode !== "no-verify") {
    throw new Error(`DATABASE_SSL_MODE="${mode}" is not supported; the only value is "no-verify".`);
  }

  const { hostname, params } = parseConnectionString(connectionString);

  if (!caBase64 && !mode) {
    if (env.NODE_ENV === "production" && !LOCAL_HOSTNAMES.has(hostname)) {
      throw new Error(
        `Refusing to connect to "${hostname}" without TLS configuration in production: with no ssl option, node-postgres ` +
          "connects in PLAINTEXT and the database accepts it. Set DATABASE_SSL_CA_B64 to the database CA certificate, " +
          "base64-encoded (docs/DEPLOYMENT_RUNBOOK.md, \"SSL to the pooler\"), or, as an explicit temporary fallback, " +
          "DATABASE_SSL_MODE=no-verify.",
      );
    }
    return undefined;
  }

  const conflicting = URL_TLS_PARAMS.filter((name) => params.has(name));
  if (conflicting.length > 0) {
    throw new Error(
      `DATABASE_URL carries TLS parameter(s) [${conflicting.join(", ")}] while TLS is configured through ` +
        "DATABASE_SSL_CA_B64 / DATABASE_SSL_MODE. node-postgres lets URL parameters override the Pool's ssl option, " +
        "which would silently discard the CA. Remove them from DATABASE_URL.",
    );
  }

  if (mode) {
    console.warn(
      "[database] DATABASE_SSL_MODE=no-verify: the connection is encrypted but the server's certificate is NOT verified. " +
        'This is a temporary fallback — see docs/DEPLOYMENT_RUNBOOK.md, "SSL fallback", for what has to happen to remove it.',
    );
    return { rejectUnauthorized: false };
  }

  // node-postgres sets the TLS servername only for DNS hosts; with an IP host
  // Node validates the certificate against the literal name "localhost"
  // instead, so "verified" would not mean what it says.
  if (isIP(hostname)) {
    throw new Error(
      `DATABASE_URL uses the IP address ${hostname}. Certificate verification needs the database's DNS hostname: ` +
        "with an IP host node-postgres checks the certificate against \"localhost\", not the address.",
    );
  }

  return { ca: decodeCaCertificate(caBase64!), rejectUnauthorized: true };
}

function decodeCaCertificate(caBase64: string): string {
  const pem = Buffer.from(caBase64, "base64").toString("utf8");
  if (!pem.includes("-----BEGIN CERTIFICATE-----")) {
    throw new Error(
      "DATABASE_SSL_CA_B64 does not decode to a PEM certificate. It must be the CA certificate FILE, base64-encoded " +
        "(for example `base64 -w0 ca.crt`), not the PEM text itself.",
    );
  }
  return pem;
}

function parseConnectionString(connectionString: string): { hostname: string; params: URLSearchParams } {
  try {
    const url = new URL(connectionString);
    return { hostname: url.hostname.replace(/^\[|\]$/g, "").toLowerCase(), params: url.searchParams };
  } catch {
    throw new Error("DATABASE_URL is not a valid connection URL.");
  }
}
