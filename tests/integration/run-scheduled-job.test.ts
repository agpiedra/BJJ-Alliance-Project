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
  return { ...actual, pingHeartbeat: vi.fn(actual.pingHeartbeat) };
});

const { runScheduledJob } = await import("../../src/lib/jobs/run-scheduled-job");
const { pingHeartbeat } = await import("../../src/lib/jobs/heartbeat");

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
