/**
 * Post-deploy verification of the production database connection.
 * docs/DEPLOYMENT_RUNBOOK.md, "Verify pooling and TLS", is the step that runs it.
 *
 *   DATABASE_URL=<pooled string> DATABASE_SSL_CA_B64=<...> pnpm verify:pooling
 *   ... pnpm verify:pooling --app-url=https://<your-domain>/es/kiosk/<academy-slug>
 *
 * Revision 30/31 of the spec found, against a real PgBouncer, that this app's
 * pooling is safe by construction — and the first deploy is the first time it
 * meets Supavisor. This finds out from a script run deliberately, not from a
 * director mid-class. Same shape as tests/integration/no-named-prepared-
 * statements.test.ts (a REQUIRED path and a CONTROL), pointed at the real pooler.
 *
 * It builds its pool and client with the app's own factories
 * (src/lib/prisma/database-pool.ts), so what it proves is about the app's
 * real configuration, not a copy of it.
 *
 * Read-only: SELECTs and one organization count. Never prints credentials.
 */
import "dotenv/config";
import { createHash } from "node:crypto";
import tls from "node:tls";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";
import { createDatabasePool, createPrismaClient } from "../src/lib/prisma/database-pool";

// Verify production semantics: with NODE_ENV unset, the app's TLS resolver
// (correctly) leaves a remote host to node-postgres' plaintext default — which
// would let this script pass a configuration production refuses to start with.
// (Read at call time by the resolver, so setting it after the imports is fine.)
(process.env as Record<string, string | undefined>).NODE_ENV ??= "production";

const APP_QUERIES = 300;
const TRANSACTIONS = 60;
const CONTROL_QUERIES = 120;
const APP_REQUESTS = 90;

type Failure = { code: string; message: string };

// Set when TLS is running on the temporary no-verify fallback, so the final
// line can never read the same as a fully verified run.
let usingFallback = false;

function failureOf(error: unknown): Failure {
  const message = error instanceof Error ? error.message : String(error);
  const code = message.match(/\b(42P05|26000|08P01|53300|57P01|08006|XX000)\b/)?.[1] ?? "other";
  return { code, message: message.replace(/\s+/g, " ").slice(0, 200) };
}

function summarize(failures: Failure[]): string {
  const byCode = new Map<string, number>();
  for (const failure of failures) byCode.set(failure.code, (byCode.get(failure.code) ?? 0) + 1);
  const counts = [...byCode].map(([code, n]) => `${code}×${n}`).join(", ");
  return `${counts} — e.g. "${failures[0].message}"`;
}

function hintForConnectError(message: string): string {
  if (/unable to verify|self.signed|local issuer/i.test(message)) {
    return "The database certificate is not trusted by DATABASE_SSL_CA_B64. Wrong file, or the wrong base64 (runbook: SSL to the pooler).";
  }
  if (/altnames/i.test(message)) {
    return "The certificate chain is trusted but does not name this host. See the runbook's SSL fallback before changing anything.";
  }
  if (/Tenant or user not found/i.test(message)) {
    return "Supavisor rejected the user. The pooled string's user is `postgres.<project-ref>`, not plain `postgres`.";
  }
  if (/password authentication failed/i.test(message)) return "Wrong database password.";
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT/i.test(message)) return "Cannot reach the host:port — check the pooled string (port 6543).";
  return "See the message above and the runbook's failure list.";
}

async function main(): Promise<boolean> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is not set. Point it at the POOLED production connection string.");
    return false;
  }
  const target = new URL(url);
  const host = target.hostname;
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(host);
  const tlsConfig = process.env.DATABASE_SSL_CA_B64?.trim()
    ? "DATABASE_SSL_CA_B64 (full verification)"
    : process.env.DATABASE_SSL_MODE?.trim()
      ? `DATABASE_SSL_MODE=${process.env.DATABASE_SSL_MODE.trim()} (FALLBACK, unverified)`
      : "none";
  console.log(`Target: ${host}:${target.port || "5432"}${target.pathname}   TLS config: ${tlsConfig}`);
  if (local) {
    // dotenv loads .env: forgetting DATABASE_URL on the command line silently
    // tests the dev database instead of production.
    console.log("NOTE: the target is a LOCAL database, so this run says nothing about production.");
  }
  console.log("");

  let ok = true;

  // 1. Connect the way the app does, and inspect the TLS session.
  const probePool = createDatabasePool();
  try {
    const client = await probePool.connect();
    const stream = (client as unknown as { connection: { stream: unknown } }).connection.stream;
    client.release();
    if (stream instanceof tls.TLSSocket && stream.encrypted) {
      if (stream.authorized) {
        console.log("[1/4] TLS      PASS  encrypted, server certificate verified");
      } else if (process.env.DATABASE_SSL_MODE === "no-verify") {
        usingFallback = true;
        console.log("[1/4] TLS      WARN  encrypted but the certificate is NOT verified (DATABASE_SSL_MODE=no-verify is a temporary fallback)");
      } else {
        console.log("[1/4] TLS      FAIL  encrypted but the certificate did not verify");
        ok = false;
      }
    } else if (local) {
      console.log("[1/4] TLS      INFO  plaintext to a local database (expected in dev)");
    } else {
      console.log("[1/4] TLS      FAIL  the connection is NOT encrypted");
      ok = false;
    }
  } catch (error) {
    const { message } = failureOf(error);
    console.log(`[1/4] TLS      FAIL  could not connect: ${message}\n      -> ${hintForConnectError(message)}`);
    await probePool.end().catch(() => {});
    return false;
  }
  await probePool.end();

  // 2. The app's real client under concurrency. REQUIRED: zero failures, and
  // every result is the answer to ITS OWN query (a pooler that crossed
  // sessions would return someone else's row).
  const prisma = createPrismaClient();
  try {
    try {
      await prisma.organization.count();
    } catch (error) {
      const { message } = failureOf(error);
      console.log(`[2/4] APP LOAD FAIL  the schema is not readable (were migrations applied — runbook step 5?): ${message}`);
      return false;
    }

    const failures: Failure[] = [];
    const pids = new Set<number>();
    const queries = Array.from({ length: APP_QUERIES }, async (_, i) => {
      try {
        const [row] = await prisma.$queryRaw<Array<{ n: number; pid: number }>>`select ${i}::int as n, pg_backend_pid()::int as pid`;
        if (row.n !== i) throw new Error(`crossed result: asked for ${i}, got ${row.n}`);
        pids.add(row.pid);
      } catch (error) {
        failures.push(failureOf(error));
      }
    });
    const transactions = Array.from({ length: TRANSACTIONS }, async () => {
      try {
        await prisma.$transaction(async (tx) => {
          await tx.organization.count();
          await tx.user.count();
        });
      } catch (error) {
        failures.push(failureOf(error));
      }
    });
    await Promise.all([...queries, ...transactions]);

    const total = APP_QUERIES + TRANSACTIONS;
    if (failures.length === 0) {
      console.log(`[2/4] APP LOAD PASS  ${total}/${total} concurrent queries and transactions succeeded (${pids.size} distinct backend connections seen)`);
    } else {
      console.log(`[2/4] APP LOAD FAIL  ${failures.length}/${total} failed: ${summarize(failures)}`);
      ok = false;
    }
  } finally {
    await prisma.$disconnect();
  }

  // 3. CONTROL: opt in to named prepared statements, the one thing that breaks
  // a transaction-mode pooler. Informational — it shows whether THIS pooler
  // can express the failure at all. On PgBouncer it failed 110 of 120.
  const controlPool = createDatabasePool();
  const control = new PrismaClient({
    adapter: new PrismaPg(controlPool, {
      disposeExternalPool: true,
      statementNameGenerator: (query) => `vp_${createHash("md5").update(query.sql).digest("hex")}`,
    }),
  });
  try {
    const failures: Failure[] = [];
    await Promise.all(
      Array.from({ length: CONTROL_QUERIES }, async (_, i) => {
        try {
          await control.$queryRaw`select ${i}::int as n`;
        } catch (error) {
          failures.push(failureOf(error));
        }
      }),
    );
    if (failures.length > 0) {
      console.log(`[3/4] CONTROL  INFO  named prepared statements DO break this pooler (${failures.length}/${CONTROL_QUERIES}: ${summarize(failures)}) — so [2/4] passing is meaningful.`);
    } else {
      console.log(`[3/4] CONTROL  INFO  named prepared statements did NOT fail here (0/${CONTROL_QUERIES}). This pooler tolerates them; the app never uses them, so [2/4] holds either way, but the control could not demonstrate the failure.`);
    }
  } finally {
    await control.$disconnect();
  }

  // 4. Optional: the deployed app itself — many cold function instances, each
  // with its own pool, which is the actual production connection-exhaustion shape.
  const appUrl = process.argv.find((arg) => arg.startsWith("--app-url="))?.slice("--app-url=".length);
  if (!appUrl) {
    console.log("[4/4] APP URL  SKIP  no --app-url given (pass a public page that reads the database, e.g. an academy's kiosk page)");
  } else {
    const statuses = new Map<string, number>();
    await Promise.all(
      Array.from({ length: APP_REQUESTS }, async () => {
        try {
          const res = await fetch(appUrl, { redirect: "manual" });
          statuses.set(String(res.status), (statuses.get(String(res.status)) ?? 0) + 1);
        } catch (error) {
          const key = `error:${failureOf(error).message.slice(0, 40)}`;
          statuses.set(key, (statuses.get(key) ?? 0) + 1);
        }
      }),
    );
    const histogram = [...statuses].map(([status, n]) => `${status}×${n}`).join(", ");
    if (statuses.size === 1 && statuses.has("200")) {
      console.log(`[4/4] APP URL  PASS  ${APP_REQUESTS}/${APP_REQUESTS} concurrent requests returned 200`);
    } else {
      console.log(`[4/4] APP URL  FAIL  ${histogram} (expected all 200 — a 404 means the URL is wrong, a 5xx means the deployment cannot reach the database)`);
      ok = false;
    }
  }

  return ok;
}

main()
  .then((ok) => {
    const verdict = !ok
      ? "FAIL"
      : usingFallback
        ? "PASS, ON THE TEMPORARY no-verify FALLBACK — the server is not authenticated; not done until DATABASE_SSL_CA_B64 replaces it (runbook: SSL fallback)"
        : "PASS";
    console.log(`\nRESULT: ${verdict}`);
    process.exit(ok ? 0 : 1);
  })
  .catch((error) => {
    console.error(`\nRESULT: FAIL — ${failureOf(error).message}`);
    process.exit(1);
  });
