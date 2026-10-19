/**
 * Observes the COMPILED app, not the source: the e2e session bypass and the security headers
 * (docs/LAUNCH_SECURITY_HEADERS_AND_BYPASS_PLAN.md).
 *
 * Run after `pnpm build`. It starts the existing production build with `next start` and NODE_ENV=test plus a
 * synthetic E2E_AUTH_BYPASS_SECRET — the "test env vars set by mistake" case — and requires the bypass to answer
 * 404 with no session cookie for an active synthetic user, the correct secret and a localhost Host. The negative
 * control then sends the SAME request to `next dev` with the same env and requires a session cookie, so a missing
 * user, a bad secret or a wrong URL cannot produce a false pass. Both servers' headers are checked on pages, an
 * API route, redirects (not followed) and real static assets. /{es,en}/dev/{belts,components} must answer HTTP 404
 * with none of their content on the production build, and render (with a synthetic belt rank) on `next dev`.
 *
 * Isolated test database only (guarded TEST_DATABASE_URL); the synthetic user and belt rank are deleted afterwards. Secrets and
 * cookies are never printed. Note: `next dev` writes into `.next`, so the production build is no longer intact after
 * this script — run it last, after anything else that needs the build.
 *
 * Usage: pnpm verify:production-build
 */
import "dotenv/config";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";
import { resolveGuardedTestDatabaseUrl, testDatabaseChildEnv } from "./lib/test-database-guard";

const PROD_PORT = 3101;
const DEV_PORT = 3102;
const PROD_START_TIMEOUT_MS = 60_000;
const DEV_START_TIMEOUT_MS = 180_000;
const REQUEST_TIMEOUT_MS = 120_000;
const SESSION_COOKIE = "authjs.session-token";
const NEXT_BIN = "node_modules/next/dist/bin/next";

const BASE_HEADERS: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "content-security-policy": "frame-ancestors 'none'",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
};

type Server = { child: ChildProcess; stderrTail: () => string };

const failures: string[] = [];
function check(ok: boolean, message: string) {
  console.log(`${ok ? "ok  " : "FAIL"} ${message}`);
  if (!ok) failures.push(message);
}

function startServer(command: "start" | "dev", port: number, env: NodeJS.ProcessEnv): Server {
  const child = spawn(process.execPath, [NEXT_BIN, command, "-p", String(port)], {
    env,
    stdio: ["ignore", "ignore", "pipe"],
    detached: process.platform !== "win32",
  });
  // Kept only for diagnosis on failure, and printed with the secret redacted.
  let tail = "";
  child.stderr?.on("data", (chunk: Buffer) => (tail = (tail + chunk.toString()).slice(-2000)));
  return { child, stderrTail: () => tail };
}

function stopServer(server: Server | undefined) {
  const child = server?.child;
  if (!child?.pid || child.exitCode !== null) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }
}

async function waitUntilUp(base: string, server: Server, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (server.child.exitCode !== null) throw new Error(`server exited early (code ${server.child.exitCode})`);
    try {
      const response = await fetch(`${base}/api/health`, { redirect: "manual", signal: AbortSignal.timeout(10_000) });
      await response.arrayBuffer();
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  throw new Error(`server not up within ${timeoutMs / 1000}s`);
}

function get(url: string) {
  return fetch(url, { redirect: "manual", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
}

function postBypass(base: string, userId: string, secret: string) {
  return fetch(`${base}/api/e2e-auth-bypass`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ userId, secret }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}

function hasSessionCookie(response: Response) {
  return response.headers.getSetCookie().some((cookie) => cookie.startsWith(`${SESSION_COOKIE}=`));
}

function checkSecurityHeaders(label: string, path: string, response: Response, referrerPolicy: string) {
  for (const [name, value] of Object.entries(BASE_HEADERS)) {
    check(response.headers.get(name) === value, `${label} ${path}: ${name} = ${response.headers.get(name)}`);
  }
  check(
    response.headers.get("referrer-policy") === referrerPolicy,
    `${label} ${path}: referrer-policy = ${response.headers.get("referrer-policy")} (want ${referrerPolicy})`,
  );
  check(!response.headers.has("x-powered-by"), `${label} ${path}: no x-powered-by`);
}

const GENERAL = "strict-origin-when-cross-origin";
const isRedirect = (s: number) => s >= 300 && s < 400;
const CASES: { path: string; status: (s: number) => boolean; kind: string; referrer: string }[] = [
  { path: "/en/login", status: (s) => s === 200, kind: "page", referrer: GENERAL },
  { path: "/", status: isRedirect, kind: "locale redirect", referrer: GENERAL },
  { path: "/en/dashboard", status: isRedirect, kind: "auth redirect", referrer: GENERAL },
  { path: "/en/kiosk/no-such-academy-synthetic", status: (s) => s < 500, kind: "kiosk tree", referrer: GENERAL },
  { path: "/api/health", status: (s) => s === 200, kind: "API", referrer: GENERAL },
  { path: "/icon-192.png", status: (s) => s === 200, kind: "public static", referrer: GENERAL },
  ...["es", "en"].flatMap((locale) =>
    ["reset-password", "accept-invitation"].map((page) => ({
      path: `/${locale}/${page}?token=SYNTHETIC`,
      status: (s: number) => s === 200,
      kind: "token page",
      referrer: "no-referrer",
    })),
  ),
  ...["reset-password", "accept-invitation"].map((page) => ({
    path: `/${page}?token=SYNTHETIC`,
    status: isRedirect,
    kind: "token redirect",
    referrer: "no-referrer",
  })),
];

async function checkHeaders(label: string, base: string) {
  let loginHtml = "";
  for (const c of CASES) {
    const response = await get(`${base}${c.path}`);
    check(c.status(response.status), `${label} ${c.path} (${c.kind}): status ${response.status}`);
    checkSecurityHeaders(label, c.path, response, c.referrer);
    if (c.path === "/en/login") loginHtml = await response.text();
    else await response.arrayBuffer();
  }
  const asset = loginHtml.match(/\/_next\/static\/[^"'\s]+\.js/)?.[0];
  check(Boolean(asset), `${label}: login page references a /_next/static script`);
  if (asset) {
    const response = await get(`${base}${asset}`);
    check(response.status === 200, `${label} /_next/static asset: status ${response.status}`);
    checkSecurityHeaders(label, "/_next/static/…", response, GENERAL);
    await response.arrayBuffer();
  }
}

// Text only these pages render. The production 404 must contain none of it; the dev control must contain its own.
// Not the translated "devBelts.heading": next-intl ships the whole message catalog on every page (login included),
// so that string is present everywhere and says nothing about this route.
const DEV_PAGE_CONTENT = ["Component library preview", "Harbor Jiu-Jitsu"];

async function checkDevPages(label: string, base: string, served: boolean, beltMarker: string) {
  for (const locale of ["es", "en"]) {
    for (const page of ["belts", "components"]) {
      const path = `/${locale}/dev/${page}`;
      const response = await get(`${base}${path}`);
      const body = await response.text();
      if (served) {
        check(response.status === 200, `${label} ${path}: status ${response.status} (want 200)`);
        const marker = page === "belts" ? beltMarker : "Component library preview";
        check(body.includes(marker), `${label} ${path}: renders its content`);
      } else {
        // The real HTTP status, not a rendered "not found" message inside a 200 stream.
        check(response.status === 404, `${label} ${path}: status ${response.status} (want 404)`);
        const leaked = [...DEV_PAGE_CONTENT, beltMarker].filter((text) => body.includes(text));
        check(leaked.length === 0, `${label} ${path}: no preview content (found: ${leaked.join(", ") || "none"})`);
      }
    }
  }
}

async function main() {
  if (!existsSync(".next/BUILD_ID")) throw new Error("No production build (.next/BUILD_ID). Run `pnpm build` first.");

  const testUrl = resolveGuardedTestDatabaseUrl();
  const secret = `synthetic-${randomBytes(16).toString("hex")}`;
  // NODE_ENV=test with a set secret: the misconfiguration the compiled guard must survive.
  const env = { ...testDatabaseChildEnv(testUrl), NODE_ENV: "test", E2E_AUTH_BYPASS_SECRET: secret } as NodeJS.ProcessEnv;

  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: testUrl }) });
  // Read-only, and before any write, so a missing fixture leaves nothing behind.
  const organization = await prisma.organization.findUniqueOrThrow({ where: { slug: "alliance-cr" } });
  const user = await prisma.user.create({
    data: {
      email: `verify-build-${Date.now()}-${randomBytes(4).toString("hex")}@example.test`,
      passwordHash: "synthetic-not-a-real-hash",
      role: "ADMIN",
      active: true,
    },
  });
  // /dev/belts renders the alliance-cr rank catalog; one synthetic rank gives it a unique marker, so the dev control
  // proves real rendering and the production check can look for that exact text.
  const beltMarker = `SYNTH-BELT-${randomBytes(4).toString("hex")}`;
  const rank = await prisma.beltRank.create({
    data: {
      organizationId: organization.id,
      track: "ADULT",
      code: beltMarker,
      labelEs: beltMarker,
      labelEn: beltMarker,
      order: 900_000 + randomBytes(2).readUInt16BE(0),
      maxStripes: 0,
      stripeColors: [],
      primaryColor: "#123456",
      barColor: "#000000",
    },
  });

  let server: Server | undefined;
  try {
    console.log(`production server (next start, NODE_ENV=test, synthetic secret) on :${PROD_PORT}`);
    server = startServer("start", PROD_PORT, env);
    const prodBase = `http://localhost:${PROD_PORT}`;
    await waitUntilUp(prodBase, server, PROD_START_TIMEOUT_MS);
    const prod = await postBypass(prodBase, user.id, secret);
    check(prod.status === 404, `production bypass: status ${prod.status} (want 404)`);
    check(!hasSessionCookie(prod), "production bypass: no session cookie");
    checkSecurityHeaders("production", "/api/e2e-auth-bypass", prod, GENERAL);
    await prod.arrayBuffer();
    await checkHeaders("production", prodBase);
    await checkDevPages("production", prodBase, false, beltMarker);
    stopServer(server);

    console.log(`negative control: development server (next dev, same env) on :${DEV_PORT}`);
    server = startServer("dev", DEV_PORT, env);
    const devBase = `http://localhost:${DEV_PORT}`;
    await waitUntilUp(devBase, server, DEV_START_TIMEOUT_MS);
    const dev = await postBypass(devBase, user.id, secret);
    check(dev.status === 200, `development bypass (negative control): status ${dev.status} (want 200)`);
    check(hasSessionCookie(dev), "development bypass (negative control): session cookie set");
    await dev.arrayBuffer();
    await checkHeaders("development", devBase);
    await checkDevPages("development", devBase, true, beltMarker);
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
    const tail = server?.stderrTail();
    if (tail) console.error(`server stderr tail:\n${tail.replaceAll(secret, "[secret]")}`);
  } finally {
    stopServer(server);
    await prisma.user.delete({ where: { id: user.id } }).catch(() => {});
    await prisma.beltRank.delete({ where: { id: rank.id } }).catch(() => {});
    await prisma.$disconnect();
  }

  if (failures.length > 0) {
    console.error(`\n${failures.length} check(s) failed:\n- ${failures.join("\n- ")}`);
    process.exit(1);
  }
  console.log("\nall checks passed");
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
