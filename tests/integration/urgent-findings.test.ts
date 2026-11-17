import "dotenv/config";
import { getTestPrismaClient } from "../helpers/test-db";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import type { MonthlyGenerationRunReport } from "../../src/lib/dues/monthly-generation-progress";
import type { GenerationAlertDetail, GenerationAlertReport } from "../../src/lib/dues/monthly-generation-alerts";

/**
 * PR-A (docs/dues/URGENT-MONITOR-IMPLEMENTATION-PLAN.md, tests A-I1–A-I5): `JobRun.urgentFindings` against the real wrapper,
 * the real route logic and the real (local, disposable) test database. Healthchecks requests go to a stubbed global fetch;
 * nothing leaves the machine.
 *
 * The property under test: the findings are committed in the SAME update as `status` and `finishedAt`. A finalized run
 * always has them, an unfinished run never does, and no later failure (pings, the heartbeat-status write) can remove them.
 */
const { handleMonthlyGenerationRequest } = await import("../../src/lib/dues/monthly-generation-route");
const { runScheduledJob } = await import("../../src/lib/jobs/run-scheduled-job");
const { atRiskKey } = await import("../../src/lib/dues/monthly-generation-alerts");

const prisma = getTestPrismaClient();
const SECRET = "test-cron-secret";
const URLS = {
  HEALTHCHECK_MONTHLY_GENERATION_URL: "https://hc-ping.example/mg",
  HEALTHCHECK_MONTHLY_GENERATION_URGENT_URL: "https://hc-ping.example/mg-urgent",
  HEALTHCHECK_MONTHLY_GENERATION_DATA_URL: "https://hc-ping.example/mg-data",
  HEALTHCHECK_MONTHLY_GENERATION_WORKLOAD_URL: "https://hc-ping.example/mg-workload",
};

const mg = () => new Request("http://localhost/api/cron/monthly-generation", { headers: { authorization: `Bearer ${SECRET}` } });
const digest = () => new Request("http://localhost/api/cron/weekly-digest", { headers: { authorization: `Bearer ${SECRET}` } });
const latest = (jobName: string) => prisma.jobRun.findFirst({ where: { jobName }, orderBy: { startedAt: "desc" } });

function stubEnvAndFetch(answer: (url: string) => Promise<Response> = async () => new Response("OK", { status: 200 }), onFirstPing?: () => Promise<void>) {
  vi.stubEnv("CRON_SECRET", SECRET);
  for (const [k, v] of Object.entries(URLS)) vi.stubEnv(k, v);
  const urls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      urls.push(String(url));
      if (urls.length === 1) await onFirstPing?.();
      return answer(String(url));
    }),
  );
  return urls;
}

/** A lock held by the test client's own connection until `release()` (as in run-scheduled-job.test.ts). */
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

const emptyReport = (over: Partial<MonthlyGenerationRunReport> = {}): MonthlyGenerationRunReport => ({ visits: [], claimErrors: 0, stoppedBy: "noClaimableSegment", ...over });
const errorVisit = (organizationId: string): MonthlyGenerationRunReport["visits"][number] => ({
  segmentId: `seg-${organizationId}`,
  organizationId,
  year: 2031,
  month: 3,
  created: 0,
  classes: { INELIGIBLE: 0, COVERED: 0, UNPRICED: 0, PENDING: 0 },
  reasons: {},
  errorCodes: {},
  error: { stage: "page", code: "timeout" as never },
  ended: "error",
});
const okReport = (over: Partial<GenerationAlertReport> = {}): GenerationAlertReport => ({
  detection: "ok",
  newMonthAtRisk: [],
  olderMonthNotClean: [],
  notActiveOrganizations: [],
  conditionC: { activatedWithoutProgress: [], progressWithoutActivation: [] },
  workload: { reasons: [], counts: { progressRows: 0, organizations: 0, maxStudentsPerOrganization: 0, studentsTotal: 0, maxBranchesPerOrganization: 0 } },
  ...over,
});
const CLEAN_FINDINGS = { v: 1, detection: "ok", newMonthAtRisk: [], conditionC: { activatedWithoutProgress: [], progressWithoutActivation: [] }, runErrors: { global: 0, organizations: [] } };

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await prisma.jobRun.deleteMany({ where: { jobName: { in: ["monthly-generation", "weekly-digest"] } } });
});
afterAll(async () => {
  await prisma.jobRun.deleteMany({ where: { jobName: { in: ["monthly-generation", "weekly-digest"] } } });
});

describe("JobRun.urgentFindings: written by the monthly-generation route in the finalize update", () => {
  it("A-I1: a clean run with the REAL detection read: findings committed with status and finishedAt", async () => {
    stubEnvAndFetch();
    const response = await handleMonthlyGenerationRequest(mg(), performance.now(), { run: async () => emptyReport() });
    expect(response.status).toBe(200);
    const run = await latest("monthly-generation");
    expect(run).toMatchObject({ status: "SUCCEEDED", urgentFindings: CLEAN_FINDINGS });
    expect(run!.finishedAt).not.toBeNull();
  });

  it("run-level errors are stored per academy and globally; the urgent signal sent to Healthchecks is unchanged", async () => {
    const urls = stubEnvAndFetch();
    await handleMonthlyGenerationRequest(mg(), performance.now(), { run: async () => emptyReport({ visits: [errorVisit("org-2"), errorVisit("org-1")], claimErrors: 1 }) });
    expect((await latest("monthly-generation"))!.urgentFindings).toMatchObject({ runErrors: { global: 1, organizations: ["org-1", "org-2"] } });
    expect(urls).toContain(`${URLS.HEALTHCHECK_MONTHLY_GENERATION_URGENT_URL}/fail`);
  });

  it("condition A is stored with its atRiskSince from the detailed detection", async () => {
    stubEnvAndFetch();
    const a = { organizationId: "org-a", year: 2031, month: 11 };
    const detail: GenerationAlertDetail = { report: okReport({ newMonthAtRisk: [a] }), atRiskSince: { [atRiskKey(a)]: "2031-11-01T21:00:00.000Z" } };
    await handleMonthlyGenerationRequest(mg(), performance.now(), { run: async () => emptyReport(), detectDetailed: async () => detail });
    expect((await latest("monthly-generation"))!.urgentFindings).toMatchObject({ newMonthAtRisk: [{ ...a, atRiskSince: "2031-11-01T21:00:00.000Z" }] });
  });

  it("A-I2 (preserved across a failure): generation throws AFTER detection: FAILED, 500, and the detection findings are kept", async () => {
    stubEnvAndFetch();
    const a = { organizationId: "org-a", year: 2031, month: 11 };
    const detail: GenerationAlertDetail = {
      report: okReport({ newMonthAtRisk: [a], conditionC: { activatedWithoutProgress: ["org-c"], progressWithoutActivation: [] } }),
      atRiskSince: { [atRiskKey(a)]: "2031-11-01T21:00:00.000Z" },
    };
    const response = await handleMonthlyGenerationRequest(mg(), performance.now(), {
      detectDetailed: async () => detail,
      run: async () => {
        throw new Error("generation exploded");
      },
    });
    expect(response.status).toBe(500);
    expect(await latest("monthly-generation")).toMatchObject({
      status: "FAILED",
      urgentFindings: {
        v: 1,
        thrown: true,
        detection: "ok",
        newMonthAtRisk: [{ ...a, atRiskSince: "2031-11-01T21:00:00.000Z" }],
        conditionC: { activatedWithoutProgress: ["org-c"], progressWithoutActivation: [] },
        runErrors: { global: 1, organizations: [] },
      },
    });
  });

  it("a throw BEFORE detection (budget infeasible): notEvaluated, one global run error", async () => {
    stubEnvAndFetch();
    const detect = vi.fn();
    await handleMonthlyGenerationRequest(mg(), performance.now(), { functionMaxMs: 1_000, detectDetailed: detect });
    expect(detect).not.toHaveBeenCalled();
    expect((await latest("monthly-generation"))!.urgentFindings).toEqual({
      v: 1,
      thrown: true,
      detection: "notEvaluated",
      newMonthAtRisk: [],
      conditionC: null,
      runErrors: { global: 1, organizations: [] },
    });
  });

  it("a failed detection read is stored as its safe code (RUNDET); C null", async () => {
    stubEnvAndFetch();
    const failed: GenerationAlertReport = { ...okReport(), detection: "timeout", conditionC: null, workload: null };
    await handleMonthlyGenerationRequest(mg(), performance.now(), { run: async () => emptyReport(), detectDetailed: async () => ({ report: failed, atRiskSince: {} }) });
    expect((await latest("monthly-generation"))!.urgentFindings).toMatchObject({ detection: "timeout", newMonthAtRisk: [], conditionC: null });
  });

  it("every Healthchecks request failing does not remove the findings (they were committed before any ping)", async () => {
    stubEnvAndFetch(async () => new Response(null, { status: 500 }));
    await handleMonthlyGenerationRequest(mg(), performance.now(), { run: async () => emptyReport() });
    expect(await latest("monthly-generation")).toMatchObject({ status: "SUCCEEDED", heartbeatStatus: "failed", urgentFindings: CLEAN_FINDINGS });
  });

  it("the heartbeat-status write failing AFTER the ping does not remove the findings", async () => {
    let lock: ReturnType<typeof holdLock> | undefined;
    stubEnvAndFetch(undefined, async () => {
      lock = holdLock(`LOCK TABLE "JobRun" IN SHARE MODE`); // taken during the first ping: the later heartbeat-status UPDATE blocks
      await lock.held;
    });
    let body: Record<string, unknown>;
    try {
      body = await (await handleMonthlyGenerationRequest(mg(), performance.now(), { run: async () => emptyReport() })).json();
    } finally {
      await lock?.release();
    }
    expect(body).toMatchObject({ finalized: "confirmed", bookkeepingError: { stage: "heartbeatStatus" } });
    expect(await latest("monthly-generation")).toMatchObject({ status: "SUCCEEDED", urgentFindings: CLEAN_FINDINGS });
  }, 30_000);

  it("A-I4: finalize not committed: NO findings and the row stays RUNNING (never findings without a finished run)", async () => {
    stubEnvAndFetch();
    let lock: ReturnType<typeof holdLock> | undefined;
    try {
      await handleMonthlyGenerationRequest(mg(), performance.now(), {
        run: async () => {
          lock = holdLock(`LOCK TABLE "JobRun" IN SHARE MODE`); // blocks the finalize UPDATE
          await lock.held;
          return emptyReport();
        },
      });
    } finally {
      await lock?.release();
    }
    const run = await latest("monthly-generation");
    expect(run).toMatchObject({ status: "RUNNING", finishedAt: null, urgentFindings: null });
  }, 30_000);

  it("A-I3: the weekly digest never writes findings", async () => {
    stubEnvAndFetch();
    await runScheduledJob("weekly-digest", digest(), async () => ({ outcome: { sent: 1, failed: 0, skipped: 0, organizationsProcessed: 1 }, body: {} }));
    expect((await latest("weekly-digest"))!.urgentFindings).toBeNull();
  });
});

describe("migration: JobRun.urgentFindings column", () => {
  it("existing rows read NULL (additive, no backfill); NULL and objects are accepted", async () => {
    const row = await prisma.jobRun.create({ data: { jobName: "weekly-digest" } });
    expect(row.urgentFindings).toBeNull();
    await prisma.jobRun.update({ where: { id: row.id }, data: { urgentFindings: { v: 1 } } });
    expect((await prisma.jobRun.findUniqueOrThrow({ where: { id: row.id } })).urgentFindings).toEqual({ v: 1 });
  });

  it("A-I5: a non-object JSON value is rejected by the CHECK constraint", async () => {
    const row = await prisma.jobRun.create({ data: { jobName: "weekly-digest" } });
    for (const value of [`'[]'::jsonb`, `'"text"'::jsonb`, `'1'::jsonb`, `'null'::jsonb`]) {
      await expect(prisma.$executeRawUnsafe(`UPDATE "JobRun" SET "urgentFindings" = ${value} WHERE id = $1`, row.id)).rejects.toThrow(/JobRun_urgentFindings_object/);
    }
  });

  it("the documented rollback statements are valid against the migrated schema (executed, then rolled back)", async () => {
    await expect(
      prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`ALTER TABLE "JobRun" DROP CONSTRAINT "JobRun_urgentFindings_object"`);
        await tx.$executeRawUnsafe(`ALTER TABLE "JobRun" DROP COLUMN "urgentFindings"`);
        throw new Error("rollback-rehearsal");
      }),
    ).rejects.toThrow("rollback-rehearsal");
    const still = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT count(*) AS n FROM information_schema.columns WHERE table_name = 'JobRun' AND column_name = 'urgentFindings'`,
    );
    expect(Number(still[0].n)).toBe(1);
  });
});
