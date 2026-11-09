import "dotenv/config";
import { getTestPrismaClient } from "../helpers/test-db";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

/**
 * C1: `runScheduledJob` is the wrapper both cron routes go through — it checks the shared
 * secret, writes a JobRun row, runs the job, finalizes that row, then pings the
 * Healthchecks.io dead-man's switch. This drives the wrapper directly against the real
 * database (no mocked Prisma): the JobRun lifecycle, status derivation, and — the one
 * ordering the user asked to be pinned by test, not just by comment — that the row is
 * ALREADY finalized in the database by the time the heartbeat ping fires, so a process
 * killed between the two (a Vercel timeout) leaves a finished row and a missed ping: a
 * FALSE ALARM from Healthchecks, never silence.
 */
vi.mock("@/lib/jobs/heartbeat", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/jobs/heartbeat")>();
  return { ...actual, pingHeartbeat: vi.fn(actual.pingHeartbeat), pingAlertCheck: vi.fn(actual.pingAlertCheck) };
});

const { runScheduledJob } = await import("../../src/lib/jobs/run-scheduled-job");
const { pingHeartbeat, pingAlertCheck } = await import("../../src/lib/jobs/heartbeat");

const prisma = getTestPrismaClient();
const createdRunIds: string[] = [];

function request(secret: string | null): Request {
  return new Request("http://localhost/api/cron/weekly-digest", { headers: secret ? { authorization: `Bearer ${secret}` } : {} });
}

async function latestRun(jobName: string) {
  const run = await prisma.jobRun.findFirst({ where: { jobName }, orderBy: { startedAt: "desc" } });
  if (run) createdRunIds.push(run.id);
  return run;
}

afterEach(() => {
  vi.mocked(pingHeartbeat).mockClear();
  vi.unstubAllEnvs();
});

afterAll(async () => {
  if (createdRunIds.length > 0) {
    await prisma.jobRun.deleteMany({ where: { id: { in: createdRunIds } } });
  }
});

describe("runScheduledJob", () => {
  it("REQUIRED: returns 401 and writes no JobRun row when the secret is missing or wrong", async () => {
    vi.stubEnv("CRON_SECRET", "test-cron-secret");
    const before = await prisma.jobRun.count({ where: { jobName: "weekly-digest" } });
    const fn = vi.fn();

    const missing = await runScheduledJob("weekly-digest", request(null), fn);
    const wrong = await runScheduledJob("weekly-digest", request("wrong"), fn);

    expect(missing.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(fn).not.toHaveBeenCalled();
    expect(await prisma.jobRun.count({ where: { jobName: "weekly-digest" } })).toBe(before);
  });

  it("REQUIRED: a clean run is recorded SUCCEEDED, with the counts the job returned, and pings success", async () => {
    vi.stubEnv("CRON_SECRET", "test-cron-secret");
    const outcome = { sent: 5, failed: 0, skipped: 1, organizationsProcessed: 2 };
    const response = await runScheduledJob("weekly-digest", request("test-cron-secret"), async () => ({ outcome, body: { ok: true } }));

    expect(response.status).toBe(200);
    const run = await latestRun("weekly-digest");
    expect(run).toMatchObject({ status: "SUCCEEDED", sent: 5, failed: 0, skipped: 1, organizationsProcessed: 2 });
    expect(run!.finishedAt).not.toBeNull();
    expect(pingHeartbeat).toHaveBeenCalledWith("weekly-digest", true);
  });

  it("REQUIRED: any failed>0 is recorded and pings /fail, even when some work also succeeded (PARTIAL)", async () => {
    vi.stubEnv("CRON_SECRET", "test-cron-secret");
    const outcome = { sent: 3, failed: 1, skipped: 0, organizationsProcessed: 1 };
    await runScheduledJob("weekly-digest", request("test-cron-secret"), async () => ({ outcome, body: { ok: false } }));

    const run = await latestRun("weekly-digest");
    expect(run).toMatchObject({ status: "PARTIAL", sent: 3, failed: 1 });
    expect(pingHeartbeat).toHaveBeenCalledWith("weekly-digest", false);
  });

  it("a total failure (nothing sent or skipped) is recorded FAILED, not PARTIAL", async () => {
    vi.stubEnv("CRON_SECRET", "test-cron-secret");
    const outcome = { sent: 0, failed: 2, skipped: 0, organizationsProcessed: 1 };
    await runScheduledJob("weekly-digest", request("test-cron-secret"), async () => ({ outcome, body: { ok: false } }));

    const run = await latestRun("weekly-digest");
    expect(run!.status).toBe("FAILED");
  });

  it("REQUIRED: a thrown error is recorded FAILED, pings /fail, and the route returns 500 — never a silent 200", async () => {
    vi.stubEnv("CRON_SECRET", "test-cron-secret");
    const response = await runScheduledJob("weekly-digest", request("test-cron-secret"), async () => {
      throw new Error("unexpected crash before the loop even started");
    });

    expect(response.status).toBe(500);
    const run = await latestRun("weekly-digest");
    expect(run!.status).toBe("FAILED");
    expect(pingHeartbeat).toHaveBeenCalledWith("weekly-digest", false);
  });

  it("caps and stores the organization breakdown and a truncated error summary", async () => {
    vi.stubEnv("CRON_SECRET", "test-cron-secret");
    const breakdown = Array.from({ length: 150 }, (_, i) => ({ organizationId: `org-${i}`, sent: 1, failed: 0, skipped: 0 }));
    const outcome = { sent: 150, failed: 0, skipped: 0, organizationsProcessed: 150, organizationBreakdown: breakdown };
    await runScheduledJob("weekly-digest", request("test-cron-secret"), async () => ({ outcome, body: { ok: true } }));

    const run = await latestRun("weekly-digest");
    const stored = run!.organizationBreakdown as unknown as Array<unknown>;
    expect(stored.length).toBeLessThanOrEqual(100);
    expect(stored.length).toBeLessThan(breakdown.length);
  });

  it("REQUIRED: the JobRun row is already finalized (not RUNNING) in the database by the time the heartbeat is pinged — kept even if the process died right after", async () => {
    vi.stubEnv("CRON_SECRET", "test-cron-secret");
    vi.stubEnv("HEALTHCHECK_DIGEST_URL", "https://hc-ping.com/does-not-matter-fetch-is-mocked");
    let sawDuringPing: { status: string; finishedAt: Date | null } | undefined;
    const fetchImpl = vi.fn(async () => {
      // Read the row from a FRESH client, not any cached reference this test holds, to prove
      // the write actually reached the database before this ping fired — not merely that the
      // in-process object was mutated in the right order.
      const fresh = getTestPrismaClient();
      const run = await fresh.jobRun.findFirst({ where: { jobName: "weekly-digest" }, orderBy: { startedAt: "desc" } });
      sawDuringPing = run ? { status: run.status, finishedAt: run.finishedAt } : undefined;
      return new Response(null, { status: 200 });
    });
    vi.stubGlobal("fetch", fetchImpl);

    const outcome = { sent: 1, failed: 0, skipped: 0, organizationsProcessed: 1 };
    await runScheduledJob("weekly-digest", request("test-cron-secret"), async () => ({ outcome, body: { ok: true } }));

    expect(fetchImpl).toHaveBeenCalled();
    expect(sawDuringPing, "the heartbeat fired before any JobRun row existed for this run").toBeDefined();
    expect(sawDuringPing!.status).not.toBe("RUNNING");
    expect(sawDuringPing!.finishedAt).not.toBeNull();
    vi.unstubAllGlobals();
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// G2a (docs/dues/G2-ROUTE-BUDGET-PLAN.md revision 2): safe wrapper diagnostics for every caller, and the optional fourth
// argument's bounded bookkeeping. Real waits and real database failures on the isolated test database; the Healthchecks request
// is a stubbed global fetch that records every request in order.

const { prisma: appPrisma } = await import("../../src/lib/prisma");
const { planRouteBudget } = await import("../../src/lib/dues/monthly-generation-route-budget");
const { DEFAULT_GENERATION_LIMITS } = await import("../../src/lib/dues/monthly-generation-progress");

const HC = "https://hc-ping.com/g2a-test-check";
const BOUNDS = { maxWaitMs: 500, timeoutMs: 1_500, statementTimeoutMs: 500, lockTimeoutMs: 500, idleInTransactionTimeoutMs: 500 };
const SECRET = "wr4pper-s3cr3t-Fabricated-9917";

function secretError() {
  const error = new Error(`message ${SECRET}`, { cause: { token: `cause ${SECRET}` } });
  error.name = `Name${SECRET}`;
  error.stack = `stack ${SECRET}\n    at x (${SECRET}.ts:1:1)`;
  Object.assign(error, { code: `code-${SECRET}`, meta: { query: `SELECT '${SECRET}'` } });
  return error;
}

/** Stubs global fetch; every Healthchecks request is recorded in order, with the JobRun row as it stood at that moment. */
function recordPings(onPing?: () => Promise<void>, response: (signal?: AbortSignal) => Promise<Response> = async () => new Response(null, { status: 200 })) {
  const pings: Array<{ url: string; rowStatus: string | null; rowFinished: boolean }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: { signal?: AbortSignal }) => {
      const run = await prisma.jobRun.findFirst({ where: { jobName: "weekly-digest" }, orderBy: { startedAt: "desc" } });
      pings.push({ url, rowStatus: run?.status ?? null, rowFinished: !!run?.finishedAt });
      await onPing?.();
      return response(init?.signal);
    }),
  );
  return pings;
}
/** Like a real endpoint that never answers: settles only when the client aborts (as real fetch does). */
const neverAnswers = (signal?: AbortSignal) =>
  new Promise<Response>((_resolve, reject) => signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));

function captureConsole() {
  const logged: string[] = [];
  const spies = (["log", "info", "warn", "error", "debug"] as const).map((level) =>
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void logged.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a, Object.getOwnPropertyNames(a ?? {})))).join(" "))),
  );
  return { logged, restore: () => spies.forEach((spy) => spy.mockRestore()) };
}

/** A lock held by another connection (the test client) until `release()`. */
function holdLock(sql: string) {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let ready!: () => void;
  const held = new Promise<void>((r) => (ready = r));
  const tx = prisma.$transaction(
    async (t) => {
      await t.$executeRawUnsafe(sql);
      ready();
      await gate;
    },
    { timeout: 60_000 },
  );
  return {
    held,
    release: async () => {
      release();
      await tx;
    },
  };
}

/** Holds every connection of the application's pool (pg's default, 10) until `release()`. */
async function exhaustAppPool() {
  const releases: Array<() => void> = [];
  const holders: Promise<unknown>[] = [];
  for (let i = 0; i < 10; i++) {
    let started!: () => void;
    const ready = new Promise<void>((r) => (started = r));
    holders.push(
      appPrisma.$transaction(
        async (tx) => {
          await tx.$executeRawUnsafe("SELECT 1");
          started();
          await new Promise<void>((r) => releases.push(r));
        },
        { maxWait: 10_000, timeout: 60_000 },
      ),
    );
    await ready;
  }
  return {
    release: async () => {
      releases.forEach((r) => r());
      await Promise.allSettled(holders);
    },
  };
}

const okOutcome = { sent: 1, failed: 0, skipped: 0, organizationsProcessed: 1 };

describe("G2a: wrapper-generated diagnostics are safe for every caller (compatibility change, digest included)", () => {
  for (const mode of ["without options (the weekly digest's path)", "with bounded bookkeeping"] as const) {
    it(`a thrown error ${mode}: no fabricated secret in the 500 body, the stored errorSummary or any console argument`, async () => {
      vi.stubEnv("CRON_SECRET", "test-cron-secret");
      vi.stubEnv("HEALTHCHECK_DIGEST_URL", HC);
      const pings = recordPings();
      const captured = captureConsole();
      let response: Response;
      try {
        response = await runScheduledJob(
          "weekly-digest",
          request("test-cron-secret"),
          async () => {
            throw secretError();
          },
          mode === "with bounded bookkeeping" ? { bookkeeping: BOUNDS } : undefined,
        );
      } finally {
        captured.restore();
        vi.unstubAllGlobals();
      }
      const text = await response.text();
      expect(response.status).toBe(500);
      expect(text).not.toContain(SECRET);
      expect(JSON.parse(text)).toMatchObject({ ok: false, error: "unrecognized_error" });
      const run = await latestRun("weekly-digest");
      expect(run).toMatchObject({ status: "FAILED", errorSummary: "unrecognized_error" });
      expect(captured.logged.length).toBeGreaterThan(0);
      expect(captured.logged.join("\n")).not.toContain(SECRET);
      expect(pings.map((p) => p.url)).toEqual([`${HC}/fail`]); // exactly one request, the failure ping
    });
  }

  it("caller-owned content passes through unchanged: the job's own body and its own outcome.errors", async () => {
    vi.stubEnv("CRON_SECRET", "test-cron-secret");
    recordPings();
    const response = await runScheduledJob("weekly-digest", request("test-cron-secret"), async () => ({
      outcome: { sent: 0, failed: 1, skipped: 0, organizationsProcessed: 0, errors: ["caller-chosen text"] },
      body: { ok: false, errors: [{ academyId: "a1", error: "caller-chosen text" }] },
    }));
    vi.unstubAllGlobals();
    expect(await response.json()).toEqual({ ok: false, errors: [{ academyId: "a1", error: "caller-chosen text" }] });
    expect((await latestRun("weekly-digest"))!.errorSummary).toBe("caller-chosen text");
  });

  it("without options, the wrapper opens no transaction: the digest's bookkeeping stays the plain queries it was", async () => {
    vi.stubEnv("CRON_SECRET", "test-cron-secret");
    recordPings();
    const spy = vi.spyOn(appPrisma, "$transaction");
    try {
      const response = await runScheduledJob("weekly-digest", request("test-cron-secret"), async () => ({ outcome: okOutcome, body: { ok: true } }));
      expect(await response.json()).toEqual({ ok: true }); // the digest's body, unchanged: no G2a fields
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
      vi.unstubAllGlobals();
    }
    expect(await latestRun("weekly-digest")).toMatchObject({ status: "SUCCEEDED", heartbeatStatus: "not_configured" });
  });
});

describe("G2a: bounded bookkeeping (optional fourth argument): every branch, exact heartbeat requests in order", () => {
  it("success: one success ping, sent after the row is final; then the heartbeat result is confirmed persisted", async () => {
    vi.stubEnv("CRON_SECRET", "test-cron-secret");
    vi.stubEnv("HEALTHCHECK_DIGEST_URL", HC);
    const pings = recordPings();
    const response = await runScheduledJob("weekly-digest", request("test-cron-secret"), async () => ({ outcome: okOutcome, body: { mine: 1 } }), { bookkeeping: BOUNDS });
    vi.unstubAllGlobals();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ mine: 1, ok: true, finalized: "confirmed", heartbeat: { request: "accepted", resultPersisted: "confirmed" } });
    expect(pings).toEqual([{ url: HC, rowStatus: "SUCCEEDED", rowFinished: true }]);
    expect(await latestRun("weekly-digest")).toMatchObject({ status: "SUCCEEDED", heartbeatStatus: "ok" });
  });

  it("JobRun create waiting for a connection (pool really exhausted): the job never runs; exactly one /fail ping; no success ping; within maxWait", async () => {
    vi.stubEnv("CRON_SECRET", "test-cron-secret");
    vi.stubEnv("HEALTHCHECK_DIGEST_URL", HC);
    const pings = recordPings();
    const job = vi.fn(async () => ({ outcome: okOutcome, body: {} }));
    const pool = await exhaustAppPool();
    let response: Response;
    const t0 = Date.now();
    try {
      response = await runScheduledJob("weekly-digest", request("test-cron-secret"), job, { bookkeeping: BOUNDS });
    } finally {
      await pool.release();
      vi.unstubAllGlobals();
    }
    const waited = Date.now() - t0;
    expect(job).not.toHaveBeenCalled();
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body).toMatchObject({ ok: false, finalized: "unknown", heartbeat: { request: "accepted", resultPersisted: "notAttempted" }, bookkeepingError: { stage: "create" } });
    expect(body.bookkeepingError.code).toMatch(/^(P\d{4}|PrismaClient\w+Error|unrecognized_error)$/);
    expect(pings.map((p) => p.url)).toEqual([`${HC}/fail`]);
    expect(waited).toBeGreaterThanOrEqual(450);
    expect(waited).toBeLessThan(BOUNDS.maxWaitMs + 1_500); // its reserve: maxWait, then one (instant here) ping
  }, 30_000);

  it("JobRun create failing with a hanging Healthchecks endpoint still ends within its reserve (create + one 5 s ping abort)", async () => {
    vi.stubEnv("CRON_SECRET", "test-cron-secret");
    vi.stubEnv("HEALTHCHECK_DIGEST_URL", HC);
    const pings = recordPings(undefined, neverAnswers); // never answers; the 5 s abort ends it
    const pool = await exhaustAppPool();
    const t0 = Date.now();
    let response: Response;
    try {
      response = await runScheduledJob("weekly-digest", request("test-cron-secret"), async () => ({ outcome: okOutcome, body: {} }), { bookkeeping: BOUNDS });
    } finally {
      await pool.release();
      vi.unstubAllGlobals();
    }
    const wall = Date.now() - t0;
    expect(await response.json()).toMatchObject({ heartbeat: { request: "notConfirmed" }, bookkeepingError: { stage: "create" } });
    expect(pings.map((p) => p.url)).toEqual([`${HC}/fail`]);
    expect(wall).toBeLessThan(BOUNDS.maxWaitMs + 5_000 + 1_500);
  }, 30_000);

  it("budget infeasible (decided by the pure helper inside the job): the runner is not started; finalized FAILED; exactly one /fail ping", async () => {
    vi.stubEnv("CRON_SECRET", "test-cron-secret");
    vi.stubEnv("HEALTHCHECK_DIGEST_URL", HC);
    const pings = recordPings();
    const runner = vi.fn();
    const response = await runScheduledJob(
      "weekly-digest",
      request("test-cron-secret"),
      async () => {
        const plan = planRouteBudget({ functionMaxMs: 30_000, coldStartReserveMs: 1_000, marginMs: 1_000, bookkeeping: BOUNDS, generation: DEFAULT_GENERATION_LIMITS });
        if (!plan.ok) return { outcome: { sent: 0, failed: 1, skipped: 0, organizationsProcessed: 0, errors: [plan.reason] }, body: { budget: plan.reason } };
        runner();
        return { outcome: okOutcome, body: {} };
      },
      { bookkeeping: BOUNDS },
    );
    vi.unstubAllGlobals();
    expect(runner).not.toHaveBeenCalled();
    expect(await response.json()).toMatchObject({ budget: "budgetInfeasible", ok: false, finalized: "confirmed", heartbeat: { request: "accepted", resultPersisted: "confirmed" } });
    expect(pings).toEqual([{ url: `${HC}/fail`, rowStatus: "FAILED", rowFinished: true }]);
    expect(await latestRun("weekly-digest")).toMatchObject({ status: "FAILED", errorSummary: "budgetInfeasible", heartbeatStatus: "ok" });
  });

  it("finalize not confirmed (the JobRun table really locked past the timeouts): exactly one /fail ping and no success ping, even though the job succeeded; heartbeat-status not attempted", async () => {
    vi.stubEnv("CRON_SECRET", "test-cron-secret");
    vi.stubEnv("HEALTHCHECK_DIGEST_URL", HC);
    const pings = recordPings();
    let lock: ReturnType<typeof holdLock> | undefined;
    let response: Response;
    const t0 = Date.now();
    try {
      response = await runScheduledJob(
        "weekly-digest",
        request("test-cron-secret"),
        async () => {
          lock = holdLock(`LOCK TABLE "JobRun" IN SHARE MODE`); // blocks the finalize UPDATE; reads still work
          await lock.held;
          return { outcome: okOutcome, body: { mine: 1 } };
        },
        { bookkeeping: BOUNDS },
      );
    } finally {
      await lock?.release();
      vi.unstubAllGlobals();
    }
    const wall = Date.now() - t0;
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body).toMatchObject({ mine: 1, ok: false, finalized: "unknown", heartbeat: { request: "accepted", resultPersisted: "notAttempted" }, bookkeepingError: { stage: "finalize" } });
    expect(pings.map((p) => p.url)).toEqual([`${HC}/fail`]);
    expect((await latestRun("weekly-digest"))!.status).toBe("RUNNING"); // here the update really did not commit
    // create + finalize, each bounded by maxWait + timeout + the in-flight statement, plus one instant ping
    expect(wall).toBeLessThan(2 * (BOUNDS.maxWaitMs + BOUNDS.timeoutMs + BOUNDS.statementTimeoutMs) + 1_500);
  }, 30_000);

  it("heartbeat-result persistence not confirmed (locked after the ping): the one request's outcome is kept, persistence is 'unknown', no second ping", async () => {
    vi.stubEnv("CRON_SECRET", "test-cron-secret");
    vi.stubEnv("HEALTHCHECK_DIGEST_URL", HC);
    let lock: ReturnType<typeof holdLock> | undefined;
    const pings = recordPings(async () => {
      lock = holdLock(`LOCK TABLE "JobRun" IN SHARE MODE`); // taken during the ping: the heartbeat-status UPDATE then blocks
      await lock.held;
    });
    const captured = captureConsole();
    let response: Response;
    try {
      response = await runScheduledJob("weekly-digest", request("test-cron-secret"), async () => ({ outcome: okOutcome, body: {} }), { bookkeeping: BOUNDS });
    } finally {
      captured.restore();
      await lock?.release();
      vi.unstubAllGlobals();
    }
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ ok: true, finalized: "confirmed", heartbeat: { request: "accepted", resultPersisted: "unknown" }, bookkeepingError: { stage: "heartbeatStatus" } });
    expect(pings).toEqual([{ url: HC, rowStatus: "SUCCEEDED", rowFinished: true }]); // exactly one request: the success ping
    expect(captured.logged.join("\n")).not.toMatch(/UPDATE|JobRun"|lock timeout/i); // safe code only, no SQL or driver text
  }, 30_000);
});

describe("four-check alerting (MONTHLY-GENERATION-ALERTING-PLAN.md §4): the scheduler ping, then three independent alert pings", () => {
  const SCHED = "https://hc-ping.com/scheduler-check";
  const URLS = { urgent: "https://hc-ping.com/urgent-check", data: "https://hc-ping.com/data-check", workload: "https://hc-ping.com/workload-check" } as const;
  const ALL = [SCHED, URLS.urgent, URLS.data, URLS.workload];
  const allOk = { urgent: true, data: true, workload: true };
  const mg = () => new Request("http://localhost/api/cron/monthly-generation", { headers: { authorization: "Bearer test-cron-secret" } });

  function stubAlerting() {
    vi.stubEnv("CRON_SECRET", "test-cron-secret");
    vi.stubEnv("HEALTHCHECK_MONTHLY_GENERATION_URL", SCHED);
    vi.stubEnv("HEALTHCHECK_MONTHLY_GENERATION_URGENT_URL", URLS.urgent);
    vi.stubEnv("HEALTHCHECK_MONTHLY_GENERATION_DATA_URL", URLS.data);
    vi.stubEnv("HEALTHCHECK_MONTHLY_GENERATION_WORKLOAD_URL", URLS.workload);
  }
  /** Stubs global fetch; records every request URL in order. `answer` decides each response (default 200). */
  function record(answer: (url: string, signal?: AbortSignal) => Promise<Response> = async () => new Response(null, { status: 200 })) {
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: { signal?: AbortSignal }) => {
        urls.push(url);
        return answer(url, init?.signal);
      }),
    );
    return urls;
  }
  const latestMg = () => latestRun("monthly-generation");

  afterEach(async () => {
    vi.mocked(pingAlertCheck).mockClear();
    vi.unstubAllGlobals();
    await prisma.jobRun.deleteMany({ where: { jobName: "monthly-generation" } });
  });

  it("REQUIRED: a clean run pings the scheduler, then urgent, data and workload, in that order; all four outcomes are stored", async () => {
    stubAlerting();
    const urls = record();
    const response = await runScheduledJob("monthly-generation", mg(), async () => ({ outcome: okOutcome, body: { mine: 1 }, alerts: allOk }), { bookkeeping: BOUNDS, alerting: true });
    expect(await response.json()).toMatchObject({ ok: true, heartbeat: { request: "accepted", resultPersisted: "confirmed", alerts: { urgent: "ok", data: "ok", workload: "ok" } } });
    expect(urls).toEqual(ALL);
    expect(await latestMg()).toMatchObject({ status: "SUCCEEDED", heartbeatStatus: "ok", alertPings: { urgent: "ok", data: "ok", workload: "ok" } });
  });

  it("REQUIRED (scheduler vs billing): a billing failure fails urgent, while the scheduler check still gets success; the run is PARTIAL", async () => {
    stubAlerting();
    const urls = record();
    await runScheduledJob("monthly-generation", mg(), async () => ({ outcome: { sent: 2, failed: 1, skipped: 0, organizationsProcessed: 1 }, body: {}, alerts: { ...allOk, urgent: false } }), {
      bookkeeping: BOUNDS,
      alerting: true,
    });
    expect(urls).toEqual([SCHED, `${URLS.urgent}/fail`, URLS.data, URLS.workload]);
    expect(await latestMg()).toMatchObject({ status: "PARTIAL", failed: 1, heartbeatStatus: "ok" });
  });

  it("REQUIRED (test 16): a workload threshold alone: SUCCEEDED, failed 0, ONLY the workload check gets /fail", async () => {
    stubAlerting();
    const urls = record();
    await runScheduledJob("monthly-generation", mg(), async () => ({ outcome: okOutcome, body: {}, alerts: { ...allOk, workload: false } }), { bookkeeping: BOUNDS, alerting: true });
    expect(urls).toEqual([SCHED, URLS.urgent, URLS.data, `${URLS.workload}/fail`]);
    expect(await latestMg()).toMatchObject({ status: "SUCCEEDED", failed: 0, alertPings: { urgent: "ok", data: "ok", workload: "ok" } });
  });

  it("REQUIRED: a check the run did not evaluate gets NO request (never a default success) and is stored not_sent", async () => {
    stubAlerting();
    const urls = record();
    await runScheduledJob("monthly-generation", mg(), async () => ({ outcome: okOutcome, body: {}, alerts: { urgent: false } }), { bookkeeping: BOUNDS, alerting: true });
    expect(urls).toEqual([SCHED, `${URLS.urgent}/fail`]);
    expect((await latestMg())!.alertPings).toEqual({ urgent: "ok", data: "not_sent", workload: "not_sent" });
  });

  it("REQUIRED: a thrown job is FAILED; scheduler success (finalized), urgent /fail, data and workload not sent", async () => {
    stubAlerting();
    const urls = record();
    const response = await runScheduledJob(
      "monthly-generation",
      mg(),
      async () => {
        throw secretError();
      },
      { bookkeeping: BOUNDS, alerting: true },
    );
    expect(response.status).toBe(500);
    expect(urls).toEqual([SCHED, `${URLS.urgent}/fail`]);
    expect(await latestMg()).toMatchObject({ status: "FAILED", heartbeatStatus: "ok", alertPings: { urgent: "ok", data: "not_sent", workload: "not_sent" } });
  });

  it("REQUIRED: JobRun create failing: exactly one request, scheduler /fail; no alert check is touched", async () => {
    stubAlerting();
    const urls = record();
    const job = vi.fn(async () => ({ outcome: okOutcome, body: {}, alerts: allOk }));
    const pool = await exhaustAppPool();
    try {
      await runScheduledJob("monthly-generation", mg(), job, { bookkeeping: BOUNDS, alerting: true });
    } finally {
      await pool.release();
    }
    expect(job).not.toHaveBeenCalled();
    expect(urls).toEqual([`${SCHED}/fail`]);
  }, 30_000);

  it("REQUIRED: finalize not confirmed: exactly one request, scheduler /fail; no alert check is touched", async () => {
    stubAlerting();
    const urls = record();
    let lock: ReturnType<typeof holdLock> | undefined;
    try {
      await runScheduledJob(
        "monthly-generation",
        mg(),
        async () => {
          lock = holdLock(`LOCK TABLE "JobRun" IN SHARE MODE`);
          await lock.held;
          return { outcome: okOutcome, body: {}, alerts: allOk };
        },
        { bookkeeping: BOUNDS, alerting: true },
      );
    } finally {
      await lock?.release();
    }
    expect(urls).toEqual([`${SCHED}/fail`]);
  }, 30_000);

  describe("REQUIRED (test 11): one ping's failure never prevents the attempts to send the other evaluated checks", () => {
    const failures = {
      "HTTP 500": async () => new Response(null, { status: 500 }),
      "a network error": async () => {
        throw new Error("ECONNREFUSED");
      },
    } as const;
    for (const [mode, fail] of Object.entries(failures)) {
      for (const target of ALL) {
        it(`${mode} on ${target.split("/").pop()}: all four requests are still made; status and counts unchanged; that one is recorded failed`, async () => {
          stubAlerting();
          const urls = record((url) => (url === target ? fail() : Promise.resolve(new Response(null, { status: 200 }))));
          await runScheduledJob("monthly-generation", mg(), async () => ({ outcome: okOutcome, body: {}, alerts: allOk }), { bookkeeping: BOUNDS, alerting: true });
          expect(urls).toEqual(ALL);
          const run = await latestMg();
          expect(run).toMatchObject({ status: "SUCCEEDED", sent: 1, failed: 0 });
          const expected = { urgent: "ok", data: "ok", workload: "ok" } as Record<string, string>;
          const check = Object.entries(URLS).find(([, u]) => u === target)?.[0];
          if (check) expected[check] = "failed";
          expect(run!.alertPings).toEqual(expected);
          expect(run!.heartbeatStatus).toBe(target === SCHED ? "failed" : "ok");
        });
      }
    }

    it("even an unexpected THROW from one alert-check client (not just a failed request) leaves the later checks attempted", async () => {
      stubAlerting();
      const urls = record();
      vi.mocked(pingAlertCheck).mockImplementationOnce(() => {
        throw new Error("unexpected");
      });
      await runScheduledJob("monthly-generation", mg(), async () => ({ outcome: okOutcome, body: {}, alerts: allOk }), { bookkeeping: BOUNDS, alerting: true });
      expect(urls).toEqual([SCHED, URLS.data, URLS.workload]); // urgent's client threw before any request
      expect((await latestMg())!.alertPings).toEqual({ urgent: "failed", data: "ok", workload: "ok" });
    });
  });

  it("REQUIRED (test 13): four endpoints that never answer: each aborts at 5 s, all four are attempted, and the post-runner path stays inside its 28 s reserve", async () => {
    stubAlerting();
    const urls = record((_url, signal) => neverAnswers(signal));
    const t0 = Date.now();
    await runScheduledJob("monthly-generation", mg(), async () => ({ outcome: okOutcome, body: {}, alerts: allOk }), { bookkeeping: BOUNDS, alerting: true });
    const wall = Date.now() - t0;
    expect(urls).toEqual(ALL);
    expect(await latestMg()).toMatchObject({ status: "SUCCEEDED", heartbeatStatus: "failed", alertPings: { urgent: "failed", data: "failed", workload: "failed" } });
    expect(wall).toBeGreaterThanOrEqual(4 * 5_000);
    expect(wall).toBeLessThan(28_000); // the route's post reserve: 2 bookkeeping writes + 4 pings
  }, 60_000);

  it("REQUIRED (test 17): the weekly digest is unchanged — even with every alert variable set, one ping, the old success rule, alertPings null", async () => {
    stubAlerting();
    vi.stubEnv("HEALTHCHECK_DIGEST_URL", HC);
    const urls = record();
    await runScheduledJob("weekly-digest", request("test-cron-secret"), async () => ({ outcome: { sent: 1, failed: 1, skipped: 0, organizationsProcessed: 1 }, body: {} }));
    expect(urls).toEqual([`${HC}/fail`]);
    expect(pingAlertCheck).not.toHaveBeenCalled();
    expect(await latestRun("weekly-digest")).toMatchObject({ status: "PARTIAL", heartbeatStatus: "ok", alertPings: null });
  });
});
