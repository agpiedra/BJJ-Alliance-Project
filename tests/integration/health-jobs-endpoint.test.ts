import "dotenv/config";
import { getTestPrismaClient } from "../helpers/test-db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * C1: `/api/health/jobs` is behind the same CRON_SECRET the cron routes already use
 * (decision #3: "job freshness behind the secret") — never public, since it names real
 * organization-touching activity. Reports, per job (`weekly-digest`):
 * the last JobRun, whether it's STALE (older than that job's own expected cadence) and
 * whether it's STUCK (a RUNNING row that never finished within a generous window) —
 * a job that never ran at all is reported the same as one that's gone quiet: `lastRun: null`,
 * `stale: true`.
 */
const { GET } = await import("../../src/app/api/health/jobs/route");

const prisma = getTestPrismaClient();
let createdRunIds: string[] = [];

function request(secret: string | null): Request {
  return new Request("http://localhost/api/health/jobs", { headers: secret ? { authorization: `Bearer ${secret}` } : {} });
}

async function createRun(overrides: {
  jobName: string;
  status?: "RUNNING" | "SUCCEEDED" | "PARTIAL" | "FAILED";
  startedAt: Date;
  finishedAt?: Date | null;
  sent?: number;
  failed?: number;
}) {
  // `??` treats an EXPLICIT `null` (the stuck-row fixture's whole point: still RUNNING,
  // never finished) the same as "not provided" — so this checks presence, not nullishness.
  const finishedAt = "finishedAt" in overrides ? overrides.finishedAt : overrides.startedAt;
  const run = await prisma.jobRun.create({
    data: {
      jobName: overrides.jobName,
      status: overrides.status ?? "SUCCEEDED",
      startedAt: overrides.startedAt,
      finishedAt,
      sent: overrides.sent ?? 0,
      failed: overrides.failed ?? 0,
    },
  });
  createdRunIds.push(run.id);
  return run;
}

// The route reads "the most recent row for this jobName" across the whole (shared) table,
// so this file's own fixtures — several deliberately OLD, to prove staleness — can only be
// deterministic if the table is EMPTY of these job names before each test runs, not
// merely cleaned of what a PREVIOUS test created (which depends on test execution order,
// something this file has no control over and must not assume).
beforeEach(async () => {
  await prisma.jobRun.deleteMany({ where: { jobName: { in: ["weekly-digest", "promotion-auto-award"] } } });
  createdRunIds = [];
});
afterEach(async () => {
  vi.unstubAllEnvs();
  if (createdRunIds.length > 0) {
    await prisma.jobRun.deleteMany({ where: { id: { in: createdRunIds } } });
    createdRunIds = [];
  }
});

describe("GET /api/health/jobs", () => {
  it("REQUIRED: returns 401 when the Authorization header is missing or wrong (never public)", async () => {
    vi.stubEnv("CRON_SECRET", "test-cron-secret");
    expect((await GET(request(null))).status).toBe(401);
    expect((await GET(request("wrong-secret"))).status).toBe(401);
  });

  it("REQUIRED: reports every known job even when never run — never hidden or crashed on, and never-run counts as stale", async () => {
    vi.stubEnv("CRON_SECRET", "test-cron-secret");
    const response = await GET(request("test-cron-secret"));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.jobs["weekly-digest"]).toMatchObject({ lastRun: null, stale: true, stuck: false });
    expect(body.ok).toBe(false);
  });

  it("REQUIRED: the removed promotion auto-award job is not reported at all (a stale ghost job would keep health red forever)", async () => {
    vi.stubEnv("CRON_SECRET", "test-cron-secret");
    const body = await (await GET(request("test-cron-secret"))).json();
    expect(Object.keys(body.jobs)).toEqual(["weekly-digest"]);
  });

  it("REQUIRED: a fresh SUCCEEDED run is reported as neither stale nor stuck, with its real counts", async () => {
    vi.stubEnv("CRON_SECRET", "test-cron-secret");
    const run = await createRun({ jobName: "weekly-digest", startedAt: new Date(), sent: 3, failed: 0 });

    const body = await (await GET(request("test-cron-secret"))).json();

    expect(body.jobs["weekly-digest"].stale).toBe(false);
    expect(body.jobs["weekly-digest"].stuck).toBe(false);
    expect(body.jobs["weekly-digest"].lastRun).toMatchObject({ status: "SUCCEEDED", sent: 3, failed: 0 });
    expect(body.jobs["weekly-digest"].lastRun.startedAt).toBe(run.startedAt.toISOString());
  });

  it("REQUIRED: a run far older than the job's own expected cadence is reported as stale, even though it SUCCEEDED", async () => {
    vi.stubEnv("CRON_SECRET", "test-cron-secret");
    const longAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000); // 30 days ago
    await createRun({ jobName: "weekly-digest", status: "SUCCEEDED", startedAt: longAgo, finishedAt: longAgo });

    const body = await (await GET(request("test-cron-secret"))).json();

    expect(body.jobs["weekly-digest"].stale).toBe(true);
  });

  it("REQUIRED: a RUNNING row that started long ago and never finished is reported as stuck", async () => {
    vi.stubEnv("CRON_SECRET", "test-cron-secret");
    const stuckSince = new Date(Date.now() - 2 * 60 * 60 * 1000); // 2 hours ago, still RUNNING
    await createRun({ jobName: "weekly-digest", status: "RUNNING", startedAt: stuckSince, finishedAt: null });

    const body = await (await GET(request("test-cron-secret"))).json();

    expect(body.jobs["weekly-digest"].stuck).toBe(true);
    expect(body.jobs["weekly-digest"].lastRun.finishedAt).toBeNull();
  });
});
