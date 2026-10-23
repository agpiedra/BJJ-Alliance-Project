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
// [2/5] keeps at most this many operations in flight: the app pool's size (pg's default `max`,
// createDatabasePool sets none). The pooler sees the same 10 concurrent connections either way;
// the bound only stops operations queueing on THIS machine. Unbounded, 300 queries hold all 10
// connections for ~30 round trips, so from an operator machine past ~60 ms RTT every transaction
// exceeds Prisma's default 2000 ms maxWait (which covers pool.connect + BEGIN) — measured against a
// local database behind a delay proxy, no pooler involved. [3/5] still runs that original shape.
const IN_FLIGHT = 10;

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

// Runs every task; with `limit`, at most that many at once (workers pulling from a shared queue).
async function runAll(tasks: Array<() => Promise<void>>, limit = tasks.length): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, tasks.length) }, async () => {
      while (next < tasks.length) await tasks[next++]();
    }),
  );
}

// 300 queries + 60 interactive transactions through the app's real client (a fresh one, warmed
// by one count as before). Each query must return ITS OWN answer: a pooler that crossed
// sessions would return someone else's row. Unbounded: every operation starts at once, queries
// first — the original shape. Bounded: at most `limit` in flight, one transaction after every
// five queries so the two kinds still overlap.
async function appLoad(limit?: number): Promise<{ failures: Failure[]; pids: Set<number> } | { unreadable: string }> {
  const prisma = createPrismaClient();
  try {
    try {
      await prisma.organization.count();
    } catch (error) {
      return { unreadable: failureOf(error).message };
    }
    const failures: Failure[] = [];
    const pids = new Set<number>();
    const queries = Array.from({ length: APP_QUERIES }, (_, i) => async () => {
      try {
        const [row] = await prisma.$queryRaw<Array<{ n: number; pid: number }>>`select ${i}::int as n, pg_backend_pid()::int as pid`;
        if (row.n !== i) throw new Error(`crossed result: asked for ${i}, got ${row.n}`);
        pids.add(row.pid);
      } catch (error) {
        failures.push(failureOf(error));
      }
    });
    const transactions = Array.from({ length: TRANSACTIONS }, () => async () => {
      try {
        await prisma.$transaction(async (tx) => {
          await tx.organization.count();
          await tx.user.count();
        });
      } catch (error) {
        failures.push(failureOf(error));
      }
    });
    const perTransaction = APP_QUERIES / TRANSACTIONS;
    const tasks = limit
      ? queries.flatMap((query, i) => ((i + 1) % perTransaction === 0 ? [query, transactions[(i + 1) / perTransaction - 1]] : [query]))
      : [...queries, ...transactions];
    await runAll(tasks, limit);
    return { failures, pids };
  } finally {
    await prisma.$disconnect();
  }
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
        console.log("[1/5] TLS      PASS  encrypted, server certificate verified");
      } else if (process.env.DATABASE_SSL_MODE === "no-verify") {
        usingFallback = true;
        console.log("[1/5] TLS      WARN  encrypted but the certificate is NOT verified (DATABASE_SSL_MODE=no-verify is a temporary fallback)");
      } else {
        console.log("[1/5] TLS      FAIL  encrypted but the certificate did not verify");
        ok = false;
      }
    } else if (local) {
      console.log("[1/5] TLS      INFO  plaintext to a local database (expected in dev)");
    } else {
      console.log("[1/5] TLS      FAIL  the connection is NOT encrypted");
      ok = false;
    }
  } catch (error) {
    const { message } = failureOf(error);
    console.log(`[1/5] TLS      FAIL  could not connect: ${message}\n      -> ${hintForConnectError(message)}`);
    await probePool.end().catch(() => {});
    return false;
  }
  await probePool.end();

  // 2. ACCEPTANCE: the app's real client, IN_FLIGHT operations in flight. REQUIRED: zero
  // failures and no crossed results. This is a CHANGED workload, not the original one passing:
  // the original (every operation started at once) is [3/5], reported but not gating.
  const total = APP_QUERIES + TRANSACTIONS;
  const acceptance = await appLoad(IN_FLIGHT);
  if ("unreadable" in acceptance) {
    console.log(`[2/5] APP LOAD FAIL  the schema is not readable (were migrations applied — runbook step 5?): ${acceptance.unreadable}`);
    return false;
  }
  if (acceptance.failures.length === 0) {
    console.log(`[2/5] APP LOAD PASS  ${total}/${total} queries and transactions succeeded, ${IN_FLIGHT} in flight (${acceptance.pids.size} distinct backend connections seen)`);
  } else {
    console.log(`[2/5] APP LOAD FAIL  ${acceptance.failures.length}/${total} failed (${IN_FLIGHT} in flight): ${summarize(acceptance.failures)}`);
    ok = false;
  }

  // 3. STRESS (information): the ORIGINAL shape — all operations started at once. Its result
  // depends on this machine's round-trip time to the database (see IN_FLIGHT), so it never
  // decides RESULT; a failure here is a result about the local queue, recorded as such.
  const stress = await appLoad();
  if ("unreadable" in stress) {
    console.log(`[3/5] STRESS   INFO  not run: ${stress.unreadable}`);
  } else if (stress.failures.length === 0) {
    console.log(`[3/5] STRESS   INFO  unbounded: ${total}/${total} started at once succeeded (${stress.pids.size} distinct backend connections seen)`);
  } else {
    console.log(`[3/5] STRESS   INFO  unbounded: ${stress.failures.length}/${total} failed: ${summarize(stress.failures)} — the original unbounded test FAILS here; it is reported, never gating (runbook step 11)`);
  }

  // 4. CONTROL: opt in to named prepared statements, the one thing that breaks
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
      console.log(`[4/5] CONTROL  INFO  named prepared statements DO break this pooler (${failures.length}/${CONTROL_QUERIES}: ${summarize(failures)}) — so [2/5] passing is meaningful.`);
    } else {
      console.log(`[4/5] CONTROL  INFO  named prepared statements did NOT fail here (0/${CONTROL_QUERIES}). This pooler tolerates them; the app never uses them, so [2/5] holds either way, but the control could not demonstrate the failure.`);
    }
  } finally {
    await control.$disconnect();
  }

  // 5. Optional: the deployed app itself — many cold function instances, each
  // with its own pool, which is the actual production connection-exhaustion shape.
  const appUrl = process.argv.find((arg) => arg.startsWith("--app-url="))?.slice("--app-url=".length);
  if (!appUrl) {
    console.log("[5/5] APP URL  SKIP  no --app-url given (pass a public page that reads the database, e.g. an academy's kiosk page)");
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
      console.log(`[5/5] APP URL  PASS  ${APP_REQUESTS}/${APP_REQUESTS} concurrent requests returned 200`);
    } else {
      console.log(`[5/5] APP URL  FAIL  ${histogram} (expected all 200 — a 404 means the URL is wrong, a 5xx means the deployment cannot reach the database)`);
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
