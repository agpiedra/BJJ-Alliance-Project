import "dotenv/config";
import tls from "node:tls";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabasePool, createPrismaClient } from "../../src/lib/prisma/database-pool";
import { resolveGuardedTestDatabaseUrl } from "../../scripts/lib/test-database-guard";
import { startTlsPostgresProxy, tlsFixture } from "../helpers/tls-postgres-proxy";

/**
 * The app's TLS to the database, exercised end to end against a real
 * Postgres through a TLS front (tests/helpers/tls-postgres-proxy.ts). Each
 * behaviour below was first verified by hand against a real TLS Postgres
 * with a private CA; this pins it, because node-postgres 9 changes its SSL
 * semantics and a silent regression here means unverified or plaintext
 * connections carrying every tenant's data.
 *
 * Two mechanisms matter and neither is obvious:
 *  - the URL's `sslmode` OVERRIDES the Pool's `ssl` option (and drops the CA);
 *  - with an IP host, Node checks the certificate against "localhost".
 */
const upstream = new URL(resolveGuardedTestDatabaseUrl());
const base64 = (fixture: string) => Buffer.from(tlsFixture(fixture)).toString("base64");

let good: Awaited<ReturnType<typeof startTlsPostgresProxy>>;
let wrongName: Awaited<ReturnType<typeof startTlsPostgresProxy>>;

/** The test database, reached through the TLS front on `port`, by DNS name. */
function urlVia(port: number): string {
  const url = new URL(upstream);
  url.hostname = "localhost";
  url.port = String(port);
  url.search = "";
  return url.toString();
}

async function tlsSession(port: number, tlsEnv: Record<string, string>) {
  const pool = createDatabasePool({ DATABASE_URL: urlVia(port), ...tlsEnv });
  try {
    const client = await pool.connect();
    try {
      const { rows } = await client.query<{ ok: number }>("select 1 as ok");
      // pg swaps its socket for a TLSSocket after the SSLRequest is accepted.
      const stream = (client as unknown as { connection: { stream: unknown } }).connection.stream;
      const secure = stream instanceof tls.TLSSocket;
      return { ok: rows[0].ok, encrypted: secure && stream.encrypted, authorized: secure && stream.authorized };
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

describe("database TLS", () => {
  beforeAll(async () => {
    const target = { host: upstream.hostname, port: Number(upstream.port || 5432) };
    good = await startTlsPostgresProxy({ serverCert: "server-localhost", upstream: target });
    wrongName = await startTlsPostgresProxy({ serverCert: "server-wrongname", upstream: target });
  });

  afterAll(async () => {
    await good.close();
    await wrongName.close();
  });

  it("REQUIRED: with the CA configured, the session is encrypted AND the certificate verified", async () => {
    const session = await tlsSession(good.port, { DATABASE_SSL_CA_B64: base64("test-ca.crt") });
    expect(session).toEqual({ ok: 1, encrypted: true, authorized: true });
  });

  it("REQUIRED: refuses a certificate from a CA you did not configure", async () => {
    await expect(tlsSession(good.port, { DATABASE_SSL_CA_B64: base64("other-ca.crt") })).rejects.toThrow(
      /unable to verify the first certificate|self.signed|unable to get local issuer/i,
    );
  });

  it("REQUIRED: refuses a certificate the right CA signed but that does not name the host — the chain alone is not identity", async () => {
    await expect(tlsSession(wrongName.port, { DATABASE_SSL_CA_B64: base64("test-ca.crt") })).rejects.toThrow(
      /does not match certificate's altnames/,
    );
  });

  it("the no-verify fallback encrypts but authenticates nothing — it accepts the wrong-name certificate", async () => {
    const session = await tlsSession(wrongName.port, { DATABASE_SSL_MODE: "no-verify" });
    expect(session).toEqual({ ok: 1, encrypted: true, authorized: false });
  });

  it("CONTROL: a URL sslmode next to ssl:{ca} DOES discard the CA — so the resolver's refusal of URL TLS parameters is load-bearing", async () => {
    // If node-postgres ever merges these instead of overriding, this fails and
    // the guard in database-ssl.ts can be relaxed. Until then it is the reason
    // DATABASE_URL must carry no TLS parameters.
    const pool = new Pool({
      connectionString: `${urlVia(good.port)}?sslmode=verify-full`,
      ssl: { ca: tlsFixture("test-ca.crt"), rejectUnauthorized: true },
    });
    try {
      await expect(pool.query("select 1")).rejects.toThrow(/unable to verify the first certificate|self.signed|unable to get local issuer/i);
    } finally {
      await pool.end();
    }
  });

  it("REQUIRED: the app's real Prisma client runs its queries over the verified TLS connection", async () => {
    const prisma = createPrismaClient({ DATABASE_URL: urlVia(good.port), DATABASE_SSL_CA_B64: base64("test-ca.crt") });
    try {
      expect(await prisma.organization.count()).toBeGreaterThanOrEqual(0);
    } finally {
      await prisma.$disconnect();
    }
  });
});
