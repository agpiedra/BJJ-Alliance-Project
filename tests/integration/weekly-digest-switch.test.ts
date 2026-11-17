import "dotenv/config";
import pg from "pg";
import { getTestPrismaClient } from "../helpers/test-db";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Weekly digest per-environment switch (WEEKLY_DIGEST_ENABLED; docs/dues/WEEKLY-DIGEST-SWITCH-PROPOSAL.md).
 * The digest route's switched-off paths (disabled, misconfigured, and every unauthenticated call while off) must do NO
 * digest work: zero database queries (counted at the `pg` driver every Prisma client uses), zero `fetch` calls (the email
 * provider and the Healthchecks heartbeat both go through `fetch`), no email send, no academy lookup, no JobRun runner.
 * An ENABLED control call proves the counters do see queries and requests. Health reporting is checked per state.
 */
vi.mock("../../src/lib/notifications/weekly-digest", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/notifications/weekly-digest")>();
  return { ...actual, sendWeeklyDigestForAcademy: vi.fn(actual.sendWeeklyDigestForAcademy) };
});
vi.mock("../../src/lib/tenant/platform-lookups", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/tenant/platform-lookups")>();
  return { ...actual, listActiveAcademyIdsForDigest: vi.fn(async () => [] as string[]) };
});
vi.mock("../../src/lib/jobs/run-scheduled-job", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/jobs/run-scheduled-job")>();
  return { ...actual, runScheduledJob: vi.fn(actual.runScheduledJob) };
});

const { GET: digestGET } = await import("../../src/app/api/cron/weekly-digest/route");
const { GET: healthGET } = await import("../../src/app/api/health/jobs/route");
const { sendWeeklyDigestForAcademy } = await import("../../src/lib/notifications/weekly-digest");
const { listActiveAcademyIdsForDigest } = await import("../../src/lib/tenant/platform-lookups");
const { runScheduledJob } = await import("../../src/lib/jobs/run-scheduled-job");

const prisma = getTestPrismaClient();
const SECRET = "digest-switch-test-secret";
const request = (auth?: string) => new Request("http://localhost/api/cron/weekly-digest", auth ? { headers: { authorization: auth } } : {});

const originalClientQuery = pg.Client.prototype.query;
const originalPoolQuery = pg.Pool.prototype.query;
/** Runs `call` while counting every SQL query sent through `pg` (Client and Pool) and every `fetch`. */
async function observe<T>(call: () => Promise<T>) {
  let queries = 0;
  const clientQuery = vi.spyOn(pg.Client.prototype, "query").mockImplementation(function (this: unknown, ...args: unknown[]) {
    queries++;
    return (originalClientQuery as (...a: unknown[]) => unknown).apply(this, args);
  } as never);
  const poolQuery = vi.spyOn(pg.Pool.prototype, "query").mockImplementation(function (this: unknown, ...args: unknown[]) {
    queries++;
    return (originalPoolQuery as (...a: unknown[]) => unknown).apply(this, args);
  } as never);
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("OK", { status: 200 }));
  try {
    const result = await call();
    return { result, queries, fetches: fetchSpy.mock.calls.length };
  } finally {
    clientQuery.mockRestore();
    poolQuery.mockRestore();
    fetchSpy.mockRestore();
  }
}

const createdRunIds: string[] = [];
beforeEach(async () => {
  vi.stubEnv("CRON_SECRET", SECRET);
  // A heartbeat URL is configured, so an enabled run WOULD ping it: the off paths must not.
  vi.stubEnv("HEALTHCHECK_DIGEST_URL", "https://hc.example/digest-check");
  vi.mocked(sendWeeklyDigestForAcademy).mockClear();
  vi.mocked(listActiveAcademyIdsForDigest).mockClear();
  vi.mocked(runScheduledJob).mockClear();
});
afterEach(() => vi.unstubAllEnvs());
afterAll(async () => {
  await prisma.jobRun.deleteMany({ where: { id: { in: createdRunIds } } });
});

describe("GET /api/cron/weekly-digest when the switch is off", () => {
  const offStates: [string, string | undefined, object][] = [
    ["unset", undefined, { ok: true, disabled: true, reason: "unset" }],
    ["false", "false", { ok: true, disabled: true, reason: "false" }],
    ["misconfigured", "yes", { ok: false, disabled: true, error: "digestMisconfigured" }],
  ];

  for (const [name, value, body] of offStates) {
    it(`${name}: authenticated call answers ${JSON.stringify(body)} with no query, no request, no email, no runner`, async () => {
      if (value !== undefined) vi.stubEnv("WEEKLY_DIGEST_ENABLED", value);
      const runsBefore = await prisma.jobRun.count({ where: { jobName: "weekly-digest" } });
      const seen = await observe(() => digestGET(request(`Bearer ${SECRET}`)));
      expect(seen.result.status).toBe(200);
      expect(await seen.result.json()).toEqual(body);
      expect(seen.queries).toBe(0);
      expect(seen.fetches).toBe(0);
      expect(runScheduledJob).not.toHaveBeenCalled();
      expect(listActiveAcademyIdsForDigest).not.toHaveBeenCalled();
      expect(sendWeeklyDigestForAcademy).not.toHaveBeenCalled();
      expect(await prisma.jobRun.count({ where: { jobName: "weekly-digest" } })).toBe(runsBefore);
    });

    it(`${name}: authentication comes first: missing or wrong bearer is 401 with the usual body, and still no work`, async () => {
      if (value !== undefined) vi.stubEnv("WEEKLY_DIGEST_ENABLED", value);
      for (const auth of [undefined, "Bearer wrong-secret", SECRET]) {
        const seen = await observe(() => digestGET(request(auth)));
        expect(seen.result.status).toBe(401);
        expect(await seen.result.json()).toEqual({ ok: false, error: "unauthorized" });
        expect(seen.queries).toBe(0);
        expect(seen.fetches).toBe(0);
      }
      expect(runScheduledJob).not.toHaveBeenCalled();
      expect(sendWeeklyDigestForAcademy).not.toHaveBeenCalled();
    });
  }

  it("enabled (control): the unchanged runner path runs, and the counters see its queries and heartbeat request", async () => {
    vi.stubEnv("WEEKLY_DIGEST_ENABLED", "true");
    const seen = await observe(() => digestGET(request(`Bearer ${SECRET}`)));
    expect(seen.result.status).toBe(200);
    expect(runScheduledJob).toHaveBeenCalledTimes(1);
    expect(listActiveAcademyIdsForDigest).toHaveBeenCalledTimes(1);
    expect(seen.queries).toBeGreaterThan(0); // the JobRun create/finalize
    expect(seen.fetches).toBeGreaterThan(0); // the heartbeat ping
    const latest = await prisma.jobRun.findFirst({ where: { jobName: "weekly-digest" }, orderBy: { startedAt: "desc" } });
    if (latest) createdRunIds.push(latest.id);
    // Same 401 body as the switched-off paths.
    const unauth = await digestGET(request("Bearer wrong-secret"));
    expect(unauth.status).toBe(401);
    expect(await unauth.json()).toEqual({ ok: false, error: "unauthorized" });
  });
});

describe("GET /api/health/jobs: switched off is not failed or stale", () => {
  const health = async () => {
    const res = await healthGET(new Request("http://localhost/api/health/jobs", { headers: { authorization: `Bearer ${SECRET}` } }));
    return (await res.json()) as { ok: boolean; jobs: Record<string, Record<string, unknown>> };
  };

  it("disabled is reported as its own state, excluded from `ok`; misconfigured fails `ok`; monthly-generation is unaffected", async () => {
    // No digest run at all (would be stale if enabled); one fresh, finished billing run (healthy).
    await prisma.jobRun.deleteMany({ where: { jobName: "weekly-digest" } });
    const run = await prisma.jobRun.create({ data: { jobName: "monthly-generation", status: "SUCCEEDED", startedAt: new Date(), finishedAt: new Date() } });
    createdRunIds.push(run.id);

    vi.stubEnv("WEEKLY_DIGEST_ENABLED", "true");
    const enabled = await health();
    expect(enabled.jobs["weekly-digest"]).toMatchObject({ state: "enabled", stale: true });
    expect(enabled.ok).toBe(false); // an enabled digest that never ran is stale, as before

    vi.stubEnv("WEEKLY_DIGEST_ENABLED", "");
    const unset = await health();
    expect(unset.jobs["weekly-digest"]).toMatchObject({ state: "disabled", reason: "unset", stale: false, stuck: false });
    expect(unset.ok).toBe(true);

    vi.stubEnv("WEEKLY_DIGEST_ENABLED", "false");
    const off = await health();
    expect(off.jobs["weekly-digest"]).toMatchObject({ state: "disabled", reason: "false", stale: false, stuck: false });
    expect(off.ok).toBe(true);

    vi.stubEnv("WEEKLY_DIGEST_ENABLED", "TRUE");
    const bad = await health();
    expect(bad.jobs["weekly-digest"]).toMatchObject({ state: "misconfigured", stale: false, stuck: false });
    expect(bad.jobs["weekly-digest"]).not.toHaveProperty("reason");
    expect(bad.ok).toBe(false);

    // The billing entry is byte-identical in every state, and carries no digest fields.
    const billing = JSON.stringify(enabled.jobs["monthly-generation"]);
    for (const h of [unset, off, bad]) expect(JSON.stringify(h.jobs["monthly-generation"])).toBe(billing);
    expect(enabled.jobs["monthly-generation"]).not.toHaveProperty("state");
  });
});
