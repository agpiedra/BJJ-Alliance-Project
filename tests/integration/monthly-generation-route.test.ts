import "dotenv/config";
import { getTestPrismaClient } from "../helpers/test-db";
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

const prisma = getTestPrismaClient();
const SECRET = "test-cron-secret";
const HC = "https://hc-ping.example/monthly-generation";

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
    // Admission needs elapsed + admissionMs < deadline: 227 000 - 44 000 = 183 000 ms of slack, in MILLISECONDS end to end.
    expect(plan.generationDeadlineMs - plan.admissionMs).toBe(183_000);
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
      heartbeat: { request: "notConfigured", resultPersisted: "confirmed" },
    });
    const run = await latestRun();
    expect(run).toMatchObject({ status: "SUCCEEDED", sent: 0, failed: 0, heartbeatStatus: "not_configured" });
    expect(run!.finishedAt).not.toBeNull();
    expect(await prisma.duesObligation.count()).toBe(obligationsBefore);
    expect(await prisma.duesGenerationProgress.count()).toBe(0);
  });

  it("REQUIRED: production defaults stay closed through the route: a claimable progress row is refused and no financial row is written", async () => {
    vi.stubEnv("CRON_SECRET", SECRET);
    const org = await prisma.organization.findFirstOrThrow({ select: { id: true } });
    const row = await prisma.duesGenerationProgress.create({ data: { organizationId: org.id, year: 2031, month: 3, lastVisitedAt: new Date(0) } });
    const obligationsBefore = await prisma.duesObligation.count();
    try {
      const body = await (await GET(authed())).json();
      expect(body.ok).toBe(true);
      expect(body.created).toBe(0);
      expect(body.visits).toHaveLength(1);
      expect(body.visits[0]).toMatchObject({ segmentId: row.id, ended: "refused" });
      expect(["organizationNotActive", "ledgerNotActive", "beforeStart"]).toContain(body.visits[0].refused);
      expect(await prisma.duesObligation.count()).toBe(obligationsBefore);
      const after = await prisma.duesGenerationProgress.findUniqueOrThrow({ where: { id: row.id } });
      expect(after.cursorStudentId).toBeNull();
    } finally {
      await prisma.duesGenerationProgress.delete({ where: { id: row.id } });
    }
  });

  it("REQUIRED: a run with failures is 200 with ok:false, recorded PARTIAL or FAILED, with a /fail ping — and still never 'billing complete'", async () => {
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
    expect(pings).toEqual([`${HC}/fail`]);
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

  it("REQUIRED: an infeasible budget is 500, recorded FAILED with the safe code RouteBudgetInfeasibleError, /fail ping, and the runner never starts", async () => {
    vi.stubEnv("CRON_SECRET", SECRET);
    vi.stubEnv("HEALTHCHECK_MONTHLY_GENERATION_URL", HC);
    recordPings();
    const run = vi.fn();
    const response = await handleMonthlyGenerationRequest(authed(), performance.now(), { run, functionMaxMs: 60_000 });
    const body = await response.json();
    expect(response.status).toBe(500);
    expect(body).toMatchObject({ ok: false, error: "RouteBudgetInfeasibleError", finalized: "confirmed" });
    expect(run).not.toHaveBeenCalled();
    expect(await latestRun()).toMatchObject({ status: "FAILED", errorSummary: "RouteBudgetInfeasibleError" });
    expect(pings).toEqual([`${HC}/fail`]);
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
