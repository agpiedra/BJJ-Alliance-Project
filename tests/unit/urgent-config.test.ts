import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { stripComments } from "../helpers/source-files";

// Importing the run module constructs the Prisma client (never connected here), which requires DATABASE_URL.
process.env.DATABASE_URL ??= "postgresql://unit-test-placeholder/db";
vi.mock("@/auth", () => ({ auth: () => Promise.resolve(null), signIn: vi.fn() }));
const { MONITOR_FUNCTION_MAX_SECONDS } = await import("../../src/lib/monitoring/urgent/run");
const { TENANT_SCOPED_MODELS } = await import("../../src/lib/tenant/tenant-guard");

/** PR-B B-U21–B-U23: the schedules, the route's static duration, the read-only boundary and the tenant classification. */
const MONITOR_DIR = "src/lib/monitoring/urgent";

describe("configuration (B-U21)", () => {
  it("vercel.json: billing stays `0 */3 * * *`, the monitor runs at :07/:22/:37/:52 (a list, not a range with step), the digest is unchanged", () => {
    const crons = (JSON.parse(readFileSync("vercel.json", "utf8")) as { crons: { path: string; schedule: string }[] }).crons;
    expect(crons).toEqual([
      { path: "/api/cron/weekly-digest", schedule: "0 13 * * 1" },
      { path: "/api/cron/monthly-generation", schedule: "0 */3 * * *" },
      { path: "/api/cron/monthly-generation-monitor", schedule: "7,22,37,52 * * * *" },
    ]);
  });

  it("the route's maxDuration literal equals MONITOR_FUNCTION_MAX_SECONDS (Next reads it statically)", () => {
    const route = stripComments(readFileSync("src/app/api/cron/monthly-generation-monitor/route.ts", "utf8"));
    expect(/export const maxDuration = (\d+);/.exec(route)?.[1]).toBe(String(MONITOR_FUNCTION_MAX_SECONDS));
    expect(MONITOR_FUNCTION_MAX_SECONDS).toBe(60);
  });
});

describe("read-only boundary (B-U22)", () => {
  /** What the monitor may import. Anything that writes billing data (the generation loop, activation, the ledger) is absent. */
  const ALLOWED = [
    /^@\/lib\/monitoring\/urgent\//,
    /^@\/lib\/dues\/monthly-generation-alerts$/,
    /^@\/lib\/dues\/urgent-findings$/,
    /^@\/lib\/jobs\/(job-health|job-names|heartbeat)$/,
    /^@\/lib\/prisma$/,
    /^@\/lib\/env$/,
    /^@\/lib\/auth\/(secrets-match|password-reset-log)$/,
    /^next\/server$/,
    /^node:crypto$/,
  ];

  it("src/lib/monitoring/urgent/** imports only the read-side allowlist", () => {
    const offenders: string[] = [];
    for (const file of readdirSync(MONITOR_DIR)) {
      const text = stripComments(readFileSync(path.join(MONITOR_DIR, file), "utf8"));
      for (const m of text.matchAll(/(?:from\s+|import\s*\(\s*)["']([^"']+)["']/g)) {
        if (!ALLOWED.some((re) => re.test(m[1]))) offenders.push(`${file}: ${m[1]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the monitor never writes any model except its own two (no create/update/upsert/delete on billing or JobRun models)", () => {
    const writes: string[] = [];
    for (const file of readdirSync(MONITOR_DIR)) {
      const text = stripComments(readFileSync(path.join(MONITOR_DIR, file), "utf8"));
      for (const m of text.matchAll(/\.(\w+)\s*\.\s*(create|createMany|update|updateMany|upsert|delete|deleteMany)\s*\(/g)) {
        if (m[1] !== "urgentAlertKey" && m[1] !== "monitorState") writes.push(`${file}: ${m[1]}.${m[2]}`);
      }
      for (const m of text.matchAll(/(UPDATE|INSERT\s+INTO|DELETE\s+FROM)\s+"(\w+)"/g)) {
        if (m[2] !== "MonitorState" && m[2] !== "UrgentAlertKey") writes.push(`${file}: ${m[1]} ${m[2]}`);
      }
    }
    expect(writes).toEqual([]);
  });

  it("the monitor does not go through runScheduledJob (it writes no JobRun rows)", () => {
    for (const file of readdirSync(MONITOR_DIR)) expect(stripComments(readFileSync(path.join(MONITOR_DIR, file), "utf8"))).not.toContain("runScheduledJob(");
  });
});

describe("tenant classification (B-U23)", () => {
  it("MonitorState and UrgentAlertKey are platform-level (no organizationId), not tenant-scoped", () => {
    expect(TENANT_SCOPED_MODELS.has("MonitorState")).toBe(false);
    expect(TENANT_SCOPED_MODELS.has("UrgentAlertKey")).toBe(false);
    const schema = readFileSync("prisma/schema.prisma", "utf8");
    for (const model of ["MonitorState", "UrgentAlertKey"]) {
      const body = new RegExp(`model ${model} \\{([\\s\\S]*?)\\n\\}`).exec(schema)?.[1];
      expect(body, model).toBeDefined();
      expect(body).not.toMatch(/organizationId/);
    }
  });
});
