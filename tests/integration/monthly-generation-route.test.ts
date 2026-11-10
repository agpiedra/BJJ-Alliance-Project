import "dotenv/config";
import { getTestPrismaClient } from "../helpers/test-db";
import { forceDeleteForTest } from "../helpers/force-delete";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import type { MonthlyGenerationRunDeps, MonthlyGenerationRunReport } from "../../src/lib/dues/monthly-generation-progress";

/**
 * G2b: `GET /api/cron/monthly-generation` against the real wrapper and the real database (no mocked Prisma).
 * - authentication: the constant-time check accepts exactly what the former `!==` accepted;
 * - the runner's deadline comes from planRouteBudget (never a hard-coded number), with elapsed time from the handler start;
 * - the HTTP contract: 200 + ok for a clean run, 200 + ok:false for a run with failures, 500 for an infeasible budget or a
 *   throw — and a 200 never certifies billing completeness;
 * - production defaults stay closed: a claimable progress row is refused, and no financial row is written.
 * Heartbeat requests are recorded through a stubbed global fetch; nothing leaves the machine.
 */
const { GET, maxDuration } = await import("../../src/app/api/cron/monthly-generation/route");
const { handleMonthlyGenerationRequest, monthlyGenerationRouteBudget, MONTHLY_GENERATION_FUNCTION_MAX_SECONDS } = await import(
  "../../src/lib/dues/monthly-generation-route"
);

const { runMonthlyGeneration: runReal } = await import("../../src/lib/dues/monthly-generation-progress");
const { currentMonthIn } = await import("../../src/lib/dues/config-input");

const prisma = getTestPrismaClient();
const SECRET = "test-cron-secret";
const HC = "https://hc-ping.example/monthly-generation";
const URGENT = "https://hc-ping.example/monthly-generation-urgent";
const DATA = "https://hc-ping.example/monthly-generation-data";
const WORKLOAD = "https://hc-ping.example/monthly-generation-workload";

function request(authorization: string | null): Request {
  return new Request("http://localhost/api/cron/monthly-generation", { headers: authorization === null ? {} : { authorization } });
}
const authed = () => request(`Bearer ${SECRET}`);

const pings: string[] = [];
function recordPings() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL) => {
      pings.push(String(url));
      return new Response("OK", { status: 200 });
    }),
  );
}

async function latestRun() {
  return prisma.jobRun.findFirst({ where: { jobName: "monthly-generation" }, orderBy: { startedAt: "desc" } });
}

const emptyReport = (overrides: Partial<MonthlyGenerationRunReport> = {}): MonthlyGenerationRunReport => ({
  visits: [],
  claimErrors: 0,
  stoppedBy: "noClaimableSegment",
  ...overrides,
});
const visit = (overrides: Partial<MonthlyGenerationRunReport["visits"][number]> = {}): MonthlyGenerationRunReport["visits"][number] => ({
  segmentId: "seg-1",
  organizationId: "org-1",
  year: 2031,
  month: 3,
  created: 0,
  classes: { INELIGIBLE: 0, COVERED: 0, UNPRICED: 0, PENDING: 0 },
  reasons: {},
  errorCodes: {},
  ended: "deadline",
  ...overrides,
});

afterEach(async () => {
  pings.length = 0;
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await prisma.jobRun.deleteMany({ where: { jobName: "monthly-generation" } });
});

afterAll(async () => {
  await prisma.jobRun.deleteMany({ where: { jobName: "monthly-generation" } });
});

describe("GET /api/cron/monthly-generation (G2b)", () => {
  it("REQUIRED: maxDuration (F) equals the route module's constant, and the approved reserves make the budget feasible", () => {
    expect(maxDuration).toBe(MONTHLY_GENERATION_FUNCTION_MAX_SECONDS);
    expect(monthlyGenerationRouteBudget()).toMatchObject({ ok: true });
  });

  it.each([
    ["no header", null],
    ["a wrong secret", "Bearer wrong-secret"],
    ["the right secret, lowercase scheme", `bearer ${SECRET}`],
    ["a prefix of the right secret", `Bearer ${SECRET.slice(0, -1)}`],
    ["the right secret plus one character", `Bearer ${SECRET}x`],
    ["the bare secret without the scheme", SECRET],
  ])("REQUIRED: %s -> 401, no JobRun row, the runner never called", async (_label, header) => {
    vi.stubEnv("CRON_SECRET", SECRET);
    const run = vi.fn();
    const response = await handleMonthlyGenerationRequest(request(header), performance.now(), { run });
    expect(response.status).toBe(401);
    expect(run).not.toHaveBeenCalled();
    expect(await latestRun()).toBeNull();
  });

  it("REQUIRED (real runner, units and admission): 150 s already spent still admits discovery; 200 s spent stops at the deadline before claiming anything", async () => {
    vi.stubEnv("CRON_SECRET", SECRET);
    const plan = monthlyGenerationRouteBudget();
    if (!plan.ok) throw new Error("expected a feasible plan");
    // Admission needs elapsed + admissionMs < deadline: 212 000 - 48 000 = 164 000 ms of slack, in MILLISECONDS end to end
    // (four sequential pings and the 4 s detection read reserved; MONTHLY-GENERATION-ALERTING-PLAN.md §5).
    expect(plan.generationDeadlineMs).toBe(212_000);
    expect(plan.generationDeadlineMs - plan.admissionMs).toBe(164_000);
    const admitted = await (await handleMonthlyGenerationRequest(authed(), performance.now() - 150_000)).json();
    expect(admitted).toMatchObject({ ok: true, stoppedBy: "noClaimableSegment" });
    await prisma.jobRun.deleteMany({ where: { jobName: "monthly-generation" } });
    const tooLate = await (await handleMonthlyGenerationRequest(authed(), performance.now() - 200_000)).json();
    expect(tooLate).toMatchObject({ ok: true, stoppedBy: "deadline", visits: [], created: 0, billingCompletenessCertified: false });
    // The wrapper still finalized the run after the runner returned: bookkeeping sits outside the generation deadline.
    expect(await latestRun()).toMatchObject({ status: "SUCCEEDED" });
  });

  it.each([
    ["missing", undefined],
    ["empty", ""],
  ])("REQUIRED: a %s CRON_SECRET throws before any write, exactly as before the constant-time change (no JobRun row, runner never called)", async (_label, value) => {
    vi.stubEnv("CRON_SECRET", value as string);
    const run = vi.fn();
    await expect(handleMonthlyGenerationRequest(authed(), performance.now(), { run })).rejects.toThrow("Missing required environment variable: CRON_SECRET");
    expect(run).not.toHaveBeenCalled();
    expect(await latestRun()).toBeNull();
  });

  it("REQUIRED: the runner's deadline is planRouteBudget's generation deadline, elapsed time counts from the handler start, closure policy is \"reopen\" and no activation or start month is passed", async () => {
    vi.stubEnv("CRON_SECRET", SECRET);
    let seen: MonthlyGenerationRunDeps | undefined;
    let elapsedAtCall = -1;
    const started = performance.now() - 1_500; // as if 1.5 s had already passed since the handler's first line
    const response = await handleMonthlyGenerationRequest(authed(), started, {
      run: async (deps) => {
        seen = deps;
        elapsedAtCall = deps.elapsedMs!();
        return emptyReport();
      },
    });
    expect(response.status).toBe(200);
    const plan = monthlyGenerationRouteBudget();
    if (!plan.ok) throw new Error("expected a feasible plan");
    expect(seen!.limits).toEqual({ deadlineMs: plan.generationDeadlineMs });
    expect(seen!.closurePolicy).toBe("reopen");
    expect(seen).not.toHaveProperty("activation");
    expect(seen).not.toHaveProperty("generationStart");
    expect(elapsedAtCall).toBeGreaterThanOrEqual(1_500);
  });

  it("REQUIRED: the real route with production defaults and no progress rows: 200, SUCCEEDED, nothing claimed, never 'billing complete', heartbeat not configured", async () => {
    vi.stubEnv("CRON_SECRET", SECRET);
    expect(await prisma.duesGenerationProgress.count(), "precondition: no progress rows").toBe(0);
    const obligationsBefore = await prisma.duesObligation.count();

    const response = await GET(authed());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      billingCompletenessCertified: false,
      stoppedBy: "noClaimableSegment",
      created: 0,
      failed: 0,
      visits: [],
      finalized: "confirmed",
      heartbeat: { request: "notConfigured", resultPersisted: "confirmed", alerts: { urgent: "not_configured", data: "not_configured", workload: "not_configured" } },
      // The real detection read ran against the empty tables: no activation and no progress row, so nothing to report (C included).
      alerts: { detection: "ok", newMonthAtRisk: [], olderMonthNotClean: [], conditionC: { activatedWithoutProgress: [], progressWithoutActivation: [] }, workload: { reasons: [] } },
    });
    const run = await latestRun();
    expect(run).toMatchObject({
      status: "SUCCEEDED",
      sent: 0,
      failed: 0,
      heartbeatStatus: "not_configured",
      alertPings: { urgent: "not_configured", data: "not_configured", workload: "not_configured" },
    });
    expect(run!.finishedAt).not.toBeNull();
    expect(await prisma.duesObligation.count()).toBe(obligationsBefore);
    expect(await prisma.duesGenerationProgress.count()).toBe(0);
  });

  it("REQUIRED: production defaults stay closed through the route: a progress row without an activation is refused, writes nothing, and is reported as condition C", async () => {
    vi.stubEnv("CRON_SECRET", SECRET);
    const org = await prisma.organization.findFirstOrThrow({ select: { id: true } });
    const row = await prisma.duesGenerationProgress.create({ data: { organizationId: org.id, year: 2031, month: 3, lastVisitedAt: new Date(0) } });
    const obligationsBefore = await prisma.duesObligation.count();
    try {
      const body = await (await GET(authed())).json();
      expect(body.created).toBe(0);
      expect(body.visits).toHaveLength(1);
      expect(body.visits[0]).toMatchObject({ segmentId: row.id, ended: "refused" });
      expect(["organizationNotActive", "ledgerNotActive", "beforeStart"]).toContain(body.visits[0].refused);
      // Stage 9: only the switch creates progress rows, so a row with no effective activation is an invariant failure (C).
      expect(body.alerts.conditionC.progressWithoutActivation).toContain(org.id);
      expect(body.ok).toBe(false);
      expect(await prisma.duesObligation.count()).toBe(obligationsBefore);
      const after = await prisma.duesGenerationProgress.findUniqueOrThrow({ where: { id: row.id } });
      expect(after.cursorStudentId).toBeNull();
    } finally {
      await forceDeleteForTest(prisma, { sql: `DELETE FROM "DuesGenerationProgress" WHERE "id" = $1`, params: [row.id] });
    }
  });

  it("REQUIRED: a run with failures is 200 with ok:false, recorded PARTIAL or FAILED — the scheduler check still gets success (it is liveness only), and still never 'billing complete'", async () => {
    vi.stubEnv("CRON_SECRET", SECRET);
    vi.stubEnv("HEALTHCHECK_MONTHLY_GENERATION_URL", HC);
    recordPings();
    const report = emptyReport({
      stoppedBy: "deadline",
      visits: [visit({ created: 2, classes: { INELIGIBLE: 1, COVERED: 2, UNPRICED: 0, PENDING: 1 }, ended: "passEnd", passFinished: { ineligible: 1, covered: 2, unpriced: 0, pending: 1, clean: false } })],
    });
    const response = await handleMonthlyGenerationRequest(authed(), performance.now(), { run: async () => report });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ ok: false, billingCompletenessCertified: false, created: 2, failed: 1, skipped: 3, finalized: "confirmed" });
    const run = await latestRun();
    expect(run).toMatchObject({ status: "PARTIAL", sent: 2, failed: 1, skipped: 3, organizationsProcessed: 1 });
    expect(run!.errorSummary).toContain("passEnded unpriced=0 pending=1");
    // An unclean pass end is not urgent: once persisted, the next run's detection reports it (B, or A after 15 h).
    expect(pings).toEqual([HC]);
  });

  it("REQUIRED: a run that stops at its deadline with work left and no failure is SUCCEEDED — not a failure, and not 'billing complete'", async () => {
    vi.stubEnv("CRON_SECRET", SECRET);
    vi.stubEnv("HEALTHCHECK_MONTHLY_GENERATION_URL", HC);
    recordPings();
    const report = emptyReport({ stoppedBy: "deadline", visits: [visit({ created: 5, ended: "deadline" })] });
    const body = await (await handleMonthlyGenerationRequest(authed(), performance.now(), { run: async () => report })).json();
    expect(body).toMatchObject({ ok: true, billingCompletenessCertified: false, stoppedBy: "deadline", created: 5, failed: 0 });
    expect((await latestRun())!.status).toBe("SUCCEEDED");
    expect(pings).toEqual([HC]);
  });

  it("REQUIRED: an infeasible budget is 500, recorded FAILED with the safe code RouteBudgetInfeasibleError, urgent /fail (scheduler success), and the runner never starts", async () => {
    vi.stubEnv("CRON_SECRET", SECRET);
    vi.stubEnv("HEALTHCHECK_MONTHLY_GENERATION_URL", HC);
    vi.stubEnv("HEALTHCHECK_MONTHLY_GENERATION_URGENT_URL", URGENT);
    recordPings();
    const run = vi.fn();
    const response = await handleMonthlyGenerationRequest(authed(), performance.now(), { run, functionMaxMs: 60_000 });
    const body = await response.json();
    expect(response.status).toBe(500);
    expect(body).toMatchObject({ ok: false, error: "RouteBudgetInfeasibleError", finalized: "confirmed" });
    expect(run).not.toHaveBeenCalled();
    expect(await latestRun()).toMatchObject({ status: "FAILED", errorSummary: "RouteBudgetInfeasibleError" });
    expect(pings).toEqual([HC, `${URGENT}/fail`]);
  });

  it("REQUIRED: an unexpected throw from the runner is 500 with a safe code only (never its message), recorded FAILED", async () => {
    vi.stubEnv("CRON_SECRET", SECRET);
    const response = await handleMonthlyGenerationRequest(authed(), performance.now(), {
      run: async () => {
        throw new Error("secret detail that must not leak");
      },
    });
    const text = await response.text();
    expect(response.status).toBe(500);
    expect(text).not.toContain("secret detail");
    expect(JSON.parse(text)).toMatchObject({ ok: false, error: "unrecognized_error" });
    const run = await latestRun();
    expect(run).toMatchObject({ status: "FAILED", errorSummary: "unrecognized_error" });
  });
});

describe("four-check alerting through the route (MONTHLY-GENERATION-ALERTING-PLAN.md §4, test 15)", () => {
  type Report = import("../../src/lib/dues/monthly-generation-alerts").GenerationAlertReport;
  const clean: Report = {
    detection: "ok",
    newMonthAtRisk: [],
    olderMonthNotClean: [],
    notActiveOrganizations: [],
    conditionC: { activatedWithoutProgress: [], progressWithoutActivation: [] },
    workload: { reasons: [], counts: { progressRows: 0, organizations: 0, maxStudentsPerOrganization: 0, studentsTotal: 0, maxBranchesPerOrganization: 0 } },
  };
  const failedDetection: Report = { detection: "P2024", newMonthAtRisk: [], olderMonthNotClean: [], notActiveOrganizations: [], conditionC: null, workload: null };
  function stubAll() {
    vi.stubEnv("CRON_SECRET", SECRET);
    vi.stubEnv("HEALTHCHECK_MONTHLY_GENERATION_URL", HC);
    vi.stubEnv("HEALTHCHECK_MONTHLY_GENERATION_URGENT_URL", URGENT);
    vi.stubEnv("HEALTHCHECK_MONTHLY_GENERATION_DATA_URL", DATA);
    vi.stubEnv("HEALTHCHECK_MONTHLY_GENERATION_WORKLOAD_URL", WORKLOAD);
    recordPings();
  }
  const go = (detect: Report, run = vi.fn(async () => emptyReport())) =>
    handleMonthlyGenerationRequest(authed(), performance.now(), { detect: async () => detect, run }).then((r) => r.json());

  it.each([
    ["billing clean, below thresholds", clean, "SUCCEEDED", 0, [HC, URGENT, DATA, WORKLOAD]],
    ["A: the new month at risk", { ...clean, newMonthAtRisk: [{ organizationId: "org-1", year: 2031, month: 11 }] }, "FAILED", 1, [HC, `${URGENT}/fail`, DATA, WORKLOAD]],
    ["B: an older month not clean", { ...clean, olderMonthNotClean: [{ organizationId: "org-1", year: 2031, month: 9 }] }, "FAILED", 1, [HC, URGENT, `${DATA}/fail`, WORKLOAD]],
    ["a workload threshold only", { ...clean, workload: { ...clean.workload!, reasons: ["progressRows"] } }, "SUCCEEDED", 0, [HC, URGENT, DATA, `${WORKLOAD}/fail`]],
    ["D: detection failed", failedDetection, "FAILED", 1, [HC, `${URGENT}/fail`]],
    ["C: an activation without progress rows", { ...clean, conditionC: { activatedWithoutProgress: ["org-1"], progressWithoutActivation: [] } }, "FAILED", 1, [HC, `${URGENT}/fail`, DATA, WORKLOAD]],
    ["C: progress rows without an activation", { ...clean, conditionC: { activatedWithoutProgress: [], progressWithoutActivation: ["org-2"] } }, "FAILED", 1, [HC, `${URGENT}/fail`, DATA, WORKLOAD]],
  ] as const)("%s → JobRun %s with failed=%i; requests %j", async (_label, detect, status, failed, expected) => {
    stubAll();
    const body = await go(detect as Report);
    expect(pings).toEqual(expected);
    const run = await latestRun();
    expect(run).toMatchObject({ status, failed, heartbeatStatus: "ok" });
    expect(body.alerts).toMatchObject({ conditionC: (detect as Report).conditionC });
  });

  it("REQUIRED: a failed detection never stops billing — the runner still runs, and data/workload are not sent", async () => {
    stubAll();
    const run = vi.fn(async () => emptyReport());
    await go(failedDetection, run);
    expect(run).toHaveBeenCalledTimes(1);
    expect((await latestRun())!.alertPings).toEqual({ urgent: "ok", data: "not_sent", workload: "not_sent" });
  });

  it("REQUIRED: run-level errors (claim, discovery, visit stage, skipped rollover) fail the urgent check", async () => {
    stubAll();
    await go(clean, vi.fn(async () => emptyReport({ claimErrors: 1 })));
    expect(pings).toEqual([HC, `${URGENT}/fail`, DATA, WORKLOAD]);
  });

  it("REQUIRED: the real detection read sees real progress rows: an older unclean month fails the data check, not the urgent one", async () => {
    stubAll();
    const org = await prisma.organization.findFirstOrThrow({ select: { id: true, academies: { select: { timezone: true } } } });
    const now = new Date();
    const current = org.academies.map((a) => currentMonthIn(a.timezone, now)).reduce((min, m) => (m.year * 12 + m.month < min.year * 12 + min.month ? m : min));
    const rows = await Promise.all([
      // Finished passes are recorded whole (DuesGenerationProgress_last_pass_complete): unclean = 1 pending student.
      prisma.duesGenerationProgress.create({
        data: { organizationId: org.id, year: 2020, month: 1, lastVisitedAt: now, lastPassCompletedAt: now, lastPassIneligible: 0, lastPassCovered: 0, lastPassUnpriced: 0, lastPassPending: 1, lastPassClean: false },
      }),
      // The new month already has a clean pass, so condition A cannot fire and only B is under test.
      prisma.duesGenerationProgress.create({
        data: { organizationId: org.id, ...current, lastVisitedAt: now, lastPassCompletedAt: now, lastPassIneligible: 0, lastPassCovered: 0, lastPassUnpriced: 0, lastPassPending: 0, lastPassClean: true },
      }),
    ]);
    // Stage 9 condition C: progress rows belong to an organization with an effective activation (S = the oldest row's month), as
    // only the switch creates them — otherwise the real read would rightly report C and fail the urgent check.
    const user = await prisma.user.findFirstOrThrow({ select: { id: true } });
    const activation = await prisma.duesActivation.create({
      data: { organizationId: org.id, startYear: 2020, startMonth: 1, fingerprintFormat: "r3", configFingerprint: "x", studentFingerprints: {}, approvedOpeningTotals: {}, approvedById: user.id, approvedAt: now },
    });
    await prisma.duesActivation.update({ where: { id: activation.id }, data: { effectiveAt: now, effectiveById: user.id } });
    try {
      // Generation itself is not under test here; the real detection read is.
      const body = await (await handleMonthlyGenerationRequest(authed(), performance.now(), { run: async () => emptyReport() })).json();
      expect(body.alerts).toMatchObject({ detection: "ok", newMonthAtRisk: [] });
      expect(body.alerts.conditionC.activatedWithoutProgress).not.toContain(org.id);
      expect(body.alerts.conditionC.progressWithoutActivation).not.toContain(org.id);
      expect(body.alerts.olderMonthNotClean).toContainEqual({ organizationId: org.id, year: 2020, month: 1 });
      expect(pings.slice(0, 3)).toEqual([HC, URGENT, `${DATA}/fail`]);
      expect(pings[3]).toMatch(new RegExp(`^${WORKLOAD}(/fail)?$`)); // seed-dependent counts: attempted either way
    } finally {
      await forceDeleteForTest(
        prisma,
        { sql: `DELETE FROM "DuesActivation" WHERE "id" = $1`, params: [activation.id] },
        { sql: `DELETE FROM "DuesGenerationProgress" WHERE "id" = ANY($1::text[])`, params: [rows.map((r) => r.id)] },
      );
    }
  });

  it("REQUIRED (test 21): the runner gets the 212 s deadline, and a detection read that uses its FULL 4 s still admits a claim attempt", async () => {
    vi.stubEnv("CRON_SECRET", SECRET);
    const slowDetect = async () => {
      await new Promise((r) => setTimeout(r, 4_000));
      return clean;
    };
    let deadlineSeen = -1;
    let elapsedAtRunner = -1;
    const body = await (
      await handleMonthlyGenerationRequest(authed(), performance.now(), {
        detect: slowDetect,
        run: async (deps) => {
          deadlineSeen = deps.limits!.deadlineMs!;
          elapsedAtRunner = deps.elapsedMs!();
          return runReal(deps);
        },
      })
    ).json();
    expect(deadlineSeen).toBe(212_000);
    expect(elapsedAtRunner).toBeGreaterThanOrEqual(4_000);
    expect(body).toMatchObject({ ok: true, stoppedBy: "noClaimableSegment" }); // admitted: it looked for work instead of stopping at the deadline
  }, 30_000);
});
